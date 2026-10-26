import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
/* `setHeaders` 拿到的是**原始** `ServerResponse`，不是 Fastify 的 reply。 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  jevOptionSpec,
  listJevOptions,
  listSwitches,
  setJevOption,
  setSwitch,
  switchSpec,
} from '../trader/control.js';
import {
  EXCHANGES,
  LLM_PROVIDERS,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  defaultStrategyConfig,
  providerDefaults,
  defaultJevConfig,
  defaultAiTeamConfig,
  isAiDriven,
  unboundedAiManagedConfig,
  type PositionView,
  type ServerEvent,
  type Trader,
  type TraderStatus,
} from '@aq/shared';
import { z } from 'zod';
import type { ExchangeConnection } from '../binance/bootstrap.js';
import { preflight } from '../binance/bootstrap.js';
import type { Vault } from '../crypto/vault.js';
import { dbPath, env, webDistDir } from '../env.js';
import { checkForUpdates, readAppVersion, readBuildInfo } from '../buildInfo.js';
import { eventBus } from '../events.js';
import { createLogger, setLogSink } from '../logger.js';
import { maskSecret, hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from '../crypto/vault.js';
import {
  aiModels,
  computeTraderStats,
  DECISION_PAGE_DEFAULT,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  normalizeMarginMode,
  ORDER_PAGE_DEFAULT,
  orders as orderStore,
  ownUnrealizedPnlOf,
  positions as positionStore,
  runtimeLogs,
  RUNTIME_LOG_CAP,
  RUNTIME_LOG_PAGE_DEFAULT,
  settings,
  strategies,
  traders,
  TRADE_PAGE_DEFAULT,
  trades as tradeStore,
  users,
  decisions,
} from '../store/repositories.js';
import { recentCycleStats, staleThresholdMs } from './staleThreshold.js';
/*
 * 智能体审计三张表（运行轨迹 / 参数实验 / 教训记忆）。
 * 它们此前**没有任何 API 暴露** —— 见 `/api/traders/:id/agent-audit` 的说明。
 */
import { agentExperiments as agentStoreExperiments, agentMemory as agentStoreMemory, agentRuns as agentStoreRuns } from '../store/agentStore.js';
import type { TraderManager } from '../trader/manager.js';
import { readLlmHealth, recordLlmHealth } from '../trader/manager.js';
import { runSelfCheck } from '../trader/selfcheckRunner.js';
import {
  requireAuth,
  signToken,
  verifyToken,
  extractToken,
  isTokenRevoked,
  generatePassword,
  generateUsername,
  type AuthedRequest,
  type TokenPayload,
} from './auth.js';
import { FailureThrottle, IP_THROTTLE_OPTIONS, USERNAME_THROTTLE_OPTIONS } from './loginThrottle.js';
import { checkOutboundUrl, parseHostAllowlist } from '../llm/urlGuard.js';
import { paperAccountState } from '../binance/paperWallet.js';
import type { BalanceService } from '../services/balance.js';

const log = createLogger('api');

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/* -------------------------------------------------------------------------- */

const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(256),
});

/**
 * 修改账户凭据的请求体。
 *
 * 加 zod 不是为了拦攻击，而是为了拦住**类型错误**：`currentPassword` 传数字时，
 * 旧代码会把它一路送到 `scryptSync`，抛出的 `TypeError` 变成 HTTP 500。
 * 校验发生在任何写操作之前，所以这里没有绕过风险 —— 但 500 会让一个纯粹的
 * 客户端错误看起来像服务端故障，还会把内部栈信息回显出去。
 */
const UpdateAccountSchema = z.object({
  currentPassword: z.string({ description: '当前密码' }).min(1, '请填写当前密码。').max(256),
  username: z.string().max(64).optional(),
  newPassword: z.string().max(256).optional(),
});

/**
 * 自定义模型端点地址。
 *
 * 在这里（而不是只在真正发请求的地方）校验，是为了给操作员一条明确的 400，
 * 而不是把危险地址先存进数据库、等到交易循环才以一条看不懂的超时报错。
 * 真正的兜底在 `LlmClient` 构造函数里 —— 那里覆盖所有出站路径，
 * 包括本次改动之前就已经存进库里的旧地址。
 */
const BaseUrlSchema = z
  .string()
  .default('')
  .superRefine((value, ctx) => {
    if (!value) return;
    /*
     * ⚠️ **这里必须也传操作员的内网白名单（2026-10-11）。**
     *
     * 这是**保存模型时的校验**，也就是用户看到「baseUrl 不被允许：私有地址 172.16.0.0/12」
     * 的那一处。只改 `client.ts`/`discovery.ts` 的话，保存这一步照样拒绝 ——
     * 于是"允许内网端点"这个开关**在用户真正会碰到的那道门上不起作用**。
     *
     * 教训：一个开关接了几处、漏了一处，等于没接 —— 因为用户只会撞上漏的那一处。
     */
    const verdict = checkOutboundUrl(value, parseHostAllowlist(env.allowPrivateLlmHosts));
    if (!verdict.allowed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `baseUrl 不被允许：${verdict.reason}` });
    }
  });

const ExchangeAccountInputSchema = z.object({
  exchange: z.enum(['binance']).default('binance'),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  testnet: z.boolean().default(true),
  canTrade: z.boolean().default(true),
});

/**
 * Only the three things a user should have to think about are required.
 *
 * The inference parameters are optional and fall back to the provider's own
 * sensible defaults — a trading bot needs a small, deterministic completion, so
 * there is no reason to make anyone choose a temperature. They remain settable
 * under "advanced" for the cases that genuinely need it.
 *
 * `maxTokens` has a deliberately generous ceiling: reasoning models burn output
 * budget on their thinking before emitting a single character, so a tight cap
 * manifests as an empty completion rather than a clear error.
 */
const AiModelInputSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1).max(80),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  /*
   * ⚠️ **`temperature` / `maxTokens` / `timeoutSeconds` / `maxRetries`
   * 曾经在这里，已删除。**
   *
   * 它们现在**只由 `providerDefaults()` 决定**，不接受客户端传入 ——
   * 控制台上那个「高级设置」面板也已经删掉。
   *
   * 删掉而不是"保留但忽略"，是因为**保留一个不会生效的入参**会让人以为
   * 它有用（比如某个脚本按旧契约传 `maxTokens: 8192`，然后困惑为什么
   * 实际用的是 16384）。**契约要跟行为一致。**
   *
   * 具体风险见 `POST /api/ai-models` 里那段说明：一个被手工调低的
   * `maxTokens` 会把决策截断成空响应，而那看起来像密钥坏了。
   */
});

/**
 * 「获取可用模型」的请求体。
 *
 * `modelId` 存在的理由是一个**功能缺陷**：编辑已有模型时，界面刻意把 API Key 输入框
 * 留空（提示写着"留空则保留已存储的密钥"），而旧契约只有 `apiKey`，服务端拿到空串
 * 就只能回一句"请先填写 API Key" —— 于是**任何一个已保存的模型都获取不到模型列表**，
 * 哪怕界面上方的密钥标签正显示着"当前已存储"。`modelId` 就是"用那条记录里已存的密钥"
 * 这个意图的唯一表达方式。
 *
 * 可选而不是必填：新建模型时还没有 id；`apiKey` 非空时（用户正在输入替换密钥）
 * 也应当优先用用户刚输入的那把。
 */
const DiscoverModelsInputSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().default(''),
  baseUrl: BaseUrlSchema,
  modelId: z.number().int().positive().optional(),
});

/**
 * Schema for probing an unsaved model.
 *
 * Deliberately does **not** require `label`: the probe saves nothing, and making
 * a display name mandatory to answer "does this key work?" is friction with no
 * purpose. Only the fields that actually determine whether the call can succeed
 * are required.
 */
const DraftModelInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const StrategyCheckInputSchema = z.object({
  aiModelId: z.number().int().positive(),
  /** Restrict the universe to one symbol for a fast, focused check. */
  symbol: z.string().max(24).optional(),
});

const StrategyInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  presetId: z.string().nullable().default(null),
  config: StrategyConfigSchema,
});

/**
 * AI 托管模式的标记。
 *
 * 它**不是一个策略预设** —— 保留这个常量是为了让既有数据能被识别：
 * 早期版本把 AI 托管做成过策略预设，于是数据库里留下了 `preset_id='ai_managed'`
 * 的策略行。那行必须从策略列表里排除，否则它会出现在用户选策略的地方。
 *
 * 与 `packages/shared/src/strategy.ts` 的注释一致：AI 托管是**机器人自己的模式**
 * （`traders.mode`），不是策略的一种 —— 策略是"一组固定参数"，
 * 而 AI 模式的意思是"没有固定参数"。
 */
const AI_MANAGED_PRESET = 'ai_managed';

const TraderInputSchema = z.object({
  name: z.string().min(1).max(80),
  /**
   * 绑定的交易所账户。
   *
   * **可以省略 / 传 `null`** —— 那是纯模拟盘机器人（用户 2026-10-27 需求）：
   * 它不下真实订单、余额由本地台账折算，所以不需要任何真实账户。
   *
   * ⚠️ 省略与 `null` 在这里是**同一个意思**（都是"没有账户"），因为创建时
   * 没有"保持原值"这个语义（那是 PATCH 才有的事）。但实盘启动时服务端会
   * 明确拒绝没有账户的机器人 —— 见 `manager.connectionFor`。
   */
  exchangeAccountId: z.number().int().positive().nullable().optional(),
  aiModelId: z.number().int().positive(),
  /**
   * 引用的策略 —— **AI 托管模式不需要它，传 `null`（或省略）**。
   *
   * 参数整份在 `traders.agent_config_json` 里（由 AI 自己写），策略对它不生效。
   * 三种取值都有意义，所以是 `nullable().optional()`：
   *   · 一个正数 → 固定策略模式引用它；
   *   · `null`   → 明确表示"不引用任何策略"（AI 托管）；
   *   · 省略     → `PATCH` 时不改动这个字段。
   *
   * 模式与它是否匹配由下面的端点校验 —— 那一层才知道 `mode`。
   */
  strategyId: z.number().int().positive().nullable().optional(),
  cycleIntervalMinutes: z.number().int().min(1).max(1440).default(15),
  /**
   * Starting equity, used as the baseline for the return percentage.
   *
   * Optional on purpose. When omitted or zero the server reads the **real**
   * wallet balance from the configured exchange, because a hand-typed number can
   * silently disagree with the account and make every return figure wrong.
   */
  initialEquity: z.number().min(0).optional(),
  /**
   * **模拟盘起始余额**（用户 2026-10-27 需求）。
   *
   * 用户原话：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的余额」。
   *
   * 省略 / 0 = 不指定：服务端回落到 `initialEquity`，再回落到 1000。
   * 只有模拟盘会读它；实盘忽略（它读交易所）。
   *
   * ⚠️ 与 `initialEquity` 分开传：后者是"收益率的分母"且会被真实余额覆盖，
   * 而这个是模拟账户的本金、永不被覆盖。混成一个字段会出现"我填了 5000，
   * 启动后变成 12.34"这种没人能解释的现象。
   */
  paperStartingBalance: z.number().min(0).optional(),
  /**
   * 运行模式。
   *
   * `'ai_managed'` 表示由 **AI 智能体托管**：参数由它自己设定并持续调整，
   * 存在 `agent_config_json`（按机器人隔离），**策略参数被忽略**。
   *
   * `'ai_team'` 表示由 **AI 团队托管**（2026-10-12 新增的多智能体模式）：
   * 7×24 事件驱动、多个角色分工协作、辩论与裁决。**与 `ai_managed` 是两套独立的
   * 代码路径** —— 用户明确要求「不要影响我现在实盘跑的机器人」。
   *
   * 两种 AI 模式都**不引用策略**（参数由 AI 自己管），所以下面的校验对它们同等生效。
   *
   * 默认 `'strategy'`，所以既有调用点（前端与脚本）行为完全不变。
   */
  mode: z.enum(['strategy', 'ai_managed', 'ai_team', 'jev']).default('strategy'),
});

/* -------------------------------------------------------------------------- */
/*  Server                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApiDependencies {
  vault: Vault;
  manager: TraderManager;
  jwtSecret: string;
  /** A credential-free connection used for public market data. */
  publicConnection: ExchangeConnection;
  /** Reads and caches exchange account balances for display. */
  balance: BalanceService;
  /**
   * **建一条只读交易所连接** —— 只给测试用，生产不传（不传就等于改动前的行为）。
   *
   * ## 为什么需要它
   *
   * `GET /api/traders/:id/positions` 与 `GET /api/traders/:id/account` 都会
   * 现建一条只读连接去问交易所的真实持仓。而**"交易所读成功、返回的持仓列表为空"**
   * 正是「模拟盘显示 0 持仓」那个 BUG 的形状 —— 没有这个注入口，那条路在测试里
   * **不可达**：真去连交易所要网络、要凭据，而测试两样都不该有。
   *
   * 于是最容易出错的那条分支反而永远测不到（本仓反复出现的"看不出异常的失败"）。
   * 有了它，测试可以注入一个假连接，逐条钉住：
   * **模拟盘 → 本地台账**、**实盘 → 交易所**、**读失败 → 503 不冒充**。
   *
   * ⚠️ **不要把生产逻辑搬到这里**，也不要为了省一次网络调用而传它 ——
   * 它存在的唯一理由是"让不可达的分支可达"。
   */
  openReadOnlyConnection?: () => Promise<ExchangeConnection>;
}

/**
 * 凭据对外暴露的形状。**原始 `apiKey` 绝不外发。**
 *
 * 这里原本在两处各写了一遍 `{ ...account, apiKeyMasked: maskSecret(account.apiKey) }`。
 * 展开运算符把 `account.apiKey` —— **明文密钥** —— 一起带进了响应体；
 * 掩码只是"额外加了一个字段"，并没有替换掉它。于是完整密钥出现在
 * `GET /api/exchange-accounts` 的响应里。
 *
 * 为什么这种 bug 很难被发现：界面只画 `apiKeyMasked`，**肉眼看不出问题**。
 * 但浏览器开发者工具、任何 XSS、任何错误上报或会话回放插件都能直接读到它。
 * 同一个类型上 `hasSecret` 的注释写着 "never the secret"，说明设计意图本就是
 * 不外发 —— 是展开运算符违背了它。
 *
 * 所以用**解构剔除**而不是展开整个对象：新增字段仍然默认外发，
 * 但密钥字段必须先被显式摘掉。改这里时请保持这个方向。
 *
 * 提成模块级导出的纯函数，是为了能直接单测 —— 见 `serialize.test.ts`。
 * 放在 `buildServer` 内部时，想测它就得搭一整套 `ApiDependencies` 桩对象，
 * 于是没人会去测，而这个 bug 就会以同样的方式回来。
 */
export function publicAccount<T extends { apiKey: string }>(account: T) {
  const { apiKey, ...rest } = account;
  return { ...rest, apiKeyMasked: maskSecret(apiKey) };
}

/**
 * 读 `:id` 路由参数，转不成有限数字就抛一个 **400**。
 *
 * 以前 22 条路由各自写 `Number((request.params as { id: string }).id)`，
 * 而 `NaN` 会被 `db/index.ts` 的 `normalise()` 静默绑成 NULL —— 于是
 * `WHERE id = NULL` 查不到行，接口回 **404「找不到该凭据/该机器人」**。
 *
 * 一个拼错的 URL 因此得到"这条记录不存在"的回答：操作员会去找一条
 * 从来没存在过的记录，而真正的病因（路径写错）被完全藏住。
 */
export function idParamOf(params: unknown): number {
  const raw = (params as { id?: unknown }).id;
  /*
   * 空串要先拦掉：`Number('')` 是 **0**，而 0 是有限数 —— 少了这一步，
   * `/api/traders//positions` 这种少了一段路径的 URL 会变成"查 id 0"，
   * 同样是个看不出病因的错误答案。
   */
  const id = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(id)) {
    const error = new Error('请求路径里的 ID 无效。');
    (error as { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/*  Health truth                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 一个机器人多久没走完一轮才算"卡住"——以它的周期为单位的倍数。
 *
 * **2 倍**，理由是把"合法的最慢情况"排除在外：
 *
 *  · `traders.last_cycle_at` 是在**一轮走完之后**才写的
 *    （`store/repositories.ts` 的 `recordCycle()`），所以 1 倍周期时，
 *    每一轮都恰好会在写之前短暂越线 —— 那是必然发生的假警报，不是故障。
 *  · 一轮的墙钟时间 = 周期本身 + 它对模型的调用 + 行情快照。模型的超时上限
 *    就是分钟级的，一个慢周期花掉接近一整个周期的时间是正常的。
 *  · 取 2 倍意味着"连续两轮都没能结束"才报警：单次超时、单次提供商抽风、
 *    单次交易所 503 都不会触发它，而**真正卡死**（事件循环被同步 SQLite 堵住、
 *    网络调用永不返回、循环退出）会在一个有界的时间内必然触发。
 *
 * 为什么不能再大：这个数字同时是运维发现"机器人已经不工作了"的延迟上限。
 * 取 3 倍会让一个 15 分钟的机器人最多沉默 45 分钟才被发现，而它在无保护、
 * 有持仓的情况下沉默的每一分钟都是真金白银的风险。
 */
export const STALE_CYCLE_MULTIPLIER = 2;

/**
 * 启动宽限期：这之后才开始判定"卡住"。
 *
 * 没有它，健康检查会在冷启动时**必然**失败一次：进程起来 → 容器开始探测 →
 * 行情快照 / 合约元数据 / 用户数据流还在加载，第一个周期要几十秒才走完，
 * 而 `last_cycle_at` 这时还是 null。那会让编排器在最不该重启的时候重启容器。
 *
 * 300 秒是一个"足够慢的启动也能走完第一轮"的下限；它也是每个机器人各自计算的
 * 下界（`max(周期 × 2, 300s)`），所以它对周期 1 分钟的机器人同样有效。
 */
export const STARTUP_GRACE_MS = 300_000;

/**
 * **`evaluateTraderHealth` 的可选上下文**（2026-10-17 · t114）。
 *
 * ## 为什么需要它（P0 假警报：`t99` 的横幅今天响了两次，两次都在正常跑）
 *
 * 原来的阈值是 `max(周期 × 2, 300 秒)` = **30 分钟**（`#10` 周期 15 分钟）。
 * 而 `staleForMs` 量的是"**距上一轮结束**"——`last_cycle_at` 是一轮**结束时**
 * 才写的，所以它把"正在进行的那一轮"整个算进去了。
 * 线上实测（只读查库，2026-10-17 16:3x）：
 *
 * ```
 *   #10  468 轮 | 均值 5.2 分钟 | 最长 26.5 分钟
 *   今天节拍：805→806 26.0 分 · 813→814 68.4 分 · 815→816 35.6 分 · 816→817 22.7 分
 * ```
 * ⇒ **一轮从开始到完成经常超过 30 分钟**，于是"正常的长轮次"必然被判成停摆。
 *
 * ## 两个字段各自解决一半
 *
 * | 字段 | 作用 |
 * |---|---|
 * | `stats` | 阈值改成 `max(周期×2, 300 秒, P95(已完成轮次时长) × 2)` —— **跟着真实分布走** |
 * | `pendingAt` | 最新一行是 pending 且**足够新** ⇒ 它明明在跑，**不算停摆** |
 *
 * ⚠️ `pendingAt` 也带年龄上限（由调用方用同一个阈值比）：`finish()` 落库时
 * `ai_latency_ms` 可能**确实是 0**，那种行会永远"看起来 pending"——
 * 一条两小时前的 pending 行必须**继续报警**。
 */
export interface HealthContext {
  /** 某机器人最近轮次时长分布（`api/staleThreshold.ts`）；缺省 = 无样本，退回原判据。 */
  statsByTrader?: ReadonlyMap<number, { samples: number; p95Ms: number | null; maxMs: number | null }>;
  /**
   * 某机器人**最新那一行** `decision_records` 的时间戳（ISO）**当且仅当它是 pending**。
   * 没有 pending 行（或该机器人没有记录）时 absence 即可 —— 不传或 `undefined`。
   */
  pendingAtByTrader?: ReadonlyMap<number, string>;
}

/**
 * **组装 `HealthContext`** —— `/api/health` 与 `manager` 的停摆审计**共用这一个**。
 *
 * ## 为什么抽成一个函数而不是各写一遍
 *
 * 两处必须看到**同一份证据**：控制台的横幅读 `/api/health`，而 `[停摆]` 日志由
 * `manager.auditStaleTraders()` 写 —— 若各自拼一遍，迟早一处算了分布、另一处没算，
 * 于是同一个机器人"在横幅里健康、在日志里停摆"。
 * 这正是 `t99` 里已经付出过一次代价的那类问题（两个真相互相矛盾）。
 *
 * ⚠️ 每一步都**不抛**：这是 `/api/health` 的必经路径，它抛一次就等于把实例判死。
 * 读不到就退回"没有证据"（阈值回到地板），而不是让端点 500。
 */
export function healthContext(now: number = Date.now()): HealthContext {
  const statsByTrader = new Map<number, { samples: number; p95Ms: number | null; maxMs: number | null }>();
  const pendingAtByTrader = new Map<number, string>();
  for (const trader of traders.list()) {
    try {
      statsByTrader.set(trader.id, recentCycleStats(trader.id, now));
    } catch {
      /* 统计读不到 ⇒ 这个机器人退回地板阈值（不会因此不判停摆）。 */
    }
    try {
      const latest = decisions.latestWithPending(trader.id);
      if (latest !== undefined && latest.pending) pendingAtByTrader.set(trader.id, latest.timestamp);
    } catch {
      /* 读不到 pending ⇒ 当作"没有证据"，行为与改动前一致。 */
    }
  }
  return { statsByTrader, pendingAtByTrader };
}

/* -------------------------------------------------------------------------- */
/*  团队岗位出勤：从日志文本里认出"谁干了活"（2026-10-17 · t111）                  */
/* -------------------------------------------------------------------------- */

/**
 * 从一条团队步骤日志里抽出 `{ role, phase, note }`。
 *
 * 形如 `[dispatch] supervisor：派出 4 个分析师并行调研`
 * （由 `manager.ts` 的 `onStep` 写成 `[${phase}] ${role}：${note}`）。
 *
 * 解析不出返回 `null` —— **不猜**。
 *
 * ## ⚠️ 为什么 `role` 段必须限定成 `[a-z][a-z_]*`
 *
 * 角色 id 全是小写下划线（`market_analyst` / `risk_officer`）。
 * 若用 `.+?`，中文也会被吃进去 —— 而 `runtime_logs` 里**另有**一种以 `[` 开头的行：
 * ```
 *   [调研] 新闻未产出：<原因>            ← manager.ts 的猎手日志
 *   [自检/ai] 模型输出未能解析…          ← selfcheckRunner
 * ```
 * 用宽判据会把它们认成"一个叫「新闻未产出」的角色"，然后**点亮编制表上不存在的一行**。
 * 那是凭空造出一次假出勤，比漏报更糟。
 */
export function parseTeamStepLine(
  message: string,
): { phase: string; role: string; note: string } | null {
  const m = /^\[([a-z_]+)\] ([a-z][a-z_]*)[：:]([\s\S]*)$/.exec(message);
  if (m === null) return null;
  /*
   * `note` 去首尾空白：中文冒号写法（`role：note`）本来就没有空格，
   * 而英文冒号写法（`role: note`）会留下一个 —— 那个前导空格到了界面上
   * 会让 `[阶段] 产出` 之间多一个缝。两种写法都该得到同一个形状。
   */
  return { phase: m[1]!, role: m[2]!, note: m[3]!.trim() };
}

/**
 * 从 `cot_trace` 里抽出各角色行的角色名。
 *
 * 形如 `- technical（group/team-grunt）：…`（`agent/deskOutput.ts` 造的格式）。
 *
 * ⚠️ **与前端 `roster.ts` 的 `lastSeenOf` 是同一个正则，但刻意各写一遍**：
 * `@aq/web` 与 `@aq/server` 之间没有依赖方向（谁 import 谁都是错的），
 * 所以没法共用。两边各有一条测试钉住这个格式 —— 改格式时两边都会红。
 */
export function parseCotTraceRoles(trace: string): string[] {
  const roles: string[] = [];
  for (const m of trace.matchAll(/^- ([a-z_]+)（[^）]*）：/gm)) roles.push(m[1]!);
  return roles;
}

/** 一个岗位最近一次被观察到干活的时刻（含来源，便于核对）。 */
export interface RoleLastSeen {
  role: string;
  at: string;
  source: 'log' | 'cot';
}

/**
 * 把两路数据源**合并**成"每个岗位最后一次露面"。
 *
 * ## 为什么要两路（这是 t111 那条用户投诉的根因）
 *
 * ```
 *   cot_trace        → 只有进了 <team> 块的角色：分析师 / bull / bear / judge
 *   runtime_logs     → supervisor / risk_officer / reporter / system_engineer
 * ```
 * 只读前者，那后三个角色在界面上**永远显示"待命"** ——
 * 而线上实测 `supervisor` 在 team 域出现 **31 次**（全系统最多）。
 *
 * ## 合并规则：**取较晚者**，同一时刻偏好 `log`
 *
 * `log` 是服务端直写的出勤证据（精确到步）；`cot` 是渲染进审计块的文本（精确到轮）。
 * 同一时刻时用 `log` 更准确。
 *
 * ⚠️ **不能"log 无条件覆盖 cot"**：`runtime_logs` 表只有 500 行上限，
 * 里面可能混着比 `cot` 更旧的行 —— 无条件覆盖会把"刚刚活跃"改写成"3 天前"，
 * 症状与本次要修的完全一样，只是方向相反。
 *
 * @param logs  `runtime_logs` 里与**这一个机器人**相关的行（调用方负责过滤 traderId/scope）
 * @param cots  `[{ trace, at }]` —— 每条决策记录的 cotTrace 与时刻
 * @param systemEngineerAt 自检行的时刻（自检日志没有角色名，但确实是 `system_engineer` 在干活）。
 *   由调用方从 `scope='selfcheck'` 的行里取最大时刻；`null` = 没有自检记录。
 */
export function mergeRoleLastSeen(
  logs: ReadonlyArray<{ message: string; createdAt: string }>,
  cots: ReadonlyArray<{ trace: string; timestamp: string }>,
  systemEngineerAt: string | null = null,
): RoleLastSeen[] {
  const latest = new Map<string, RoleLastSeen>();
  const bump = (role: string, at: string, source: 'log' | 'cot'): void => {
    const prev = latest.get(role);
    if (prev === undefined || at > prev.at || (at === prev.at && source === 'log')) {
      latest.set(role, { role, at, source });
    }
  };

  for (const line of logs) {
    const step = parseTeamStepLine(line.message);
    if (step !== null) bump(step.role, line.createdAt, 'log');
  }
  if (systemEngineerAt !== null) bump('system_engineer', systemEngineerAt, 'log');

  for (const c of cots) {
    for (const role of parseCotTraceRoles(c.trace)) bump(role, c.timestamp, 'cot');
  }

  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface TraderHealth {
  traderId: number;
  name: string;
  status: TraderStatus;
  /** 距离上一轮结束的毫秒数；从未跑完过一轮时为 null。 */
  staleForMs: number | null;
  /** 该机器人被判定为卡住。只有 status === 'running' 才可能为 true。 */
  stale: boolean;
  /** 已在运行但还没有任何一轮的完成记录（首轮仍在跑）。 */
  awaitingFirstCycle: boolean;
  /**
   * **"一轮正在进行中"**（2026-10-17 · t114）—— 存在一条**足够新的 pending 行**。
   *
   * `true` 时 `stale` 必然为 `false`：卡住的另一面是"明明在跑"，而
   * 旧判据分不出这两者（`last_cycle_at` 只在一轮**结束时**写）。
   * 详见 `HealthContext` 与 `evaluateTraderHealth` 里那一段。
   */
  cycleInProgress?: boolean;
  /**
   * 这个机器人**这一次**用的停摆阈值（毫秒）—— 让操作员能自己核对
   * "为什么它没被判红"，而不必去读源码。分布驱动之后这个数**因机器人而异**。
   */
  thresholdMs?: number;
}

export interface HealthVerdict {
  /** 所有**正在运行**的机器人都还有心跳。注意它与 HTTP 状态码是同一件事。 */
  ok: boolean;
  /** 只有"运行中且已卡住"的机器人。 */
  stale: TraderHealth[];
  /** 所有机器人（含已停止的），便于控制台一眼看到全貌。 */
  traders: TraderHealth[];
}

/**
 * 从 `traders.last_cycle_at` 推导每个机器人的决策新鲜度。
 *
 * 这个函数存在的理由只有一个：**让健康检查说真话**。
 * 原来 `/api/health` 无条件返回 `ok: true`，而 `deploy/docker-compose.yml` 与
 * `Dockerfile` 的 HEALTHCHECK 都以它为准 —— 于是一个决策循环已经挂死、
 * 或者事件循环被同步 SQLite 阻塞的进程，在编排器看来永远"健康"。
 * 没人会收到告警，容器也不会重启，而账户可能还挂着仓位。
 *
 * 三条必须守住的边界（否则这就是一个比原来更糟的检查）：
 *
 *  1. **只有 `running` 参与判定。** `safe_mode` / `error` 仍在跑循环，但它们的
 *     失败是**已经**通过状态和 `last_error` 上报过的；`stopped` 则根本不跑。
 *     把它们算成"不健康"会让一个被刻意停在原地的机器人在编排器眼里永远是坏的。
 *  2. **`starting` 不参与。** AutoTrader 先写 `starting` 再跑首轮，把它算进去
 *     等于在启动瞬间就判定失败。
 *  3. **阈值有下界（启动宽限），且基于该机器人自己的周期。** 见上面两个常量。
 *
 * 纯函数：只依赖传入的列表和 `now`，所以可以直接单测边界（见 `health.test.ts`）。
 */
export function evaluateTraderHealth(
  traderRows: readonly Pick<
    Trader,
    'id' | 'name' | 'status' | 'lastCycleAt' | 'cycleIntervalMinutes'
  >[],
  now: number,
  /**
   * 每个**正在运行**的机器人是什么时候被启动的。
   *
   * 为什么需要它而不是用进程启动时间：宽限期必须按每个机器人自己的年龄算。
   * 用一个全局的"进程已运行多久"会让运行两小时后才启动的机器人在第一轮
   * 卡死时被宽限整整 2 小时；反过来，如果按"第一次看到 null 的时间"算，
   * 一个永远跑不完第一轮的机器人每次探测都重新获得宽限，**永远不会**被判为
   * 卡住 —— 那正是这个检查要抓的情形。
   *
   * 缺省为空时退化为"用进程启动时间"，只是为了让纯函数好测。
   */
  startedAtByTrader: ReadonlyMap<number, number> = new Map(),
  /**
   * **可选上下文**（2026-10-17 · t114）：分布阈值 + "正在跑"的证据。
   *
   * 不传 = 行为与改动前**逐字节一致**（阈值仍是 `max(周期 × 2, 300 秒)`）——
   * 这让老调用方（测试桩、第三方嵌入）不受影响，也让"放宽"只发生在
   * **真的读到了证据**的地方。见 `HealthContext` 的说明。
   */
  context: HealthContext = {},
): HealthVerdict {
  const traders: TraderHealth[] = traderRows.map((trader) => {
    /*
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │ ⚠️ 阈值：三层取最大（2026-10-17 · t114）                            │
     * ├─────────────────────────────────────────────────────────────────────┤
     * │  周期 × 2      —— 原判据，仍是地板                                  │
     * │  300 秒        —— 起步宽限，仍是地板                                │
     * │  P95 × 2       —— **新增**：跟着该机器人真实分布走（读出样本才有）   │
     * └─────────────────────────────────────────────────────────────────────┘
     * 放宽**只发生在确有长轮次证据的机器人上**：没有样本时退回原来那 30 分钟。
     */
    const thresholdMs = staleThresholdMs({
      cycleIntervalMinutes: trader.cycleIntervalMinutes,
      stats: context.statsByTrader?.get(trader.id) ?? { samples: 0, p95Ms: null, maxMs: null },
      multiplier: STALE_CYCLE_MULTIPLIER,
      floorMs: STARTUP_GRACE_MS,
    });
    const lastCycleMs = trader.lastCycleAt ? new Date(trader.lastCycleAt).getTime() : null;
    const valid = lastCycleMs !== null && Number.isFinite(lastCycleMs);

    // Only a `running` trader is judged. See the boundary list above.
    if (trader.status !== 'running') {
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: valid ? now - (lastCycleMs as number) : null,
        stale: false,
        awaitingFirstCycle: false,
        /* 不参与判定的分支也如实报出阈值（控制台用来说明"为什么没判它"）。 */
        thresholdMs,
      };
    }

    /*
     * ⚠️ **`running` 还不够 —— 必须当前进程真的持有它的实例**（外部 issue #119）。
     *
     * `traders.status` 是**持久化状态**，它说的是"这个机器人被标记为运行中"，
     * **不保证**当前进程里真有一个 `AutoTrader` 在转。两类假阳性都由此而来：
     *
     *   1. **演示数据**：`seed:demo` 把 62% 的示例机器人标成 `running`，
     *      而种子脚本**只写库、不起运行时** —— 约 12 分钟后 `/api/health`
     *      从 `ok: true` 翻成 `ok: false` 并**永久保持红色**
     *      （实测另一台实例上 6 个示例机器人的 `staleForMs ≈ 6.8 小时`）。
     *      于是 Docker / compose 的 HEALTHCHECK 判 unhealthy、配上 `restart`
     *      会**反复重启**，而重启修不好它（数据还在库里，12 分钟后再红一次）。
     *   2. **库里残留 `running` 但进程没起**：`GLOBAL_TRADING_DISABLED=true`
     *      或启动失败时的中间窗口同样如此。
     *
     * ## 为什么这个假阳性比没有检查更糟
     *
     * 这个端点的立意是「决策循环挂死时容器必须告警」（本函数头部的边界清单，
     * 还记着 8.5 小时的静默停摆事故）。一个**长期亮着**的假阳性会让运维
     * 对它的告警脱敏 —— **真挂死那次反而没人看**。
     *
     * ## 判据：`startedAtByTrader` 里有它
     *
     * 那张表来自 `manager.runningSince()`，即**当前进程真正持有的实例**。
     * 上游没提供它时（测试桩、第三方嵌入方）退化为"不判定" ——
     * 而不是"把库里所有 `running` 都当成卡住"：后者会在缺能力时误报，
     * 而"误报的检查比没有检查更糟"（同样见头部注释）。
     */
    if (!startedAtByTrader.has(trader.id)) {
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        /*
         * 仍然如实报出"库里记的最近一轮是什么时候" —— 控制台要能看到它，
         * 只是**不拿它判红**。
         */
        staleForMs: valid ? now - (lastCycleMs as number) : null,
        stale: false,
        awaitingFirstCycle: false,
        thresholdMs,
      };
    }

    if (!valid) {
      /*
       * Running but no completed cycle is tolerated only for the startup grace
       * period, measured from *this trader's* start. `start()` kicks the first
       * cycle off immediately, so either it finished and wrote the timestamp, or
       * it is wedged.
       *
       * `startedAt` 在这里**必然存在** —— 上面那道守卫已经确认
       * `startedAtByTrader.has(trader.id)`（这是 issue #119 的修复）。
       * 所以不再有 `undefined` 的分支：那曾经让一个"没有实例的 running"
       * 被当成"宽限期内"，从而把演示数据判红。
       */
      const startedAt = startedAtByTrader.get(trader.id)!;
      const runningForMs = now - startedAt;
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: runningForMs,
        stale: runningForMs !== null && runningForMs > thresholdMs,
        awaitingFirstCycle: true,
        thresholdMs,
      };
    }

    const staleForMs = now - (lastCycleMs as number);
    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⭐ **"正在进行的一轮"要能被看见**（2026-10-17 · t114）
     * ══════════════════════════════════════════════════════════════════════
     *
     * `staleForMs` 量的是"距上一轮**结束**"，而一轮正在跑时 `last_cycle_at`
     * 还停在上一次 —— 于是**正在跑**与**卡死**在旧判据下长得一模一样。
     * 唯一的区分线索是 `decision_records` 里那条 **pending 行**
     *（`begin()` 写的 `ai_latency_ms = 0 && error IS NULL && decisions_json` 空）。
     *
     * ## ⚠️ 必须带年龄上限（这一步是"不放过真停摆"的关键）
     *
     * pending 判据在 `finish()` 落库时 `ai_latency_ms` 可能**确实是 0**
     *（模型几乎瞬回）—— 那种行会**永远**"看起来 pending"。
     * 若只看"有没有 pending"，一个真死掉的机器人会**永不报警**。
     *
     * 所以只认**年龄 < 阈值**的 pending：它开始于阈值之内 ⇒ 这一轮确实在进行中；
     * 一条 2 小时前的 pending 行说明进程在那一轮里就没了 ⇒ **照常判红**。
     */
    const pendingAt = context.pendingAtByTrader?.get(trader.id);
    const pendingMs = pendingAt === undefined ? null : new Date(pendingAt).getTime();
    const cycleInProgress =
      pendingMs !== null && Number.isFinite(pendingMs) && now - pendingMs < thresholdMs;

    return {
      traderId: trader.id,
      name: trader.name,
      status: trader.status,
      staleForMs,
      stale: !cycleInProgress && staleForMs > thresholdMs,
      awaitingFirstCycle: false,
      /*
       * 让控制台能说清"它是在跑还是卡住了" —— 这正是本批反复出现的
       * 「信号在没人看的地方」的反面：**同一个判据，把区分依据一起报出去**。
       */
      cycleInProgress,
      thresholdMs,
    };
  });

  const stale = traders.filter((t) => t.stale);
  return { ok: stale.length === 0, stale, traders };
}

/**
 * 给团队模式取一个**真实存在**的 `aiModelId` 当占位。
 *
 * ## 为什么需要它（本地实测踩到的坑）
 *
 * `traders.ai_model_id` 是 `NOT NULL` + 外键，而团队模式**不使用**这个字段
 *（它的模型出口是独立的 magpie 网关配置，见 `teamGateway.ts`）。
 * 所以需要写一个"满足外键、但没人读"的值。
 *
 * 第一版硬编码成 `1`，假设"建表时必然有 id=1 的模型"。**那个假设不成立**：
 * 本地库里模型 id 是 `4/5/8/9`（没有 1），于是建团队机器人直接
 * `FOREIGN KEY constraint failed` —— 而那个错误完全指不到真正的原因
 *（看起来像"外键配置错了"，实际是"占位值选错了"）。
 *
 * ## 行为
 *
 * · 有模型 → 返回**第一条的 id**（团队模式不读它，取哪条都一样）；
 * · 一条都没有 → 抛**说人话**的错误，而不是让外键去报。
 */
function requireAnyModelIdForTeam(): number {
  const first = aiModels.list()[0];
  if (!first) {
    throw new Error(
      'AI 团队模式需要数据库里至少存在一条「AI 模型」记录（团队模式本身不使用它，' +
        '但机器人表的这一列是必填的）。请先到「AI 模型」页添加任意一条。',
    );
  }
  return first.id;
}

export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // The console is served from the same origin in production, and Vite proxies
    // /api during development.
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  /**
   * Tolerate body-less and oddly-typed POSTs.
   *
   * Several endpoints (`/start`, `/stop`, `/run-once`, `/test`) are POSTs with
   * an optional body. Browsers omit `Content-Type` entirely when there is no
   * body, while curl and PowerShell tend to send
   * `application/x-www-form-urlencoded`; Fastify's default behaviour is to
   * reject the latter with a 415 before the route ever runs. Normalising here
   * keeps those routes callable from anything.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('请求体不是合法的 JSON');
      (error as { statusCode?: number }).statusCode = 400;
      done(error, undefined);
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Error handling                                                         */
  /* ---------------------------------------------------------------------- */

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) log.error(`unhandled API error: ${error.message}`, error);
    void reply.code(status).send({ error: error.message });
  });

  /** `:id` 路由参数的读取入口（解析与拒绝逻辑见 `idParamOf`）。 */
  const idOf = (request: AuthedRequest): number => idParamOf(request.params);

  /** Wrap a handler so thrown errors become clean 400s with a message. */
  const guard =
    <T>(handler: (input: T, request: AuthedRequest, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (request: AuthedRequest, reply: FastifyReply) => {
      try {
        return await handler(request.body as T, request, reply);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: (error as Error).message });
      }
    };

  /* ---------------------------------------------------------------------- */
  /*  Health + auth (unauthenticated)                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * 存活探测。
   *
   * 这个端点是**未认证**的（容器 healthcheck 必须能打它），所以它不能回显
   * 文件系统布局：此前直接返回 `dbPath`（如 `/srv/<应用目录>/data/autoquant.sqlite`），
   * 未认证的调用方由此得知操作系统、部署根目录、以及数据目录名 ——
   * 那是给后续攻击挑目标的信息，而这个端点本来就只是回答"我还活着吗"。
   *
   * 只保留文件名而不是删掉整个字段：控制台「操作员账户」页把它当作
   * 「连的是哪个库」的提示在显示（`packages/web/.../AccountSection.tsx`）。
   * 文件名足以区分实例，且不泄漏任何路径。
   */
  /*
   * Health now tells the truth, and it still answers only one question: "is this
   * process still doing its job?"
   *
   * Why it had to change: the Dockerfile and `deploy/docker-compose.yml`
   * HEALTHCHECKs both use this endpoint as their **only** signal, and it used to
   * return `ok: true` unconditionally. A trading process whose decision loop had
   * hung — or whose event loop was blocked on synchronous SQLite work — looked
   * permanently healthy to the orchestrator: no alert, no restart, while the
   * account may still be carrying open positions.
   *
   * Why a non-200 is safe here: every existing caller already checks only
   * `r.ok` (the HEALTHCHECK `fetch`) or just prints the body (`up.sh`), so the
   * 200/503 distinction breaks nothing while giving the orchestrator a way to
   * restart a wedged instance. Stopped and paused traders **never** affect the
   * status code — that would make a deliberately stopped bot permanently "bad".
   */
  app.get('/api/health', async (_request, reply) => {
    /*
     * `runningSince()` is optional at the call site on purpose.
     *
     * This is the one route whose failure takes the whole instance down in an
     * orchestrator's eyes, and it runs before anything else the process does. An
     * `ApiDependencies.manager` that predates this method — a test stub, or any
     * embedder supplying its own manager — would otherwise turn a *successful*
     * probe into a 500, which is the same "the healthcheck lies" failure this
     * endpoint was just fixed to stop producing, pointing the other way.
     *
     * Missing the map degrades instead of throwing: a running trader with no
     * completed cycle is then not judged, rather than judged wrongly.
     */
    const runningSince =
      typeof deps.manager.runningSince === 'function'
        ? deps.manager.runningSince()
        : new Map<number, number>();
    const health = evaluateTraderHealth(traders.list(), Date.now(), runningSince, healthContext());
    const body = {
      ok: health.ok,
      /*
       * 产品版本号，取自 `package.json`。
       *
       * 原来这里是**硬编码的 `'0.1.0'`** —— 一个从写下那天起就没变过、也永远不会
       * 变的字符串。它看起来像状态，其实什么都没说：控制台「操作员账户」页那个
       * 「服务端版本」格子因此长期在骗人。
       *
       * 这个端点**无需认证**，所以它只回产品版本号，**不回 commit**：
       * 精确到提交的版本足以让攻击者去查该提交的已知缺陷，而这属于认证后才该给的
       * 信息（见 `/api/system` 的 `build` 与 `/api/system/update`）。
       */
      version: readAppVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      hasOwner: users.count() > 0,
      dryRun: env.dryRun,
      tradingDisabled: env.globalTradingDisabled,
      environment: deps.publicConnection.environment,
      /*
       * 只回**文件名**，绝不回 `dbPath`。
       *
       * 这个端点**无需认证**（容器 healthcheck 必须能打它），所以它不能公布
       * 文件系统布局：绝对路径会同时泄漏操作系统、部署根目录与数据目录名 ——
       * 那是给后续攻击挑目标的信息，而这个端点本来就只是回答"我还活着吗"。
       * 保留字段本身是因为控制台「操作员账户」页把它当作"连的是哪个库"的提示。
       */
      db: basename(dbPath),
      /*
       * Decision freshness. Only running-and-stale traders appear here; each one
       * carries how long it has been silent so an operator does not have to read
       * the source to know what "too long" means
       * (threshold = max(cycleIntervalMinutes × 2, 300s)).
       */
      staleTraders: health.stale.map((entry) => ({
        id: entry.traderId,
        name: entry.name,
        staleForMs: entry.staleForMs,
        awaitingFirstCycle: entry.awaitingFirstCycle,
        /*
         * ⚠️ **`t114` 之后必须把它带出去**：阈值是分布驱动的，**因机器人而异**
         *（`max(周期×2, 300 秒, P95×2)`）。不带出去，控制台只能干看着一个
         * "已 45 分钟没跑完"，却不知道**这一台**的阈值是多少。
         *
         * 实测缺口：加完 `thresholdMs` 之后忘了在这里放行，横幅那一行就只能显示
         * `（阈值 NaN 分钟）` —— 而类型检查**抓不到**（它是可选字段）。
         * 所以 `staleRegression.test.ts` 有一条源码守卫盯着这个映射。
         */
        thresholdMs: entry.thresholdMs,
      })),
      runningTraders: health.traders.filter((entry) => entry.status === 'running').length,
    };
    if (!health.ok) {
      return reply.code(503).send({
        ...body,
        reason: `有 ${health.stale.length} 个正在运行的机器人已超过各自周期的 2 倍仍未完成一轮决策。`,
      });
    }
    return body;
  });

  /**
   * Registration is open only while the instance has no accounts: the first one
   * becomes the owner. After that, new accounts must be created by an owner.
   */
  /*
   * 注册接口已移除。
   *
   * 这个系统目前面向**单人自用**部署：首次启动自动生成管理员账号并打印一次，
   * 登录后可在「操作员账户」里自行修改用户名与密码。
   *
   * 保留一个「首个账户可自助注册」的入口意味着：任何能访问到控制台的人在
   * 数据库为空时都能把自己变成管理员 —— 而这个窗口在部署脚本还没跑完、
   * 或数据卷被误删重建时会真实出现。对单人部署来说，这个风险没有任何对应的收益。
   *
   * 这里返回明确的 410 而不是 404：如果将来有人照着旧文档去调它，
   * 应该看到「已移除、改用首次启动自动创建」这条信息，而不是一个语焉不详的 404。
   */
  /* ---------------------------------------------------------------------- */
  /*  Login throttling                                                       */
  /* ---------------------------------------------------------------------- */

  /*
   * 两个维度各一把节流器，见 `loginThrottle.ts` 里对阈值取舍的说明。
   * 计数器只在内存里，进程重启即清零：这是单人自用部署下的刻意取舍
   * （见该模块顶部注释），换来的是不引入 Redis 这类新依赖。
   */
  const usernameThrottle = new FailureThrottle(USERNAME_THROTTLE_OPTIONS);
  const ipThrottle = new FailureThrottle(IP_THROTTLE_OPTIONS);

  /*
   * 修改凭据的「当前密码」校验也要节流，但用**独立**的实例。
   *
   * 需要它：这个端点要求已登录，但"已登录"不等于"知道密码" ——
   * 令牌泄漏之后，攻击者可以拿它当在线口令预言机（每次校验同样跑 scrypt）。
   * 独立实例的理由：在这里连错几次不该把**登录**路径锁掉（反之亦然），
   * 否则一个错误的猜测就能把操作员挡在自己的控制台外面。
   */
  const accountThrottle = new FailureThrottle(USERNAME_THROTTLE_OPTIONS);
  const accountIpThrottle = new FailureThrottle(IP_THROTTLE_OPTIONS);

  /**
   * 一次登录尝试要计入的「来源」键。
   *
   * 除了 `request.ip`（`trustProxy: true` 下取自 `X-Forwarded-For`，**可被伪造**），
   * 还额外计入 TCP 层的对端地址：直连场景下攻击者能随意编造 XFF 来轮换 IP 键，
   * 但换不掉自己的出口地址。两者相同时只记一个键，避免把正常流量算两遍。
   */
  const ipThrottleKeys = (request: FastifyRequest): string[] => {
    const keys = [`ip:${request.ip}`];
    const socketAddress = request.socket.remoteAddress;
    if (socketAddress && socketAddress !== request.ip) keys.push(`sock:${socketAddress}`);
    return keys;
  };

  app.post('/api/auth/register', async (_request, reply) =>
    reply.code(410).send({
      error:
        '注册已停用。本系统面向单人部署：管理员账号在首次启动时自动创建，' +
        '凭据会打印在服务日志中；登录后可在「操作员账户」中修改用户名与密码。',
    }),
  );

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写用户名与密码。' });

    const username = parsed.data.username;
    const password = parsed.data.password;
    const usernameKeys = [`user:${username.toLowerCase()}`];
    const ipKeys = ipThrottleKeys(request);

    // 先判节流、后验口令：scrypt 是刻意做得昂贵的（约几十毫秒），
    // 一个不限次数的登录端点本身就是一条 CPU 耗尽路径 ——
    // 节流器在这里既防爆破，也让每个被拒的请求几乎不花 CPU。
    const userVerdict = usernameThrottle.check(usernameKeys);
    const ipVerdict = ipThrottle.check(ipKeys);
    if (!userVerdict.allowed || !ipVerdict.allowed) {
      const retryAfterSeconds = Math.max(userVerdict.retryAfterSeconds, ipVerdict.retryAfterSeconds);
      return reply
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: `登录尝试过于频繁，请在 ${retryAfterSeconds} 秒后重试。` });
    }

    const record = users.findByUsername(username);
    let passwordOk = false;
    if (record) {
      passwordOk = verifyPassword(password, record.passwordHash);
    } else {
      // 用户名不存在时**也必须**跑一遍 scrypt。
      //
      // 这里原先是 `if (!record || !verifyPassword(...))`，`||` 短路意味着
      // 未知用户名的 401 根本不派生密钥，比"密码错"快几十毫秒。
      // 那条时间差就是一个可靠的**用户名枚举预言机**：
      // 先花几毫秒问出哪些用户名存在，再对存在的那个慢慢爆破密码 ——
      // 于是 generateUsername() 随机后缀换来的优势被完全抵消。
      verifyPassword(password, DUMMY_PASSWORD_HASH);
    }

    if (!record || !passwordOk) {
      usernameThrottle.recordFailure(usernameKeys);
      ipThrottle.recordFailure(ipKeys);
      return reply.code(401).send({ error: '用户名或密码不正确。' });
    }

    usernameThrottle.recordSuccess(usernameKeys);
    ipThrottle.recordSuccess(ipKeys);

    const token = signToken(
      {
        sub: record.id,
        username: record.username,
        role: record.role,
        credAt: users.credentialsChangedAt(record.id) ?? 0,
      },
      deps.jwtSecret,
    );
    return {
      token,
      user: { id: record.id, username: record.username, role: record.role, createdAt: record.createdAt },
    };
  });

  /* ---------------------------------------------------------------------- */
  /*  Everything below requires a session                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 令牌签名有效 ≠ 仍然有效。
   *
   * 账户改过凭据之后，此前签发的所有令牌都必须立刻作废 —— 否则"改密码"
   * 在最需要它的时候（令牌泄漏、设备丢失）救不了任何东西。
   * 判定逻辑本身是 `auth.ts` 里的纯函数，这里只负责把数据库里的当前值喂给它。
   */
  const tokenRevoked = (payload: TokenPayload): boolean =>
    isTokenRevoked(payload, users.credentialsChangedAt(payload.sub));

  const authed = { preHandler: requireAuth(deps.jwtSecret, tokenRevoked) };

  app.get('/api/auth/me', authed, async (request: AuthedRequest) => ({
    user: request.user,
  }));

  /*
   * 修改账户凭据：用户名与密码。
   *
   * 两者放在同一个端点，因为它们共享同一条安全前提：**必须验证当前密码**。
   * 只靠会话令牌就允许改密码，意味着任何一次令牌泄露（浏览器残留、日志、
   * 代理）都能被升级成永久接管 —— 攻击者改掉密码，真正的所有者就进不来了。
   *
   * 改完用户名要**重新签发令牌**：JWT 的载荷里带着用户名，
   * 不重签的话前端拿的还是旧身份，下次校验就会对不上。
   */
  const updateAccount = async (request: AuthedRequest, reply: FastifyReply) => {
    // 校验请求体再动任何东西：`currentPassword` 不是字符串时会一路走进
    // `scryptSync` 并抛出 TypeError，变成一条 500 —— 看起来像服务端坏了。
    const parsed = UpdateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '请求内容无效。' });
    }
    const body = parsed.data;

    const record = users.findById(request.user!.sub);
    if (!record) return reply.code(404).send({ error: '找不到该账户。' });

    // 节流的键用**库里的**用户名，不用请求体里的：请求体根本没有用户名字段，
    // 而这个端点一次只能改自己的凭据。
    const accountKeys = [`acct:${record.username.toLowerCase()}`];
    const accountIpKeys = ipThrottleKeys(request);
    const accountVerdict = accountThrottle.check(accountKeys);
    const accountIpVerdict = accountIpThrottle.check(accountIpKeys);
    if (!accountVerdict.allowed || !accountIpVerdict.allowed) {
      const retryAfterSeconds = Math.max(
        accountVerdict.retryAfterSeconds,
        accountIpVerdict.retryAfterSeconds,
      );
      return reply
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: `当前密码尝试过于频繁，请在 ${retryAfterSeconds} 秒后重试。` });
    }

    const full = users.findByUsername(record.username);
    if (!full || !verifyPassword(body.currentPassword, full.passwordHash)) {
      accountThrottle.recordFailure(accountKeys);
      accountIpThrottle.recordFailure(accountIpKeys);
      /*
       * ⚠️ **必须带机器可读码**（外部 issue #148）。
       *
       * 401 在这里的意思是"**本次请求的口令填错了**"，与 `auth.ts` 里那三个
       * 401（需要登录 / 令牌过期 / 凭据变更 = "**会话结束了**"）是**完全不同的事**。
       *
       * 而前端原来只按状态码判断 → 见到 401 就清 token 跳登录页 →
       * **在设置页把当前密码输错一次就被登出**。
       *
       * 加这个码之后前端能区分两者（判据见 `packages/web/src/lib/api.ts`
       * 的 `shouldSignOut()`）。**不要改状态码**：401 对外语义是对的
       * （确实未通过认证），改成 400 会把"认证失败"与"参数错误"混在一起。
       */
      return reply
        .code(401)
        .send({ error: '当前密码不正确。', code: 'invalid_current_password' });
    }
    accountThrottle.recordSuccess(accountKeys);
    accountIpThrottle.recordSuccess(accountIpKeys);

    const nextUsername = typeof body.username === 'string' ? body.username.trim() : undefined;
    const nextPassword = typeof body.newPassword === 'string' ? body.newPassword : undefined;

    if (nextUsername === undefined && nextPassword === undefined) {
      return reply.code(400).send({ error: '没有需要修改的内容。' });
    }

    if (nextPassword !== undefined && nextPassword.length < 8) {
      return reply.code(400).send({ error: '新密码至少需要 8 位字符。' });
    }

    if (nextUsername !== undefined) {
      if (nextUsername.length < 3 || nextUsername.length > 64) {
        return reply.code(400).send({ error: '用户名需要 3 到 64 个字符。' });
      }
      if (nextUsername !== record.username && users.findByUsername(nextUsername)) {
        return reply.code(409).send({ error: '该用户名已被占用。' });
      }
      users.updateUsername(record.id, nextUsername);
    }

    if (nextPassword !== undefined) {
      users.updatePassword(record.id, hashPassword(nextPassword));
    }

    /*
     * 凭据变更加盖时间戳，作废该账户此前签发的**所有**会话。
     *
     * 用户名也算凭据：令牌载荷里带着用户名，改完名字之后另一个浏览器里的旧会话
     * 仍然以旧身份通过校验。一次"改名"或"改密码"应当等价于"把其他设备登出"。
     *
     * 顺序很关键：必须**先**盖时间戳、**后**签发新令牌，
     * 否则新令牌带着变更前的时间戳，一签发就会被自己的撤销检查拒掉。
     */
    const credentialsChangedAt =
      nextUsername !== undefined || nextPassword !== undefined
        ? users.markCredentialsChanged(record.id)
        : (users.credentialsChangedAt(record.id) ?? 0);

    const updated = users.findById(record.id)!;
    // 用户名可能变了，重新签发令牌，否则前端拿的还是旧身份
    const token = signToken(
      {
        sub: updated.id,
        username: updated.username,
        role: updated.role,
        credAt: credentialsChangedAt,
      },
      deps.jwtSecret,
    );
    return { ok: true, token, user: updated };
  };

  app.patch('/api/auth/account', authed, updateAccount);

  /*
   * 旧端点保留为别名。
   *
   * 控制台是单页应用，浏览器可能缓存着上一版的 JS：如果直接删掉这个路由，
   * 那些页面上的「修改密码」会得到一个 404，而用户完全无从判断原因。
   * 保留成本是两行，收益是消除一类难以解释的失败。
   */
  app.post('/api/auth/password', authed, updateAccount);

  /* --- Static catalogues ------------------------------------------------- */

  app.get('/api/catalog', authed, async () => ({
    providers: LLM_PROVIDERS,
    exchanges: EXCHANGES,
    presets: STRATEGY_PRESETS,
    defaultStrategy: defaultStrategyConfig(),
    /*
     * 创建机器人时预选哪个模型。
     *
     * 原来是"列表第一个"，而列表按 id 排 —— 于是一个**余额不足或已失效**的模型
     * 只要 id 最小，就会成为每个新机器人的默认，每次创建都要手动改回来。
     * 这里让操作员能指定，取不到就回落到第一个（与以前的行为一致）。
     */
    defaultAiModelId: (() => {
      const saved = Number(settings.get('default_ai_model_id') ?? '');
      if (Number.isFinite(saved) && saved > 0 && aiModels.get(saved)) return saved;
      return aiModels.list()[0]?.id ?? null;
    })(),
  }));

  /* --- System status ----------------------------------------------------- */

  app.get('/api/system', authed, async () => ({
    dryRun: env.dryRun,
    tradingDisabled: env.globalTradingDisabled,
    environment: deps.publicConnection.environment,
    environmentLabel: deps.publicConnection.endpoints.label,
    clockOffsetMs: deps.publicConnection.clockOffsetMs,
    weightUsed: deps.publicConnection.rest.usedWeight1m,
    weightLimit: deps.publicConnection.rest.weightLimitPerMinute,
    /**
     * 并发请求占用。
     *
     * 权重预算曾经只能靠"上一份响应里的 header"约束，而每一批 `Promise.all`
     * 都在读完那个已经过期的值之后同时放行 —— 40 个请求一起出去，75% 的软上限
     * 等于不存在。现在每个请求在发出前先占一个槽位，这个字段让"当前有几个请求
     * 同时在路上"变得可见，而不是只能靠推测。
     */
    requestsInFlight: deps.publicConnection.rest.inFlightCount,
    maxRequestsInFlight: deps.publicConnection.rest.maxInFlightPerRequest,
    tradableSymbols: deps.publicConnection.registry.size,
    runningTraders: deps.manager.runningIds(),
    /**
     * 自动恢复已经放弃的机器人（`status = 'error'` 且没在运行）。
     *
     * 见 `TraderManager.resumePersisted()`：一次瞬时的启动失败以前会把机器人
     * 永久钉在 error 上，而**没有任何地方**会再提起它。现在它会被自动重试，
     * 放弃时也会留在这里 —— 这个列表就是为了让"放弃"这件事不可能被忽略。
     */
    failedTraders: deps.manager.failedTraders(),
    /**
     * 部署版本 —— "线上跑的是哪一版"。
     *
     * 服务器上没有 `.git`（部署是打包上传），所以这份信息来自构建机随包写下的
     * `build-info.json`。**没有它时是 `null`**，而不是一个看起来正常的默认值：
     * "我不知道我跑的是哪一版"必须显示成未知。
     */
    build: readBuildInfo(),
    /** 产品版本号（`package.json`）。与上面那个是两件事，分开给。 */
    version: readAppVersion(),
  }));

  /**
   * 与远端仓库比对部署版本 —— 回答"线上是不是最新的"。
   *
   * ## 为什么单独一个端点，而不是塞进 `/api/system`
   *
   * 这一次要**出网**（GitHub API，8 秒超时）。塞进 `/api/system` 会让整页的加载
   * 被一个诊断性的可选项拖住，而 `/api/system` 是控制台每次轮询都会打的端点。
   * 单独一个端点也让它能被独立缓存与独立失败：取不到版本比对，不该影响"我现在
   * 跑在什么环境里"那一整块。
   *
   * 结果在 `checkForUpdates()` 内部缓存（成功 10 分钟、失败 1 分钟），
   * 所以反复打开这一页不会反复打 GitHub。
   */
  app.get('/api/system/update', authed, async () => checkForUpdates());

  app.get('/api/logs', authed, async (request) => {
    /*
     * ⚠️ **这里只做"字符串 → 数字"，钳制交给仓储层**（`runtimeLogs.list()`）。
     *
     * 原来这里写的是 `Number.isFinite(limit) ? limit : 200`，而 `1e21` **是有限数** ——
     * 它直达 SQL 的 `LIMIT ?` 后 `node:sqlite` 抛 `datatype mismatch`，
     * 整个端点变成 500（实测触发条件是 ≥1e21 或非整数）。
     * 与 `orders` 的处理保持一致：上限的钳制集中在一处，每个路由不必各写一遍。
     */
    const limit = Number((request.query as { limit?: string }).limit ?? RUNTIME_LOG_PAGE_DEFAULT);
    return { logs: runtimeLogs.list(limit) };
  });

  /* --- Exchange accounts ------------------------------------------------- */

  app.get('/api/exchange-accounts', authed, async () => {
    // Balances are read from the cache here so that a polling console stays
    // cheap; the dedicated endpoint below forces a fresh read on demand.
    const balances = await deps.balance.getAll();

    return exchanges.list().map((account) => {
      const result = balances.get(account.id);
      return {
        ...publicAccount(account),
        balance: result?.ok ? result.balance : null,
        balanceError: result && !result.ok ? result.error : null,
      };
    });
  });

  /**
   * Live balance for one credential.
   *
   * `?refresh=1` bypasses the cache — an operator pressing refresh is asking for
   * "now", and serving them a stale number would be a lie.
   */
  app.get('/api/exchange-accounts/:id/balance', authed, async (request, reply) => {
    const id = idOf(request);
    if (!exchanges.get(id)) return reply.code(404).send({ ok: false, error: '找不到该凭据' });

    const refresh = String((request.query as { refresh?: string }).refresh ?? '') === '1';
    const result = await deps.balance.get(id, { force: refresh });
    if (!result.ok) return reply.code(200).send({ ok: false, error: result.error });
    return { ok: true, balance: result.balance, cached: result.cached };
  });

  app.post('/api/exchange-accounts', authed, guard(async (body: unknown) => {
    const parsed = ExchangeAccountInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const account = exchanges.create({
      exchange: parsed.data.exchange,
      label: parsed.data.label,
      apiKey: parsed.data.apiKey,
      apiSecretEnc: deps.vault.encrypt(parsed.data.apiSecret),
      testnet: parsed.data.testnet,
      canTrade: parsed.data.canTrade,
    });
    deps.balance.invalidate(account.id);
    return publicAccount(account);
  }));

  /**
   * Test **unsaved** exchange credentials.
   *
   * Mirrors the model draft probe: the point is to find out whether a key works
   * before it is committed to the database, rather than discovering a typo from a
   * failed trading cycle later.
   */
  app.post('/api/exchange-accounts/test-draft', authed, async (request, reply) => {
    const parsed = ExchangeAccountInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, checks: [], error: '请填写完整的交易所、API Key 与 Secret。' });
    }
    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: parsed.data.testnet ? 'demo' : 'production',
        apiKey: parsed.data.apiKey,
        apiSecret: parsed.data.apiSecret,
        dryRun: true,
        // 一次性的连通性自检：结论由下面的 preflight 报告，不必广播"已连接"。
        quiet: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, checks: [], error: (error as Error).message });
    }
  });

  app.patch('/api/exchange-accounts/:id', authed, guard(async (body: unknown, request) => {
    const id = idOf(request);
    const parsed = ExchangeAccountInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof exchanges.update>[1] = {};
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.apiKey !== undefined) patch.apiKey = parsed.data.apiKey;
    if (parsed.data.apiSecret) patch.apiSecretEnc = deps.vault.encrypt(parsed.data.apiSecret);
    if (parsed.data.testnet !== undefined) patch.testnet = parsed.data.testnet;
    if (parsed.data.canTrade !== undefined) patch.canTrade = parsed.data.canTrade;

    exchanges.update(id, patch);
    // The stored key may have changed, so the cached balance and REST client are
    // no longer trustworthy.
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  app.delete('/api/exchange-accounts/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    const inUse = exchanges.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({
        error: `该凭据正被 ${inUse} 个机器人使用，请先删除或改派它们。`,
      });
    }
    exchanges.remove(id);
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  /** Connect with the stored key and report exactly what is wrong, if anything. */
  app.post('/api/exchange-accounts/:id/test', authed, async (request, reply) => {
    const id = idOf(request);
    const row = exchanges.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该凭据' });

    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        dryRun: true,
        // 同上：自检结果由 preflight 报告。
        quiet: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message, checks: [] });
    }
  });

  /* --- AI models --------------------------------------------------------- */

  app.get('/api/ai-models', authed, async () =>
    aiModels.list().map((model) => {
      const row = aiModels.getWithSecret(model.id);
      let masked = '';
      if (row?.api_key_enc) {
        try {
          masked = maskSecret(deps.vault.decrypt(row.api_key_enc));
        } catch {
          masked = 'unreadable';
        }
      }
      return {
        ...model,
        apiKeyMasked: masked,
        hasKey: Boolean(row?.api_key_enc),
        /*
         * ⚠️ **把"这个模型最近一次调用成没成"一起返回。**
         *
         * 2026-09-29 实测：网关连着 12 次回 `insufficient credits`（HTTP 400），
         * 而界面上没有任何迹象 —— 只有服务器日志里有。这份 `health` 就是让
         * 控制台能说出"模型现在不能用"（见 `LlmHealth` 的完整说明）。
         */
        health: readLlmHealth(model.id),
      };
    }),
  );

  /**
   * Ask the provider which models this key can use.
   *
   * This is the primary way the UI learns about models. A static list would go
   * stale — and a stale default fails only at runtime, once a trader is already
   * trying to make a decision.
   *
   * 密钥来源有两条，**顺序不能反**：
   *
   *   1. 请求体里的 `apiKey` 非空 —— 用户正在输入一把替换密钥，以他输入的为准；
   *   2. `apiKey` 为空但带上了 `modelId` —— 编辑已保存的模型时界面刻意留空输入框
   *      （明文密钥从不回显），这时才回头读那条记录里加密存储的密钥。
   *
   * 这里的密钥**只**作为请求头发给提供商，绝不进日志、异常消息或响应体：
   * 失败路径回给用户的始终是 `discoverModels()` 里那条不含密钥的中文提示。
   * 另外 `modelId` 与其它模型端点一样走 `authed` 之后才可用，未认证的调用方
   * 无法借它去用别人的密钥。
   */
  app.post('/api/ai-models/discover', authed, async (request, reply) => {
    const parsed = DiscoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      // baseUrl 被地址白名单拒绝时要把原因说出来（"为什么不能打这个地址"），
      // 其余字段的 zod 默认提示是英文，对操作员没用 —— 保持原来的中文兜底。
      const baseUrlIssue = parsed.error.issues.find((issue) => issue.path[0] === 'baseUrl');
      return reply.code(400).send({
        ok: false,
        models: [],
        source: 'fallback',
        message: baseUrlIssue?.message ?? '参数无效。',
      });
    }

    const { provider, modelId } = parsed.data;
    let apiKey = parsed.data.apiKey;

    if (!apiKey && modelId !== undefined) {
      const row = aiModels.getWithSecret(modelId);
      if (row?.api_key_enc) {
        try {
          apiKey = deps.vault.decrypt(row.api_key_enc);
        } catch {
          // 解密失败通常意味着主密钥换过、或密文损坏。把原因说清楚，
          // 但**不能**把密文或异常详情带出去 —— 那属于凭据材料。
          return reply.code(400).send({
            ok: false,
            models: [],
            source: 'fallback',
            message: '已存储的 API Key 无法解密，请在编辑框中重新填写一次。',
          });
        }
      }
      // 记录不存在、或存在但没存过密钥：与"没带 modelId"走同一条落空路径，
      // 统一由 discoverModels() 给出那句"请先填写 API Key"的中文提示。
    }

    const { discoverModels } = await import('../llm/discovery.js');
    return discoverModels({
      provider: provider as never,
      apiKey,
      ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {}),
    });
  });

  /**
   * Probe an **unsaved** model configuration.
   *
   * The saved-model endpoint can only test what is already in the database, which
   * means a wrong key or a hallucinated model id could only be discovered after
   * committing it. This closes that gap.
   */
  app.post('/api/ai-models/test-draft', authed, async (request, reply) => {
    const parsed = DraftModelInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.issues[0]?.message ?? '参数无效。', latencyMs: 0 });
    }
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) {
      return reply.code(400).send({ ok: false, message: '自定义提供商必须填写基础 URL。', latencyMs: 0 });
    }

    /*
     * ⚠️ **编辑一个已存模型时，界面不会回传密钥（留空表示"不改它"）—— 所以这里必须回落。**
     *
     * 用户 2026-10-08 报的：「编辑一个已经添加过 key 的模型提供商时候需要重新填入 KEY，
     * 不然无法测试通过」。根因就是这一行原来直接吃表单里的 `apiKey`，
     * 而编辑态下它是空字符串 —— 拿空密钥去认证当然失败。
     * **界面上的提示写着"留空则保留已存储的密钥"，而测试连接却把"留空"当成了"空密钥"**：
     * 两句话互相矛盾，用户只能靠重新输入一遍来绕过。
     *
     * 修法：表单带了 `id`（编辑态）且 `apiKey` 为空时，**解密那条已存的密钥**用。
     * 前端因此不必判断该调 `/test-draft` 还是 `/:id/test` —— 那是实现细节，
     * 不该让用户（和界面的分支）去承担。
     */
    /*
     * ⚠️ **字段名是 `modelId`，不是 `id`** —— 与同一族的 `/discover` 保持一致
     * （那条路由的注释早就写明"`modelId` 是用已存密钥的唯一表达方式"）。
     *
     * 我第一版写成了 `id`，于是前端传的 `modelId` 被丢掉、回落逻辑永不触发，
     * 用户看到的仍是 `Missing API key.`。**同一个东西两个名字，就是这种结果。**
     */
    const draftModelId = Number((request.body as { modelId?: unknown } | null)?.modelId);
    let effectiveKey = parsed.data.apiKey;
    if (!effectiveKey && Number.isFinite(draftModelId) && draftModelId > 0) {
      const existing = aiModels.getWithSecret(draftModelId);
      if (existing) effectiveKey = deps.vault.decryptOptional(existing.api_key_enc);
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const defaults = providerDefaults(parsed.data.provider as never);
      const client = new LlmClient({
        provider: parsed.data.provider as never,
        apiKey: effectiveKey,
        model: parsed.data.model,
        baseUrl,
        temperature: parsed.data.temperature ?? defaults.temperature,
        maxTokens: parsed.data.maxTokens ?? defaults.maxTokens,
        // Cap the probe so a wrong endpoint fails fast instead of hanging.
        timeoutSeconds: Math.min(parsed.data.timeoutSeconds ?? defaults.timeoutSeconds, 60),
        maxRetries: 0,
      });
      return await client.testConnection();
    } catch (error) {
      return reply.code(400).send({ ok: false, message: explainProbeError((error as Error).message), latencyMs: 0 });
    }
  });

  /**
   * 把探针的原始报错翻成**操作员能照做**的一句话。
   *
   * 用户 2026-10-08 在 OpenCode GO 上选了 `claude-haiku-5-5`，界面只说
   * 「Model does not support this protocol.」—— 那句话既没说是**哪个**模型的问题，
   * 也没说**该怎么办**。实测两种情况都试过（`/chat/completions` 400 不支持该协议、
   * `/messages` 401 该模型不被支持），结论是**这个模型在那个网关上是不可用的**，
   * 而不是我们的协议实现错了。
   *
   * 所以这里补一句指向"换模型"的话 —— 否则人会一直去查密钥和 URL（那是提示里让他查的
   * 前三项），而真正的原因在第四项。
   */
  function explainProbeError(message: string): string {
    /*
     * ⚠️ **OpenCode Go 只覆盖【开源模型】，而它的 `/models` 返回的是网关全集。**
     *
     * 用户 2026-10-08 选了 `claude-haiku-5-5` 并报「连不上」。查官方文档
     * （<https://opencode.ai/docs/zh-cn/go/>）：
     *
     * > Go 通过两种用量方案，稳定访问**开源编程模型**……我们测试了一组精选的**开源模型**
     *
     * 而 Claude 是 Anthropic 的**专有**模型 —— **不在 Go / Go Plus 的范围内**。
     * 实测也印证：`chat/completions` 返 400「Model does not support this protocol」、
     * `messages` 返 401「is not supported」；而**同一个 key、同一个端点**跑
     * `deepseek-v4.1-flash` 是 **200**。所以不是协议实现的问题，是订阅没覆盖该模型。
     *
     * 而「获取可用模型」列的是**网关全集（37 个）**，没按订阅过滤 ——
     * 界面上因此看不出"哪些真的能用"。至少要让报错把这层说破，否则人会一直去查
     * 密钥和 URL（提示里让他查的前三项），而真正的原因在订阅范围上。
     */
    if (/ModelProtocolUnsupported|does not support this protocol/i.test(message)) {
      return (
        `${message} —— 这类模型在你的服务商侧不提供 OpenAI 兼容接口。` +
        '若用的是 OpenCode Go，注意它只覆盖**开源模型**（如 deepseek 系），' +
        'Claude / GPT 这类专有模型不在订阅范围内 —— 「获取可用模型」列的是网关全集，' +
        '但不等于你的订阅能用。请换一个开源模型 id 再测。'
      );
    }
    if (/is not supported|ModelError/i.test(message)) {
      return (
        `${message} —— 该模型在你的订阅下不可用。` +
        'OpenCode Go 只覆盖开源模型，专有模型需要另配 key。请换一个模型 id 再测。'
      );
    }
    return message;
  }

  app.post('/api/ai-models', authed, guard(async (body: unknown) => {
    const parsed = AiModelInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) throw new Error('自定义提供商必须填写基础 URL。');

    // Anything the user left alone falls back to the provider's own defaults, so
    // the common path really is just name + key + model id.
    const defaults = providerDefaults(parsed.data.provider as never);

    return aiModels.create({
      provider: parsed.data.provider as never,
      label: parsed.data.label,
      model: parsed.data.model,
      baseUrl,
      apiKeyEnc: deps.vault.encryptOptional(parsed.data.apiKey),
      /*
       * 四个参数**一律**取 provider 的默认值 —— 见 `AiModelInputSchema` 上的说明。
       * 控制台的「高级设置」面板已删掉，这里也不再接受客户端传入。
       */
      temperature: defaults.temperature,
      maxTokens: defaults.maxTokens,
      timeoutSeconds: defaults.timeoutSeconds,
      maxRetries: defaults.maxRetries,
    });
  }));

  app.patch('/api/ai-models/:id', authed, guard(async (body: unknown, request) => {
    const id = idOf(request);
    const parsed = AiModelInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof aiModels.update>[1] = {};
    if (parsed.data.provider !== undefined) patch.provider = parsed.data.provider as never;
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.model !== undefined) patch.model = parsed.data.model;
    if (parsed.data.baseUrl !== undefined) patch.baseUrl = parsed.data.baseUrl;
    if (parsed.data.apiKey) patch.apiKeyEnc = deps.vault.encrypt(parsed.data.apiKey);
    /*
     * ⚠️ **改了 provider 就要把这四项刷新成它的默认值。**
     *
     * 它们现在是"provider 的属性"而不是"这条记录的属性"：把 kimi 的记录
     * 改成 commandcode、却留着 kimi 的超时与输出预算，会得到一个**两边都不对**
     * 的组合（比如 kimi 的 180s 超时配上一个更慢的网关）。
     *
     * 只在 provider 真的变了时候刷新：只是想改个名字的 PATCH 不该动它们。
     */
    if (patch.provider !== undefined) {
      const next = providerDefaults(patch.provider);
      patch.temperature = next.temperature;
      patch.maxTokens = next.maxTokens;
      patch.timeoutSeconds = next.timeoutSeconds;
      patch.maxRetries = next.maxRetries;
    }

    aiModels.update(id, patch);
    return { ok: true };
  }));

  /**
   * Strategy health check — "策略体检".
   *
   * Runs the real pipeline (live market data → real prompts → a real model call
   * → real parsing → real risk review) against a **simulated** account, so a
   * strategy can be validated before any exchange credential exists. Reports
   * each stage separately, because "the model failed" and "the risk engine
   * refused everything" both look like "the bot did nothing" from outside.
   */
  app.post('/api/strategies/:id/check', authed, async (request, reply) => {
    const id = idOf(request);
    const strategy = strategies.get(id);
    if (!strategy) return reply.code(404).send({ ok: false, error: '找不到该策略' });

    const parsed = StrategyCheckInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '请选择一个要用于测试的 LLM 模型。' });

    const modelRow = aiModels.getWithSecret(parsed.data.aiModelId);
    if (!modelRow) return reply.code(404).send({ ok: false, error: '找不到该 AI 模型' });

    const apiKey = deps.vault.decryptOptional(modelRow.api_key_enc);
    if (!apiKey && modelRow.provider !== 'custom') {
      return reply.code(400).send({ ok: false, error: `AI 模型「${modelRow.label}」还没有配置 API Key。` });
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const { checkStrategy } = await import('../strategy/healthCheck.js');

      const client = new LlmClient({
        provider: modelRow.provider as never,
        apiKey,
        model: modelRow.model,
        ...(modelRow.base_url ? { baseUrl: modelRow.base_url } : {}),
        temperature: modelRow.temperature,
        maxTokens: modelRow.max_tokens,
        timeoutSeconds: modelRow.timeout_seconds,
        maxRetries: modelRow.max_retries,
      });

      const result = await checkStrategy({
        config: strategy.config,
        connection: deps.publicConnection,
        client,
        ...(parsed.data.symbol ? { symbol: parsed.data.symbol.toUpperCase() } : {}),
      });

      return { ...result, strategyName: strategy.name, modelLabel: modelRow.label, model: modelRow.model };
    } catch (error) {
      log.error(`策略体检失败：${(error as Error).message}`);
      return reply.code(500).send({ ok: false, error: (error as Error).message, stages: [], sample: null });
    }
  });

  app.delete('/api/ai-models/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    const inUse = aiModels.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该模型正被 ${inUse} 个机器人使用。` });
    }
    aiModels.remove(id);
    return { ok: true };
  }));

  /**
   * Probe the model endpoint without starting a trader.
   *
   * 结果写进 `llm_health:<id>`(同一份记录机器人运行时的调用结果)。否则点完「测试」
   * 刷新页面,「最近测试」就回到"从未测试" —— 结果只活在前端内存里。
   */
  app.post('/api/ai-models/:id/test', authed, async (request, reply) => {
    const id = idOf(request);
    const row = aiModels.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该模型' });

    const at = () => new Date().toISOString();
    try {
      const { LlmClient } = await import('../llm/client.js');
      const client = new LlmClient({
        provider: row.provider as never,
        apiKey: deps.vault.decryptOptional(row.api_key_enc),
        model: row.model,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        timeoutSeconds: Math.min(row.timeout_seconds, 60),
        maxRetries: 0,
      });
      const probe = await client.testConnection();
      recordLlmHealth(id, probe.ok
        ? { ok: true, at: at(), latencyMs: probe.latencyMs }
        : { ok: false, at: at(), latencyMs: probe.latencyMs, error: probe.message.slice(0, 300) });
      return probe;
    } catch (error) {
      const message = (error as Error).message;
      recordLlmHealth(id, { ok: false, at: at(), error: message.slice(0, 300) });
      return reply.code(400).send({ ok: false, message, latencyMs: 0 });
    }
  });

  /**
   * 指定「创建新机器人时预选哪个模型」。
   *
   * ## 为什么需要它
   *
   * `GET /api/config-catalog` 早就在读 `settings.default_ai_model_id` 并把它交给
   * 前端（`catalog.defaultAiModelId`），那段注释写着它存在的理由：
   *
   *   原来是"列表第一个"，而列表按 id 排 —— 于是一个**余额不足或已失效**的模型
   *   只要 id 最小，就会成为每个新机器人的默认，每次创建都要手动改回来。
   *   **这里让操作员能指定。**
   *
   * **但没有任何地方写这个设置** —— 它读得到、用得上、改不了，
   * 于是"取不到就回落到第一个"那半句成了唯一会发生的行为，而操作员每次创建
   * 新机器人仍然要手动改回来。这个端点补上缺的那一头。
   */
  app.post('/api/ai-models/:id/set-default', authed, async (request, reply) => {
    const id = idOf(request);
    if (!aiModels.get(id)) return reply.code(404).send({ error: '找不到该模型' });
    settings.set('default_ai_model_id', String(id));
    return { ok: true, defaultAiModelId: id };
  });

  /* --- Strategies -------------------------------------------------------- */

  /*
   * 策略列表**排除 AI 托管模式用的那类策略**。
   *
   * ## 为什么
   *
   * AI 托管**不是一个策略** —— 策略是"一组固定参数"，而 AI 模式的意思是"没有固定参数"。
   * 它在创建机器人时作为一个**模式**被选中，而不是从策略列表里挑。
   *
   * 让它出现在这里有两个具体后果：
   *   1. 任何既有机器人都能选中它，包括那些本该按固定参数跑的；
   *   2. 它看上去像一个"可以编辑的策略"，而那个外壳是假的 ——
   *      用户改完，AI 下一轮就覆盖；或者用户的修改被静默忽略。
   *
   * ## ⚠️ 这是权宜之计，不是最终形态
   *
   * 真正干净的做法是让 `traders.strategy_id` 可空，使 AI 机器人**根本不需要**一个策略。
   * **那需要重建 traders 表，而它被 8 张表用 ON DELETE CASCADE 引用** ——
   * `DROP TABLE traders` 会连带删掉全部交易历史。那件事必须单独做、带备份、
   * 并且在能守在现场的时候做。**不能顺手做。**
   *
   * 在那之前，用这条过滤保证"它不出现在用户能选策略的任何地方"。
   */
  app.get('/api/strategies', authed, async () =>
    strategies.list().filter((s) => s.presetId !== AI_MANAGED_PRESET),
  );

  app.get('/api/strategies/:id', authed, async (request, reply) => {
    const strategy = strategies.get(idOf(request));
    if (!strategy) return reply.code(404).send({ error: '找不到该策略' });
    return strategy;
  });

  app.post('/api/strategies', authed, guard(async (body: unknown) => {
    const parsed = StrategyInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');
    return strategies.create({
      name: parsed.data.name,
      description: parsed.data.description,
      config: parsed.data.config,
      presetId: parsed.data.presetId,
    });
  }));

  app.patch('/api/strategies/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = idOf(request);
    const parsed = StrategyInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');

    const patch: Parameters<typeof strategies.update>[1] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;

    strategies.update(id, patch);
    const updated = strategies.get(id);
    if (!updated) return reply.code(404).send({ error: '找不到该策略' });
    return updated;
  }));

  app.delete('/api/strategies/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    const inUse = strategies.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该策略正被 ${inUse} 个机器人使用。` });
    }
    strategies.remove(id);
    return { ok: true };
  }));

  /* --- Traders ----------------------------------------------------------- */

  /**
   * 最近一次账目校验的结论（`settings.ledger_check:<id>`）。
   *
   * 交易循环每轮都会把「账本净额 vs 交易所流水净额」算一遍并存下来，
   * 但**从来没有送到界面上** —— 操作员因此只能看到一个可能错的值。
   * 这里只做读取，不改变任何东西。
   */
  function ledgerCheckOf(traderId: number): { platformNet: number; exchangeNet: number; gap: number; checkedAt: string } | null {
    const raw = settings.get(`ledger_check:${traderId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        platformNet: Number(parsed.platformNet ?? 0),
        exchangeNet: Number(parsed.exchangeNet ?? 0),
        gap: Number(parsed.gap ?? 0),
        checkedAt: String(parsed.checkedAt ?? ''),
      };
    } catch {
      return null;
    }
  }

  app.get('/api/traders', authed, async () => {
    const running = new Set(deps.manager.runningIds());
    return traders.list().map((trader) => ({
      ...trader,
      // The live loop is the source of truth for status, not the stored value.
      status: running.has(trader.id) ? deps.manager.statusOf(trader.id) : ('stopped' as const),
      isRunning: running.has(trader.id),
      /*
       * ⚠️ **账本与交易所的差额必须发到界面上。**
       *
       * 用户 2026-10-07 报的：「起始权益 100.05，现在 100.84，为什么显示 +$1.29？」
       *
       * 首页那个"交易盈亏"来自 `trades.net_pnl` 求和（账本），而这个机器人**一直在漏记
       * 平仓手续费**（33 张已成交的平仓单 `fee=0`），账本只好拿开仓费顶上
       * —— 11 笔呈现精确的 `fee = 2 × entry_fee`。差额就是这个字段。
       *
       * 系统的账目校验（`ledger_check:<id>`）**每轮都算出这个 gap 并写进 settings**，
       * 却**从来没有一条路径把它送到界面上**。于是操作员看到一个错数、且没有任何提示。
       *
       * 带出去，让界面能说"账本与交易所差了多少"，而不是继续假装账本是准的。
       */
      ledger: ledgerCheckOf(trader.id),
      /*
       * **下一轮决策的预定时刻**（epoch 毫秒）—— 界面据此显示倒计时。
       *
       * 用户 2026-10-07：「能在这里加入一个倒计时吗？让我明显知道下一轮决策剩余周期」。
       *
       * 由 `AutoTrader.nextCycleAt` 提供：它记的是**定时器真正被排到的那一刻**，
       * 已经把"模型自己要求的间隔"（`requestedMinutes`）与"失败短重试"算进去了。
       * **界面不要自己拿"上一轮时间 + 配置周期"推算** —— 那会忽略这两件事，
       * 显示一个骗人的倒计时（模型说 5 分钟、界面显示 60 分钟）。
       */
      nextCycleAt: deps.manager.nextCycleAtOf(trader.id),
    }));
  });

  app.post('/api/traders', authed, guard(async (body: unknown) => {
    const parsed = TraderInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    /*
     * **账户是可选的**（用户 2026-10-27 需求）：不传 = 纯模拟盘机器人，
     * 它不需要任何真实交易所账户。传了就必须真实存在 —— 一个打错的 id
     * 会让"绑了账户"这件事变成一句空话。
     */
    const requestedAccountId = parsed.data.exchangeAccountId ?? null;
    const account =
      requestedAccountId === null ? null : exchanges.get(requestedAccountId);
    if (requestedAccountId !== null && !account) throw new Error('未知的交易所账户');
    /*
     * ⚠️ **团队模式不校验 `ai_model_id`** —— 它**不使用**这个字段（用户 2026-10-12 要求）。
     *
     * 用户原话：
     * > 「团队多智能体模式，在创建/修改的时候就不应该采用 AI 模型列表里面的，
     * >  而是直接采用系统的 magpie，（系统 AI 列表里面添加的那些不应该给这个模式使用）」
     *
     * 团队模式的模型出口来自**独立的 magpie 网关配置**（见 `teamGateway.ts`），
     * 所以「AI 模型」列表里有什么、那条记录是不是 magpie、有没有被改过，
     * **都与团队模式无关**。
     *
     * ## 为什么数据库那一列仍然保留
     *
     * `traders.ai_model_id` 是 `NOT NULL`（建表时就定了），改成可空要一次迁移，
     * 而迁移的风险（重建表、影响正在跑的实盘机器人）**远大于收益**。
     *
     * 所以：**列保留、写入一个占位值、团队模式不读它**。
     * 这比"为了语义干净去做一次有风险的迁移"更符合本项目"不碰实盘"的纪律。
     */
    const isTeamMode = parsed.data.mode === 'ai_team';
    if (!isTeamMode && !aiModels.get(parsed.data.aiModelId)) throw new Error('未知的 AI 模型');

    /*
     * ── 策略：**两种模式的要求正好相反** ────────────────────────────────
     *
     * 用户的原话：「智能托管模式完全独立出来……就算策略工坊里面默认策略 —
     * 稳健就算删除、没有任何策略，都不影响智能托管模式（做到完全独立）」。
     *
     *   · **AI 托管**：**不引用任何策略** —— 参数整份在 `agent_config_json` 里。
     *     所以连"必须选一个"这个动作都取消了，`strategyId` 直接写 `null`。
     *   · **固定策略**：**必须**有一个 —— 否则它没有任何可用的参数。
     *
     * 两个方向都要拦：只拦一边的话，要么建出"没有配置的固定策略机器人"，
     * 要么又把 AI 托管绑回一个它用不上的策略（这正是要修的那个问题）。
     */
    /*
     * ⚠️ 用 `isAiDriven` 而不是 `=== 'ai_managed'` —— **加新模式时这里必须自动生效**。
     *
     * 写死单个模式名的话，新建 `ai_team` 机器人时会被下面那个 `else` 分支
     * 要求"必须选一个策略"，而 AI 团队模式的参数**整份由团队自己管**，
     * 根本没有可选策略 —— 于是新模式一建就报错。
     *
     * 这正是共享包把 `AI_DRIVEN_MODES` 导出来的理由：**让"哪些模式由 AI 驱动"
     * 只有一个定义处**，而不是散在各层的字符串比较里。
     */
    /*
     * ⚠️ **用共享包的 `isAiDriven()`，不要再写死枚举**（2026-10-19）。
     *
     * 上面那段注释自己就写着「让"哪些模式由 AI 驱动"只有一个定义处」，
     * 而这里原本仍然是 `mode === 'ai_managed' || mode === 'ai_team'` ——
     * 加 `'jev'` 时它**正好会掉进 `else`**，于是新建 JEV 模式的机器人会报
     * 「固定策略模式必须选择一个策略」，而 JEV 模式压根不需要策略。
     *
     * ⇒ 判据必须是 `AI_DRIVEN_MODES` 那份唯一清单（`isAiDriven()`），
     *   加新模式时只改 `domain.ts` 一处。
     */
    const isAiDrivenMode = isAiDriven(parsed.data.mode);
    const requestedStrategyId = parsed.data.strategyId ?? null;
    if (isAiDrivenMode) {
      if (requestedStrategyId !== null) {
        throw new Error('AI 托管模式不引用任何策略 —— 请不要为它选择策略。');
      }
    } else {
      if (requestedStrategyId === null) throw new Error('固定策略模式必须选择一个策略。');
      if (!strategies.get(requestedStrategyId)) throw new Error('未知的策略');
    }

    /*
     * ── 起始权益 / 模拟盘本金 ────────────────────────────────────────────
     *
     * 两条**互相独立**的路径：
     *
     *   · **模拟盘**（没有账户，或操作员填了 `paperStartingBalance`）：
     *     本金就是操作员填的那个数 —— **不去读任何真实钱包**。这正是用户说的
     *     「模拟盘不应该根据真实钱包的余额」。
     *   · **实盘**：沿用原来的行为，从交易所读真实余额做收益率分母。
     */
    const paperStartingBalance = parsed.data.paperStartingBalance ?? 0;
    const isPaperOnly = account === null;

    let initialEquity = parsed.data.initialEquity ?? 0;
    let equitySource: 'exchange' | 'manual' | 'paper' | 'unavailable' = 'manual';

    if (isPaperOnly) {
      /*
       * 没有账户 → **不可能**读真实余额。用操作员填的模拟本金；
       * 没填就留 0，由 `manager` 在首次启动时回落到默认值。
       */
      if (initialEquity <= 0) initialEquity = paperStartingBalance;
      equitySource = initialEquity > 0 ? 'paper' : 'unavailable';
    } else if (account && initialEquity <= 0) {
      const live = await deps.balance.walletBalanceOf(account.id);
      if (live !== null && live > 0) {
        initialEquity = live;
        equitySource = 'exchange';
      } else {
        equitySource = 'unavailable';
      }
    }

    /* 模拟本金没单独填时，用 `initialEquity` 兜底 —— 两者语义不同，但都比 0 好。 */
    const effectivePaperBalance = paperStartingBalance > 0 ? paperStartingBalance : initialEquity;

    const trader = traders.create({
      name: parsed.data.name,
      /* `null` = 纯模拟盘机器人（没有真实交易所账户）。 */
      exchangeAccountId: requestedAccountId,
      /*
       * ⚠️ **团队模式写入一个占位 `aiModelId`** —— 因为 `traders.ai_model_id` 是
       * `NOT NULL` + 外键（建表时就定了），而团队模式**不使用**这个字段
       *（它的模型出口来自独立的 magpie 网关配置，见 `teamGateway.ts`）。
       *
       * 为什么不做迁移把它改成可空：那要重建表，而这张表上挂着**正在跑的实盘机器人**
       * —— 迁移风险远大于"语义干净"带来的收益。本项目的纪律是"不碰实盘"。
       *
       * ## ⚠️ 占位值**不能硬编码成 `1`**（本地实测踩到）
       *
       * 第一版写的是 `? 1 : ...`，理由是"建表时必然有 id=1 的模型"。
       * **那个假设不成立**：本地实测库里模型 id 是 `4/5/8/9`（没有 1），
       * 于是建团队机器人直接 `FOREIGN KEY constraint failed` ——
       * 而错误信息完全指不到"占位值选错了"这个原因。
       *
       * 正确做法：**取一个真实存在的模型 id**。团队模式从不读它，
       * 所以取哪一条都行，只要满足外键。
       *
       * 一条模型都没有时（全新库）→ 抛一个说人话的错误，而不是外键报错。
       */
      /*
       * ⚠️ **`jev` 与 `ai_team` 一样：不读 `aiModelId`**（2026-10-19）。
       *
       * 两者的决策模型都不来自「AI 模型」列表：
       * ```
       *   ai_team → 角色路由在运行时决定模型名（走 magpie 网关）
       *   jev     → 固定调 `jev-latest`（走 magpie 网关）
       * ```
       * 所以这里都只需要"一个真实存在的外键值"，取哪条都行。
       * 不这么处理的话，用户会被要求给一台根本不读模型的机器人挑一个模型。
       */
      aiModelId:
        parsed.data.mode === 'ai_team' || parsed.data.mode === 'jev'
          ? requireAnyModelIdForTeam()
          : parsed.data.aiModelId,
      strategyId: requestedStrategyId,
      cycleIntervalMinutes: parsed.data.cycleIntervalMinutes,
      initialEquity,
      paperStartingBalance: effectivePaperBalance,
      mode: parsed.data.mode,
    });

    /*
     * ── AI 托管的机器人**自带一份完整配置** ─────────────────────────────
     *
     * ⚠️ 这一步是"完全独立"的实质所在。
     *
     * `agent_config_json` 原来**只在 AI 自己改参数时**才被写入（`ports.ts` 的
     * `setAgentConfig`）—— 也就是说一个刚建好的 AI 托管机器人身上是 `NULL`，
     * 它第一轮跑起来读的是**策略的配置**。于是"策略没了"就等于"它没有配置"，
     * 这正是用户要修的那个依赖。
     *
     * 现在建号时就写入一份完整配置。从这一刻起它的参数只属于它自己，
     * 策略（乃至"没有任何策略"）与它再无关系。
     *
     * ⚠️ **用 `unboundedAiManagedConfig()` 而不是 `parse({})`**（2026-10-03）。
     *
     * `parse({})` 走的是 schema 的**保守默认值**（3 个持仓、5x 杠杆、逐仓、
     * 75 分门槛）—— 而 AI 托管的机器人**不引用策略**，模型改这些只能靠自己
     * 想起来改，界面上根本没有入口。于是"完全交给模型"实际变成了
     * "系统先替它定死一组保守边界"。用户的原话：
     *
     *   「既然完全交给模型，那么怎么操作都由模型决定啊，而不是系统就提前写死了，
     *     模型改还有什么意义呢？？」
     *
     * 所以智能托管的起点改成**不设边界**（见 `unboundedAiManagedConfig()`）：
     * 上限顶格、门槛归零，唯一的例外是 `requireStopLoss`（那是结构要求，
     * 不是策略偏好）。**已有机器人不会被追溯修改** —— 它们的参数已经在自己的
     * `agent_config_json` 里，怎么调由模型与操作员决定。
     *
     * ---
     *
     * ⚠️ **`ai_team` 用【自己那份】配置，不借用智能托管的。**
     *
     * `unboundedAiManagedConfig` 是**单智能体**的参数集；团队模式有**风控官**在
     * 裁决之后把关，语义不同（见设计 §二/§三）。
     *
     * 但上一轮我**漏了给团队模式播种**（只写了注释说"留给 S3"），于是实测踩到：
     *
     *     机器人 #11 的配置里没有任何候选标的（静态列表为空、也没开动态候选池）
     *     —— 它不会交易任何东西。
     *
     * 也就是说：团队模式**跑得起来、界面显示"运行中"，但永远不会开任何仓**。
     * 而用户要的正是「然后做相应的动作（**开仓、平仓、调仓**等等）」。
     *
     * 所以现在**每种 AI 驱动模式各自播种自己那份**：
     *   · `ai_managed` → `unboundedAiManagedConfig()`（单智能体口径）
     *   · `ai_team`    → `defaultAiTeamConfig()`（含**动态标的池**）
     *   · `jev`        → `defaultJevConfig()`（动态标的池 + 实验性的收紧风控）
     */
    if (parsed.data.mode === 'ai_managed') {
      traders.setAgentConfig(trader.id, JSON.stringify(unboundedAiManagedConfig()));
    } else if (parsed.data.mode === 'ai_team') {
      traders.setAgentConfig(trader.id, JSON.stringify(defaultAiTeamConfig()));
    } else if (parsed.data.mode === 'jev') {
      /*
       * ⚠️ 与团队模式同一类坑：**不播种就会空转**（策略配置全空 ⇒ 没有候选标的
       * ⇒ Jev 永远收到空数组 ⇒ 一台"运行中"的机器人永远不开仓）。
       */
      traders.setAgentConfig(trader.id, JSON.stringify(defaultJevConfig()));
    }

    return { ...trader, equitySource };
  }));

  app.patch('/api/traders/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = idOf(request);
    if (deps.manager.isRunning(id)) {
      return reply.code(409).send({ error: '请先停止该机器人，再修改它的配置。' });
    }
    const parsed = TraderInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    /*
     * ⚠️ **改了仓储不支持的字段时必须明说，不能静默成功（2026-10-11 审查发现）。**
     *
     * `TraderInputSchema` 含 `exchangeAccountId`（创建时必需），而 `traders.update()`
     * 的入参里**没有这个字段** —— 于是编辑弹窗改了交易所账户、接口回 200、
     * `return traders.get(id)` 看起来一切正常，**而账户根本没变**。
     *
     * 这是最坏的一类失败：**它告诉你成功了。**
     *
     * ## ⚠️ 判据必须是"值变了没有"，不是"键在不在"（2026-10-11 当天返工）
     *
     * 第一版写的是 `key in parsed.data` —— **它把用户改任何东西都挡住了**，
     * 用户报的原话是「我修改机器人模型报错了」。我为了防"静默失败"，
     * 造出了一个"什么都改不了"。
     *
     * ### 真正的原因（已实测证实，不是推测）
     *
     * 我起初以为是 zod 的 `.partial()` 会保留声明过的键 —— **实测否定了它**：
     *
     *     z.object({ a: z.number().optional(), b: z.string() }).partial()
     *       .safeParse({ b: 'x' }).data   →  { b: 'x' }
     *       'a' in data                   →  false
     *
     * 所以 `key in parsed.data` 对**未传**的键本来就是 false。
     * 真正的原因是**前端把 `exchangeAccountId` 一起提交了** ——
     * 配置弹窗会带上当前选中的交易所账户，哪怕用户改的是别的东西。
     *
     * 结论不变、但理由不同：**要判断的是"这一次有没有改它"，只能拿值和库里的比。**
     * 一个请求体里出现某个字段，既不代表用户改了它、也不代表没改 ——
     * **只有和当前值比较才能回答那个问题。**
     */
    const current = traders.get(id);
    if (!current) return reply.code(404).send({ error: `找不到机器人 ${id}` });
    const requestedAccountId = (parsed.data as { exchangeAccountId?: number }).exchangeAccountId;
    if (requestedAccountId !== undefined && requestedAccountId !== current.exchangeAccountId) {
      return reply.code(400).send({
        error:
          '暂不支持通过编辑修改交易所账户。要换账户，请新建一个机器人' +
          '（当前这个可以停掉保留历史）。',
      });
    }
    traders.update(id, parsed.data);
    return traders.get(id);
  }));

  app.delete('/api/traders/:id', authed, guard(async (_body: unknown, request) => {
    const id = idOf(request);
    await deps.manager.stopTrader(id);
    traders.remove(id);
    return { ok: true };
  }));

  app.post('/api/traders/:id/start', authed, async (request, reply) => {
    const id = idOf(request);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({
        error: '交易已被 GLOBAL_TRADING_DISABLED 全局禁用。要启动机器人请先移除该设置。',
        preflight: [],
      });
    }
    const body = (request.body ?? {}) as { dryRun?: boolean };
    // Paper mode is the default: a real-money start must be asked for explicitly.
    const dryRun = body.dryRun ?? true;
    /* ⚠️ 同步返回，不等启动跑完 —— 建连接/拉持仓/对账都要等，界面会像"点了没反应"（2026-10-10）。 */
    const result = deps.manager.startTraderAsync(id, dryRun);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/traders/:id/stop', authed, async (request) => {
    /* ⚠️ 不 await：stopTrader 已先把状态翻成 stopped 并掐断在途 AI 请求（2026-10-10）。 */
    void deps.manager.stopTrader(idOf(request));
    return { ok: true };
  });

  /** Force one decision cycle immediately instead of waiting for the interval. */
  /*
   * 手工平仓 —— **操作员的最高权限**。
   *
   * ## 为什么不加任何前置检查
   *
   * 这里原本**根本没有这条路由**：控制台上的「平仓」按钮只弹一个说明弹窗。
   * 那个设计的理由是"机器人自己在管理持仓，控制台不该和它抢"。
   *
   * **那个理由把"代码整洁"放在了"操作员对自己资金的控制权"前面。**
   *
   * 所以这条路由**不检查机器人是否在运行、不检查是否 dryRun、不检查全局开关**
   * —— 那些检查都属于"机器人要不要开仓"，而这条是"人要退出"。
   * **一个止不住手的操作员是被困住的。**
   *
   * 唯一的前置条件是"本地有这个持仓"，由 `closePosition` 内部判断。
   */
  /*
   * 全部平仓。
   *
   * **这条路由必须在 `:symbol` 那条之前**，否则 `/positions/close-all`
   * 会被当成 `symbol = 'CLOSE-ALL'` 吃掉。
   *
   * 与单币种平仓同样**不做任何前置检查** —— 见上面那条的说明。
   */
  app.post('/api/traders/:id/positions/close-all', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = await deps.manager.closeAllPositions(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post('/api/traders/:id/positions/:symbol/close', authed, async (request, reply) => {
    const id = idOf(request);
    const symbol = String((request.params as { symbol: string }).symbol).toUpperCase();
    try {
      const result = await deps.manager.closePosition(id, symbol);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post('/api/traders/:id/run-once', authed, async (request, reply) => {
    const id = idOf(request);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({ error: '交易已被全局禁用。' });
    }
    try {
      const summary = await deps.manager.runCycleNow(id);
      return { ok: true, summary };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * 让 AI **现在**审视一次策略（不等事件、不等兜底超时）。
   *
   * ## 与 `/run-once` 的区别（别混）
   *
   *   `/run-once`      跑一个**决策周期** —— 机器人按当前参数决策一次
   *   `/agent-review`  跑一次**策略审视** —— AI 反思并决定要不要改参数
   *
   * ## 为什么不受全局熔断限制
   *
   * 审视**不下任何订单** —— 它只读绩效、复盘与实验记录，然后可能写一份新参数。
   * 而"交易被禁用时正该能做的事"恰恰包括"让 AI 想想我们哪里做错了"，
   * 与 `/reconcile` 同一条理由。
   *
   * 参数写回后**不会**立刻变成订单：下单是决策周期的事，而周期在熔断下不跑。
   */
  app.post('/api/traders/:id/agent-review', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = deps.manager.requestAgentReview(id);
      if (!result.accepted) return reply.code(409).send({ ok: false, ...result });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, note: (error as Error).message });
    }
  });

  /**
   * Rebuild a trader's ledger from the exchange's own history.
   *
   * Deliberately **not** gated by the global trading kill switch: it places no
   * orders and only corrects the books, which is exactly what you want to be
   * able to do while trading is disabled.
   */
  app.post('/api/traders/:id/reconcile', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = await deps.manager.reconcileTrader(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /* --- Trader data ------------------------------------------------------- */

  /**
   * **这份 `positions` 是从哪儿来的** —— 前端据此区分「交易所真的没有仓」与「这是模拟仓」。
   *
   * ## 为什么必须有这个字段（用户实测 ×2 的 BUG）
   *
   * 模拟盘（`dry_run=1`）机器人的持仓**只存在于本地台账**：它的成交是本地模拟的，
   * 从来不会真的发到交易所（`broker.ts:663` 的 `if (this.dryRun) return this.simulateStandard(...)`）。
   * 而控制台卡片读的 `/account` 之前一律给交易所读数的 `positions` —— 于是它恒为
   * 空数组，卡片显示「持仓 0 / 保证金占用 0.00 / 当前无持仓」，
   * **而同一张卡里的「浮动」却有值**（那个数字走的是本地台账 + 行情标记价）。
   *
   * 「0 持仓却有浮盈」这个自相矛盾，根子就是这两路数字来源不同而界面上看不出来。
   * 所以修完必须让调用方能判定：**不必猜**。
   *
   * · `'exchange'`     —— 交易所实时读数（实盘机器人在跑）
   * · `'local_mirror'` —— 本机器人自己的**本地台账**（模拟盘；交易所对它本来就不存在这些仓）
   * · `'none'`         —— 这次没有可用的持仓读数（机器人没在跑，或交易所读失败）
   */
  type PositionsSource = 'exchange' | 'local_mirror' | 'none';

  /**
   * **某个机器人此刻是不是纸面模式**（模拟盘）。
   *
   * 判据分两级，**顺序不能反**：
   *
   * 1. `deps.manager.dryRunOf(id)` —— 正在跑的那个实例用的就是它，这是**运行时事实**。
   *    `null` 表示"它没在跑"，此时这个值此刻不存在（不是 `false` —— 见那个方法的说明）。
   * 2. 落库的 `traders.dry_run`（迁移 18）—— 它是**机器人自己的属性**，跨重启有效。
   *    三态：`true` / `false` / `undefined`（从未显式指定过）。
   *
   * ⚠️ `undefined` **不能**当成实盘：那时要回落到进程级的 `env.dryRun` ——
   * 与 `manager.resumePersisted(env.dryRun)` 同一条口径。把它读成 `false`
   * 会让一个"没在跑的模拟盘机器人"被当成实盘去读交易所，于是又回到空持仓。
   */
  const isPaperTrader = (traderId: number): boolean => {
    const runtime = deps.manager.dryRunOf(traderId);
    if (runtime !== null) return runtime;
    return traders.get(traderId)?.dryRun ?? env.dryRun;
  };

  /**
   * 本地台账 → `PositionView[]`。
   *
   * ## 为什么抽出来（而不是在调用点各写一份 map）
   *
   * 这条映射有**两个调用点**，而它们只差一件事：**拿不拿得到标记价**。
   *
   * · `/positions` 的"机器人没在跑"那条路**按设计不读交易所**，所以标记价与浮盈
   *   都是**占位零**（见那段「一个会闪烁的表格比一个说读不到的表格更糟」的注释）；
   * · 模拟盘机器人在跑时，标记价可以从**行情**拿到（行情是事实，与哪个机器人无关 ——
   *   与 `ownUnrealizedPnlOf` 借用标记价同一条理由），于是浮盈是真值。
   *
   * 两处各写一份 map 的话，"哪些字段该给什么"迟早会在一边被改而另一边没跟上。
   * 所以这里用**可选的 `markPriceOf`** 表达那唯一的差别：给得出就算真值，
   * 给不出就回落成占位零（与改动前逐字段一致）。
   */
  /*
   * ⚠️⚠️ **模拟盘的保证金模式从开仓单里取**（2026-10-18 修）
   *
   * ## 用户报的问题
   *
   * 持仓页「保证金模式」一列永远显示 `—`（用户截图指出）。
   *
   * ## 根因
   *
   * 真实盘走 `liveExchangeView`，那里的 `marginType` 读自交易所
   * （`/fapi/v2/positionRisk`，实时值）。**而模拟盘走这条 `localPositionsFor`，
   * 它只读本地 `positions` 表 —— 那张表没有 `margin_type` 列**（只有 `margin_used`），
   * 所以 `marginType` 恒为 `undefined`，前端只能显示 `—`。
   *
   * ## 为什么 `#11` 一直是 `—`
   *
   * `#11`（团队测试）= `dry_run = 1` ⇒ 它是**模拟盘**，交易所那边**根本没有持仓**
   * （实测账户 2「gaoshou3」在 `positionRisk` 里返回空）。
   * 所以"实时读交易所"这条路对它永远读不到东西 —— 不是交易所没返回，
   * 而是**这条路径压根不该用它**。
   *
   * ## 取值来源
   *
   * `orders.margin_type` —— 开仓那一刻由服务端记下的值（`setMarginType` 成功后才写）。
   * `orderStore.latestMarginTypeBySymbol()` 取每个标的**最新一条带模式的订单**，
   * 这正是"该标的当前的模式"最接近的事实。
   *
   * ⚠️ 取不到时保持 `undefined`（界面 `—`），**绝不默认成 `'cross'`** ——
   * 与 `normalizeMarginMode()` 的约定一致：认不出就是不知道。
   */
  const paperMarginTypes = (traderId: number): Map<string, string> => {
    try {
      return orderStore.latestMarginTypeBySymbol(traderId);
    } catch {
      /* 读不到就当没有 —— 界面显示 `—`，比显示一个猜的值好。 */
      return new Map<string, string>();
    }
  };

  /**
   * **保护单是否还在挂载中**（2026-10-19 用户要求）。
   *
   * ## 为什么需要它
   *
   * 用户原话：
   * > 「我刚才看到这单开单的时候提示没有止损，后面又有了好像是系统自动补上，
   * >  但是这显示是不是有问题？…显示要正常不要让我产生误会」
   *
   * 市场价开仓到保护单挂好之间有约 2 秒的窗口：
   * ```
   *   t+0s  成交（持仓已存在，stopLoss 在本地也已算好）
   *   t+2s  两张条件单挂上
   * ```
   * 窗口内界面说「无止损」是**把"还不知道"说成了"没有"** —— 两件事不一样。
   *
   * ## 判据
   *
   * ```
   *   开仓不足 60 秒  &&  该标的一条 NEW 保护单都没有  ⇒ 挂载中
   * ```
   * 60 秒远大于实测的 2 秒，留足余量；超过 60 秒还缺，
   * 那就是**真的缺**（由 `ensureStopsOnOpenPositions()` 下一轮补），
   * 这时界面该如实说"无止损"。
   *
   * ⚠️ 只在**本地持仓**上算（模拟盘/未运行机器人）。实盘走交易所挂单列表，
   * 那里本来就是真相，不需要这个猜测。
   */
  const PROTECTION_PENDING_MS = 60_000;
  const protectionPendingOf = (
    traderId: number,
    row: { symbol: string; opened_at: string },
  ): boolean => {
    const age = Date.now() - new Date(row.opened_at).getTime();
    if (!(age >= 0 && age < PROTECTION_PENDING_MS)) return false;
    try {
      /* 有任何一张 NEW 的保护单就不算"挂载中" —— 已经在挂了。 */
      const orderTypes = orderStore.openProtectionTypes(traderId, row.symbol);
      return orderTypes.length === 0;
    } catch {
      /* 读不到订单表时**不猜**：当作不在挂载中，让界面按实际情况显示。 */
      return false;
    }
  };

  const localPositionsFor = (
    traderId: number,
    markPriceOf?: ReadonlyMap<string, number>,
  ): PositionView[] => {
    const marginBySymbol = paperMarginTypes(traderId);
    return positionStore.open(traderId).map((row) => {
      const mark = markPriceOf?.get(row.symbol);
      const hasMark = typeof mark === 'number' && Number.isFinite(mark) && mark > 0;
      /*
       * ⚠️ **不给标记价时，这里必须与改动前的 `/positions` 回退分支逐字段一致**
       * （`markPrice = entry_price`、浮盈 0、`marginUsed = row.margin_used`、
       * 名义按**入场价**算）。那条路径服务的是"机器人没在跑"，它按设计**不读
       * 交易所、也不读行情** —— 自行推算保证金会静默改掉它的数字。
       */
      if (!hasMark) {
        return {
          id: row.id,
          traderId,
          symbol: row.symbol,
          /*
           * ⚠️ **`side` 必须显式收窄成 `'long' | 'short'`**（`PositionRow.side` 是
           * `string`，而 `PositionView.side` 是联合类型）。
           * 口径与 `autoTrader.ts` 的 `toPositionView()` 完全一致 —— 本表里这一列
           * 只由交易循环写入，取值只有这两个；两处用同一种收法，将来才不会分叉。
           */
          side: row.side === 'long' ? 'long' : 'short',
          quantity: row.quantity,
          entryPrice: row.entry_price,
          markPrice: row.entry_price,
          leverage: row.leverage,
          liquidationPrice: row.liquidation_price,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          peakPnlPercent: row.peak_pnl_percent,
          marginUsed: row.margin_used,
          /* 模拟盘的保证金模式来自开仓单 —— 见 `localPositionsFor` 函数头那段说明。 */
          marginType: normalizeMarginMode(marginBySymbol.get(row.symbol)) ?? undefined,
          notional: row.quantity * row.entry_price,
          stopLoss: row.stop_loss,
          takeProfit: row.take_profit,
          openedAt: row.opened_at,
          openReasoning: row.open_reasoning,
        };
      }
      const markPrice = mark as number;
      /*
       * 方向由 `side` 承载、数量恒为正 —— 与 `ownUnrealizedPnlOf()` 同一个算式。
       */
      const isLong = row.side === 'long';
      const unrealizedPnl =
        (isLong ? markPrice - row.entry_price : row.entry_price - markPrice) * row.quantity;
      /*
       * 保证金口径：真实占用优先，缺失时按「价 × 量 ÷ 杠杆」推。
       * 与 `liveExchangeView` 里那条（`live.marginUsed`）以及
       * `unrealizedPnlPercent` 的分母保持一致 —— 界面同屏出现这三个数时口径必须相同。
       */
      const marginUsed =
        row.margin_used > 0
          ? row.margin_used
          : (row.entry_price * row.quantity) / Math.max(1, row.leverage);
      return {
        id: row.id,
        traderId,
        symbol: row.symbol,
        side: row.side === 'long' ? 'long' : 'short',
        quantity: row.quantity,
        entryPrice: row.entry_price,
        markPrice,
        leverage: row.leverage,
        liquidationPrice: row.liquidation_price,
        unrealizedPnl,
        unrealizedPnlPercent: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
        peakPnlPercent: row.peak_pnl_percent,
        marginUsed,
        /* 模拟盘的保证金模式来自开仓单 —— 见 `localPositionsFor` 函数头那段说明。 */
        marginType: normalizeMarginMode(marginBySymbol.get(row.symbol)) ?? undefined,
        notional: row.quantity * markPrice,
        stopLoss: row.stop_loss,
        takeProfit: row.take_profit,
        /* 刚开仓且保护单还没挂好 —— 界面显示「挂单中」而不是「无止损」。 */
        protectionPending: protectionPendingOf(traderId, row),
        openedAt: row.opened_at,
        openReasoning: row.open_reasoning,
      };
    });
  };

  /** 这条只读连接拿到的账户读数形状（`AccountState` 不引新 import）。 */
  type ExchangeAccountState = Awaited<ReturnType<ExchangeConnection['broker']['getAccountState']>>;

  /**
   * 建一条**只读**交易所连接 —— 默认实现用该机器人的凭据，测试可注入。
   *
   * 返回 `null` 表示**找不到凭据行**（`错误`那条路要如实说出来，而不是静默当空仓）。
   */
  const openReadOnlyFor = async (trader: Trader): Promise<ExchangeConnection | null> => {
    if (deps.openReadOnlyConnection) return deps.openReadOnlyConnection();
    /*
     * 纯模拟盘机器人没有交易所账户（用户 2026-10-27 需求）——
     * 没有凭据行就是"读不到账户事实"，返回 null，由调用方按"读不到"处理
     * （模拟盘的持仓本来就来自本地台账，不依赖这条连接）。
     */
    if (trader.exchangeAccountId === null) return null;
    const row = exchanges.getWithSecret(trader.exchangeAccountId);
    if (!row) return null;
    const { connectExchange } = await import('../binance/bootstrap.js');
    return connectExchange({
      environment: row.testnet === 1 ? 'demo' : 'production',
      apiKey: row.api_key,
      apiSecret: deps.vault.decrypt(row.api_secret_enc),
      dryRun: true,
      /*
       * 这条连接是**一次性**的：控制台每次轮询都会重建它，只为拿到交易所
       * 真实持仓（而不是本地镜像）。不加这个开关时，`loaded 528 tradable...`
       * 会每 44 秒写一条 —— 30 分钟 41 条，而同期只有 11 个周期。
       */
      quiet: true,
    });
  };

  /**
   * **账户读数（尽力而为）** —— 读不到就 `null`，绝不让它影响持仓那一路。
   *
   * ## 模拟盘读本地钱包，实盘读交易所（用户 2026-10-27 需求）
   *
   * 原来的注释写的是"模拟盘的持仓不来自交易所，但账户余额仍然只能问交易所" ——
   * 那是旧的设计。用户明确要求「模拟盘不应该根据真实钱包的余额，而应该可以
   * 自定义模拟盘的余额」，所以现在模拟盘的账户读数由**本地台账**折算：
   *
   * ```
   *   walletBalance = 模拟起始余额 + 已实现净盈亏
   *   unrealizedPnl = Σ 各持仓按标记价算出的浮盈
   * ```
   *
   * 这与交易循环里 `paperAccountStateOf()` 用的是**同一套数字**，所以控制台看到的
   * 余额与机器人决策时看到的余额不会打架。
   *
   * ⚠️ 纯模拟盘（`exchangeAccountId === null`）**根本没有账户可问** ——
   * 走旧路径会永远返回 `null`，界面上显示成"读不到余额"，看起来像坏了。
   */
  const readAccountBestEffort = async (trader: Trader): Promise<ExchangeAccountState | null> => {
    try {
      if (isPaperTrader(trader.id)) {
        /*
         * 浮盈要按标记价算 —— 与 `paperMarkPrices()` 同一来源（公开行情，
         * 不需要该账户有凭据）。
         */
        const local = positionStore.open(trader.id);
        const marks = await paperMarkPrices(local);
        const starting = deps.manager.paperStartingBalanceOf(trader.id);
        const realized = tradeStore.lifetimeNetPnl(trader.id);
        let unrealizedPnl = 0;
        let marginUsed = 0;
        for (const position of local) {
          marginUsed += Number.isFinite(position.margin_used) ? position.margin_used : 0;
          const mark = marks.get(position.symbol);
          if (mark === undefined) continue;
          const diff =
            position.side === 'long'
              ? (mark - position.entry_price) * position.quantity
              : (position.entry_price - mark) * position.quantity;
          if (Number.isFinite(diff)) unrealizedPnl += diff;
        }
        return paperAccountState({ startingBalance: starting, realizedPnl: realized, unrealizedPnl, marginUsed });
      }
      const connection = await openReadOnlyFor(trader);
      if (!connection) return null;
      return await connection.broker.getAccountState();
    } catch (error) {
      /*
       * 不静默：账户读数失败要留下原因。
       * 原来这里是空 `catch`，于是"为什么余额是空的"完全无法从日志判断 ——
       * 而这正是模拟盘刚接上本地钱包时最容易出错的地方（字段名、单位、空值）。
       */
      log.warn(`[trader ${trader.id}] 账户读数失败：${(error as Error).message}`);
      return null;
    }
  };

  /**
   * 用**公共行情**给本地台账配标记价（模拟盘专用）。
   *
   * ⚠️ 走 `deps.publicConnection` 而**不是**用凭据建的那条只读连接：标记价是
   * **公开行情**，不需要签名，也不需要该账户有凭据。顺带避免"为了给一个模拟仓
   * 算浮盈而去解密交易所密钥"这种越界。
   *
   * 读不到就让浮盈按 0 计，并由调用方把标的报出来（不静默 —— 见 `ownUnrealizedPnlOf`）。
   */
  const paperMarkPrices = async (
    local: ReadonlyArray<{ symbol: string }>,
  ): Promise<Map<string, number>> => {
    const marks = new Map<string, number>();
    if (local.length === 0) return marks;
    const want = new Set(local.map((p) => p.symbol));
    const premiums = await deps.publicConnection.market.premiumIndex().catch(() => []);
    for (const premium of premiums) {
      if (!want.has(premium.symbol)) continue;
      const value = Number(premium.markPrice);
      if (Number.isFinite(value) && value > 0) marks.set(premium.symbol, value);
    }
    return marks;
  };

  /**
   * Read the exchange directly for a trader's live account and positions.
   *
   * Uses a throwaway read-only connection so the console always shows what the
   * exchange actually holds, rather than our local mirror — the whole point of
   * having a reconciliation loop is that the mirror can be wrong.
   *
   * ⚠️ **一个例外：模拟盘（`dry_run`）机器人。** 交易所对它**不是**真相来源 ——
   * 它的仓位在交易所根本不存在，用它只会得到"空持仓"。见 `PositionsSource` 的说明。
   */
  const liveExchangeView = async (traderId: number) => {
    const trader = traders.get(traderId);
    if (!trader || !deps.manager.isRunning(traderId)) {
      return {
        live: false,
        account: null,
        positions: [] as PositionView[],
        positionsSource: 'none' as PositionsSource,
        error: undefined as string | undefined,
      };
    }
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️ **模拟盘（`dry_run`）在这里就短路 —— 在解密凭据、建连接之前**
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 为什么必须短路（而不是连接成功之后再换持仓来源）
     *
     * 如果先连交易所、再按 `paper` 决定用哪份持仓，那么**交易所一抖动就会走
     * `catch`**，于是模拟盘拿到 `live: false` → `/positions` 回 **503**。
     * 那正是本仓最忌讳的形态：用户看到的是"读不到持仓"，而他手里的模拟仓
     * **根本不需要交易所** —— 一次无关的网络故障让它闪烁，比不修还糟。
     *
     * ## 短路之后各字段从哪来
     *
     * · `positions`  —— **本地台账** + 公共行情的标记价（模拟盘的真相就是它）
     * · `openOrderCount` —— 本地 `pending` 行数（模拟盘的委托从不出现在交易所）
     * · `ownUnrealizedPnl` —— 同一个 `ownUnrealizedPnlOf`（与实盘同一个算式）
     * · `account`   —— **仍然尽力问交易所**（账户余额是账户级事实）；
     *                  读不到就 `null`，**不影响上面三个数字**
     *
     * ## 实盘一个字段都没动
     *
     * 下面 `try` 里那条路对 `paper === false` 的机器人是**逐字节原样**。
     */
    if (isPaperTrader(traderId)) {
      const local = positionStore.open(traderId);
      const marks = await paperMarkPrices(local);
      const own = ownUnrealizedPnlOf(local, (symbol) => marks.get(symbol));
      if (own.missingMarkPrice.length > 0) {
        log.warn(
          `[trader ${traderId}] 这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：${own.missingMarkPrice.join('、')}`,
        );
      }
      return {
        live: true,
        account: await readAccountBestEffort(trader),
        positions: localPositionsFor(traderId, marks),
        positionsSource: 'local_mirror' as PositionsSource,
        ownUnrealizedPnl: own.unrealizedPnl,
        openOrderCount: positionStore.pending(traderId).length,
        error: undefined as string | undefined,
      };
    }
    try {
      /*
       * 建一条**只读**交易所连接。`deps.openReadOnlyConnection` 是**测试用**的
       * 注入口 —— 见 `ApiDependencies` 上那个字段的说明（不传时行为与改动前相同）。
       */
      const connection = await openReadOnlyFor(trader);
      if (!connection)
        return {
          live: false,
          account: null,
          positions: [] as PositionView[],
          positionsSource: 'none' as PositionsSource,
          error: '找不到该凭据',
        };
      const [account, livePositions, liveOrders] = await Promise.all([
        connection.broker.getAccountState(),
        connection.broker.getPositions(),
        /*
         * ⚠️ **挂单数必须由这里给，不能让界面用 WebSocket 镜像去数。**
         *
         * 用户 2026-10-08 报：「有 3 个挂单，为什么上面不显示保证金占用？」
         * 卡片写 0.00、而下方「挂单占用」写 26.74。
         *
         * 根因：卡片判断"是否空仓"用的是 `live?.orders`（**WebSocket 镜像**），
         * 那个镜像在推送断开/重连时是**空的**，于是它以为"没有任何挂单"，
         * 走了"空仓 ⇒ 占用为 0"那条推算；而下方「当前委托」的角标是表格
         * **自己调接口**数出来的 3。**同一屏两个数来自两个时效，于是自相矛盾。**
         *
         * 与持仓同一个道理（`positions` 也是从交易所实时读的）：
         * 判断"有没有东西占着保证金"这件事，**必须问交易所，不能问镜像**。
         */
        connection.broker.getOpenOrders(),
      ]);
      // Layer the local records (stop/target ids, peak PnL, entry reasoning) on
      // top of the exchange's truth.
      const local = positionStore.open(traderId);
      const bySymbol = new Map(local.map((p) => [p.symbol, p]));
      /*
       * 显式标成 `PositionView[]`：这条路由的契约就是它（`docs/API.md`），
       * 而内联对象字面量在 `app.get()` 里没有任何类型约束 —— 字段名写错（`marginTyp`）
       * 只会静默多一个没人读的键，前端拿到的一直是 `undefined`（界面 `—`）。
       * 加上这一层，`tsc` 就能替这条"改了但没接线"的路径把关。
       */
      const exchangePositions: PositionView[] = livePositions.map((live) => {
        const record = bySymbol.get(live.symbol);
        return {
          id: record?.id ?? 0,
          traderId,
          symbol: live.symbol,
          side: live.side,
          quantity: live.quantity,
          entryPrice: live.entryPrice,
          markPrice: live.markPrice,
          leverage: live.leverage,
          liquidationPrice: live.liquidationPrice,
          unrealizedPnl: live.unrealizedPnl,
          unrealizedPnlPercent: live.unrealizedPnlPercent,
          peakPnlPercent: record?.peak_pnl_percent ?? 0,
          marginUsed: live.marginUsed,
          /*
           * 保证金模式（全仓 / 逐仓）—— 订单记录那列的**当前配置兜底来源**。
           *
           * 它读自交易所的 `positionRisk`（`broker.getPositions()`），是**实时**的账户配置，
           * 而**不是这张单下单时的历史快照**（那是 `OrderRecord.marginType`）。
           * 界面对这两个口径分得很清：落库值优先，缺失时才用这一份，并明说它是当前值。
           *
           * 再收一次口：`ExchangePosition.marginType` 的类型来自 `binance/types.ts` 的声明，
           * 运行期拿到的是交易所原样的字符串 —— 认不出的写法宁可当"不知道"（前端显示 `—`），
           * 也绝不猜成 `'cross'`。
           */
          marginType: normalizeMarginMode(live.marginType) ?? undefined,
          notional: live.notional,
          stopLoss: record?.stop_loss ?? null,
          takeProfit: record?.take_profit ?? null,
          openedAt: record?.opened_at ?? new Date().toISOString(),
          openReasoning: record?.open_reasoning ?? '',
        };
      });
      /*
       * ⚠️ **本机器人的浮盈必须按它自己的入场价算，不能拿交易所的合并持仓。**
       *
       * 独立验收（2026-10-07）连着指出两次，第二次是对的：
       *
       *  · 第一版直接对 `livePositions` 求和 —— 那是**整个账户**的持仓。
       *  · 第二版按 symbol 过滤后求和 —— 好一些，但同一账户里**两台机器人做同一个币**时，
       *    交易所的 `positionRisk` 只给一条**合并净头寸**，浮盈照旧被合并、两者互相污染。
       *
       * 正确答案在仓库里已经有了：`ownUnrealizedPnlOf()` —— 它用**本机器人自己**的
       * `entry_price × quantity × 标记价` 算，与交易所怎么合并无关，而且会回报
       * "哪些标的缺标记价"（缺了就跳过，不拿 0 冒充）。快照写入路径（`autoTrader`）
       * 一直在用它 —— 所以这里再自己写一遍的话，同屏会出现两个"本机器人浮盈"
       * 且数值不同。**同一个算式只留一份。**
       *
       * `positions` 列表保持原样：它是账户级视图，持仓卡与账户条都依赖它。
       */
      const markPriceOf = new Map(livePositions.map((live) => [live.symbol, live.markPrice]));
      /*
       * ⚠️ **交易所没有的标的要回落到【行情】标记价**（2026-10-15 修）
       *
       * `dry_run`（模拟盘）机器人的本地持仓**在交易所不存在** → 这里恒缺标记价 →
       * 那个仓的浮盈被按 0 计入首页数字，而界面上看不出异样（数字看着正常）。
       * 线上实测（`#11`）：每 5 秒一条
       * ```
       *   这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：SOLUSDT
       * ```
       * 而那个 SOLUSDT 空头是**模拟仓** —— 交易所侧本来就没有它。
       *
       * 标记价是**行情事实**（对所有机器人相同），借它不引入归属错误 ——
       * 与"借用交易所 `markPrice`"是同一条理由（见上面 `ownUnrealizedPnlOf` 那段）。
       *
       * ⚠️ 只对交易所**没有**的标的去查行情：有的话仍用交易所那个数 ——
       * 它是这个账户的实际结算依据。
       */
      const missingMark = local.map((p) => p.symbol).filter((symbol) => !markPriceOf.has(symbol));
      if (missingMark.length > 0) {
        const want = new Set(missingMark);
        const premiums = await connection.market.premiumIndex().catch(() => []);
        for (const premium of premiums) {
          if (!want.has(premium.symbol)) continue;
          const value = Number(premium.markPrice);
          if (Number.isFinite(value) && value > 0) markPriceOf.set(premium.symbol, value);
        }
      }
      const own = ownUnrealizedPnlOf(local, (symbol) => markPriceOf.get(symbol));
      /*
       * ⚠️ **缺标记价的标的必须说出来，不能静默按 0 计。**
       *
       * `ownUnrealizedPnlOf` 的返回值里专门有 `missingMarkPrice`，而它的注释
       * （`repositories.ts:3604`）写明"必须有人能说出来"—— 快照那条路径
       * （`autoTrader.ts:9619`）就解构并 `emit('warn')` 了。
       * 独立验收 2026-10-07 抓到：这条新路由把那一半丢掉了 —— 同一个函数两处调用，
       * 一处上报、一处静默。
       *
       * 触发条件：本地有 `open` 行、而交易所该 symbol 已无 `positionRisk`
       * （外部平仓 / 本地未同步）→ 那个仓的浮盈会被当成 0，界面看不出异样。
       */
      if (own.missingMarkPrice.length > 0) {
        log.warn(
          `[trader ${traderId}] 这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：${own.missingMarkPrice.join('、')}`,
        );
      }
      const ownUnrealizedPnl = own.unrealizedPnl;
      /*
       * ── 持仓到底该问谁 ────────────────────────────────────────────────────
       *
       * ⚠️ **模拟盘（`dry_run`）机器人的持仓只存在于本地台账。**
       *
       * 上面那段注释（`dry_run` 机器人恒缺标记价）已经写明了这个事实的一半：
       * 交易所侧**本来就没有**它的仓。当时只把"浮盈"那一路改成用本地台账算，
       * 而 `positions` 被刻意留成账户级视图 —— 于是出现用户实测两次的那个矛盾：
       * 卡片「持仓 0 / 保证金占用 0.00」，同一张卡里却有「浮动 +$0.32」。
       *
       * **浮盈不可能是 0 持仓** —— 两个数字来自不同的来源，而界面上看不出来。
       * 所以这里按来源分流，并把来源随响应交给前端（`positionsSource`）：
       * 前端再没有"猜"的余地。
       *
       * ⚠️ **实盘（非纸面）分支逐字节不变**：`paper === false` 时用的还是上面那份
       * `exchangePositions`，一个字段都没动。
       *
       * ⚠️ 标记价用的是**同一个** `markPriceOf`（上面刚补过行情回落），
       * 所以持仓数、保证金占用、浮动盈亏三个数字**同口径** —— 这正是
       * 「同屏三个数字互相矛盾」那个老问题的解法。
       */
      const paper = isPaperTrader(traderId);
      const positions: PositionView[] = paper
        ? localPositionsFor(traderId, markPriceOf)
        : exchangePositions;
      /*
       * ⚠️ **挂单数也要跟着来源走**（同一族的次生矛盾）。
       *
       * `openOrderCount` 的用途是让卡片回答"有没有东西占着保证金"，而模拟盘的
       * 委托**从不出现在交易所**（`broker.ts` 的 `simulateStandard` 路径）——
       * 问交易所只会恒得 0。本地那张 `status='pending'` 的行才是它的挂单。
       *
       * 实盘分支仍然问交易所：那个镜像在推送断开时可能是空的，而"有没有挂单"
       * 必须问交易所（见上面 `getOpenOrders` 那段实测）。
       */
      const openOrderCount = paper ? positionStore.pending(traderId).length : liveOrders.length;
      /*
       * `openOrderCount` 是**挂单数** —— 卡片用它判断"有没有东西占着保证金"。
       * 只给数量、不传订单明细：界面要的只是"空不空"（明细由「当前委托」那张表自己查）。
       *
       * ⚠️ 它的**来源跟着 `positionsSource` 一起变**（模拟盘问本地、实盘问交易所）——
       * 见上面 `openOrderCount` 那段的理由。混用会让"0 持仓却有挂单占用"再次出现。
       */
      return {
        live: true,
        account,
        positions,
        positionsSource: (paper ? 'local_mirror' : 'exchange') as PositionsSource,
        ownUnrealizedPnl,
        openOrderCount,
        error: undefined as string | undefined,
      };
    } catch (error) {
      /*
       * ⚠️ **这条日志是必须的，不是可选的。**
       *
       * 这个 `catch` 原来**什么都不打**：交易所读失败时静默返回 `live: false`，
       * 而调用方会把它当成"机器人没在跑"、回退到本地镜像 —— 于是界面上出现
       * 一个已经不存在的持仓、几秒后又消失（用户报的那个现象）。
       *
       * 那种故障**没有留下任何痕迹**，只能靠盯着界面看。一条 warn 让"到底是不是
       * 交易所读数在失败"变成一个可以查的问题。频率有上限：控制台的持仓轮询
       * 是 30 秒一次，所以最坏也只是每 30 秒一行。
       */
      log.warn(`机器人 #${traderId} 的交易所读数失败，本轮不回退到本地镜像：${(error as Error).message}`);
      return {
        live: false,
        account: null,
        positions: [] as PositionView[],
        positionsSource: 'none' as PositionsSource,
        error: (error as Error).message,
      };
    }
  };

  /**
   * 统计 + **熔断器的当前读数**。
   *
   * ## 熔断读数为什么挂在响应上、而不是进 `TraderStats`
   *
   * `TraderStats` 是**仓储层**算出来的纯统计（只读数据库）。而熔断读数依赖
   * **运行时真实生效的那份配置**（AI 托管下来自 `traders.agent_config_json`，
   * 与策略表里那份可能不同）与进程内的最新权益 —— 让仓储去重算它，既多两趟查询，
   * 又可能算出与交易循环不一致的答案。
   *
   * ## 它回答的是哪一个问题
   *
   * 熔断生效时交易循环会**跳过整个周期**（连模型都不问），所以操作员看到的是：
   * 状态 running、权益一动不动、决策流里一条 `skipped` —— 而**没有任何一处说
   * "它被熔断了、以及怎么解除"**。这个字段就是那一处。
   *
   * 机器人在**停止**时是 `null`（那时没有内存里的配置可用来判定），
   * 客户端据此不渲染那一行 —— 而不是渲染成"没有熔断"。
   */
  app.get('/api/traders/:id/stats', authed, async (request, reply) => {
    const id = idOf(request);
    /*
     * ⚠️ **不存在的机器人必须回 404，不能回 200 + 全零**（外部 issue #162）。
     *
     * 原来这里不检查存在性：`computeTraderStats()` 走的是 SQL 聚合
     *（`aggregateTrades()` 的 `COUNT(*)` / `SUM(...)`），一个不存在的 id 会得到
     * `COUNT = 0` 与 `SUM = NULL`（被兜底成 0）—— 于是响应是
     * **200 + 权益 0 / 收益 0% / 胜率 0%**。
     *
     * 而同一个资源族的 `/api/traders/:id/account`（下方几行）**是回 404 的**。
     * 两者不一致的后果不是"不好看"：**"权益 0"会被读成"这个机器人亏光了"** ——
     * 一个打错的 id、或一个刚被删掉的机器人，在界面上表现为"账户归零"。
     * 这个项目下的是真实订单，"权益 0"是最需要被当真的一类读数。
     *
     * 对齐 `/account` 的写法（同一句话、同一个状态码），
     * 这样两个端点在"机器人不存在"这件事上给出同一个答案。
     */
    const trader = traders.get(id);
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return {
      ...computeTraderStats(id),
      circuitBreaker: deps.manager.readCircuitBreaker(id),
      /*
       * 有效杠杆表盘的刻度。`null` = 读不到，前端显示"不知道"而不是 0 ——
       * 见 `manager.leverageCap()` 的说明。
       */
      maxLeverage: deps.manager.leverageCap(id),
      /*
       * 这个机器人自己在不在纸面模式。
       *
       * 与 `circuitBreaker` 同一个理由挂在响应上，而不是进 `TraderStats`：
       * 它是**运行时**的事实（`dryRun` 是启动参数、不落库），仓储层算不出来。
       *
       * `null` = 它没在运行 —— 客户端据此**不渲染**那一行，而不是渲染成「实盘」。
       * 顶栏那个徽章读的是进程级的 `env.dryRun`，两者可以不一致，所以必须分开说。
       */
      dryRun: deps.manager.dryRunOf(id),
    };
  });

  app.get('/api/traders/:id/positions', authed, async (request, reply) => {
    const id = idOf(request);
    const live = await liveExchangeView(id);

    /*
     * ── 读得到交易所就用交易所的；**读不到时不要拿本地镜像冒充** ──────────
     *
     * `live.live === false` 有**两个完全不同的原因**，而它们原来被当成了一回事：
     *
     *   1. **机器人没在跑** —— 此时本地镜像是唯一的真相，必须返回它；
     *   2. **读交易所失败**（网络抖动、限流、连接超时）—— 此时本地镜像**可能已经过期**：
     *      仓位刚在交易所平掉、而对账还没跑，本地那一行还写着 `open`。
     *
     * 第二种情况下把镜像返回出去，界面就会**先显示一个已经不存在的持仓、几秒后又
     * 让它消失**（用户的原话：「会显示不存在的订单（实际是没有的，会出现几秒钟
     * 然后又突然消失）」）。而本地镜像是**回退值**：它的权益、标记价、浮盈全是
     * 占位零（见 `localPositionsFor` 不给标记价的那条回落），也就是说那份"持仓"
     * 从数字上就不可信。
     *
     * ⚠️ **模拟盘（`dry_run`）不在"回退值"那一类里**：它的交易所读数恒为空，
     * 本地台账才是**它自己的真相**。所以 `liveExchangeView` 在那种情况下直接返回
     * 本地台账（`positionsSource: 'local_mirror'`），到这里 `live.live` 已经是 `true` ——
     * 下面那条 503 与"没在跑"的分支都不该被走到。
     *
     * **一个会闪烁的表格比一个说"读不到"的表格更糟** —— 前者让人怀疑整张表，
     * 后者只说明这一次读数没成功。所以这里回 503：前端拿到非 2xx 会**保留上一次
     * 成功的交易所读数**（`usePolled` 的既有行为），界面于是停在"最后一次真实读数"
     * 上，而不是跳到一个本地猜的版本。
     */
    if (live.live) return live.positions;

    if (live.error) {
      reply.code(503);
      return { error: `暂时读不到交易所持仓：${live.error}` };
    }

    /* 机器人没在跑 —— 本地镜像是唯一的真相，照旧返回。 */
    /*
     * ⚠️ **这条路上没有 `marginType`，那是刻意的**（不是漏了）。
     *
     * 保证金模式只存在于**交易所的逐标的配置**里：本地 `positions` 表从来没有这一列，
     * 而这条路径按设计**不读交易所**（机器人停了，读它没有意义）。所以这里给不出值，
     * 结果是 `undefined` → 界面显示 `—`。
     *
     * **不要用币安的默认值把它填成 `'cross'`**：那会让"读不到"与"确实是全仓"在界面上
     * 长得一模一样，而这个界面在别处（`marginUsed`、熔断读数、`dryRun`）已经明确
     * 选择了"不知道就说不知道"。
     */
    return localPositionsFor(id);
  });

  /** Live exchange view, so the console can show truth rather than our mirror. */
  app.get('/api/traders/:id/account', authed, async (request, reply) => {
    const trader = traders.get(idOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return liveExchangeView(trader.id);
  });

  /**
   * 账户上的**外部交易活动** —— 不属于本平台任何机器人的成交。
   *
   * ## 为什么是独立端点而不是塞进 `/account`
   *
   * `/account` 是**实时**读交易所的，而这个结论来自**最近一次对账**
   * （每 10 轮一次深扫）。两者时效性不同、失败方式也不同：交易所读不到时
   * `/account` 报错，而这个检测的结论**仍然有效**（来自上一次成功的对账）。
   * 混在一个响应里会让「哪个是实时、哪个是上次的」变得说不清。
   *
   * 机器人**停止之后**这个端点仍然能返回结论 —— 那正是最需要它的时刻：
   * 操作员看到余额不对，而机器人已经停了、不会再跑对账。
   */
  app.get('/api/traders/:id/foreign-activity', authed, (request, reply) => {
    const trader = traders.get(idOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return readForeignActivityFor(trader.id);
  });

  /**
   * 订单记录，**分页**返回；响应体是 `OrderRecord[]`，**形状没有变**
   * （老客户端与 `docs/API.md` 都照旧）。
   *
   * | 参数 | 说明 |
   * |---|---|
   * | `limit` | 一页多少条。默认 100，上限 `ORDER_PAGE_MAX`（200）——**钳制不报错** |
   * | `before` | 游标：只返回 `id` 比它更小的订单。第一页不传 |
   *
   * 上限的钳制在仓储层（`clampOrderLimit`），所以这里不做验证：
   * 一个手写的 `?limit=999999` 最坏也只是拿到 200 条，而不是把整张订单表
   * 拼成响应 —— 这张表随机器人运行无限增长，正是操作者说的"一次加载上万条卡死"。
   */
  app.get('/api/traders/:id/orders', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string };
    const limit = Number(query.limit ?? ORDER_PAGE_DEFAULT);
    // `before` 是非数字/缺失时按"第一页"处理：发不出正确游标的调用方应该拿到
    // 最新的一页，而不是一个 400（与 `limit` 的钳制同一个取舍）。
    const before = Number(query.before);
    return orderStore.list(idOf(request), limit, Number.isFinite(before) ? before : null);
  });

  /**
   * 成交记录，**分页**返回；响应体是 `TradeRecord[]`，**形状没有变**。
   *
   * 参数与 `/orders` 基本一致（`limit` 默认 100、上限 `TRADE_PAGE_MAX`），
   * 但**多一个 `beforeClosedAt`** —— 见下。
   *
   * ## 为什么成交要多一个游标参数（`/orders` 不需要）
   *
   * 用户报过：「**历史成交里面日期显示错乱（不是完全按时间排序）**」。
   *
   * 根因是 `trades.id` 是**插入顺序**，而**对账补录的行 id 更大、成交时刻却更早**
   * 实测 18 行里 4 处乱序。修法是**按 `closed_at` 排序**，而按时间排序之后，
   * 只用 `id` 做游标会让页边界漏行（补录行 id 大、时间早，会被 `id < cursor`
   * 整个跳过）。
   *
   * 所以成交列表用**复合游标** `(closed_at, id)`：`before` 给 id、
   * `beforeClosedAt` 给那一行的成交时刻。**两个都给才启用新行为**，只给
   * `before` 时退回按 id 分页 —— 老调用方（以及任何只发一个游标的脚本）
   * 行为与以前完全一致。
   */
  /**
   * ── **智能体审计**（`agent_runs` / `agent_experiments` / `agent_memory`）──
   *
   * ## 为什么要有这个端点（用户 2026-10-12 的要求）
   *
   * 用户理想中的团队要有「**汇报工作的**」角色，而团队模式的看板要能显示
   * 「有哪些智能体、都是什么分工、都在做什么」。
   *
   * 但这三张表**此前在前端完全不可见** —— 仓储层写得很完整
   *（`agentStore.recent()` 三个方法都有），**却没有任何 API 暴露它们**，
   * 于是 `web/src` 里对这三张表的引用是 **0 处**（考古报告 §5.2 记的就是这件事）。
   *
   * 结果是：AI 改了什么参数、反思出了什么教训、每个角色跑得怎么样 ——
   * **全都在库里，但操作员一条都看不到**。那等于没有审计。
   *
   * ## 一次返回三张表
   *
   * 合成一个响应而不是三个端点：界面上一块面板就要同时显示它们
   *（"这一轮做了什么 + 学到了什么 + 之前试过什么"），
   * 分三个请求会让面板出现三次加载闪烁。
   */
  app.get('/api/traders/:id/agent-audit', authed, (request) => {
    const traderId = idOf(request);
    const query = request.query as { limit?: string };
    const parsed = Number(query.limit ?? 20);
    /* 钳制而不报错 —— 与 `clampDecisionLimit` 同一个原则（界面传错不该 500）。 */
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 100) : 20;

    return {
      /** 每次角色运行（谁跑了、用了多少 token、多久）。 */
      runs: agentStoreRuns.recent(traderId, limit),
      /** 参数实验（改了什么 + 真实结果）。**这是"自我迭代"的审计线索。** */
      experiments: agentStoreExperiments.recent(traderId, limit),
      /** 教训记忆（按标的）。 */
      memory: agentStoreMemory.recent(traderId, limit),
      /** 待结算的实验数 —— 界面可以据此说"还有 N 个在等结果"。 */
      pendingExperiments: agentStoreExperiments.pending(traderId).length,
      /** 累计运行次数 —— 判断"这个机器人到底跑过多少次"。 */
      runCount: agentStoreRuns.countSince(traderId, '1970-01-01T00:00:00Z'),
    };
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **一个岗位"最近什么时候干过活" + "它干过的历史"**（2026-10-17 · t111）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户报的问题（这是他看到的原话）
   *
   * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
   *
   * ## 根因：界面只读了**一半**的数据源
   *
   * `TeamBoard` 的"最近活跃于 X 分钟前"原来只从 `decision_records.cot_trace` 里抽
   * （`lastSeenOf` 的正则 `- <role>（<model>）：`）。而**只有进了 `<team>` 块的角色**
   * 才有那种行 —— 实测只有分析师 / `bull` / `bear` / `judge`
   * （`agent/deskOutput.ts` 里 `lines.push` 的那四处）。
   *
   * 于是这三类角色在界面上**永远显示"待命"**，而它们在 `runtime_logs` 里出现得很频繁：
   * ```
   *   supervisor     ← 派发阶段，写的是 note('supervisor', …) → runtime_logs(scope='team')
   *   risk_officer   ← 风控阶段，onStep → runtime_logs(scope='team')
   *   reporter       ← 汇报阶段，onStep → runtime_logs(scope='team')
   * ```
   * 线上实测 `supervisor` 在 team 域出现 **31 次**（全系统最多），界面上却写"待命" ——
   * **界面在说谎，不是角色没跑**。
   *
   * ## 为什么在这里解析 `runtime_logs` 的文本，而不是新加一张表
   *
   * 团队每一步都会写一行 `[<phase>] <role>：<note>`（见 `manager.ts` 的 `onStep`），
   * 自检写的是 `[自检/<source>] …`（`scope='selfcheck'`）。
   * **两个数据源都已经存在、都已经带 traderId 与时刻** —— 加表或加列意味着迁移，
   * 而这次要的只是"把已有的东西读出来"。
   *
   * ⚠️ 代价是**解析文本**，所以下面两个正则都写成了**锚定形状**而不是"包含子串"：
   * 团队行的 `role` 段只允许 `[a-z_]+`（角色 id 的既有形状），
   * 这样 `[调研] 新闻未产出：…`（同样以 `[` 开头的另一种行）不会被误认成角色。
   *
   * ## 负向校准（这条判据本身也要可证伪）
   *
   * 只有"能解析出角色"才算数：解析不出就**返回空**，让界面退回它原来的判断，
   * 而不是拿一个猜出来的角色名去点亮编制表 —— 那会造出新的假出勤。
   */

  /*
   * 解析与合并逻辑都在**模块级**（`parseTeamStepLine` / `parseCotTraceRoles` /
   * `mergeRoleLastSeen`）—— 那里是纯函数、可被单元测试直接调用。
   * 这里不再重复定义（重复就会有两份判据，迟早漂移）。
   */

  /** 一个岗位最近一次被观察到干活的时刻（含来源，便于核对）。 */
  type RoleLastSeenLocal = RoleLastSeen;

  /**
   * 汇总"每个岗位最后一次露面"。
   *
   * 合并规则见模块级 `mergeRoleLastSeen()`（那里是纯函数、有单元测试）。
   * 这里只负责**取数**：把 `runtime_logs` 与 `decision_records` 里
   * 与本机器人相关的部分挑出来。
   */
  const collectLastSeen = (traderId: number, logLimit: number): RoleLastSeenLocal[] => {
    /*
     * ① `runtime_logs`：团队步骤 + 自检。
     *
     * ⚠️ `runtimeLogs.list()` 是**全局**的（全表最近 N 条），所以必须按
     * `traderId` 过滤 —— 多机器人共用一个进程时不过滤会把别人的出勤算到这个头上。
     * 同时接受 `traderId === null` 的行（进程级日志），与 `selfcheckRunner` 的口径一致。
     */
    const logs: Array<{ message: string; createdAt: string }> = [];
    let systemEngineerAt: string | null = null;
    for (const line of runtimeLogs.list(logLimit)) {
      if (line.traderId !== traderId && line.traderId !== null) continue;
      if (line.scope !== 'team' && line.scope !== 'selfcheck') continue;
      if (line.scope === 'selfcheck') {
        /*
         * 自检行没有角色名，但**它确实是 `system_engineer` 在干活**
         * （`manager.buildSelfCheckAsk()` 用 `tierForRole('system_engineer')`）。
         * 单独取最大时刻 —— 不能把整行文本塞给 `parseTeamStepLine`，
         * 那会命中 `[自检/ai] …` → 解析成 null，白跑一遍。
         */
        if (systemEngineerAt === null || line.createdAt > systemEngineerAt) {
          systemEngineerAt = line.createdAt;
        }
        continue;
      }
      logs.push({ message: line.message, createdAt: line.createdAt });
    }

    /* ② `decision_records.cot_trace`：进了 `<team>` 块的那些角色。 */
    const cots: Array<{ trace: string; timestamp: string }> = [];
    for (const record of decisionStore.list(traderId, DECISION_PAGE_DEFAULT)) {
      if (typeof record.cotTrace !== 'string' || record.cotTrace.length === 0) continue;
      cots.push({ trace: record.cotTrace, timestamp: record.timestamp });
    }

    return mergeRoleLastSeen(logs, cots, systemEngineerAt);
  };

  /**
   * 一个岗位的历史工作详情（**只读**）。
   *
   * 用户原话：「每个角色**增加一个可点击按钮，点击去以后能看他历史工作详情**」。
   *
   * 数据源与 `collectLastSeen` 同两个，但这里**保留全部条目**（不只是最后一次），
   * 且标明来源：`log` = 服务端直写的步骤日志；`cot` = 那一轮审计块里的产出摘要。
   */
  app.get('/api/traders/:id/agent/last-seen', authed, (request) => {
    const traderId = idOf(request);
    const parsed = Number((request.query as { limit?: string }).limit ?? RUNTIME_LOG_PAGE_DEFAULT);
    /* 钳制而不报错 —— 与其它端点同一原则（界面传错不该 500）。 */
    const logLimit = Number.isFinite(parsed)
      ? Math.min(Math.max(1, Math.trunc(parsed)), RUNTIME_LOG_CAP)
      : RUNTIME_LOG_PAGE_DEFAULT;

    return { roles: collectLastSeen(traderId, logLimit) };
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  **机器人控制**（2026-10-18）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户要一个标签，专门放**实时生效**（不需要重启机器人）的配置：
   * > 「是实时生效的那种（不受机器人运行影响），运行中机器人改了这里配置也会更
   * >   马上生效的，以后我计划放很多功能进去，目前只需要做一个功能：JEV 模型开关」
   *
   * ## 为什么是独立一组端点，而不是塞进 `/api/settings`
   *
   * `settings` 表是**通用 key-value**（`agent_last_wake`、`foreign_activity:8` 都在里面），
   * 那组端点没有"这是哪个机器人的开关"的概念。而这里的开关：
   * ```
   *   ① 有明确的语义（每个都在 `RUNTIME_SWITCHES` 里定义了 label + effect）
   *   ② 要能回答"现在这个值是界面设的、还是 .env 带来的"
   * ```
   * 后者对操作员很重要 —— 见 `SwitchState.source` 的注释。
   *
   * ## 加新功能时不用改这里
   *
   * 往 `trader/control.ts` 的 `RUNTIME_SWITCHES` 加一行，这两个端点自动支持。
   */
  app.get('/api/traders/:id/control', authed, (request) => {
    /* `idOf` 仍要调：它校验 id 是正整数（否则 400），与其它端点同一套纪律。 */
    idOf(request);
    return { switches: listSwitches() };
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  **JEV 模式的可调选项**（2026-10-19）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户要求：「要有开关（像团队模式一样，这边增加 P3 选项和其他你觉得必要的
   * 选项，**不要全部写死**）」。
   *
   * 与 `/control` 那组的分工：
   * ```
   *   /control        → 布尔开关（Jev 初筛开/关）
   *   /jev-options    → JEV 模式专属的枚举/数字/布尔配置
   * ```
   * 分成两组是因为**它们的作用域不同**：初筛开关影响整个团队模式，
   * 而这里的选项只影响 `mode === 'jev'` 的机器人。
   */
  app.get('/api/traders/:id/jev-options', authed, (request) => {
    idOf(request);
    return { options: listJevOptions() };
  });

  app.post('/api/traders/:id/jev-options/:key', authed, async (request, reply) => {
    idOf(request);
    const key = String((request.params as { key: string }).key);
    const body = (request.body ?? {}) as { value?: unknown };

    const spec = jevOptionSpec(key);
    if (spec === null) {
      return reply.code(400).send({ error: `没有这个选项：${key}` });
    }
    if (typeof body.value !== 'string' && typeof body.value !== 'number') {
      return reply.code(400).send({ error: '需要 { value: "…" }' });
    }
    const raw = String(body.value);

    /*
     * ⚠️ **逐类型校验，并且说清哪里不对**。
     *
     * 静默接受一个非法值（例如把置信度设成 500）会让"界面显示 500、实际行为
     * 是 100"这种事发生 —— 而那是最难查的一类不一致。
     */
    if (spec.kind === 'enum') {
      const allowed = spec.options?.map((o) => o.value) ?? [];
      if (!allowed.includes(raw)) {
        return reply
          .code(400)
          .send({ error: `「${spec.label}」只能是：${allowed.join(' / ')}` });
      }
    } else if (spec.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return reply.code(400).send({ error: `「${spec.label}」必须是数字` });
      }
      if (spec.range !== undefined && (n < spec.range.min || n > spec.range.max)) {
        return reply
          .code(400)
          .send({
            error: `「${spec.label}」必须在 ${spec.range.min} ~ ${spec.range.max} ${spec.range.unit} 之间`,
          });
      }
    } else {
      if (raw !== 'on' && raw !== 'off') {
        return reply.code(400).send({ error: `「${spec.label}」只能是 on / off` });
      }
    }

    setJevOption(key, raw);
    /* 回读一次 —— 与 `/control` 同一条纪律：界面显示的必须是此刻的值。 */
    return { options: listJevOptions() };
  });

  app.post('/api/traders/:id/control/:key', authed, async (request, reply) => {
    /*
     * ⚠️ **`idOf` 的校验结果不参与"改哪个开关"** —— 开关是全局的（
     * 与机器人无关：Jev 一旦关掉，任何机器人都不会再调用它）。
     * 但 id 仍要合法，否则说明前端传错了。
     */
    idOf(request);
    const key = String((request.params as { key: string }).key);
    const body = (request.body ?? {}) as { on?: unknown };

    if (typeof body.on !== 'boolean') {
      return reply.code(400).send({ error: '需要 { on: true|false }' });
    }
    /*
     * 未知 key → **400 并说清是哪个**。
     * 不要静默接受：那会让前端以为开关生效了（而实际什么都没改）。
     */
    if (switchSpec(key) === null) {
      return reply.code(400).send({ error: `没有这个开关：${key}` });
    }

    setSwitch(key, body.on);
    /*
     * 回读一次当前状态 —— 前端直接用返回值刷新，不必再发一次 GET
     * （两次请求之间可能被别人改掉，回读保证"界面显示的一定是此刻的值"）。
     */
    return { switches: listSwitches() };
  });

  app.get('/api/traders/:id/agent/:role/steps', authed, (request) => {
    const traderId = idOf(request);
    const role = String((request.params as { role: string }).role);
    /*
     * 角色 id 只允许 `[a-z_]+`：这条**不是安全边界**（参数是走 SQL 参数化的），
     * 而是**判据的诚实性** —— 一个含中文/空格的 role 必然匹配不到任何真实行，
     * 提前返回空比让它去扫一遍表更清楚。
     */
    if (!/^[a-z][a-z_]*$/.test(role)) {
      return { role, steps: [], lastSeenAt: null };
    }

    const parsed = Number((request.query as { limit?: string }).limit ?? 50);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 200) : 50;

    type Step = { at: string; phase: string | null; message: string; source: 'log' | 'cot' };
    const steps: Step[] = [];

    /* ① 服务端步骤日志（团队 + 自检）。 */
    for (const line of runtimeLogs.list(RUNTIME_LOG_CAP)) {
      if (line.traderId !== traderId && line.traderId !== null) continue;
      if (line.scope !== 'team' && line.scope !== 'selfcheck') continue;
      const step = parseTeamStepLine(line.message);
      if (step !== null) {
        if (step.role === role) {
          steps.push({ at: line.createdAt, phase: step.phase, message: step.note, source: 'log' });
        }
        continue;
      }
      /* 自检行归到 `system_engineer`（理由见 `collectLastSeen`）。 */
      if (line.scope === 'selfcheck' && role === 'system_engineer') {
        steps.push({ at: line.createdAt, phase: 'selfcheck', message: line.message, source: 'log' });
      }
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ②-b **`dispatch` scope 的按币并行产出**（2026-10-18 · 用户实测）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 用户看到的现象
     *
     * > 「标的侦查员」在岗，历史工作详情显示「共 0 条」「它在岗，但确实一次都没被叫到过」
     *
     * ## 真相
     *
     * 它**每一轮都在跑**，`runtime_logs` 里明确写着：
     * ```
     *   [dispatch] supervisor：按币并行：18 个标的，并发 4
     *   [dispatch] supervisor：按币并行完成：成功 16 · 失败 2 · 并发峰值 4
     * ```
     * 但这个端点只扫 `scope IN ('team','selfcheck')` ⇒ 把 `dispatch` 全漏了。
     *
     * ⇒ **"0 条"是查询漏了一张表，不是它没工作。** 这类假警报比没有面板更糟：
     *   它让人去查一个不存在的问题。
     */
    if (role === 'symbol_scout' || role === 'per_symbol') {
      for (const line of runtimeLogs.list(RUNTIME_LOG_CAP)) {
        if (line.traderId !== traderId && line.traderId !== null) continue;
        /*
         * ⚠️ **它的 scope 是 `team`，`[dispatch]` 只是消息前缀**（2026-10-18 实测纠正）。
         *
         * 我第一版写成 `line.scope !== 'dispatch'`，于是永远匹配不到 —— 实测
         * `SELECT scope FROM runtime_logs WHERE message LIKE '%按币并行%'` 得到的
         * 20 条全部是 `team`。判据要按**消息前缀**，不是 scope。
         */
        if (!line.message.startsWith('[dispatch]')) continue;
        steps.push({ at: line.createdAt, phase: 'dispatch', message: line.message, source: 'log' });
      }
    }

    /*
     * ②-c 复盘员的产出在 `agent_memory`（每笔平仓后的教训），不在 `agent_runs`。
     *      实测 #11 有 52 条，而面板显示 0 —— 同一个"查错表"问题。
     */
    if (role === 'reviewer' || role === 'memory_curator') {
      for (const m of agentStoreMemory.recent(traderId, 50)) {
        steps.push({
          at: m.createdAt,
          phase: 'lesson',
          message:
            `${m.symbol} · ${m.closeReason} · 净 ${m.netPnl >= 0 ? '+' : ''}${m.netPnl.toFixed(4)} USDT\n` +
            m.lesson,
          source: 'log',
        });
      }
    }

    /*
     * ②-d 策略师的产出在 `agent_experiments`（每次调参与者与结果），不在 `agent_runs`。
     *      实测 #11 有 29 条实验。
     */
    if (role === 'strategist') {
      for (const e of agentStoreExperiments.recent(traderId, 50)) {
        const outcome =
          e.outcomeNetPnl === null
            ? ''
            : `（${e.outcomeTrades ?? 0} 笔后结果 ${e.outcomeNetPnl >= 0 ? '+' : ''}${e.outcomeNetPnl.toFixed(4)} USDT）`;
        steps.push({
          at: e.createdAt,
          phase: 'experiment',
          message: `${e.reason || e.trigger || '参数实验'}${outcome}`,
          source: 'log',
        });
      }
    }

    /* ③ 审计块里的角色产出（那一轮它交出的原文摘要）。 */
    for (const record of decisionStore.list(traderId, DECISION_PAGE_DEFAULT)) {
      if (typeof record.cotTrace !== 'string' || record.cotTrace.length === 0) continue;
      for (const line of record.cotTrace.split('\n')) {
        const m = /^- ([a-z_]+)（[^）]*）：([\s\S]*)$/.exec(line);
        if (m === null || m[1] !== role) continue;
        steps.push({ at: record.timestamp, phase: null, message: m[2]!, source: 'cot' });
      }
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️ **丢掉正文为空的条目**（2026-10-18 · 用户：「大片空白的，是给人看的吗？」）
     * ══════════════════════════════════════════════════════════════════════
     *
     * `cotTrace` 里有一批行是 `- judge（模型）：` 后面**什么都没有**（模型这一轮
     * 只调了工具、没产出文字）。端点把它们当正常条目推出去，界面上就只剩一个时间戳 ——
     * 实测 12 条里有 9 条是空的，整页几乎全是空白。
     *
     * ⇒ 在这里过滤，**不要靠前端隐藏**：空条目会占掉 `limit` 的名额，
     *   把真正有内容的记录挤出去（用户看到的是"最近 12 条"，
     *   而其中 9 条是空的、更早的有内容的反而看不到）。
     *
     * 判据是"去掉空白后长度为 0" —— 只含换行/空格的也算空。
     */
    const nonEmpty = steps.filter((s) => s.message.trim().length > 0);

    /* 新的在前 —— 界面点开先看"最近发生了什么"。 */
    nonEmpty.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const trimmed = nonEmpty.slice(0, limit);

    return {
      role,
      /*
       * `total` 让界面能如实说"还有 N 条更早的"（而不是假装这就是全部）。
       * **它数的是过滤后的**：空条目不是"看不到的内容"，它本来就没内容。
       */
      total: nonEmpty.length,
      steps: trimmed,
      lastSeenAt: trimmed.length > 0 ? trimmed[0]!.at : null,
    };
  });

  /**
   * **跑一次自检**（用户需求 #6）。
   *
   * ## 用户的原话（这是本端点存在的理由）
   *
   * > 「你迭代更新系统得搞智能体团队**持续观察、测试**，然后反馈给你做相应得处理，
   * >  **不要有任何 BUG，也不要老让我来测试和发现问题，你要自己发现问题自己解决**」
   *
   * > 「本地开发 + 服务器运行都要有 **AI 自检、问题留痕**」
   *
   * ## 为什么是 POST 而不是 GET
   *
   * 它会**写库**（发现落进 `runtime_logs` 的 `selfcheck` scope）——
   * GET 不该有副作用。而且它是一次真实的检查动作，不是读既有结果。
   *
   * ## 为什么既返回结果又写日志
   *
   * 两处都要：
   *   · **返回结果** → 调用方（界面按钮、我的脚本）能立刻看到；
   *   · **写日志** → 留痕。用户要"下次唤醒时能快速定位"，
   *     而日志是唯一**跨会话持久**的地方（进程重启也在）。
   *
   * ## 目前只跑确定性层
   *
   * 不依赖模型 —— 因为**模型挂掉的时候恰恰最需要自检**。
   * AI 层建在这一层之上，见 `selfcheckRunner.runSelfCheck` 的 `ask` 参数。
   */
  app.post('/api/traders/:id/selfcheck', authed, async (request) => {
    const traderId = idOf(request);
    const query = request.query as { windowHours?: string };
    const parsed = Number(query.windowHours ?? 6);
    /* 钳制而不报错 —— 与其它端点同一原则。 */
    const windowHours = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 168) : 6;

    const result = await runSelfCheck(traderId, { windowHours });
    return {
      windowHours: result.evidence.windowHours,
      deterministic: result.deterministic,
      ai: result.ai,
      evidence: result.evidence,
    };
  });

  app.get('/api/traders/:id/trades', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string; beforeClosedAt?: string };
    const limit = Number(query.limit ?? TRADE_PAGE_DEFAULT);
    const before = Number(query.before);
    return tradeStore.list(
      idOf(request),
      limit,
      Number.isFinite(before) ? before : null,
      typeof query.beforeClosedAt === 'string' && query.beforeClosedAt.length > 0
        ? query.beforeClosedAt
        : null,
    );
  });

  /**
   * 决策记录，**分页**返回；响应体是 `DecisionRecord[]`，**形状没有变**
   * （老客户端、`docs/API.md` 与"全部记录"页都照旧）。
   *
   * | 参数 | 说明 |
   * |---|---|
   * | `limit` | 一页多少条。默认 50，上限 `DECISION_PAGE_MAX`（200）——**钳制不报错** |
   * | `before` | 游标：只返回 `id` 比它更小的记录。第一页不传 |
   *
   * 上限的钳制在仓储层（`clampDecisionLimit`），所以这里不做验证：
   * 一个手写的 `?limit=999999` 最坏也只是拿到 200 条，
   * 而不是把整个决策史（含完整提示词）一次性拼成响应。
   */
  app.get('/api/traders/:id/decisions', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string };
    const limit = Number(query.limit ?? DECISION_PAGE_DEFAULT);
    // `before` 是新参数，非数字/缺失一律按"第一页"处理：发不出正确游标的调用方
    // 应该拿到最新的一页，而不是一个 400。
    const before = Number(query.before);
    const records = decisionStore.list(idOf(request), limit, Number.isFinite(before) ? before : null);
    /*
     * ⚠️ **列表绝不返回提示词全文。**
     *
     * 用户 2026-10-07 报"页面加载几十秒"。实测：`decision_records` 只有 910 行，
     * 但 `user_prompt` 一个字段就 **81.6 MB**（单条最大 283 KB）。而这一页返回
     * 30 条，每条约 90 KB → **一次列表 ≈ 2.7 MB JSON**，浏览器下载 + 解析几十秒。
     *
     * 数据库本身不慢（元数据 30 条 4ms、含全文 62ms，索引齐全）——
     * 慢的是**把不该传的东西传到了浏览器**。
     *
     * 提示词只在用户点开「提示词」标签时才需要，那时由
     * `GET /traders/:id/decisions/:recordId` 单条取（详情接口本来就有）。
     */
    return records.map((record) => ({ ...record, systemPrompt: '', userPrompt: '' }));
  });

  app.get('/api/traders/:id/decisions/:recordId', authed, async (request, reply) => {
    const recordId = Number((request.params as { recordId: string }).recordId);
    const record = decisionStore.get(recordId);
    if (!record || record.traderId !== idOf(request)) {
      return reply.code(404).send({ error: '找不到该决策记录' });
    }
    return record;
  });

  app.get('/api/traders/:id/equity', authed, async (request) => {
    /*
     * ⚠️ **`limit` 必须钳成正数。**
     *
     * 原来只做了 `Number.isFinite` 兜底，于是 `?limit=-1` 会原样透传到 SQL ——
     * 而在 SQLite 里 **`LIMIT -1` 的意思是"不限行"**。`equity_snapshots`
     * 又没有保留策略（3 分钟一个周期，半年约 8.6 万行），一次请求就能把
     * 全部历史快照拉回来，压在**驱动交易循环的同一个事件循环**上。
     *
     * 上限与仓储层的窗口（`EQUITY_CURVE_WINDOW`）对齐：再多也没有消费者。
     */
    const raw = Number((request.query as { limit?: string }).limit ?? 500);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 5000) : 500;
    return equityStore.list(idOf(request), limit);
  });

  /* --- Public market data ------------------------------------------------ */

  app.get('/api/market/symbols', authed, async () => {
    const registry = deps.publicConnection.registry;
    const tickers = await deps.publicConnection.market.ticker24h().catch(() => []);
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    return registry
      .all()
      .map((info) => {
        const ticker = bySymbol.get(info.symbol);
        return {
          symbol: info.symbol,
          baseAsset: info.baseAsset,
          price: Number(ticker?.lastPrice ?? 0),
          changePercent24h: Number(ticker?.priceChangePercent ?? 0),
          quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
          minNotional: info.minNotional,
        };
      })
      .filter((s) => s.quoteVolume24h > 0)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
  });

  app.get('/api/market/klines', authed, async (request, reply) => {
    const query = request.query as { symbol?: string; interval?: string; limit?: string };
    if (!query.symbol) return reply.code(400).send({ error: '缺少 symbol 参数' });
    const interval = (query.interval ?? '15m') as never;
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1000);
    return deps.publicConnection.market.klines(query.symbol, interval, limit);
  });

  /* --- Live event stream ------------------------------------------------- */

  app.get('/api/events', { websocket: true }, (socket, request) => {
    // 这是**唯一**允许从查询参数取令牌的地方（浏览器的 WebSocket 构造函数
    // 无法设置请求头）。HTTP 路由一律只认 Authorization 头，见 auth.ts。
    const token = extractToken(request, { allowQueryToken: true });
    if (!token) {
      socket.close(1008, '需要登录');
      return;
    }
    const payload = verifyToken(token, deps.jwtSecret);
    if (!payload || tokenRevoked(payload)) {
      socket.close(1008, 'Invalid session');
      return;
    }

    /*
     * Replay recent history so a freshly-opened console is not blank.
     *
     * ⚠️ **必须带 `replay: true`。** 这些事件是几分钟甚至几小时前发生的，而客户端
     * 原来把它们和实时事件一视同仁 —— 于是**每刷新一次页面，右下角就弹一轮
     * 「已平仓 ETHUSDT」**，内容还是过时的。操作员实测到的就是"每次刷新都弹，
     * 弹的全是旧消息"。
     *
     * 带标记之后：**数据照填**（持仓、权益、状态需要初值），
     * **但不弹通知、也不重复追加日志**。见 `ServerEvent` 上 `Replayable` 的说明。
     */
    for (const event of eventBus.history(30)) {
      socket.send(JSON.stringify({ ...event, replay: true }));
    }

    const unsubscribe = eventBus.subscribe((event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });

    /*
     * ⚠️ **心跳。原来没有，于是页面老是显示「推送断开」。**
     *
     * 这条流是**事件驱动**的：只在有事件时发数据。而机器人空闲时（等待下一个
     * 周期、或者根本没在运行）一分钟都可能一个事件都没有 —— 而中间的
     * 反向代理有一条空闲超时（nginx 的 `proxy_read_timeout` 默认 60 秒），
     * **一条 60 秒没有数据的 WebSocket 会被它单方面切断**。
     *
     * 客户端会把这次切断当成故障：状态变 `closed`、页面顶上弹「推送断开，
     * 按 4 秒轮询兜底」，然后指数退避重连。重连成功后过一分钟再来一次 ——
     * **于是这条警告变成了一个周期性的东西**，而它本意是提示异常。
     * 一个每两分钟出现一次的"异常提示"等于没有提示，而且它让操作员
     * 误以为系统不稳定。
     *
     * 用协议层的 `ping`：浏览器会自动回 `pong`（不需要改客户端），
     * 而任何中间代理看到的都是**双向的真实流量**，空闲计时器因此被重置。
     * 30 秒是常见的空闲超时（60 秒）的一半，留了一半余量。
     */
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);

    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    socket.on('error', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /* --- Server logs to the console ---------------------------------------- */

  /*
   * 全局日志落盘与推送。**这是日志进入数据库与前端事件的唯一入口。**
   *
   * 交易循环（`AutoTrader.emit`）不再自己写库与推事件，而是通过 `meta` 把
   * 归属交过来 —— 原先两边各写一次，一条日志就变成两条记录加两个事件，
   * 界面上同一句话出现两遍。
   *
   * `meta.traderId` 存在时：记录归属该机器人，`message` 用 `meta.raw`
   * （不带机器人名前缀 —— 归属已经由 `trader_id` 表达，名字不必再写一遍）。
   * 不存在时：是服务器级日志，`trader_id` 留空，并按 `[scope]` 加前缀区分来源。
   */
  /*
   * ── 把日志 meta 里几个"诊断必需"的字段拼成短尾巴 ────────────────────────
   *
   * `runtime_logs` 只有 `message` 一列（没有 meta 列，加列要迁移，而它是环形缓冲，
   * 收益不值）。所以关键上下文只能拼进正文。
   *
   * ⚠️ **只挑必需字段**，不把整个 meta 序列化：
   * 那会把提示词、响应体之类的大对象也塞进日志，既撑爆环形缓冲，又可能泄露内容。
   *
   * ⚠️ **值要截断到 60 字符**：模型 id 可能很长（`group/auto-xxx`），
   * 而错误信息可能带整段 HTML。截断保长度可控。
   */
  const diagnosticTail = (meta: Record<string, unknown>): string => {
    const picked: string[] = [];
    const add = (key: string): void => {
      const v = meta[key];
      if (v === undefined || v === null) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return;
        picked.push(`${key}=${s.length > 60 ? `${s.slice(0, 60)}…` : s}`);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        picked.push(`${key}=${String(v)}`);
      }
    };
    /* 顺序即重要性：先说"哪个模型"，再说"什么错"。 */
    for (const key of ['model', 'provider', 'status', 'kind', 'attempt', 'elapsedMs', 'error']) {
      add(key);
    }
    return picked.join(' ');
  };

  setLogSink((level, scope, message, meta) => {
    if (level === 'debug') return;
    const m = (meta ?? {}) as { traderId?: number; raw?: string };
    const traderId = typeof m.traderId === 'number' ? m.traderId : null;
    const text = traderId !== null && typeof m.raw === 'string' ? m.raw : message;
    /*
     * ⚠️⚠️ **把关键结构化上下文补进正文**（2026-10-18 修）
     *
     * ## 事故
     *
     * `llm/client.ts` 记录失败时是这样调的：
     * ```ts
     * log.error(`${this.provider} 的模型调用失败 —— 这类错误不会因重试而成功`, {
     *   provider, model, attempt, status, kind, retryable, elapsedMs, error,
     * });
     * ```
     * 而这条 sink **只从 meta 里读 `traderId` 和 `raw`**，其余全部丢弃。
     * 再加上 `runtime_logs` 表只有 `message` 列、没有 meta 列 ⇒
     * **落库的正文只有「custom 的模型调用失败」，看不到是哪个模型、什么状态码。**
     *
     * 实测后果：近 2 小时 83 条 `llm` error，全部长得一模一样，
     * 想回答"哪个模型在挂"时**查不到** —— 只能看到"出事了 83 次"。
     *
     * 同一个教训在本仓库已经出现过一次（`errors.ts` 里那条
     * 「模型不可用：deepseek-flash」）：**日志要能回答"是哪个"，
     * 否则它只能回答"出事了"。**
     *
     * ## 做法
     *
     * 不新增数据库列（那要迁移，且 `runtime_logs` 是环形缓冲，收益不值）。
     * 改为在写库/推事件时，把几个**诊断必需的**字段拼成一个短尾巴：
     * ```
     *   custom 的模型调用失败 —— 这类错误不会因重试而成功
     *     ｜model=group/auto-glm-5-3 status=400 kind=bad_request
     * ```
     *
     * ⚠️ **只挑必需字段**（model / status / kind / attempt / elapsedMs）。
     * 不把整个 meta 序列化进去 —— 那会把提示词、响应体之类的大对象也塞进日志，
     * 既撑爆环形缓冲，又可能泄露内容。
     */
    const diag = diagnosticTail(m);
    const withDiag = diag === '' ? text : `${text} ｜${diag}`;
    runtimeLogs.write(traderId, level, scope, withDiag);
    eventBus.publish({
      type: 'log',
      traderId,
      level,
      /*
       * ⚠️ **不再把 `[scope]` 拼进正文。**
       *
       * 原来这里是 `message: traderId === null ? `[${scope}] ${message}` : text`，
       * 于是界面上显示 `[binance:bootstrap] loaded 528 tradable …` ——
       * **机器码出现在给人看的文本里**。
       *
       * 拼进去之后界面就再也分不出哪段是来源、哪段是正文，
       * 连"把来源翻译成中文"都做不到。所以来源单独传，
       * 由展示层翻译（`logScopeLabel`）。原始码完整保留，筛选靠它。
       */
      message: withDiag,
      scope,
      timestamp: new Date().toISOString(),
    });
  });

  /* --- Static console ---------------------------------------------------- */

  if (existsSync(webDistDir)) {
    /*
     * ⚠️ **缓存策略必须显式设置 —— 否则"改好了用户却还看到旧的"。**
     *
     * ## 为什么（2026-10-07 实测踩到）
     *
     * 用户报「页面 BUG 还在」，而线上产物里**确实已经包含修复**
     * （`TraderPage-*.js` 里能搜到新代码、磁盘上旧 chunk 已删）。
     * 问题出在 `index.html` 被浏览器缓存了：它引用的是**懒加载 chunk 的文件名**，
     * 而 chunk 名带 hash、每次构建都变 —— 于是"缓存住的 index.html + 已消失的旧 chunk"
     * 让页面停在旧版本上。用户只能靠 Ctrl+F5 才能看到修复。
     *
     * ## 规则
     *
     *  · `index.html` —— **每次都回源验证**（`no-cache` 不等于不缓存，而是必须先问服务器）。
     *    它是"版本指针"，必须永远是最新的。
     *  · `assets/*` —— 文件名**带内容 hash**，内容一变文件名就变，所以可以**永久缓存**。
     *    这既快又不会出现陈旧内容（陈旧的那个文件名已经不存在了）。
     *
     * 这套组合是标准做法：**入口不缓存、指纹资源永久缓存**。
     * 它同时消掉了"每次部署都要用户手动硬刷新"和"白下载没变的资源"两个问题。
     */
    await app.register(fastifyStatic, { root: webDistDir });
    /*
     * 缓存策略统一在这里下发（`@fastify/static` 的 `setHeaders` 选项在这版类型里
     * 不被接受，而 `onSend` 钩子对静态文件同样生效、类型也干净）。
     */
    app.addHook('onSend', async (request, reply, payload) => {
      const url = request.url.split('?')[0] ?? '';
      if (url.includes('/assets/')) {
        /* 文件名带内容 hash：内容一变名字就变，可以永久缓存。 */
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        /*
         * 其余（`index.html` 与 SPA 回落到它的那些前端路由）都是**版本指针**，
         * 必须每次回源验证 —— 否则"改好了用户却还看到旧页面"。
         */
        reply.header('Cache-Control', 'no-cache, must-revalidate');
      }
      return payload;
    });
    app.setNotFoundHandler((request, reply) => {
      // SPA fallback: client-side routes must resolve to index.html.
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      reply.header('Cache-Control', 'no-cache, must-revalidate');
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/**
 * 首次启动创建管理员账号，并把凭据打印一次。
 *
 * 用户名与密码**都**可以随机生成（除非通过 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 指定）。
 * 随机用户名不是多余的：固定的 `admin` 等于把登录所需的两半信息送出去一半，
 * 安全性就只剩密码一道防线。用户登录后可以随时在「操作员账户」里改掉。
 */
export function bootstrapOwnerAccount(): {
  created: boolean;
  username?: string;
  password?: string;
} {
  if (users.count() > 0) return { created: false };

  const username = env.adminUsername || generateUsername();
  const password = env.adminPassword || generatePassword();
  users.create(username, hashPassword(password), 'owner');
  return { created: true, username, password };
}

/**
 * 读最近一次对账检测到的外部交易活动**与账本差额**。
 *
 * 返回 `rounds: 0` 而不是 `null`：**「检测过，没有外部活动」和
 * 「从来没检测过」对操作员的含义不同** —— 前者是"账户干净"，
 * 后者是"我们还不知道"。用 `detectedAt` 区分。
 *
 * ## ⚠️ 2026-10-14：补上 `ledgerGap`（用户报"列表页和详情页数据对不上"）
 *
 * ### 现象
 *
 * 列表页「盈亏」显示 **+4.84**（本地记账），详情页「账户余额」显示 **92.34**
 * （交易所真实值），两者差 **12.55** —— 而界面上**没有任何地方解释这个差**。
 *
 * ### 根因：两个数字口径不同，而界面没说
 *
 * ```
 *   本地记账（trades 净额合计）   = 起始 + 已实现净额 = 104.89  ← 列表页
 *   交易所真实权益               = 92.34                        ← 详情页
 *   差额（ledger_check.gap）     = 12.55                        ← 只在后端台账里
 * ```
 *
 * 差额的来源是**对账重建的已知缺陷**（窗口起点落在持仓中间 → 开/平判反，
 * 见 `reconstructRoundTrips()` 的说明）—— 系统**每轮都在检测它**，
 * 但那个数字**只进了 `ledger_check:` 台账与给模型看的提示词**，
 * 没有进任何界面。于是操作员看到两个数字对不上，而**无处可知为什么**。
 *
 * ### 为什么在这里补，而不是新开端点
 *
 * 这个端点本来就是为"账户余额不对"建的（见上面那段注释），
 * 而 `gap` 正是那个问题的**量化答案**。分成两个端点会让
 * 「外部活动」与「账本差额」这两件相关的事在界面上被拆到两处。
 *
 * ⚠️ 读不到时**不带这个字段**（不是 `0`）—— 「我们不知道」和「账没问题」
 * 对操作员的含义完全不同（同 `readForeignActivity` 的说明）。
 */
function readForeignActivityFor(traderId: number): {
  rounds: number;
  net: number;
  symbols: string[];
  firstAt: string | null;
  lastAt: string | null;
  detectedAt: string | null;
  /** 平台账本与交易所流水的差额（`undefined` = 没读到，不代表 0）。 */
  ledgerGap?: number;
  /** 对账检查的时刻（`undefined` = 从没跑过对账）。 */
  ledgerCheckedAt?: string;
} {
  const empty = {
    rounds: 0,
    net: 0,
    symbols: [] as string[],
    firstAt: null,
    lastAt: null,
    detectedAt: null,
  };
  /*
   * ⚠️ 账本差额**独立读**（同 `readForeignActivity` 的做法）：
   * 两个台账是分别写的，任一个缺失不该让另一个也丢。
   */
  const gap = (() => {
    try {
      const raw = settings.get(`ledger_check:${traderId}`);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { gap?: number; incomeReadFailed?: boolean; checkedAt?: string };
      /*
       * ⚠️ 读流水失败那一轮的 `gap` 是**假差额**（等于整个 platformNet）——
       * 与 `readForeignActivity` 里同一条判据，不能只修一处。
       */
      if (parsed.incomeReadFailed) return {};
      return {
        ...(typeof parsed.gap === 'number' ? { ledgerGap: parsed.gap } : {}),
        ...(typeof parsed.checkedAt === 'string' ? { ledgerCheckedAt: parsed.checkedAt } : {}),
      };
    } catch {
      return {};
    }
  })();
  try {
    const raw = settings.get(`foreign_activity:${traderId}`);
    if (!raw) return { ...empty, ...gap };
    const parsed = JSON.parse(raw) as Partial<ReturnType<typeof readForeignActivityFor>>;
    return {
      rounds: typeof parsed.rounds === "number" ? parsed.rounds : 0,
      net: typeof parsed.net === "number" ? parsed.net : 0,
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
      firstAt: typeof parsed.firstAt === "string" ? parsed.firstAt : null,
      lastAt: typeof parsed.lastAt === "string" ? parsed.lastAt : null,
      detectedAt: typeof parsed.detectedAt === "string" ? parsed.detectedAt : null,
      ...gap,
    };
  } catch {
    return { ...empty, ...gap };
  }
}
