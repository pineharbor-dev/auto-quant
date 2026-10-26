import {
  StrategyConfigSchema,
  defaultStrategyConfig,
  isAiDriven,
  type CircuitBreakerReading,
  type StrategyConfig,
  type StrategyRecord,
  type TraderStatus,
} from '@aq/shared';
import { connectExchange, preflight, type ExchangeConnection, type PreflightCheck } from '../binance/bootstrap.js';
import type { BinanceEnvironment } from '../binance/endpoints.js';
import { BinanceUserDataStream } from '../binance/ws.js';
import type { Vault } from '../crypto/vault.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { jevBool, jevEnum, jevNumber } from './control.js';
import { createJevDecisionModel } from './jevModel.js';
import { createLogger } from '../logger.js';
import { env } from '../env.js';
import { MarketDataService } from '../market/service.js';
import { paperAccountState } from '../binance/paperWallet.js';
import { LlmClient } from '../llm/client.js';
import { discoverModels } from '../llm/discovery.js';
import { aiModels, equity, exchanges, positions, runtimeLogs, settings, strategies, trades as tradeStore, traders } from '../store/repositories.js';
import { eventBus } from '../events.js';
import { checkConfigReachability } from '../risk/reachability.js';
import { AgentRuntime } from './agent/runtime.js';
import { AutoTrader, type DecisionModel } from './autoTrader.js';
import { ModelRouter } from '../llm/modelRouter.js';
import { createMagpieCallFactory, discoverFromGateway } from './magpieGateway.js';
import { resolveTeamGateway } from './teamGateway.js';
import { runAgentTask } from './agent/harness.js';
import { parseIntelReport } from './intel/parseIntel.js';
import { rankIntel } from './intel/freshness.js';
/* ⚠️ 情报键的**唯一**构造函数 —— 不在别处另拼字符串（见 ResearchCache.keys）。 */
import { signalKeyOf } from './intel/attribution.js';
import {
  HUNTERS,
  buildHunterTask,
  mergeHunterReports,
  summariseHunters,
  type HunterReport,
} from './intel/hunters.js';
import { mapConcurrent } from './agent/pool.js';
import { ModelsDevStore } from '../llm/modelsDev.js';
import type { ModelsDevLookup } from '../llm/modelDiscovery.js';
import { runOutsideCritical } from './agent/resourceGate.js';
import { runSelfCheck } from './selfcheckRunner.js';
import { createRoutedDecisionModel, createTeamDecisionModel, tierForRole } from './routedModel.js';
import { setAvailableModelIds } from './routedModel.js';

const log = createLogger('manager');

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  **models.dev 模型档案 store（进程级单例）**（2026-10-14 接上）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 它补什么
 *
 * 运行时 `GET /v1/models` **拿不到定价（`cost`）与知识截止（`knowledge`）** ——
 * `modelDiscovery.ts` 文件头的表格已经把这两个缺口写清楚了。
 * models.dev 用官方目录补上它们，以及 `tool_call` / `structured_output` /
 * `canonical_model_id`。
 *
 * ## 为什么是单例，而不是"每个机器人一个"
 *
 * ```
 *   · 快照是 5.6MB（gzip 0.54MB）—— 每个机器人存一份纯属浪费
 *   · 刷新循环要带 ETag 做条件请求 —— 多个 store 会各自拉一遍
 *   · 索引是纯数据（8,831 条），没有"每机器人不同"的部分
 * ```
 * ⚠️ 所以它放在**模块级**，在第一次装配时懒加载。
 *
 * ## 为什么 `load()` 是同步的、且失败不抛
 *
 * `discoverFromGateway` 在**装配路径**上（机器人启动时），而
 * "启动时要等一次网络"是这个项目明确要避免的形态。
 * 所以：
 * ```
 *   启动 → load() 同步读本地快照（有就有，没有就没有）→ 立刻可用
 *   后台 → 每日刷新一次（带 ETag，304 就跳过）
 * ```
 * ⚠️ 读不到快照时返回 `null`，`buildCatalog` 会把它当成"这次不补参数" ——
 * **不是错误**，机器人照常启动（与 `pluginProvidersPath` 读不到时同源）。
 *
 * ## 为什么刷新失败【绝不】清空
 *
 * 旧快照比"没有快照"好得多：定价与知识截止在一周内几乎不变，
 * 而"因为一次网络抖动就把参数全丢"会让调度器立刻失去依据。
 * 见 `ModelsDevStore.refresh` 的三态语义（`updated` / `not_modified` / `failed`）。
 */
let modelsDevStoreSingleton: ModelsDevStore | null = null;

/**
 * 取 models.dev 的查询函数（首次调用时同步装载快照并挂上刷新循环）。
 *
 * ⚠️ 返回 `null` 是**正常情况**（还没拉到过快照）—— 调用方照样传下去，
 * `buildCatalog` 会按"不补参数"处理。
 */
function modelsDevLookup(): ModelsDevLookup | null {
  if (modelsDevStoreSingleton === null) {
    const store = new ModelsDevStore({ dataDir: env.dataDir });
    const index = store.load();
    if (index === null) {
      /*
       * ⚠️ **不在这里同步拉网络** —— 那是启动路径，会拖慢机器人启动。
       * 直接挂上刷新循环：它会在后台拉第一次，拉到之后下一次装配就能用上。
       */
      log.info('models.dev 本地快照不存在，将在后台首次拉取（本次装配不补参数）。');
    } else {
      log.info(`models.dev 快照已装载：${index.byLeafName.size} 个叶子名。`);
    }
    store.startRefreshLoop();
    modelsDevStoreSingleton = store;
  }
  return modelsDevStoreSingleton.lookup();
}

/**
 * 一次调用的输出上限**下限**（token）—— 保证推理有地方可写。
 *
 * ## 为什么需要它（实盘实测，不是推测）
 *
 * provider 的 `max_tokens` 在不同端点上的行为**并不一致**，但有一种明确有害：
 * **推理与正文共享同一个额度**。而本系统的提示词很大（实测 `prompt_tokens`
 * 51161–278504、平均 107114），`reasoningEffort` 又是 `high` ——
 * **推理量随提示词规模一起涨**。
 *
 * 实测那台机器人（`ai_models.max_tokens = 16384`）：
 *
 *     #235   in 51521   out 16384   reasoning 16384   ← 推理吃满，正文 0
 *     #234   in 105846  out 30567   reasoning 28590   ← 推理 28590 > 16384
 *
 * `#235` 那一轮**正文一个字都没剩下**，而它仍然被记成 `success=1` ——
 * 从操作台上看只是"这一轮没什么可做的"。库里有 **8 次** `completion_tokens`
 * 正好等于 16384，也就是 **8 次把输出预算全部花在思考上**。
 *
 * ## 为什么是 131072（128k）
 *
 * 实测（直接对 `/chat/completions` 探边界）：这个 provider 接受 `max_tokens`
 * 到 **393,216**（传 `1000000` 被拒："the valid range of max_tokens is
 * [1, 393216]"）。而观测到的推理峰值只有 28,590 —— 65,536 本来也有余量。
 *
 * 取 131,072 是因为**下一步会提高思考档位**（`reasoning_effort` 实测支持
 * `low|medium|high|xhigh|max`，现在用的是 `high`）：档位越高推理越长，
 * 而推理与正文共享这个额度。128k 给"最难的那次决策"留出空间。
 *
 * ## 为什么不直接设成 provider 的上限（393,216）
 *
 * 那个数是**这个 provider** 的硬限。换一个 provider 可能低得多，而**设超上限
 * 会让整次调用以 400 失败**（决策直接没了）。128k 是一个跨 provider 相对安全
 * 的值，且远超实际需要。真正的空间约束在输入侧（见 `PROMPT_UTILISATION`）。
 *
 * ## 为什么是"下限"而不是直接覆盖
 *
 * 值可能来自数据库（控制台不暴露这个字段，但迁移与脚本可以写）。
 * 用一个下限意味着：**更高的配置照旧生效，更低的会被抬上来** ——
 * 而"更低"在当前契约下没有任何正当理由。
 *
 * 它**不增加正常开销**：`max_tokens` 是上限而不是预扣，模型不会因为它变大
 * 就多说废话。
 */
const MIN_MAX_TOKENS_FOR_REASONING = 131_072;

/**
 * 成交推送之后，隔多久去对一次账。
 *
 * 一笔平仓会连着推若干帧（部分成交、最后成交），而一次对账要为每个相关标的
 * 问一遍 `/fapi/v1/userTrades`。5 秒足够把「同一次平仓」的全部帧收进同一次对账，
 * 又短到操作员在界面上看不出延迟。
 */
const FILL_RECONCILE_DEBOUNCE_MS = 5_000;

/* -------------------------------------------------------------------------- */
/*  AI 模型的健康快照                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一个 AI 模型**最近一次调用**的结果。
 *
 * ## 为什么它必须存在（实测：控制台上什么都看不到）
 *
 * 2026-09-29 实测：网关连着 **12 次**回
 *
 * ```text
 * You have insufficient credits to make this request.
 * Please purchase more credits to continue using the service.   （HTTP 400）
 * ```
 *
 * 而**控制台上完全看不出来** —— 页面那片「AI 模型」的字段还是那个样子，
 * 用户只能去服务器上翻 `server.log` 才知道机器人已经断了十几分钟没做决策。
 *
 * 一个"正在运行、状态正常"的界面，配上一条只会写日志的失败路径，
 * 就是这次要修的东西：**把`模型是否还能用`变成界面上的一个事实。**
 */
export interface LlmHealth {
  ok: boolean;
  /** 最近一次调用的时间（ISO）。 */
  at: string;
  latencyMs?: number;
  /** 失败时的原因（已经截断，避免把整段 HTML 错误页塞进数据库）。 */
  error?: string;
}

/** 读某个模型最近的调用健康度。没有记录时返回 `null`（= 还没调用过）。 */
export function readLlmHealth(aiModelId: number): LlmHealth | null {
  const raw = settings.get(`llm_health:${aiModelId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LlmHealth>;
    if (typeof parsed?.ok !== 'boolean' || typeof parsed?.at !== 'string') return null;
    return {
      ok: parsed.ok,
      at: parsed.at,
      latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    /* 坏了就当没有记录 —— 它只是给界面看的，不值得阻断任何事。 */
    return null;
  }
}

export function recordLlmHealth(aiModelId: number, health: LlmHealth): void {
  settings.set(`llm_health:${aiModelId}`, JSON.stringify(health));
}

/* -------------------------------------------------------------------------- */
/*  启动守卫                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 启动一台机器人之前的三道守卫 —— **做成纯函数是为了能被单测钉住**。
 *
 * ## 为什么要把它们从 `startTrader()` 里抠出来
 *
 * `trader/manager.ts` 有一千六百多行、管着启动 / 停止 / 开机恢复，而它**一行行为测试都没有**
 * （测试里只有 `import type`）。启动路径会真读库、真连交易所，夹具成本很高 ——
 * 于是**恰恰是最该有覆盖的那几条守卫，一条都没被覆盖**。而它们各自都对应一次真实事故：
 *
 *   1. **全局熔断**（`GLOBAL_TRADING_DISABLED`）：它原来只装在 `/start` 与 `/run-once`
 *      两个路由上，而**开机恢复没有看它** —— 操作员设了开关并重启（env 只能靠重启改），
 *      原本 running 的机器人**照样用 `dryRun=false` 恢复实盘交易**，而启动日志还写着
 *      「任何机器人都无法启动」——一句**事实错误**的话，让人以为已经止血。
 *   2. **机器人不存在**：一个被删掉的 id 仍然能点"启动"，失败信息必须说清是"找不到"，
 *      而不是别的什么。
 *   3. **重复启动**：同一台机器人被启动两次会走两条完整的启动流程（重复对账、重复下单）。
 *      占位（`this.starting`）必须**第一个 await 之前**就写进去，否则并发 start 会双双通过检查。
 *
 * 项目自己的风格要求就是"导出的纯函数优先于需要打桩的对象"（§5.4）—— 这里照它办。
 * **判定顺序与错误文案都与原来一字不差**：这只是提取，不是改行为。
 */
/**
 * 启动流程的看门狗（毫秒）。
 *
 * 超过这个时间还没进入 `running`，就把状态落到 `error` 并释放 `starting` 占位 ——
 * 见 `startTraderAsync` 里的说明。**"永远停在启动中"会让操作员既看不到结论、
 * 又点不动按钮**，比一个明确的失败更糟。
 */
const START_WATCHDOG_MS = 90_000;

/**
 * 模拟盘没有填起始余额时的默认本金（USDT）。
 *
 * 为什么不是 0：0 余额会让每一笔开仓都被「保证金不足」拒掉，而界面上看起来
 * 只是「机器人一直不交易」—— 与仓库里反复记录的那类"静默失能"同一个形状。
 * 1000 与 `simulate.ts` 的夹具、`seedDemoData.ts` 的常见档位一致。
 */
const DEFAULT_PAPER_BALANCE = 1000;

/**
 * 连接缓存的键：**同一台机器人的"模拟盘"与"实盘"是两条不同的连接。**
 *
 * 见 `connectionFor` 里那段说明 —— 键里少了 `dryRun` 会让模拟盘启动复用到实盘连接，
 * 日志写模拟、订单真实成交（2026-10-11 审查发现的 P0）。
 */
function connectionCacheKey(traderId: number, dryRun: boolean): string {
  return `${traderId}:${dryRun ? 'paper' : 'live'}`;
}

/** 把某台机器人**两种模式**的连接都从缓存里去掉（停止 / 失败 / 清理时用）。 */
function dropConnections(store: Map<string, ExchangeConnection>, traderId: number): void {
  store.delete(connectionCacheKey(traderId, true));
  store.delete(connectionCacheKey(traderId, false));
}

export function startGuard(input: {
  traderId: number;
  globalTradingDisabled: boolean;
  traderExists: boolean;
  running: boolean;
  starting: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (input.globalTradingDisabled) {
    return {
      ok: false,
      error: 'GLOBAL_TRADING_DISABLED 已设置 —— 拒绝启动任何机器人（这是全局熔断，不是这一台的问题）。',
    };
  }
  if (!input.traderExists) {
    return { ok: false, error: `找不到机器人 ${input.traderId}` };
  }
  if (input.running || input.starting) {
    return {
      ok: false,
      error: input.starting ? '该机器人正在启动中' : '该机器人已经在运行中',
    };
  }
  return { ok: true };
}

/**
 * 开机恢复的重试节奏（F2 + F4）。
 *
 * 为什么需要重试：`startTrader()` 的失败以前是**终局**的。启动时一次网络抖动、
 * 一次 LLM 提供商的 5xx、一次交易所 503，就把机器人写成 `error`，
 * 而 `resumePersisted()` 只恢复 `running` / `safe_mode` —— 于是它**永远**
 * 停在 error 上，静默地什么都不做，直到有人注意到控制台并手动点一次启动。
 * 一个"必须无人值守跑几周"的系统不能有这种闩锁。
 *
 * 为什么是这几个数：
 *  · 第一次尝试不等待 —— 绝大多数启动是正常的，冒烟路径不能变慢。
 *  · 退避 5s → 15s → 45s → 90s（上限 90s）。单次失败最常见的成因（DNS 抖动、
 *    网关 502）在十几秒内就会自愈，所以早期退避要短；而一次失败的 LLM/交易所
 *    调用本身可能已经等了 15–120s，所以上限不宜太小，否则总预算被一次慢失败吃掉。
 *  · 4 次重试 / 约 2.5 分钟的总预算。它必须**明显短于**最短的合法
 *    `cycleIntervalMinutes`（schema 允许的最小值是 1 分钟）乘以一个"人还能忍"的
 *    倍数，否则"启动中"会变成一种新的静默状态；同时它又要长到能穿过一次
 *    分钟级的提供商抽风。
 */
const BOOT_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];

/**
 * 这些启动失败**不重试**：重试改变不了结果，只会让"机器人起不来"这件事
 * 延迟几分钟才浮出水面，并在此期间反复把同样的错误发进日志和事件流。
 *
 * 判据是"人需要做点什么"：填凭据、入金、改配置。
 */
const PERMANENT_START_FAILURES = [
  /还没有配置 API Key/,
  /还没有存储 API Key/,
  /没有合约交易权限/,
  /可用余额为 0/,
  /找不到交易所账户/,
  /找不到策略/,
  /找不到 AI 模型/,
  /找不到机器人/,
  /还没有配置/,
];

function isPermanentStartFailure(message: string): boolean {
  return PERMANENT_START_FAILURES.some((pattern) => pattern.test(message));
}

/* -------------------------------------------------------------------------- */
/*  Manager                                                                    */
/* -------------------------------------------------------------------------- */

export interface StartResult {
  ok: boolean;
  error?: string;
  preflight: PreflightCheck[];
  /**
   * 这次结果是**操作员的「停止」叠在启动过程中**产生的，而不是启动自己失败。
   *
   * ⚠️ 必须区分这两者：`attemptStart()` 的两个取消分支已经自己把状态写成
   * `stopped` 并返回失败，而外层 `startTraderAsync` 原来只看 `ok`，
   * **无条件再写一次 `error`** —— 一次显式的停止就此变成"待恢复的故障"。
   * 而 `resumePersisted()` 会恢复 `error`、刻意不恢复 `stopped`
   * （后者是人的决定）。所以那次覆盖的代价是：**下一次部署/重启把刚被叫停的
   * 机器人重新拉起并下单** —— 正是本文件反复声明绝不允许的那件事。
   *
   * 不能改用 `cancelledStarts.has(id)` 判断：那面旗子在 `startTrader` 的
   * `finally` 里就被收掉了（语义是"进行中的启动被取消"），而这里的 `.then`
   * 在它之后运行 —— 用旗子等于什么都没看见。
   */
  cancelled?: boolean;
}

/**
 * `buildTeamModel` 的结果 —— **带原因**，而不是"成功给模型 / 失败给 null"。
 *
 * ## 为什么要带原因（复核发现的 P0，2026-10-12）
 *
 * 原来返回 `DecisionModel | null`，于是失败时调用点只能看到"没有模型"，
 * 就**静默退回到单模型路径**了。一台标着「AI 团队」的机器人实际在用**一个模型**
 * 跑，而界面上看不出任何异常 —— 用户以为团队在开会，其实没有。
 *
 * `reason` 让调用点能把失败**说清楚**（页面上的 preflight check + 日志），
 * 同时仍然不阻断启动（与「模型不可达不阻止启动」的既有原则一致）。
 */
/**
 * 团队模式网关的固定参数。
 *
 * **不取自 `ai_models`** —— 团队模式与「AI 模型」列表完全解耦（用户 2026-10-12 要求）。
 * 这些值是"跑一个 7 人团队会议"的合理默认：单次 300 秒（团队一轮要跑 7 次调用）、
 * 单模型内重试 2 次（跨模型的降级由 `ModelRouter` 负责，不重复做）。
 */
const TEAM_GATEWAY_TIMEOUT_SECONDS = 300;
const TEAM_GATEWAY_MAX_RETRIES = 2;
const TEAM_GATEWAY_TEMPERATURE = 0.2;

/**
 * 团队模式的单次输出预算基准。
 *
 * 8192 起步：够一个角色写完整的论证，而 `ModelRouter.budgetFor` 会对
 * 思维链模型再放大（但**不会小于**这个值 —— 见那里的说明）。
 */
const TEAM_BASE_MAX_TOKENS = 8192;

interface TeamModelBuild {
  model: DecisionModel | null;
  /** `null` = 成功。有值 = 失败原因（给人看的中文）。 */
  reason: string | null;
}

/**
 * Owns the lifecycle of every running trader.
 *
 * Each trader gets its own exchange connection, market-data cache and model
 * client, so one trader's rate-limit pressure or provider outage cannot degrade
 * another's decisions. Stopping is always clean: the loop is cleared and any
 * partially-open state is left for the next start to reconcile.
 */

/**
 * 自检的 AI 层单次请求超时（秒）。
 *
 * 比团队决策（`TEAM_GATEWAY_TIMEOUT_SECONDS`）短得多：自检是**后台任务**，
 * 它卡住不该拖过一个检查间隔（默认 30 分钟）——
 * 一次自检的 AI 层没出结果，确定性层的结果仍然有效。
 */
const SELF_CHECK_TIMEOUT_SECONDS = 120;

/**
 * **agent 的"办公室"** —— 每个机器人一个独立工作目录。
 *
 * 为什么要独立目录：harness 会在 `cwd` 里读写文件、存会话状态。
 * 多个机器人共用一个目录会互相踩（一个的会话状态被另一个读到）。
 */
/**
 * **调研结果的缓存**（2026-10-12 实测后加的）。
 *
 * ## 为什么必须缓存
 *
 * 实测：一次真 agent 调研要 **197 秒**（2608 字的带来源简报）。
 * 而它**原本每轮都重跑** —— 于是每一轮决策都先白等 3 分钟，
 * 而这 3 分钟里查到的新闻**和上一轮基本一样**（新闻不是秒级变化的）。
 *
 * ## 这条改动其实实现了"调研与决策解耦"的最小形态
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 缓存新鲜 | **立刻返回**（决策不再等待）|
 * | 缓存过期 | **立刻返回旧结果 + 后台刷新** —— 决策用"稍旧但可用"的情报，而不是等 |
 * | 完全没有缓存 | 只能等（第一次总得查一次）|
 *
 * 这正是用户要的"7×24 不间断"该有的形状：
 * **调研在后台持续跑，决策随时读最新可用的结果**，两者不互相阻塞。
 *
 * ⚠️ 为什么不是"后台定时刷新"：那需要一个常驻 timer（上一轮刚为 `stopAll()`
 * 清理过 timer 泄漏问题）。用"用到时看是否过期、过期就在后台刷一次"更简单，
 * 且**没有额外生命周期**。
 */
interface ResearchCache {
  text: string;
  at: number;
  /** 刷新是否正在进行 —— 防止并发轮次同时起多个 agent。 */
  refreshing: boolean;
  /**
   * **这一份调研材料里可选的情报键**（2026-10-15 加）。
   *
   * ## 为什么必须存它（断点②，一次真实事故）
   *
   * 裁决官要"标注这条决策依据了哪几条情报"，而**校验它没编造**需要
   * "这次真的给过它哪些键"（见 `routedModel.ts` 的 `availableIntelKeys`）。
   *
   * 而本闭包原来**只返回 `string`** —— 于是 `routedModel` 里的
   * `availableIntelKeys` 恒为 `[]`，`tradingDesk.ts:2010` 那段
   * "必须标注 intel_keys"的要求**根本不进提示词**。实测线上：
   * ```
   *   225 轮 raw_response 里 `intel_keys` 出现 0 次
   *   trades / positions 的 intel_keys 全部为 []
   *   ⇒ signalHealth 永远 insufficient_data
   * ```
   *
   * ## 键的格式
   *
   * `<来源域名>|<方向>|<标的们>`（见 `attribution.ts` 的 `signalKeyOf`）——
   * 用**同一个构造函数**生成，不在这里另拼一遍字符串
   *（两处各拼一次必然漂移，那正是 `signalKeyOf` 的注释记过的教训）。
   */
  keys: string[];
}
const researchCache = new Map<number, ResearchCache>();

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  ⭐ **调研成果要活过进程重启**（2026-10-13 实测后加）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 事故现象
 *
 * 线上日志反复出现（每 16 分钟一次）：
 * ```
 *   03:08:20 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**（下一轮就会有）
 *   03:24:56 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 *   03:28:21 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 *   03:45:08 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 * ```
 * **"首次调研"出现了很多次** —— 而它字面上只能有一次。
 * 而同一时段确实**成功过一次**：
 * ```
 *   03:50:38 [调研] 可用情报 2 条（过期被剔除 0 条；…）
 * ```
 * 然后 `03:58:23` 服务重启（一次部署），`03:59:37` 又是"首次调研"。
 *
 * ## 根因
 *
 * `researchCache` 是**进程内存**（`Map`）—— 重启就没了。而一次调研要
 * **22 分钟**（实测），所以"重启 → 22 分钟没有新闻"是必然的。
 *
 * ⚠️ **这不是"实现 bug"，而是与用户要求的冲突**：
 * > 「更新成 **7×24 不间断**、不定时、持续工作模式」
 *
 * 一个"每次重启就要重新花 22 分钟找新闻"的系统，**不满足 7×24**。
 * 而且实测那份情报**只值 2 条**（查询一次成本很高），丢掉它很浪费。
 *
 * ## 修法：内存优先 + `settings` 表兜底
 *
 * ```
 *   读：内存有 → 用它（快，且是最新的）
 *       内存没有 → 读 `settings`（重启后仍能拿到上一份）
 *   写：内存 + `settings`（同时）
 * ```
 *
 * ⚠️ **只持久化"真的有内容"的那一份**（`at > 0 && text.length > 0`）——
 * 占位对象（`at: 0`）不该被写进库里，否则重启后会把"空情报"当成"旧情报"
 *（那是本项目已经修过一次的坑，见 `runOnce` 里那段说明）。
 *
 * ⚠️ **仍然有过期判据**：读回来的那一份照样走 `researchTtlMs()` 判断 ——
 * 持久化只是"让它活过重启"，不是"让它永不过期"。
 */
const RESEARCH_CACHE_SETTING_PREFIX = 'research_cache:';

/** 从库里读回一份（重启后仍能拿到）。**只在内存没有时读。** */
function readPersistedResearch(traderId: number): ResearchCache | undefined {
  try {
    const raw = settings.get(`${RESEARCH_CACHE_SETTING_PREFIX}${traderId}`);
    if (raw === undefined || raw.length === 0) return undefined;
    const parsed = JSON.parse(raw) as { text?: unknown; at?: unknown; keys?: unknown };
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const at = typeof parsed.at === 'number' ? parsed.at : 0;
    /* ⚠️ 空情报不认 —— 与内存那侧的判据一致（`at > 0 && text.length > 0`）。 */
    if (at <= 0 || text.length === 0) return undefined;
    /*
     * ⚠️ `keys` 是 2026-10-15 之后才写进库的 —— 旧记录没有它。
     * 读不到就按 `[]`（**不猜**）：那会让裁决官"无从标注"，
     * 而那比"给它一组可能过期的键"安全（后者会让归因记下错的键）。
     */
    const keys = Array.isArray(parsed.keys)
      ? parsed.keys.filter((k): k is string => typeof k === 'string' && k.length > 0)
      : [];
    return { text, at, refreshing: false, keys };
  } catch {
    /* 库读不出来不该让决策失败 —— 当作"没有缓存"，照常走首次调研。 */
    return undefined;
  }
}

/** 写一份到库里（失败不影响内存那侧）。 */
function persistResearch(traderId: number, text: string, at: number, keys: readonly string[]): void {
  /* ⚠️ 只持久化"真的有内容"的那一份 —— 占位（空串）不该进库。 */
  if (at <= 0 || text.length === 0) return;
  try {
    /*
     * ⚠️ `keys` 必须一起持久化（2026-10-15）—— 否则重启后
     * `availableIntelKeys` 会变成 `[]`，裁决官**无从标注情报来源**，
     * 而那份材料明明是有情报的（`text` 还在）。
     */
    settings.set(`${RESEARCH_CACHE_SETTING_PREFIX}${traderId}`, JSON.stringify({ text, at, keys }));
  } catch {
    /* 写不进去只是"重启后要重查一次"，不该让本轮失败。 */
  }
}

/** 读缓存：**内存优先，库兜底**（见上面那段说明）。 */
function getResearchCache(traderId: number): ResearchCache | undefined {
  /*
   * ⚠️ 这里必须是 `researchCache.get(...)`（内存 Map），**不是** `getResearchCache(...)`。
   *
   * 我做批量替换（`researchCache.get(` → `getResearchCache(`）时，
   * **把这个封装函数自己的函数体也换掉了** → 它变成无限递归。
   * 同类错误还有 `clearResearchCache`（那次更直接：`clearResearchCache(traderId)` 调自己）。
   *
   * ⚠️ 教训：**批量替换会改到"定义处"本身** ——
   * 替换后必须逐个检查新写的封装函数体，而不是只看替换计数。
   * 而 TypeScript **抓不到这种错**（递归调用的类型完全合法），
   * 所以这类错误只能靠"逐个看函数体"或"跑一次真实路径"发现。
   */
  const inMemory = researchCache.get(traderId);
  if (inMemory !== undefined) return inMemory;
  const persisted = readPersistedResearch(traderId);
  if (persisted !== undefined) {
    /* 回填内存，避免每次读都碰库。 */
    researchCache.set(traderId, persisted);
  }
  return persisted;
}

/** 写缓存：**内存与库同时写**（见上面那段说明）。 */
function setResearchCache(traderId: number, entry: ResearchCache): void {
  researchCache.set(traderId, entry);
  persistResearch(traderId, entry.text, entry.at, entry.keys);
}

/**
 * 清掉调研缓存。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ **两个场景需要相反的行为 —— 所以必须区分**（2026-10-13）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 场景 A：用户主动停止机器人（`stopResearchRefresher`）
 *
 * 既有测试的意图（`researchLifecycle.test.ts` 原文）：
 * > 「缓存也要清：机器人停掉后再启动时，一份 10 分钟前的旧情报没有意义 ——
 * >  而留着它会让**新启动的第一轮基于旧情报决策**。」
 *
 * **那个意图是对的**：用户按了停止，再按启动时他期待"重新看现在的市场"。
 * 所以这里要**连库一起删**（`dropPersisted: true`）。
 *
 * ## 场景 B：进程重启（部署 / 崩溃 / OOM）
 *
 * ```
 *   03:50:38 [调研] 可用情报 2 条      ← 22 分钟换来的
 *   03:58:23 服务重启（一次部署）
 *   03:59:37 [调研] 首次调研在后台进行  ← 又得等 22 分钟
 * ```
 * **而进程重启时根本不会调用 `stopResearchRefresher`**（代码没跑）——
 * 所以库里的那一份**自然保留**，正是我要的。
 *
 * ## 所以：默认只清内存，停止机器人时显式连库一起删
 *
 * ```
 *   clearResearchCache(id)                        → 只清内存（进程重启走这条，库保留）
 *   clearResearchCache(id, { dropPersisted: true }) → 连库删（用户主动停止走这条）
 * ```
 *
 * ⚠️ 这个区分**必须写清楚** —— 否则下一个人看到"停止时清了库、
 * 而重启时没清"会以为是漏了，然后"修"成一致，于是两个场景必然坏一个。
 */
function clearResearchCache(traderId: number, options?: { dropPersisted?: boolean }): void {
  researchCache.delete(traderId);
  if (options?.dropPersisted === true) {
    try {
      settings.set(`${RESEARCH_CACHE_SETTING_PREFIX}${traderId}`, '');
    } catch {
      /* 删不掉只是"下次启动可能拿到旧情报"，不该让停止流程失败。 */
    }
  }
}

/** 缓存有效期：默认 15 分钟（新闻不是秒级变化的）。 */
/**
 * **调研缓存的有效期**（毫秒）。
 *
 * ⚠️ **必须大于刷新间隔**（2026-10-13 实测后改）。
 *
 * ## 原来写死 15 分钟，而刷新间隔是 10 分钟、调研实测要 22 分钟
 *
 * ```
 *   刷新间隔   10 分钟
 *   TTL        15 分钟
 *   实际耗时   **22.1 分钟**
 * ```
 * 于是决策经常读到"已过期"的缓存 —— 而它本可以读上一份
 *（**新闻不是秒级变化的**，一份 20 分钟前的情报比"没有情报"好得多）。
 *
 * ## 新口径
 *
 * ```
 *   TTL = 刷新间隔 + 10 分钟
 * ```
 * 这样"上一份的年龄"最多到"下一份刚准备好" —— **中间不会出现空窗**。
 *
 * ⚠️ 上界 90 分钟：再长的话"旧闻当新闻"的风险就超过收益了
 *（实测 `rankIntel` 会把超过 48 小时的消息判为过期，所以上界不是安全线，
 *  而是"情报新鲜度"的取舍）。
 */
function researchTtlMs(): number {
  const explicit = Number(process.env.AQ_RESEARCH_TTL_MS ?? '');
  if (Number.isFinite(explicit) && explicit >= 60_000) return explicit;
  return researchIntervalMs() + 10 * 60_000;
}

/**
 * **后台调研的刷新间隔**（毫秒）—— 与 `ensureResearchRefresher` 共用一处。
 *
 * ⚠️ 抽成函数是因为**两个地方都要用它**（间隔与 TTL 必须自洽）——
 * "同一个算术写在两个地方，改一处等于没改"（本项目已经踩过两次）。
 */
function researchIntervalMs(): number {
  const raw = Number(process.env.AQ_RESEARCH_INTERVAL_MS ?? '');
  /*
   * 默认 **20 分钟**：实测一次调研 **22.1 分钟**（4 猎手串行、全部有产出）。
   * 比它短的间隔只会让下一轮撞上还没跑完的那轮。
   */
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 20 * 60_000;
}
function agentWorkdir(traderId: number): string {
  const base = process.env.AQ_AGENT_WORKDIR ?? '/opt/autoquant/data/agent-workspace';
  return `${base}/trader-${traderId}`;
}

/**
 * **后台调研的定时器**（每个机器人一个）—— 2026-10-13。
 *
 * ⚠️ 放在模块级（而不是类字段）：`research` 是一个闭包，
 * 它拿不到 `TraderManager` 的 `this`。而"每个机器人最多一个刷新循环"
 * 这个约束需要**跨调用共享状态**。
 */
const researchRefreshers = new Map<number, NodeJS.Timeout>();

/**
 * **在飞调研的中止控制器**（每个机器人一个）—— 2026-10-13。
 *
 * ## 为什么需要它（实测）
 *
 * 修了定时器泄漏之后，实测仍看到：
 * ```
 *   #11 status = stopped        ← 已停止
 *   claude 进程 2 个，etime 00:27  ← 但进程还在跑
 * ```
 * 它们是"启动时立刻跑一次"那批猎手 —— **已经起飞的进程停不下来**，
 * 会跑完（约 200–600 秒）才自然退出，期间每个约 150–250MB。
 *
 * 所以停止时要**主动中止**它们（`harness` 已支持 `signal`）。
 */
const researchAborts = new Map<number, AbortController>();

/**
 * **保证这个机器人有一个后台调研循环**（幂等）。
 *
 * ## 为什么需要它（用户需求 ② 的实质）
 *
 * > 「系统**不再是像现在这样定时去工作**，而是**持续、并发**的工作」
 *
 * 而实测（`#2471`）整轮 **619 秒** —— 因为决策**同步等**调研跑完。
 * 四个猎手并发也要约 400 秒，而 240 秒的猎手超时在并发下让四个**全部超时**。
 *
 * 解耦之后：调研在后台持续跑，决策读缓存**立即返回**。
 *
 * ⚠️ **幂等是必须的**：`research()` 每轮都调它，若每次都起一个定时器，
 * 几分钟内就会堆出几十个 claude code 进程（实测单进程约 250MB）。
 */
function ensureResearchRefresher(
  traderId: number,
  symbols: readonly string[],
  apiKey: string,
  /**
   * ⚠️ **情报触发的提前唤醒**（去轮次化的第三个唤醒源）。
   *
   * 本函数是**模块级**的，拿不到 `this.running`，所以由调用方（类方法里）
   * 注入这个回调，一路传给 `refreshResearch`。不传 = 只调研、不唤醒。
   */
  onHotIntel?: (why: string) => void,
): void {
  if (researchRefreshers.has(traderId)) return;
  /*
   * ══════════════════════════════════════════════════════════════════════
   *  ⚠️ **三个数字必须自洽**（2026-10-13 实测后重定）
   * ══════════════════════════════════════════════════════════════════════
   *
   * ## 原来那三个数字互相矛盾
   *
   * ```
   *   后台刷新间隔   10 分钟
   *   缓存 TTL       15 分钟
   *   调研实际耗时   **22.1 分钟**   ← 实测（4 猎手串行，全部有产出）
   * ```
   *
   * **后果**：每 10 分钟起一次调研，而一次要 22 分钟 →
   * ① 永远有第二批在跑（`refreshing` 标志挡住了并发，但**下一次触发又立刻开始**）；
   * ② 缓存 15 分钟就过期 → **决策经常读到"已过期"的缓存**，
   *    而那句日志会写着"先用旧结果，后台正在刷新"。
   *
   * ## 为什么原来的注释说"6–8 分钟"
   *
   * 那时是**并发 2**（四个猎手两批），而那个配置下**每个都超时** ——
   * "6–8 分钟"是"超时前跑的那一段"，不是"真的跑完"。
   * 现在串行（并发 1）**真的跑完了**，耗时是 **22.1 分钟**（实测各猎手 199–510 秒）。
   *
   * ## 新的口径（按"实测耗时"反推，而不是按"希望多久"）
   *
   * ```
   *   刷新间隔  = max(默认 20 分钟, 上次实测耗时 × 1.2)
   *   TTL       = 刷新间隔 + 10 分钟   ← 保证"缓存不会在下一份准备好之前就过期"
   * ```
   * ⚠️ **TTL 必须 > 刷新间隔**：否则决策会在两份情报之间读到"已过期"，
   * 而那段时间**它本可以读上一份**（新闻不是秒级变化的）。
   *
   * ⚠️ 而"实测耗时"用**自适应**的：不同机器、不同模型档位下耗时差很多
   *（我这次是 22 分钟，4 核机器上可能 8 分钟）。写死一个数会在换机器后失准。
   */
  const intervalMs = researchIntervalMs();

  const runOnce = (): void => {
    const cached = getResearchCache(traderId);
    if (cached?.refreshing === true) return;
    /*
     * ⚠️ **占位不能伪装成"一份旧情报"**（2026-10-13 实测踩到）。
     *
     * ## 现象
     *
     * ```
     *   [调研] 缓存已过期（29863939 分钟前）—— 先用旧结果，后台正在刷新
     * ```
     * **29863939 分钟 ≈ 56 年** —— 因为占位对象里 `at: 0` 被解释成 1970 年。
     *
     * ## 两个后果，第二个更严重
     *
     * ① 日志里出现一个荒谬的时间（可读性问题）；
     * ② **空字符串被当作"旧情报"返回给团队** ——
     *    而 `text: ''` 在提示词里等于**一片空白**，团队却以为
     *    "有一份过期但可用的情报"。**那比"明说没有材料"更糟**：
     *    它让 `newscaster` / `sentiment` 以为有材料可整理。
     *
     * ## 修法：`at: 0` 的占位**不算缓存**
     *
     * 判据统一成"**有没有真的查到过东西**"（`at > 0`）。
     * 于是 `research()` 那边走的是"首次调研在后台进行 —— 本轮没有新闻材料"
     * 那条路径，**如实说没有**。
     */
    const hasRealCache = cached !== undefined && cached.at > 0 && cached.text.length > 0;
    setResearchCache(traderId, {
      text: hasRealCache ? cached.text : '',
      at: hasRealCache ? cached.at : 0,
      refreshing: true,
      /* 占位时沿用旧 keys（它属于那份旧 text）；没有旧缓存就是空。 */
      keys: hasRealCache ? (cached?.keys ?? []) : [],
    });
    /*
     * 每次刷新一个**新的** controller（上一次的已经作废）——
     * 于是"停止"只需要 abort 最新那一个。
     */
    const controller = new AbortController();
    researchAborts.set(traderId, controller);
    void runOutsideCritical(async () =>
      refreshResearch(traderId, symbols, apiKey, controller.signal, onHotIntel),
    )
      /*
       * ⚠️⚠️ **不能写成 `.catch(() => undefined)`**（2026-10-13 实测抓到）。
       *
       * ## 事故现象
       *
       * 线上日志停在最后一句"4 个来源全部有产出。"，**之后再无任何调研日志** ——
       * 既没有"可用情报 N 条"，也没有"退回原文"，也没有任何错误。
       * 看起来像"后台调研跑完了但什么都没查到"，而**真相是它抛异常了**。
       *
       * 排查时我完全无从下手：`refreshResearch` 里每一个分支都会写日志，
       * 唯独"抛异常"这条路径**一个字都不留**。
       *
       * ## 为什么这条特别危险
       *
       * 它是**后台任务**：没人 await 它，异常不会冒泡到任何地方 ——
       * 如果这里吞掉，那个异常就**永远消失了**。
       * 而"团队没有新闻材料"这个现象，既可能来自"真的没查到"，
       * 也可能来自"代码炸了" —— **两者在界面上长得一模一样**。
       *
       * 所以这里必须**写日志**。这也是本项目反复强调的那条：
       * **"知道它失败"与"知道它为什么失败"是两件事。**
       */
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLogs.write(traderId, 'error', 'team', `[调研] 后台刷新异常：${message.slice(0, 300)}`);
        /* 堆栈也留下 —— 只有 message 往往指不到行号。 */
        if (error instanceof Error && error.stack !== undefined) {
          runtimeLogs.write(traderId, 'error', 'team', `[调研] 堆栈：${error.stack.slice(0, 500)}`);
        }
      })
      .finally(() => {
        const cur = getResearchCache(traderId);
        if (cur !== undefined) cur.refreshing = false;
      });
  };

  const timer = setInterval(runOnce, intervalMs);
  /* 不因为这个定时器把进程吊在退出前。 */
  timer.unref();
  researchRefreshers.set(traderId, timer);
  /* 立刻跑一次 —— 否则第一轮决策要等一个间隔才有材料。 */
  runOnce();
}

/**
 * **停掉某个机器人的后台调研循环**（2026-10-13）。
 *
 * ## 为什么必须停（一个真实的资源泄漏）
 *
 * 实测：`#11` 已经 `stopped`，而服务器上**还有 2 个 claude 进程在跑**。
 * 核实后发现 `researchRefreshers` **只在创建处出现，从未被清理** ——
 * 也就是说：
 * ```
 *   机器人停止 → 决策循环停了 → 而后台调研【每 10 分钟】照常起 4 个进程
 * ```
 * 它**不会报错、不会出现在界面上**，只是安静地吃 CPU/内存
 *（实测单个 claude 进程约 250MB）。
 *
 * ⚠️ **同时清掉缓存**：缓存是"这个机器人当前的情报"，
 * 机器人停掉之后再启动时，一份 10 分钟前的旧情报没有意义 ——
 * 而留着它会让新启动的第一轮**基于旧情报决策**。
 */
export function stopResearchRefresher(traderId: number): void {
  const timer = researchRefreshers.get(traderId);
  if (timer !== undefined) {
    clearInterval(timer);
    researchRefreshers.delete(traderId);
  }
  /*
   * ⚠️ **中止在飞的猎手**（2026-10-13 补）。
   *
   * 只清定时器是不够的：实测 `#11` 已 stopped 而 `claude` 进程仍在跑
   *（`etime 00:27`）—— 那是"启动时立刻跑一次"那批。它们会跑完
   *（约 200–600 秒）才自然退出，期间每个约 150–250MB。
   */
  const controller = researchAborts.get(traderId);
  if (controller !== undefined) {
    controller.abort();
    researchAborts.delete(traderId);
  }
  /*
   * ⚠️ **用户主动停止 → 连库一起删**（`dropPersisted: true`）。
   *
   * 既有测试的意图（`researchLifecycle.test.ts`）：
   * 「机器人停掉后再启动时，一份 10 分钟前的旧情报没有意义 ——
   *   而留着它会让**新启动的第一轮基于旧情报决策**。」
   *
   * **而进程重启（部署/崩溃）走的是另一条路** —— 它根本不调用这个函数，
   * 所以库里的那一份自然保留（那正是"活过重启"的意思，见 `clearResearchCache`）。
   */
  clearResearchCache(traderId, { dropPersisted: true });
}

/**
 * **猎手并发数** —— 由 CPU 核数推导，**两处调研共用这一个**。
 *
 * ## 为什么抽成函数（2026-10-13）
 *
 * 实测发现**同一个硬编码的 `|| 2` 在文件里出现了两处**
 *（L635 的 `refreshResearch` 与 L1614 的另一条调研路径）——
 * 我只改了第一处，而**测试当场抓到了第二处**（那条断言是全文匹配的）。
 *
 * 这正是"同一个算术写在两个地方"的典型代价：改一处等于没改。
 * 所以抽成**唯一**的实现。
 *
 * ## 取值
 *
 * ```
 *   AQ_HUNTER_CONCURRENCY 显式设置 → 用它
 *   否则 → min(3, max(1, floor(核数 / 2)))
 *     2 核 → 1（串行）· 4 核 → 2 · 8 核以上 → 3（封顶）
 * ```
 *
 * ## 为什么默认是 1 而不是 2（实测）
 *
 * ```
 *   单独实测一个猎手任务： ok=true 耗时 **92.7 秒**
 *   线上并发跑四个：        **3 个未产出**（每个"超过 600 秒未返回"）
 * ```
 * 服务器只有 **2 核 / 1971MB**，而每个猎手是
 * **一整个 claude code 进程**（150–250MB，自带 node 运行时）。
 * 2 核切成 5–6 份 → 每个慢 6 倍以上 → 全部超时。
 *
 * ⚠️ 而代价是**不对称的**：
 * ```
 *   慢 6 分钟（串行）→ 调研在【后台】跑，决策不等它 → 没有代价
 *   全部超时        → 团队永远拿不到新闻 → 功能失效
 * ```
 * 实测裁决官的原话：「材料**无新闻、无情绪**……数据不足无法判断」。
 *
 * ## ⚠️⚠️ 2026-10-14：真正的瓶颈是**内存**，而且它是被【僵尸进程】吃掉的
 *
 * 上面那个"并发四个 → 三个超时"的结论**方向是对的，但归因不全**。
 * 那天实测服务器状态：
 * ```
 *   可用内存        696MB      ← 而每个猎手要 150–250MB
 *   Swap 已用      1014MB / 2047MB   ← 已经被压到交换区上半场
 *   僵尸进程        7 个，各 66–72MB，合计 ≈ 500MB
 *                  （`/root/dsh_trade` 的 `src/bot.mjs`，目录已被删除、
 *                    日志不存在、0 个网络连接、25 天只用 1.5 小时 CPU）
 * ```
 * **清掉那 7 个之后**：可用内存 **696MB → 1039MB**（+49%），swap 回落到 707MB。
 *
 * ⚠️ **教训**：当时把"并发超时"归因成"2 核 CPU 不够"，而实际上是
 * **内存被不属于本项目的僵尸进程占着**。CPU 核数是那台机器买定离手的部分，
 * 但**可用内存是会漂移的** —— 所以只看 `cpus().length` 会得出一个
 * **过时的、偏保守的**上限，而且永远不会自己变好。
 *
 * ## 所以现在**同时看核数与可用内存**，取两者中更严的那个
 *
 * ```
 *   byCores  = min(3, max(1, floor(核数 / 2)))          ← 原来唯一依据
 *   byMemory = max(1, floor((可用内存 − 512MB 保留) / 250MB))
 *   limit    = min(byCores, byMemory, 3)
 * ```
 * ⚠️ **保留 512MB 不是随手定的**：服务本体 ~95MB、magpie ~74MB、
 * Node 堆与文件缓存会有波动，而**内存耗尽会触发 swap，进而让【所有】
 * 猎手一起变慢** —— 那比"少开一个并发"糟糕得多（上面那条"全部超时"就是它）。
 *
 * ⚠️ **读不到内存时退回按核数算**（不要因为读不到就降到 1）——
 * 与 `exchangeMaxLeverageOf` 返回 null 时退回旧行为是同一条纪律：
 * **读不到某个事实，不该让功能停下来。**
 */
function hunterConcurrency(): number {
  const explicit = Number(process.env.AQ_HUNTER_CONCURRENCY ?? '');
  if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
  const cores = (() => {
    try {
      return Math.max(1, cpus().length);
    } catch {
      return 1;
    }
  })();
  const byCores = Math.min(3, Math.max(1, cores));
  return Math.min(byCores, hunterConcurrencyByMemory());
}

/**
 * ⚠️ **核数这一项为什么是 `min(3, cores)` 而不是 `min(3, floor(cores/2))`**（2026-10-14）
 *
 * 原来除以 2 的依据是那句实测「2 核切成 5–6 份 → 每个慢 6 倍以上 → 全部超时」。
 * 但**那次慢不是 CPU 造成的，是内存**（僵尸进程占了 500MB，可用只剩 696MB，
 * swap 已被压到 1014MB/2047MB）—— 见 `hunterConcurrency` 上方那段完整证据。
 *
 * 而猎手这个工作负载**几乎不烧 CPU**：它的时间全花在等两件事上
 * ```
 *   ① claude code 进程启动（node 冷启动，一次性、毫秒级到秒级）
 *   ② WebSearch / WebFetch 的网络往返（几秒到几十秒）
 * ```
 * 真正的 CPU 密集部分是**没有的** —— 所以按"核数 ÷ 2"给 I/O 密集任务定并发，
 * 是把一个**不成立的模型**当成了依据。
 *
 * ⚠️ **所以真正的闸门交给内存**（`hunterConcurrencyByMemory`），
 * 核数只保留一个**合理性封顶**（不许超过 3）。
 *
 * ⚠️ **这是一次基于证据的修正，但仍需实测确认** —— 部署后会看猎手的
 * `ok` 比例与 `latencyMs`：若并发提到 2 之后完成率反而下降，就该退回。
 * 判据写在 `refreshResearch` 的日志里（每个猎手都记了耗时与成败）。
 */

/**
 * 按**当前可用内存**能开几个猎手（每个按 250MB 上界估）。
 *
 * ⚠️ 返回 `3`（而不是 1）当**读不到**内存时 —— 见 `hunterConcurrency()`
 * 的说明：读不到事实不该让功能降级。真正的封顶由 `byCores` 做。
 *
 * ⚠️ 保留 512MB 给服务本体/网关/缓存 —— 理由见上面那段（swap 会让**所有**
 * 猎手一起慢，那比少开一个并发糟得多）。
 */
function hunterConcurrencyByMemory(): number {
  const availMb = availableMemoryMb();
  if (availMb === null) return 3;
  const usable = availMb - HUNTER_MEMORY_RESERVE_MB;
  if (usable <= 0) return 1;
  return Math.max(1, Math.min(3, Math.floor(usable / HUNTER_MEMORY_PER_TASK_MB)));
}

/** 给服务本体、magpie 网关与文件缓存留的余量（见 `hunterConcurrencyByMemory`）。 */
const HUNTER_MEMORY_RESERVE_MB = 512;

/** 单个猎手的内存上界（实测记录在 `hunterConcurrency` 上方：150–250MB）。 */
const HUNTER_MEMORY_PER_TASK_MB = 250;

/**
 * Linux 上的**可用内存**（MB）—— 优先 `MemAvailable`。
 *
 * ⚠️ **用 `MemAvailable` 而不是 `MemFree`**：后者不把可回收的 page cache 算进去，
 * 在 Linux 上通常小一个数量级（实测同一时刻 `free` 392MB vs `available` 1039MB）。
 * 按 `MemFree` 算会得出"内存快没了"的错误结论，从而把并发降到 1。
 *
 * 读不到（非 Linux / 权限）时返回 `null` —— 调用方据此退回按核数算。
 */
function availableMemoryMb(): number | null {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (m === null) return null;
    return Math.floor(Number(m[1]) / 1024);
  } catch {
    return null;
  }
}

/**
 * **猎手超时**（毫秒）—— 同样两处共用。
 *
 * ⚠️ 原来两处**不一致**：`refreshResearch` 是 600 秒，另一条路径是 240 秒。
 * 而 240 秒**小于实测的单猎手耗时上界**（单独 92.7 秒，但并发时会成倍拉长）——
 * 那条路径的猎手实际上更容易全部超时。
 *
 * 600 秒的依据：实测单猎手 92.7–197 秒；留 3 倍余量以吸收并发抖动。
 */
function hunterTimeoutMs(): number {
  const v = Number(process.env.AQ_RESEARCH_TIMEOUT_MS ?? '');
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/**
 * **真正跑一次四猎手调研**，把结果写进 `researchCache`。
 *
 * ⚠️ 它**不抛错**（调用方已经 catch）—— 后台任务失败不该影响任何东西。
 *
 * ⚠️ 动态 `import()` 而不是顶部静态导入：`manager.ts` 与
 * `agent/harness.js` 之间有循环依赖（harness 用到 manager 的日志类型），
 * 而这段代码**只在后台首次刷新时才需要**。
 */
async function refreshResearch(
  traderId: number,
  symbols: readonly string[],
  apiKey: string,
  signal?: AbortSignal,
  /**
   * ⚠️ **情报触发的提前唤醒**（去轮次化的第三个唤醒源）—— 见下面调用点那段注释。
   *
   * 模块级函数拿不到 `this.running`，所以由调用方注入这个回调。
   * 不传 = 只调研、不唤醒（旧行为）。
   */
  onHotIntel?: (why: string) => void,
): Promise<void> {
  const { runAgentTask } = await import('./agent/harness.js');
  const { HUNTERS, buildHunterTask, mergeHunterReports, summariseHunters } = await import('./intel/hunters.js');
  const { mapConcurrent } = await import('./agent/pool.js');
  const { parseIntelReport } = await import('./intel/parseIntel.js');
  const { rankIntel } = await import('./intel/freshness.js');

  /*
   * ⚠️ 并发数与超时都走**共用函数**（`hunterConcurrency()` / `hunterTimeoutMs()`）——
   * 它们的完整依据写在函数上方。抽出来的原因见那里：
   * **同一个硬编码的 `|| 2` 在这个文件里出现过两处**，改一处等于没改。
   */
  const limit = hunterConcurrency();
  const timeoutMs = hunterTimeoutMs();
  /*
   * ⚠️ 超时走 `hunterTimeoutMs()` —— 依据写在它上方。
   * （这里原来还有一个 `?? 600_000` 的副本，与并发数那次是同一个教训：
   *   **同一个算术写在两个地方，改一处等于没改**。）
   */

  const results = await mapConcurrent(HUNTERS, limit, async (hunter) => {
    /* ⚠️ 每个猎手一个独立 workdir/HOME —— 共用会让并发实例争用 ~/.claude。 */
    const dir = `${agentWorkdir(traderId)}/hunter-${hunter.id}`;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就用共用目录 —— 至少不要因此整个失败。 */
    }
    const r = await runAgentTask({
      task: buildHunterTask(hunter, symbols),
      allowedTools: 'WebSearch,WebFetch',
      model: process.env.AQ_RESEARCH_GROUP ?? 'group/team-news',
      fastModel: process.env.AQ_GRUNT_GROUP ?? 'group/team-grunt',
      workdir: dir,
      timeoutMs,
      authToken: apiKey,
      /* 机器人停止时中止在飞的猎手 —— 见 `researchAborts` 的说明。 */
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      hunterId: hunter.id,
      label: hunter.label,
      ok: r.ok,
      text: r.text,
      ...(r.error === undefined ? {} : { error: r.error }),
      latencyMs: r.latencyMs,
    };
  });

  const reports = results.map((res, i) => {
    if (res.ok) return res.value;
    const hunter = HUNTERS[i];
    return {
      hunterId: hunter?.id ?? `hunter_${i}`,
      label: hunter?.label ?? `猎手 ${i}`,
      ok: false,
      text: '',
      error: res.error,
      latencyMs: 0,
    };
  });

  runtimeLogs.write(traderId, 'info', 'team', `[调研] ${summariseHunters(reports)}`);
  /* ⚠️ 失败原因必须写进日志 —— "知道它失败"与"知道为什么失败"是两件事。 */
  for (const rep of reports.filter((x) => !x.ok)) {
    runtimeLogs.write(traderId, 'warn', 'team', `[调研] ${rep.label} 未产出：${rep.error ?? '未知原因'}`);
  }

  if (reports.filter((x) => x.ok).length === 0) {
    /*
     * ⚠️ **全部失败时不覆盖旧缓存** —— 旧结果可能还有用（只是旧），
     * 覆盖成空会让下一轮"什么都没有"。
     */
    runtimeLogs.write(traderId, 'warn', 'team', '[调研] 全部猎手未产出 —— 保留上一份结果（若有）');
    return;
  }

  const merged = mergeHunterReports(reports);
  const parsed = parseIntelReport(merged, Date.now(), 'news_hunter');
  if (parsed.intel.length > 0) {
    /*
     * ⚠️⚠️ **`requireConfirmed: false`**（2026-10-13 实测后改）。
     *
     * ## 为什么改（实测数据）
     *
     * 线上真实一次调研的 3 条情报：
     * ```
     *   · coinstats.app · 72.0h前 · weight=0.00 · 独立来源=1 · confirmed=false
     *   · www.forbes.com · 72.0h前 · weight=0.00 · 独立来源=1 · confirmed=false
     *   · pluang.com    · 24.0h前 · weight=0.33 · 独立来源=1 · confirmed=false
     *
     *   rankIntel(默认)         → 0 条   ← 全部剔除
     *   rankIntel(不要求确认)   → 1 条   ← pluang 那条本可用
     * ```
     *
     * `independentSources` 的算法是"**同一个事件**被几个不同域名报道"。
     * 而三家媒体**报道的是三件不同的事** —— 所以这个数**在实践中几乎永远是 1**，
     * 于是 `confirmed` 永远为 `false`、**新闻永远进不了决策**。
     * 这正是"零决策"链条的最后一环。
     *
     * ## 更重要的：这条规则与用户的明确要求冲突
     *
     * > 「系统**不再设置内置风控**（我的想法是既然都要做这么智能了，
     * >  那么风格也应该由一个智能体来负责，而不是系统内置简单风控规则）」
     *
     * `requireConfirmed` 正是一个**内置规则替 AI 做决定** ——
     * 而且它做的是最坏的那种决定：**把情报扔掉**，
     * 而不是**把情报和它的可信度一起交给 AI**。
     *
     * ## 改法：标注，而不是丢弃
     *
     * · **过期**（`weight <= 0`）仍然剔除 —— 那是"事实层面的旧"，不是判断问题；
     * · **未确认**的**保留**，但在文本里**明确标注**"单一来源 · 未确认" ——
     *   让裁决官看到它、并**自己决定**给多少权重。
     *
     * 这样"防幻觉"的目的仍然达到（AI 知道它只有一个来源），
     * 但**决定权回到了 AI 手里** —— 与需求 ③ 一致。
     */
    const ranked = rankIntel(parsed.intel, Date.now(), { requireConfirmed: false });
    if (ranked.length > 0) {
      const text = ranked
        .map((r) => {
          const h = (r.assessment.ageMs / 3_600_000).toFixed(1);
          /*
           * ⚠️ **可信度必须写在文本里** —— 否则 `requireConfirmed: false`
           * 就变成"悄悄放宽了标准"，而 AI 不知道自己拿到的是单来源情报。
           */
          const trust = r.assessment.confirmed
            ? `已确认（${r.assessment.independentSources} 个独立来源）`
            : `**单一来源 · 未确认**（${r.assessment.independentSources} 个来源）`;
          return `- [${r.intel.direction}] ${r.intel.summary}\n` +
            `  来源：${r.intel.sourceUrl}（${trust}）\n` +
            `  ${h} 小时前 · ${r.assessment.verdict}`;
        })
        .join('\n');
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⭐ **生成"这次给过哪些情报键"**（2026-10-15 修 —— 断点②）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 裁决官要标注"这条决策依据了哪几条情报"，而**校验它没编造**需要
       * "这次真的给过它哪些键"。本闭包原来只返回 `string`，于是
       * `routedModel` 的 `availableIntelKeys` 恒为 `[]`、
       * `tradingDesk` 那段"必须标注 intel_keys"的要求**根本不进提示词**。
       *
       * ⚠️ **键用 `signalKeyOf()` 构造，不在这里另拼字符串** ——
       * 两处各拼一次必然漂移，而漂移的后果是"归因记下的键永远匹配不上成交"。
       * `attribution.ts` 的注释里记过同一类教训（标的必须排序后拼接）。
       *
       * ⚠️ **一条情报可能涉及多个标的**：`signalKeyOf` 会把它们排序后拼成一个键，
       * 所以这里对每条情报各生成**一个**键 —— 与 `trades.intel_keys` 的写入侧
       *（`autoTrader` 存的是决策给的键）保持同一口径。
       */
      const keys = ranked.map((r) =>
        signalKeyOf({
          /* Intel.sourceHost 已经是域名（解析时就归一化过），不必再取一次。 */
          sourceHost: r.intel.sourceHost,
          direction: r.intel.direction,
          symbols: r.intel.symbols,
        }),
      );
      setResearchCache(traderId, { text, at: Date.now(), refreshing: false, keys });
      const unconfirmed = ranked.filter((r) => !r.assessment.confirmed).length;
      runtimeLogs.write(
        traderId, 'info', 'team',
        `[调研] 可用情报 ${ranked.length} 条（过期被剔除 ${parsed.intel.length - ranked.length} 条` +
          (unconfirmed > 0 ? `；其中 ${unconfirmed} 条为单一来源未确认，已标注供裁决官自行权衡` : '') +
          '）',
      );

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⭐ **情报触发的提前唤醒**（2026-10-14 · 去轮次化的阶段 2）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## ⚠️ 这段功能**曾经从未生效过**（2026-10-16 发现并修复）
       *
       * 它原来写在 `buildTeamModel` 里的一个**深层闭包**中，位于一句
       * `return` **之后** —— 即**不可达代码**。而 `intelWake.test.ts` 用
       * **源码结构断言**钉住了它（"调研发现强情报时必须调 `requestEarlyCycle`"），
       * 于是那个测试**一直绿着，而功能一次都没跑过**。
       *
       * 我按"注释说它该干什么"删掉那段不可达代码时，4 个测试同时变红 ——
       * **那才是它的第一次生效**。教训：**结构断言能让"不可达的代码"看起来是活的**；
       * 而"不可达"这件事只有 `no-unreachable` 那条 eslint 规则（被显式关掉了）会报。
       *
       * ## 判据：什么值得叫醒决策
       *
       * ```
       *   direction 是 bullish/bearish（neutral 不算 —— 那不是信号）
       *   且 confirmed（≥2 个独立来源 —— 单源传闻不值得打断）
       *   且 freshness 是 fresh（"新鲜"档 —— 偏旧的不值得）
       * ```
       *
       * ⚠️ 注意这三道判据**比上面缓存用的 `requireConfirmed: false` 更严**，
       * 那是**刻意的**：写进材料供裁决官权衡可以放宽（决定权在 AI 手里），
       * 但**主动打断决策循环**必须严格 —— 否则单源传闻就能反复叫醒它。
       *
       * ## 为什么只在这里"发现"，不在这里"决定醒不醒"
       *
       * `requestEarlyCycle` 内部有完整的四道闸（运行中/团队模式/最小间隔/
       * 只提前不推后）—— 尤其"最小间隔"防的是
       * "情报 → 唤醒 → 决策 → 又一条情报"的紧循环。
       */
      const hot = ranked.filter(
        (r) =>
          (r.intel.direction === 'bullish' || r.intel.direction === 'bearish') &&
          r.assessment.confirmed &&
          r.assessment.freshness === 'fresh',
      );
      if (hot.length > 0) {
        const why = `情报唤醒：${hot.length} 条已确认的强方向情报（${hot
          .slice(0, 3)
          .map((h) => `[${h.intel.direction}] ${h.intel.summary.slice(0, 30)}`)
          .join('；')}）`;
        runtimeLogs.write(traderId, 'info', 'team', `[调研] ${why}`);
        onHotIntel?.(why);
      }
      return;
    }
    const note = '（本轮没有可用的新鲜情报：查到的都过期了）';
    setResearchCache(traderId, { text: note, at: Date.now(), refreshing: false, keys: [] });
    /*
     * ⚠️ **这里必须写日志**（2026-10-13 实测踩到）。
     *
     * ## 事故现象
     *
     * 线上日志停在"4 个来源全部有产出。"，**之后再无任何调研日志** ——
     * 既没有"可用情报 N 条"，也没有"退回原文"，也没有异常。
     * 于是"团队没有新闻材料"这件事**完全没有解释**。
     *
     * 而真相是：`parseIntelReport` 解析出 **3 条**情报，
     * 但 `rankIntel` 把它们**全部剔除**（`hoursAgo` 缺失 → 判为过期）
     * → 走到这个分支 → **而这个分支一句话都不说**。
     *
     * ## 为什么这条日志是必须的
     *
     * "查到 3 条但都被时效过滤掉" 与 "什么都没查到" 是**两件不同的事**：
     * 前者说明**猎手在正常工作、但输出缺字段**（该改提示词）；
     * 后者说明**信息源本身没有消息**（不该改代码）。
     * 不写日志就把这两件事混成了一件 —— 而那正是我这次排查花了很久的原因。
     */
    runtimeLogs.write(
      traderId, 'warn', 'team',
      `[调研] 查到 ${parsed.intel.length} 条情报但**全部过期**（weight=0）—— ` +
        '本轮没有可用情报。这说明猎手查到了东西、但那些消息太旧了（新闻猎手被要求查"今天"）',
    );
    return;
  }
  /* 解析不出结构化情报 → 退回合并后的原文（格式没对上，但原文仍可能有信息）。 */
  runtimeLogs.write(traderId, 'warn', 'team', '[调研] 产出不是结构化格式 —— 退回原文使用');
  setResearchCache(traderId, { text: merged, at: Date.now(), refreshing: false, keys: [] });
}
/**
 * **从"停摆判定"产出要记的日志**（纯函数 · 2026-10-17 · t99）。
 *
 * ## 为什么抽出来
 *
 * 与 `selfcheck.ts` 同一条理由：**判断逻辑是最该被断言的部分**，而它不该需要
 * 一整个 `TraderManager` 实例（那要真库、真交易所连接）才测得到。
 * 抽成纯函数之后，"实盘升级为 error / 模拟盘降为 warn / 消息必须带哪些事实"
 * 都能直接断言，并且能反向守着"**不许另造第二套阈值**"（见下）。
 *
 * ## ⚠️ 阈值是**传进来的**，不是这里写死的
 *
 * `multiplier` / `graceMs` 由调用方从 `api/server.ts` 导入后传入 ——
 * 它们就是 `/api/health` 判 `ok:false` 用的**同一批常量**。
 * 测试传一组"不是 2/300"的值就能证明这里没有硬编码：
 * **如果哪天有人把它写回 `× 2`，那条用例会红。**
 *
 * ## 分两级：只对会影响真实资金的事发强信号
 *
 * `dry_run=0` → `error`；其余（模拟盘、或不知道）→ `warn`。
 * `dryRun` 的解析口径与 `resumePersisted` / `attemptStart` 一致：
 * `row.dryRun ?? envDryRun`（机器人自己记的优先，没有才回落进程级环境变量）。
 *
 * ## 消息形状（**稳定、可检索**）
 *
 * ```
 *   [停摆] #10「赚大钱」实盘 · 已 36 分钟没有完成一轮决策（判据：周期 15 分钟 × 2
 *          与 300 秒起步宽限取较大者）· 连续失败 9 轮 · 最近错误：<前 300 字符>
 * ```
 * 前缀固定，字段顺序固定 —— 排查时 `grep '\[停摆\]'` 能把这一类全捞出来，
 * 而且四个事实（trader_id / 停摆时长 / 连续失败轮数 / 最近错误）都在同一行上。
 */
export function buildStaleNotices(input: {
  stale: ReadonlyArray<{
    traderId: number;
    staleForMs: number | null;
    awaitingFirstCycle: boolean;
    /*
     * ⚠️ **`t114` 之后这两个字段由判定函数一并带出**（`evaluateTraderHealth`）：
     *   · `thresholdMs` —— 这个机器人**这一次**用的阈值（分布驱动，因机器人而异）
     *   · `cycleInProgress` —— 是否有"足够新的 pending 行"（真在跑）
     * 都是可选的：老调用方（测试夹具）不传时文案退回"周期 × 倍数 与 宽限取较大者"。
     * ⚠️ `cycleInProgress === true` 的条目**不该出现在 `stale` 里**
     *（判定函数已经排除它）；这里再多一道防御，见下面。
     */
    thresholdMs?: number;
    cycleInProgress?: boolean;
  }>;
  rows: ReadonlyArray<{
    id: number;
    name: string;
    cycleIntervalMinutes: number;
    dryRun?: boolean;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
  envDryRun: boolean;
  multiplier: number;
  graceMs: number;
}): Array<{ traderId: number; level: 'error' | 'warn'; message: string }> {
  const byId = new Map(input.rows.map((row) => [row.id, row]));
  const out: Array<{ traderId: number; level: 'error' | 'warn'; message: string }> = [];

  for (const entry of input.stale) {
    const row = byId.get(entry.traderId);
    /* 判定里有、库里读不到（并发删除）→ 跳过，不去编一条没有名字的记录。 */
    if (row === undefined) continue;
    /*
     * ⚠️ **防御**：判定函数已经把"一轮在跑"的排除了。这里再挡一次，
     * 是因为**"误报一条停摆"的代价今天已经量过**（`t114`：响了两次，
     * 两次 `#10` 都在正常工作）。多一道守卫比多一条假警报便宜。
     */
    if (entry.cycleInProgress === true) continue;

    const realMoney = (row.dryRun ?? input.envDryRun) === false;
    const level: 'error' | 'warn' = realMoney ? 'error' : 'warn';
    const minutes = Math.round((entry.staleForMs ?? 0) / 60_000);
    const errorSnippet = (row.lastError ?? '（没有错误信息）').slice(0, 300);

    /*
     * 判据描述：优先用判定函数带回来的**这一个机器人自己的阈值**
     *（分布驱动之后它因机器人而异）；没有时退回"周期 × 倍数 与 宽限取较大者"。
     */
    const rule =
      entry.thresholdMs !== undefined
        ? `${Math.round(entry.thresholdMs / 60_000)} 分钟（周期 ${row.cycleIntervalMinutes} 分钟 × ${input.multiplier}` +
          `、${Math.round(input.graceMs / 1000)} 秒起步宽限、与实测轮次 P95 × 2 取较大者）`
        : `周期 ${row.cycleIntervalMinutes} 分钟 × ${input.multiplier}` +
          ` 与 ${Math.round(input.graceMs / 1000)} 秒起步宽限取较大者`;

    const message =
      `[停摆] #${entry.traderId}「${row.name}」${realMoney ? '实盘' : '模拟盘'} · ` +
      `已 ${minutes} 分钟没有完成一轮决策（判据：${rule}）· ` +
      `连续失败 ${row.consecutiveFailures} 轮 · 最近错误：${errorSnippet}`;

    out.push({ traderId: entry.traderId, level, message });
  }
  return out;
}

export class TraderManager {
  private readonly running = new Map<number, AutoTrader>();
  /**
   * 正在启动中的机器人（**跨 await 的互斥锁**）。
   *
   * `this.running.has(id)` 是**同步**判断，而 `this.running.set(id, autoTrader)`
   * 发生在一长串 `await` 之后（连交易所、校时、`exchangeInfo`、LLM `testConnection`、
   * 拉 N 个标的的标记价）。中间任何时刻到达的第二个 `POST /start` 都会看到
   * "还没在运行" → **两个 `AutoTrader` 先后 `start()` 成功、后者覆盖前者**：
   * 两个循环用同一份凭据重复下单、重复写同一批数据库行，而且其中一个
   * `stopTrader` 根本停不掉（`running` 里只剩后写入的那一个）。
   *
   * 双击按钮、脚本重试、或者"操作员点启动时恰好有一次开机退避重试在等"，
   * 都能凑成这个组合。所以启动必须**先占位、再干活**。
   */
  private readonly starting = new Set<number>();
  private readonly connections = new Map<string, ExchangeConnection>();
  private readonly userStreams = new Map<number, BinanceUserDataStream>();
  /**
   * 成交触发的即时对账，按机器人去抖 —— 见 `scheduleFillReconcile()`。
   */
  private readonly fillReconcileTimers = new Map<number, NodeJS.Timeout>();
  private stopping = false;
  /**
   * 被明确取消启动的机器人（操作员点了停止、或进程正在关闭）。
   *
   * 开机恢复会在退避后重试启动，而"点了停止"是比"我想让它跑"更强的意图：
   * 没有这个集合时，`stopTrader()` 之后退避到期的重试仍然会把机器人拉起来。
   */
  private readonly cancelledStarts = new Set<number>();
  /**
   * 每个正在运行的机器人是什么时候被启动的（本地时钟）。
   *
   * 给 `/api/health` 用：一个已经跑起来但还没写 `last_cycle_at` 的机器人，
   * 它的启动宽限期必须从**它自己**启动那一刻算起。用一个全局的「进程已运行多久」
   * 会让运行两小时后才启动的机器人在卡死时被白白宽限两小时；按「第一次看到
   * null」算则更糟 —— 一个永远跑不完第一轮的机器人每次探测都能重新获得宽限，
   * 于是**永远不会**被判为卡住，而它恰恰是这个检查要抓的东西。
   */
  private readonly startedAt = new Map<number, number>();

  constructor(private readonly vault: Vault) {}

  /**
   * 读出策略配置，非法则回退到默认值。
   *
   * `null` 记录 = 不依赖策略（AI 托管），同样给默认值。
   *
   * ⚠️ **回退必须留一条 warn**：`config_json` 是用户可编辑的旧行，校验失败时
   * 静默换成默认值等于把用户的策略偷偷换掉，而页面上看不出任何异常。
   */
  private configOf(
    strategyRecord: StrategyRecord | undefined | null,
  ): StrategyConfig {
    const parsed = strategyRecord ? StrategyConfigSchema.safeParse(strategyRecord.config) : null;
    if (strategyRecord && !parsed?.success) {
      log.warn(`策略「${strategyRecord.name}」校验未通过，非法字段已回退为默认值`);
    }
    return parsed?.success ? parsed.data : defaultStrategyConfig();
  }

  /**
   * Subscribe to the exchange's user-data stream for alerting.
   *
   * Deliberately **advisory only**: it logs and surfaces events but never trades.
   * All position state is still derived from the REST reconciliation that runs
   * every cycle, so a dropped or mis-routed socket cannot silently desynchronise
   * the bot — it can only delay a notification. That separation is what makes it
   * safe to attach a streaming dependency to a system that must run unattended.
   */
  /**
   * **写状态并推送**（2026-10-13 加）—— 修一个真实的"自相矛盾"。
   *
   * ## 用户报的现象
   *
   * > 「明显BUG，运行状态一边停止，一边是运行中」
   *
   * 截图里同时出现：页头徽章「**运行中**」，而按钮是「**启动**」。
   *
   * ## 根因：`manager.ts` 里 9 处 `traders.setStatus` **全都只写数据库、不推送**
   *
   * ```
   *   autoTrader.ts（正确）:
   *     setStatus() { traderStore.setStatus(...); eventBus.publish({type:'trader_status'}) }
   *
   *   manager.ts（9 处，错）:
   *     traders.setStatus(traderId, 'stopped', null);   ← 无推送
   * ```
   *
   * 于是点"停止"之后：
   * ```
   *   REST 重新拉取 → trader.status = 'stopped' → 按钮变「启动」   ✅
   *   WebSocket 从未收到 stopped 推送 → liveStatus 仍是旧的 running
   *                                     → 徽章显示「运行中」      ❌
   * ```
   * **两个数据源说的是两件事**，界面就自相矛盾了。
   *
   * ## 为什么之前没被发现
   *
   * 前端的 `status = liveStatus ?? trader?.status` **假设"推送总是比 REST 新"** ——
   * 而这里的情况恰好相反：**推送压根没发**，于是 REST 是对的、推送是陈旧的。
   *
   * ⚠️ 修法放在**服务端**（而不是让前端去猜哪个更新）：推送缺了就是缺了，
   * 前端无论怎么合并都补不出一个从未发出的通知。
   */
  private setTraderStatus(traderId: number, status: TraderStatus, error: string | null = null): void {
    traders.setStatus(traderId, status, error);
    eventBus.publish({
      type: 'trader_status',
      traderId,
      status,
      ...(error === null ? {} : { detail: error }),
    });
  }

  private async startUserStream(traderId: number, connection: ExchangeConnection): Promise<void> {
    if (!connection.rest.hasCredentials) return;

    const emit = (level: 'info' | 'warn' | 'error', message: string): void => {
      runtimeLogs.write(traderId, level, 'binance:userdata', message);
      eventBus.publish({
        type: 'log',
        traderId,
        level,
        message,
        /* 来源单独传 —— 界面用中文标签渲染，原始码仍存库供筛选。 */
        scope: 'binance:userdata',
        timestamp: new Date().toISOString(),
      });
    };

    const stream = new BinanceUserDataStream(connection.rest, connection.endpoints, {
      onMarginCall: (event) => {
        const detail = event.p
          .map((p) => `${p.s} ${p.ps} 数量=${p.pa} 维持保证金=${p.mm}`)
          .join('; ');
        emit(
          'error',
          `收到追加保证金通知（MARGIN CALL）——账户已接近强平。钱包余额 ${event.cw}。持仓：${detail}`,
        );
      },
      onOrderUpdate: (event) => {
        const o = event.o;
        // Only surface the transitions an operator cares about.
        if (o.X === 'FILLED' || o.X === 'CANCELED' || o.X === 'EXPIRED') {
          emit('info', `订单 ${o.s} ${o.S} ${o.o} ${o.X} 数量=${o.z}@${o.ap}`);
        }
        /*
         * 成交 → 立刻把账本对齐。
         *
         * 这里原来只写一行日志，配一句注释说"成交以 REST 对账为准"。那句话在
         * "对账是唯一写者"这一层仍然成立，但它掩盖了一个代价：**账本最长滞后
         * 一整个周期**（生产里 45 分钟）。对账仍是唯一写者，现在只是多了一个
         * 触发时机 —— 见 `scheduleFillReconcile()`。
         *
         * 撤单 / 过期不动账本（它们不改变持仓），仍由周期对账收拾。
         */
        if (o.X === 'FILLED') this.scheduleFillReconcile(traderId);
      },
      onListenKeyExpired: () => {
        emit('warn', '用户数据流的 listenKey 已过期，已重新创建并重连。');
      },
      onReconnected: (reason) => {
        emit('info', `用户数据流已重连（${reason}）。`);
        /*
         * ⚠️ **重连（以及首次连接）之后立刻对齐一次。**
         *
         * 断线期间可能漏掉成交推送 —— 重连不等于"什么都没发生"。实测 `20:55`
         * 那次 watchdog 强制重连之后，`21:17` 与 `21:27` 两笔保本止损在交易所
         * 成交，而账本整整 26 分钟毫无反应（当时还没有 `scheduleFillReconcile`，
         * 两个成因叠在一起，于是界面显示的是**已经不存在的事**）。
         *
         * 连接重建是**唯一**能补上"断线窗口"的时刻：那段窗口里的帧永远不会再来，
         * 只能靠读交易所补齐。
         *
         * 首次连接也走这条路径（`reason` 是 `startup`）—— 那正是想要的：进程刚
         * 起来，账本最需要立刻确认一次。它与 `AutoTrader.start()` 里那一遍重复，
         * 但对账幂等且串行，多跑一遍只是几次 API 调用。
         */
        this.scheduleFillReconcile(traderId);
      },
      onAccountConfigUpdate: (event) => {
        if (event.ac) emit('info', `${event.ac.s} 的杠杆已调整为 ${event.ac.l}x`);
      },
    });

    try {
      await stream.start();
      this.userStreams.set(traderId, stream);
      emit('info', '已订阅交易所用户数据流（订单、持仓与保证金告警）。');
    } catch (error) {
      // Alerting is a nice-to-have; never let it block a trader from starting.
      log.warn(`无法启动用户数据流：${(error as Error).message}`);
      emit('warn', `无法订阅用户数据流：${(error as Error).message}`);
    }
  }

  /**
   * 交易所刚推来一条成交 —— 排一次即时对账。
   *
   * ## 这一条把「纯告警」的注释改了
   *
   * `startUserStream()` 上面写着用户数据流是 "advisory only … a dropped socket
   * can only delay a notification"。那个说法有一个没被兑现的前提：**既然成交
   * 推送已经到了手上，账本就没有理由再等下一个周期**。实测两笔保本止损在
   * 21:17 与 21:27 触发，控制台到 21:43 仍显示「持仓 0、委托全部待对账」、
   * 历史成交里没有这两笔 —— 操作员看到的是一份停在上一个周期的账，而它说的
   * 是**已经不存在的事**。
   *
   * ## 仍然可以断
   *
   * 套接字掉线只是退回原来的行为（下一个周期对账），不会更差；对账本身是幂等
   * 且串行的（`applyExchangeFill` 会等周期跑完），所以这里加的**只是一个触发**，
   * 没有改动任何记账语义。这正是让一个流式依赖可以挂在一个必须无人值守的系统上
   * 的前提。
   */
  private scheduleFillReconcile(traderId: number): void {
    // 已经排上了就合并 —— 同一笔成交会推好几帧，没必要对账好几遍。
    if (this.fillReconcileTimers.has(traderId)) return;

    const timer = setTimeout(() => {
      this.fillReconcileTimers.delete(traderId);
      const autoTrader = this.running.get(traderId);
      if (!autoTrader) return;
      void autoTrader
        .applyExchangeFill()
        /*
         * ── **成交之后：唤醒决策循环**（事件驱动的核心一步）──────────────
         *
         * ## 为什么必须排在 `applyExchangeFill()` **之后**
         *
         * 顺序反了会让团队基于**半更新的账本**做判断（"我以为还持有，
         * 其实止损已经打掉了"）—— 那正是调研里"错误级联"的入口。
         * 先对齐状态，再叫它来看。
         *
         * ## 为什么这里需要它
         *
         * 系统原来两者都有、但中间缺一环：
         *   · 成交 → **账本**立刻对齐（本函数）；
         *   · AI 可以要求"下次什么时候再看"（1–120 分钟）。
         *
         * 缺的是：**成交之后决策循环并不知道**。账本已经对了，而团队要等到
         * 下一个周期（最长 120 分钟）才重新评估 —— 那意味着
         * **仓位已经没了，团队还在按"持有"思考**。
         *
         * 用户的要求正是这件事：
         * > 「系统**不再是像现在这样定时去工作**，而是持续、并发的工作」
         *
         * ⚠️ `requestEarlyCycle` 内部只对 `ai_team` 生效（见那里的说明）——
         * 用户明确要求不要改变现有实盘机器人（`#10 赚大钱` 是 `ai_managed`）的行为。
         */
        .then(() => {
          autoTrader.requestEarlyCycle('有成交');
        })
        .catch((error) => {
          log.warn(
            `机器人 #${traderId} 成交后即时对账失败（下一个周期仍会补上）：${(error as Error).message}`,
          );
        });
    }, FILL_RECONCILE_DEBOUNCE_MS);

    /*
     * 不因为这个定时器把进程吊在退出前：它是**可丢弃的** ——
     * 丢掉只是退回"下一个周期对账"，而不是丢掉一次成交。
     */
    timer.unref();
    this.fillReconcileTimers.set(traderId, timer);
  }

  /** 取消一个还没到点的即时对账（机器人被停掉、或进程正在关闭）。 */
  private cancelFillReconcile(traderId: number): void {
    const timer = this.fillReconcileTimers.get(traderId);
    if (!timer) return;
    clearTimeout(timer);
    this.fillReconcileTimers.delete(traderId);
  }

  isRunning(traderId: number): boolean {
    return this.running.has(traderId);
  }

  /**

  /**
   * 某个机器人此刻是不是在纸面模式下跑。
   *
   * `null` = **它没在运行**，所以这个值此刻不存在 —— 与 `circuitBreakerReading()`
   * 同一条约定：**"不知道"不能渲染成 `false`**（那会被读成"它在花真钱"）。
   *
   * 类型上 `isDryRun` 是 `boolean`，但 `deps.broker` 在测试里是替身、
   * 不一定实现了那个 getter —— 所以按 `unknown` 收，读不到就老实说读不到。
   */
  dryRunOf(traderId: number): boolean | null {
    const trader = this.running.get(traderId);
    if (!trader) return null;
    const value: unknown = trader.isDryRun;
    return typeof value === 'boolean' ? value : null;
  }

  /**
   * **启动代数**：每个机器人最近一次启动的序号。
   *
   * 用途只有一个：让"上一次启动的看门狗/回调"能判断自己是否已经过期，
   * 从而不去覆盖后来者的状态（见 `startTraderAsync`）。
   */
  private readonly startGeneration = new Map<number, number>();

  runningIds(): number[] {
    return [...this.running.keys()];
  }

  /** 正在运行的机器人的启动时刻，供健康检查计算启动宽限期。 */
  runningSince(): ReadonlyMap<number, number> {
    return this.startedAt;
  }

  statusOf(traderId: number): TraderStatus {
    return this.running.get(traderId)?.currentStatus ?? 'stopped';
  }

  /**
   * **下一轮决策的预定触发时刻**（epoch 毫秒），没有排程时 `null`。
   *
   * 由 `AutoTrader.nextCycleAt` 提供 —— 它记的是**定时器真正被排到的那一刻**，
   * 已经把"模型要求的间隔"和"失败短重试"都算进去了。界面据此显示倒计时，
   * **不自己推算**（推算会忽略那两件事，从而显示错误的时间）。
   */
  nextCycleAtOf(traderId: number): number | null {
    return this.running.get(traderId)?.nextCycleAt ?? null;
  }

  /**
   * **模拟盘账户读数** —— 由本地台账折算，不碰交易所。
   *
   * ## 余额怎么来（用户 2026-10-27 需求）
   *
   * 用户原话：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的余额」。
   *
   * ```
   *   walletBalance = 起始余额 + 已实现净盈亏
   *   unrealizedPnl = Σ 各持仓按标记价算出的浮盈
   *   marginUsed    = Σ 各持仓占用的保证金
   * ```
   *
   * 三个数**全部**来自本地台账，逐笔可核对 —— 与「账是可核对的」那条口径一致。
   *
   * ## 为什么浮盈要按**标记价**实时算
   *
   * 持仓行里存的是入场价与数量，浮盈必须用当前标记价才准。这里走
   * `this.running` 里那个 AutoTrader 的行情服务；机器人还没起来时（比如对账路径）
   * 拿不到标记价，就**按 0 计** —— 宁可少算浮盈，也不要凭空造一个价格。
   * 调用方（`connectionFor`）只在**运行中**才会读到这个函数，所以那种情况很少。
   *
   * ## 起始余额的回落顺序
   *
   *   `paper_starting_balance` → `initial_equity` → 默认 1000
   *
   * 老机器人（迁移前创建的）两个字段都可能为 0，回落给一个能开仓的默认值，
   * 而不是 0 —— 0 余额会让每一笔开仓都被「保证金不足」拒掉，看起来像功能坏了。
   */
  /**
   * 这台机器人**模拟盘本金的权威值**（`paper_starting_balance` → `initial_equity` → 默认）。
   *
   * 公开给 API 层：控制台的「账户」页要显示与机器人决策时**完全一样**的余额，
   * 否则两边会各算一套、然后对不上。回落顺序与 `paperAccountStateOf` 必须一致 ——
   * 所以只在这里实现一次，两处都调它。
   */
  paperStartingBalanceOf(traderId: number): number {
    const trader = traders.get(traderId);
    const explicit = trader?.paperStartingBalance ?? 0;
    if (explicit > 0) return explicit;
    const fallback = trader?.initialEquity ?? 0;
    if (fallback > 0) return fallback;
    return DEFAULT_PAPER_BALANCE;
  }

  private paperAccountStateOf(traderId: number): ReturnType<typeof paperAccountState> {
    const startingBalance = this.paperStartingBalanceOf(traderId);
    const realizedPnl = tradeStore.lifetimeNetPnl(traderId);

    /* 浮盈与保证金：只有运行中的机器人拿得到标记价。 */
    let unrealizedPnl = 0;
    let marginUsed = 0;
    const live = this.running.get(traderId);
    const marks = live ? live.paperMarkPrices() : new Map<string, number>();
    for (const position of positions.open(traderId)) {
      marginUsed += Number.isFinite(position.margin_used) ? position.margin_used : 0;
      const mark = marks.get(position.symbol);
      if (mark === undefined) continue;
      const quantity = position.quantity;
      const entry = position.entry_price;
      const diff =
        position.side === 'LONG' ? (mark - entry) * quantity : (entry - mark) * quantity;
      if (Number.isFinite(diff)) unrealizedPnl += diff;
    }

    return paperAccountState({ startingBalance, realizedPnl, unrealizedPnl, marginUsed });
  }

  /**
   * Resolve an exchange account into a live connection, reusing it if present.
   *
   * ## `exchangeAccountId === null` —— 纯模拟盘机器人（用户 2026-10-27 需求）
   *
   * 模拟盘不需要真实账户：它不下真实订单（`BinanceBroker` 的 dryRun 分支全程本地
   * 模拟），余额由本地台账折算（`binance/paperWallet.ts`）。所以这里在**没有账户**
   * 且 `dryRun` 为真时，建一条**只有公开行情**的连接（`connectExchange` 本来就允许
   * 不传凭据 —— 它只做校时与 `exchangeInfo`，都不需要签名）。
   *
   * 再给 broker 挂上 `paperAccount`：`getAccountState()` 从此读本地台账，
   * 而不是发一次签名的 `/fapi/v3/account`。
   *
   * ⚠️ **`dryRun` 为假时无账户一律拒绝**：那是"要下真单却没有凭据"，
   * 必须明确报错，绝不能静默降级成模拟盘（那会让操作员以为在下真单）。
   */
  private async connectionFor(
    traderId: number,
    exchangeAccountId: number | null,
    dryRun: boolean,
  ): Promise<ExchangeConnection> {
    /*
     * ⚠️ **缓存键必须带上 `dryRun`（2026-10-11 审查发现的 P0）。**
     *
     * 原来键只有 `traderId`，命中就直接返回 —— **完全不比对 `dryRun`**。后果：
     *
     *   1. 开机数秒后对全部机器人做对账，那是按**实盘**建的连接；
     *   2. 之后操作员按默认的「模拟盘」启动同一台机器人；
     *   3. 它拿到的是第 1 步那条**实盘**连接 —— 日志写"模拟盘"，**订单真实成交**。
     *
     * 这是"一个字段说模拟、另一个字段在下真单"，比任何账目偏差都严重：
     * 操作员以为在纸面上试，钱已经动了。
     *
     * 键改成 `traderId:paper|live`：两种模式各持一条连接，互不冒充。
     * 同一台机器人的两种模式**本来就不该共享**连接对象 ——
     * 它的 `dryRun` 是构造时定死的，不是可切换的开关。
     */
    const cacheKey = connectionCacheKey(traderId, dryRun);
    const existing = this.connections.get(cacheKey);
    if (existing) return existing;

    /* --- 纯模拟盘：没有账户，只要一条公开行情连接 + 本地钱包 --------- */
    if (exchangeAccountId === null) {
      if (!dryRun) {
        throw new Error(
          '这台机器人没有绑定交易所账户，只能以模拟盘运行。' +
            '要跑实盘，请先在「交易所」页添加凭证并在创建/编辑时绑定。',
        );
      }
      const connection = await connectExchange({
        /* 模拟盘没有账户，就用 Demo 的公开行情端点（它不需要任何凭据）。 */
        environment: 'demo',
        dryRun: true,
        quiet: true,
        paperAccount: () => this.paperAccountStateOf(traderId),
        ...(process.env.BINANCE_WS_HOST ? { wsHostOverride: process.env.BINANCE_WS_HOST } : {}),
      });
      this.connections.set(cacheKey, connection);
      return connection;
    }

    const account = exchanges.getWithSecret(exchangeAccountId);
    if (!account) throw new Error(`找不到交易所账户 ${exchangeAccountId}`);

    const apiKey = account.api_key;
    const apiSecret = this.vault.decrypt(account.api_secret_enc);

    const environment: BinanceEnvironment = account.testnet === 1 ? 'demo' : 'production';

    const connection = await connectExchange({
      environment,
      apiKey,
      apiSecret,
      dryRun,
      /*
       * 模拟盘即使**绑定了真实账户**，账户读数也走本地台账 —— 否则模拟盘会看到
       * 真金白银的余额，而它下的单在交易所根本不存在，两边永远对不上。
       * 这正是用户说的「模拟盘不应该根据真实钱包的余额」。
       */
      ...(dryRun ? { paperAccount: () => this.paperAccountStateOf(traderId) } : {}),
      /*
       * **不给每个机器人刷两条启动日志。**
       *
       * `connectExchange` 在非 quiet 时会打「已连接 …」和「已加载 528 个
       * 可交易的 USDT 本位永续合约；请求权重上限 2400/分钟」。
       * 而这里是**每个机器人各建一条连接**（缓存按 `traderId`），
       * 于是 5 个机器人启动时把同样两句话刷 5 遍 ——
       * 实测在「数据与日志」页上，十几行日志里只有两行是新信息。
       *
       * `server.ts` 里那三处调用本来就传了 `quiet: true`，这里是漏掉的第四处。
       *
       * ⚠️ 顺便记下**没有**做的事：连接缓存是按 `traderId` 的，
       * 所以共用同一个交易所账户的多个机器人会各建一条连接（各做一次校时、
       * 各拉一次 `exchangeInfo`）。**那确实是浪费，但不改** ——
       * 它要动"下单用的 broker 对象归谁"，而收益只是启动时省几次 API 调用
       * （不是热点），风险与收益不成比例。
       */
      quiet: true,
      ...(process.env.BINANCE_WS_HOST ? { wsHostOverride: process.env.BINANCE_WS_HOST } : {}),
    });

    this.connections.set(cacheKey, connection);
    return connection;
  }

  /**
   * Build the model client for a trader and confirm it actually answers.
   *
   * The probe is deliberately part of start-up: a rejected API key would
   * otherwise only surface as a failed trading cycle every N minutes, which is
   * a slow and confusing way to learn that a key is wrong.
   */
  /**
   * 问 provider 要一次这个模型的上下文长度，**写回数据库**。
   *
   * 调用点是 `buildModel()`：只在 `input_token_limit` 为空时才走这里，所以
   * 正常路径下它一辈子只跑一次。见那段注释里"为什么必须在这里补"。
   *
   * 全程不抛：任何失败都只记一条 warn 并保持保守预算 —— **读不到上下文长度
   * 不该让机器人起不来**。
   */
  private async discoverContextLength(
    aiModelId: number,
    row: { provider: string; model: string; label: string; base_url: string | null; api_key_enc: string | null },
  ): Promise<void> {
    const apiKey = this.vault.decryptOptional(row.api_key_enc);
    if (!apiKey) return;

    const result = await discoverModels({
      provider: row.provider as never,
      apiKey,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
    });
    if (!result.ok) {
      log.warn(
        `模型「${row.label}」的上下文长度未知，且无法从 provider 发现（${result.message}）——` +
          '**提示词预算将退回保守值**，这会白白浪费上下文（1M 的模型只能用 6 万）。',
      );
      return;
    }

    const match = result.models.find((m) => m.id === row.model);
    if (!match?.contextLength) {
      log.warn(
        `模型「${row.label}」（${row.model}）不在 provider 返回的 ${result.models.length} 个模型里，` +
          '或者它没有 `context_length` 字段 —— 提示词预算退回保守值。',
      );
      return;
    }

    aiModels.update(aiModelId, { inputTokenLimit: match.contextLength });
    log.info(
      `模型「${row.label}」的上下文长度已自动发现：${match.contextLength} tokens —— ` +
        '提示词预算按它重算（换模型后不需要手工填任何东西）。',
    );
  }

  /**
   * **构造 AI 团队模式的模型出口**（2026-10-12 新增）。
   *
   * ## 与 `buildModel` 的关系：并存，不替换
   *
   * `buildModel` 是"一条记录 = 一个模型"（`ai_managed` 用）；
   * 本方法是"一条记录 = 一个网关 + 动态模型名"（`ai_team` 用）。
   * **两者互不调用、互不影响** —— 用户硬约束要求团队模式不能碰到实盘那条路。
   *
   * ## 为什么复用 `ai_models` 那条记录当网关出口
   *
   * magpie 是 **705 个模型共用一套 baseUrl/key**，靠请求体里的模型名切换。
   * 而 `ai_models` 是"一条记录一个模型"—— 一对多表达不了。
   *
   * 与其新增一套"网关配置"概念（用户得再学一遍、再配一遍），不如
   * **把已有那条 magpie 记录当出口**：它的 baseUrl/key 就是网关的。
   * 判据用 `looksLikeMagpieGateway(baseUrl)` —— 从配置**推断**，不需要用户勾开关。
   *
   * ## 失败时不阻断启动
   *
   * 与 `buildModel` 的探测失败同一个原则（用户 2026-10-10 定的：
   * 「模型用尽那你启动以后页面上提示就行了」）：
   * 出口不通用 `error` 状态说清，而不是让机器人起不来。
   */
  /**
   * **装配 JEV 模式（实验性）的决策模型**（2026-10-19）。
   *
   * ## 它与 `buildTeamModel` 的关系
   *
   * 两者都需要**一个 magpie 网关出口**（baseUrl + key），但用途完全不同：
   * ```
   *   团队模式 → 用网关调很多 LLM，做辩论与裁决
   *   JEV 模式 → 用网关调 Jev（/v1/systemone），做类型化判断
   * ```
   * ⚠️ 所以**复用 `resolveTeamGateway()` 找出口**（同一套 `.env`/自动发现逻辑），
   * 但**不复用 `buildTeamModel`** —— 那会把模型档位、角色路由一起拖进来，
   * 而那些东西对 Jev 毫无意义（它只有 `jev-latest` 一个入口）。
   *
   * ## 失败时返回 `reason`，不抛
   *
   * 与 `buildTeamModel` 同一条纪律：装配失败**不阻断启动**，
   * 由调用方 push 一条 `severity: 'error'` 的 preflight check + 写日志。
   * 见 `buildTeamModel` 上方那段关于"静默退回单模型"的 P0 记录。
   */
  private buildJevModeModel(traderId: number): {
    model: DecisionModel | null;
    reason: string | null;
  } {
    const gateway = resolveTeamGateway(process.env);
    if (gateway === null) {
      return {
        model: null,
        reason:
          '找不到 magpie 网关配置。请在服务器 `.env` 里设置 `MAGPIE_GATEWAY_URL` 与 `MAGPIE_GATEWAY_KEY`' +
          '（或确保 magpie 的 caller-keys.json 可被本服务读取）。',
      };
    }

    /*
     * 策略配置里与风险有关的量 —— 它们是**代码算档位的输入**，
     * 不是 Jev 的判断对象（见 `jevModel.ts` 文件头：杠杆不给 Jev 选）。
     *
     * ⚠️ `strategies.get()` 要的是 **strategyId**，不是 traderId
     *（本文件 2736 行同一条写法）。`strategyId` 可空 —— AI 驱动模式的
     * 机器人可以不挂策略，那时用 `defaultJevConfig()` 的口径兜底。
     */
    const config = traders.get(traderId);
    const strategyRecord =
      config?.strategyId == null ? undefined : strategies.get(config.strategyId);
    const risk = strategyRecord?.config.riskControl;
    const equity = config?.initialEquity ?? 0;

    /*
     * ⚠️ **杠杆取策略上限的一半**：本模式是实验性的，先保守起步。
     * 直接取上限会让第一笔就用满，而 Jev 的表现**完全未知**
     *（`docs/JEV-MODE-DESIGN.md` §八 明确写了"盈利表现未验证"）。
     */
    const leverageCap = risk?.altcoinMaxLeverage ?? 10;
    const leverage = Math.max(1, Math.floor(leverageCap / 2));

    return {
      model: createJevDecisionModel({
        baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        /*
         * 模型名固定 `jev-latest`：网关侧那个别名指向当前可用的 Jev 版本
         *（实测返回 `jev-1.13.0`）。**不要在客户端钉版本号** ——
         * 那会让网关升级后我们还在请求旧版本，与 `AGENTS.md` 的网关边界相反。
         */
        model: 'jev-latest',
        timeoutMs: 20_000,
        /*
         * ⚠️⚠️ **这些参数传的是「读取函数」，不是值**（2026-10-19 用户要求）。
         *
         * ## 原来为什么不对
         *
         * 用户原话：
         * > 「需重启，你别搞这种啊，完全可以程序自己解决的吧？
         * >  用户不要关注这些和增加繁琐步骤」
         *
         * 原来的写法是 `riskPercent: 0.01` —— 在**装配时读一次**，
         * 之后界面上改了它**永远不会生效**，只能重启机器人。
         * 那是我的实现偷懒，不是必然。
         *
         * ⇒ 现在传函数，`jevModel` 在**每次决策时**调用它现读。
         *   于是界面上改完，**下一轮就用新值**，用户不需要知道"重启"这回事。
         */
        readRiskPercent: () => Math.max(0.001, jevNumber('risk_percent') / 100),
        readMaxCandidates: () => Math.max(1, Math.floor(jevNumber('max_candidates'))),
        readCoinSelect: () => jevEnum('coin_select'),
        readEntryType: () => jevEnum('entry_type'),
        readAllowShort: () => jevBool('allow_short'),
        readAllowResize: () => jevBool('allow_resize'),
        readAllowTrailing: () => jevBool('allow_trailing'),
        readMinConfidence: () => jevNumber('min_confidence'),
        readMinRiskRewardRatio: () => jevNumber('min_rr'),
        /*
         * ⚠️ 最小名义给一个**保守的固定值 5 U**。
         *
         * `buildJevModeModel()` 拿不到"当前在算哪个标的"，所以无法按标的读。
         * 而真正的逐标的判断由 `registry.minNotional(symbol)` 在**下单层**做
         *（`autoTrader` 的 `minNotionalOf`）—— 那里才是权威。
         *
         * 这里的作用只是"别让档位算出一个连 5 U 都不到的仓位"：
         * 线上实测 `AGTUSDT/QUSDT/GTCUSDT` 的 `MIN_NOTIONAL` 都是 5 U，
         * 而决策名义只有 3.74 U ⇒ 全被交易所拒。
         */
        readMinNotional: () => 5,
        readHoldAskEvery: () => Math.max(1, Math.floor(jevNumber('hold_ask_every'))),
        /* 权益也每轮现读 —— 余额会变，写死会让档位基于旧余额。 */
        readEquity: () => traders.get(traderId)?.initialEquity ?? equity,
        readMarginMode: () => jevEnum('margin_mode'),
        readLeverageMode: () => jevEnum('leverage_mode'),
        readLeverageManual: () => jevNumber('leverage_manual'),
        /*
         * ⚠️ **杠杆上限 = min(策略上限, 币种级上限)**（2026-10-19）。
         *
         * 用户原话：「滑动范围是不能大于账户本身限制」。
         *
         * 但 `buildJevModeModel()` 拿不到"当前在算哪个标的"，所以这里用
         * **策略上限**作为保守值 —— 真正的逐标的判断在 `autoTrader` 里
         * 通过 `leverageCapCache`（`getMaxLeverage` 的缓存）做。
         *
         * 实际下界由 `resolveLeverage()` 的 `Math.min(cap, …)` 兜住，
         * 而账户级限制由 `broker.setLeverage()` 的 `-4421` 降级处理。
         */
        /*
         * ⚠️ **杠杆上限按标的区分**（2026-10-19 修正）。
         *
         * 原来这里返回的是 `leverage`（= `floor(altcoinMaxLeverage / 2)` = 5），
         * 那是"默认值"，不是"上限" —— 于是滑杆设 20x 也会被夹到 5x，
         * 而用户看不出为什么。
         *
         * ## 正确口径
         * ```
         *   BTC/ETH → btcEthMaxLeverage（20x）
         *   其它    → altcoinMaxLeverage（10x）
         * ```
         * ⚠️ 这里**拿不到具体标的**（`buildJevModeModel` 没有 symbol 参数），
         * 所以给的是**两类中较宽的那个**（20x）——
         * 逐标的收紧由 `resolveLeverage()` 在 `jevModel` 里按
         * `c.symbol` 判断（见 `isMajorSymbol`）。
         *
         * 账户级限制（子账户 5x）仍然只能靠 `broker.setLeverage()` 降级。
         */
        readLeverageCap: () => Math.max(1, risk?.btcEthMaxLeverage ?? 20),
        /*
         * ⚠️ `riskControl.marginMode` 的类型只有 `'isolated'`（策略层没开放全仓），
         * 所以这里**不需要分支** —— 写 `=== 'cross' ? 'cross' : 'isolated'`
         * 会被 tsc 判成"这个比较不可能成立"，那正是类型在提醒我它不存在。
         */
        marginMode: risk?.marginMode ?? 'isolated',
      }),
      reason: null,
    };
  }

  private async buildTeamModel(traderId: number): Promise<TeamModelBuild> {    /*
     * ⚠️ **团队模式【不】使用「AI 模型」列表里的任何记录**（用户 2026-10-12 明确要求）。
     *
     * 用户原话：
     * > 「团队多智能体模式，在创建/修改的时候就不应该采用 AI 模型列表里面的，
     * >  而是直接采用系统的 magpie，（系统 AI 列表里面添加的那些不应该给这个模式使用），
     * >  因为这个模式很多东西会和其他的冲突，例如我刚才修改列表里面 magpie 的模型，
     * >  目的是为了更改赚大钱机器人的模型，但是**我猜测实际影响到了你那个团队模式的测试机器人**」
     *
     * **他猜对了**，实测确认：`#10 赚大钱` 与 `#11 团队测试` 当时都指向 `ai_models #13`。
     * 改那条记录去调一台机器人，会连带改掉所有团队机器人。
     *
     * 根因是我原来的设计：让团队模式**复用 `ai_models` 里那条 magpie 记录当网关出口**，
     * 理由是"用户不用学新配置概念"。那个理由站不住 ——
     * `ai_models` 的语义是"**一个模型**"，而团队模式要的是"**一个网关**"，
     * 两者生命周期与用途都不同，共用一条记录必然互相干扰。
     *
     * 现在改成读**独立配置**（`.env` 显式配置优先，否则从 magpie 自己的配置自动发现），
     * 与 `ai_models` 完全解耦：改任何一边都不影响另一边。
     */
    const gateway = resolveTeamGateway(process.env);
    if (gateway === null) {
      return {
        model: null,
        reason:
          '找不到 magpie 网关配置。请在服务器 `.env` 里设置 `MAGPIE_GATEWAY_URL` 与 `MAGPIE_GATEWAY_KEY`' +
          '（或确保 magpie 的 caller-keys.json 可被本服务读取）。',
      };
    }
    const baseUrl = gateway.baseUrl;
    const apiKey = gateway.apiKey;

    /*
     * ── **自动发现：让系统跟上模型的变化**（用户 2026-10-12 的明确要求）──
     *
     * 用户原话：
     *
     * > 「万一今天能用，明天不能用、改了名字或者限量了，又或者**突然上线了什么模型**
     * >  （假如系统运行中这个提供商增加了一个模型，很好用智商高，**系统是否会自动发现，
     * >  自动调研判断模型档次，然后应用到相应的智能体中**）」
     *
     * ## 为什么要在**装配时**拉一次（而不是每次决策都拉）
     *
     * · 装配发生在启动时 → **不占决策时间**（一轮决策本来就要几十秒）；
     * · 模型上下线是**低频**事件（小时/天级），每次决策都拉纯属浪费；
     * · 失败就退回静态档案（`modelCatalog`）—— **发现不了也要能跑**。
     *
     * ## 发现结果怎么"应用到智能体"
     *
     * `catalog.byTier` 是"档位 → 模型 id（免费优先排序）"。
     * 它被喂给 `ModelRouter` 当**候选链**，于是角色路由用的就是**当前真实存在**
     * 的模型，而不是档案里那份可能已经过期的清单。
     *
     * 这也是"合理安排使用"的落地点：`byTier` 的排序把 `free: 'all'` 排在前面，
     * 所以体力活（T1/T2）会优先走不限量的通道，把付费额度留给真正需要判断的环节。
     */
    const catalog = await discoverFromGateway(
      {
        baseUrl,
        apiKey,
        timeoutSeconds: TEAM_GATEWAY_TIMEOUT_SECONDS,
        maxRetries: TEAM_GATEWAY_MAX_RETRIES,
        temperature: TEAM_GATEWAY_TEMPERATURE,
        /*
         * ⚠️ `plugin-providers.json` 是 **Docker 卷里的文件**，
         * 只在同机部署时读得到。读不到就退化为"不知道免费与否"（`free: 'unknown'`），
         * **绝不猜** —— 猜错的代价是把免费模型当付费的避开（白烧额度），
         * 或者反过来（以为免费其实烧钱）。
         */
        pluginProvidersPath: process.env.MAGPIE_PLUGIN_PROVIDERS_PATH ?? null,
      },
      /*
       * ⚠️ **models.dev 的查询函数**（2026-10-14 接上）—— 补齐运行时拿不到的客观参数。
       *
       * 它是**进程级单例**（`modelsDevLookup()`）：快照只在第一次调用时同步读一次，
       * 之后由它自己的每日刷新循环维护。所以这里传的是**同一个** store，
       * 不会因为"每个机器人装配一次"而重复读盘或重复拉网络。
       *
       * ⚠️ **传 `null` 也完全合法** —— 还没拉到快照时它什么都不补，
       * 而那正是"读不到某个事实不该让功能停下来"的既有纪律
       *（与 `pluginProvidersPath` 读不到时退化为 `free: 'unknown'` 同源）。
       */
      { modelsDev: modelsDevLookup() },
    );

    if (catalog !== null) {
      /*
       * 把"发现了什么"写进日志 —— 用户要求"看得见系统在做什么"，
       * 而"模型目录变了"正是最该被看见的一类变化（它会影响后续所有决策）。
       */
      runtimeLogs.write(
        traderId,
        'info',
        'team',
        `模型目录已刷新：共 ${catalog.models.length} 个（免费 ${catalog.models.filter((m) => m.free === 'all').length} 个）；` +
          `T3 ${catalog.byTier.T3_deep.length} / T2 ${catalog.byTier.T2_mid.length} / T1 ${catalog.byTier.T1_fast.length}`,
      );
      if (catalog.appeared.length > 0) {
        runtimeLogs.write(traderId, 'info', 'team', `发现新模型：${catalog.appeared.slice(0, 10).join('、')}`);
      }
      if (catalog.disappeared.length > 0) {
        runtimeLogs.write(traderId, 'warn', 'team', `模型已消失：${catalog.disappeared.slice(0, 10).join('、')}`);
      }
    } else {
      runtimeLogs.write(
        traderId,
        'warn',
        'team',
        '未能从网关拉取模型目录 —— 本轮使用内置的静态模型档案（不影响交易，但可能错过新模型或已下线的模型）。',
      );
    }

    const router = new ModelRouter({
      /*
       * **把网关报的模型元数据交给路由器**（2026-10-17 · `t118` 的接线，`t118` 自己不在 inScope）。
       *
       * 为什么要传：`profileOf()` 只在**静态档案** `MODEL_PROFILES` 里找，而 T1 链的 5 个候选里
       * **4 个不在档案里**（`beam-free` / `group/auto-space-bunny-free` / `team-grunt` / `team-analyst`）
       * ⇒ 返回 `undefined` ⇒ 以前**一律不放大预算**。
       *
       * 2026-10-17 服务器实测（28,500 字符 = 生产规模，`newscaster` 的 base 是 1024）：
       * ```
       *   beam-free mt=1024 → reasoning=1023 · content=  0 字
       *   beam-free mt=2048 → reasoning=2047 · content=  0 字   ← 旧的 ×2 重试救不回来
       *   beam-free mt=4096 → reasoning=2336 · content=2244 字 ✅
       * ```
       * ⇒ **不是"思维链太长"，是基准 1024 太小**。`t117` 已用"未登记也 ×4"兜住；
       * 本条让路由器**知道**这些模型的 `reasoning`/`maxOutputTokens`，从"盲放大"变成"有依据的放大"。
       *
       * `catalog` 为 `null`（没拉到快照）时传 `undefined` —— 与不传等价，退回 `t117` 的兜底。
       */
      discoveredProfiles:
        catalog?.models.map((m) => ({
          id: m.id,
          reasoning: m.reasoning,
          contextTokens: m.contextTokens,
          maxOutputTokens: m.maxOutputTokens,
        })) ?? undefined,
      call: createMagpieCallFactory({
        baseUrl,
        apiKey,
        timeoutSeconds: TEAM_GATEWAY_TIMEOUT_SECONDS,
        maxRetries: TEAM_GATEWAY_MAX_RETRIES,
        temperature: TEAM_GATEWAY_TEMPERATURE,
        pluginProvidersPath: process.env.MAGPIE_PLUGIN_PROVIDERS_PATH ?? null,
        /*
         * ⚠️ **只用于 llm 日志的归属**（2026-10-17 加，见 `MagpieGatewayConfig.traderId`）。
         *
         * 这个工厂是**每机器人一个**（`buildTeamModel(traderId)` 由 `startTrader`
         * 调用），所以构造级归属在这里是**正确**的。而 `buildSelfCheckAsk()` 那个
         * 工厂被整个自检 sweep 复用、**跨多个机器人** —— 它**故意不传**
         *（错误归因比 `null` 更糟：`null` 只是查不到，记错会把人引向不存在的故障）。
         *
         * 线上实测代价：`llm` 域 17 条「空内容（finish_reason=length）」里
         * **14 条 `trader_id` 是 `null`**，于是"哪个机器人在空转"答不出来。
         */
        traderId,
      }),
      /*
       * **把发现到的候选链交给路由器** —— 这就是"应用到相应的智能体中"那一步。
       *
       * `null`（没发现成功）时路由器回退到静态档案，行为与之前一致。
       */
      ...(catalog !== null ? { discoveredLadders: catalog.byTier } : {}),
      /*
       * 观测：每一次降级都写进本机器人的日志。
       * 用户反复要求"看得见系统在做什么"，而降级正是最该被看见的事
       *（"为什么这轮慢"的答案通常就是"首选额度尽了、换了两次"）。
       */
      onFallback: (info: { from: string | null; to: string; verdict: { reason: string } }) => {
        runtimeLogs.write(
          traderId,
          'warn',
          'team',
          `模型降级：${info.from ?? '首选'} → ${info.to}（${info.verdict.reason}）`,
        );
      },
    });

    /*
     * ⚠️ **这里返回的是「跑整个交易台」的模型，不是单角色路由**（S3 完成接线）。
     *
     * 为什么这个区别重要：`autoTrader` 只会 `complete(system, user)` 一次，
     * 而团队模式需要**一次调用背后跑完 7 个角色**（4 分析师并行 → 辩论 → 裁决）。
     * 所以编排必须**封装在模型层内部**，交易循环那边看到的仍然是
     * "一个模型给了一段 `<decision>` 文本"。
     *
     * 这也是"不碰交易循环"的具体形态 —— 见 `routedModel.ts` 的文件头说明。
     */
    /*
     * ⚠️ **把网关的真实模型清单交给候选链过滤器**（2026-10-18）。
     *
     * ## 为什么在这里
     *
     * `routedModel.ts` 的 T1/T2/T3 候选链是手工维护的字符串数组，而**链上的 id 会失效**
     * （本文件 2026-10-18 实测：`group/auto-space-bunny-free` 在线上网关已不存在，
     * 现名 `group/auto-space-bunny`）。失效时没有任何测试会变红，只会让每轮决策
     * 先撞一次 404 再轮到下一个候选 —— 静默变慢，最难发现的那一类。
     *
     * ## 为什么用 `discoverModels` 而不是自己再打一次 `/v1/models`
     *
     * 那个函数**已经**在别处被用来发现上下文长度了，而且自带 baseUrl/key 的处理与
     * 缓存。这里再打一次只会多一份要维护的代码。
     *
     * ## 拿不到会怎样
     *
     * `setAvailableModelIds(null)` ⇒ `resolveLadder()` 原样返回（不筛）。
     * **宁可用可能失效的链，也不能让机器人没有候选** —— 见 `ladderResolve.ts`。
     * 整段包 try/catch：这是"让链更准"的优化，**不能因为它的失败让机器人起不来**。
     */
    try {
      /*
       * `gateway` 是 `TeamGatewayConfig`（`{ baseUrl, apiKey, source }`）——
       * key 与地址它自己已经解析好了，**不需要再去查库/解密**。
       */
      const discovered = await discoverModels({
        provider: 'magpie' as never,
        apiKey: gateway.apiKey,
        baseUrl: gateway.baseUrl,
      });
      if (discovered.ok && discovered.models.length > 0) {
        setAvailableModelIds(discovered.models.map((m) => m.id));
      } else {
        setAvailableModelIds(null);
      }
    } catch (error) {
      setAvailableModelIds(null);
      log.warn('取网关模型清单失败，候选链不做死 id 过滤（这只会让慢一点，不影响正确性）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const model = createTeamDecisionModel({
      router,
      baseMaxTokens: TEAM_BASE_MAX_TOKENS,
      /*
       * 每一步都写进本机器人的日志 —— 用户反复要求"看得见系统在做什么"。
       * 多智能体模式下这一步尤其关键：否则界面上只是一轮很慢的决策，
       * 看不出"它在开会"。
       */
      onStep: ({ role, phase, note }) => {
        runtimeLogs.write(traderId, 'info', 'team', `[${phase}] ${role}：${note}`);
        /*
         * ⚠️ **同时推给前端事件流**（2026-10-12）。
         *
         * 用户要求团队看板「直观显示**有哪些智能体，都是什么分工，都在做什么**」。
         * 只写 `runtime_logs` 的话，界面得靠轮询日志才能看到 —— 而团队的每一步
         * 是**实时**发生的（分析师并行、辩论、裁决），轮询既慢又拿不到"正在进行中"。
         *
         * 带 `role` 与 `phase` 推 `cycle_step`，界面就能**按角色分组、按阶段排序**
         * 显示成"团队正在开会"的形态，而不是一串时间戳日志。
         *
         * `cycleNumber` 用当前轮次（`autoTrader` 那边也会推它自己的步骤，
         * 两者用同一个 `traderId` + `cycleNumber` 就自然归到同一轮）。
         */
        eventBus.publish({
          type: 'cycle_step',
          traderId,
          /*
           * 轮次取自数据库的 `last_cycle_number` **+1** —— 团队会议发生在
           * 决策循环的第 7 步，那时 `last_cycle_number` 还是**上一轮**的值，
           * 所以 +1 就是"正在跑的这一轮"。
           *
           * 用数据库而不是内存计数：**跨重启一致**（部署重启后轮次不会错位），
           * 而且与 `autoTrader` 那边推的 `cycleNumber` 同源，能自然归到同一轮。
           */
          cycleNumber: (traders.get(traderId)?.lastCycleNumber ?? 0) + 1,
          level: 'info',
          message: note,
          at: new Date().toISOString(),
          role,
          phase,
        });
      },
      /*
       * ── **市场调研（联网搜索）**（用户需求 #2 / #4）──────────────────────
       *
       * 用户原话：
       * > 「总管**委派子代理去做市场调研**（查新闻、各大交易所社区、社交媒体、
       * >  新闻源等等。。）根据资料反馈给相应的智能体做处理」
       * > 「以后系统自身需要用到网络搜索，**可以直接用 magpie 内置的搜索 MCP**
       * >  `http://127.0.0.1:3425/mcp/magpie/web-search`（我已经配置好了密钥）」
       *
       * ## 为什么直接用 magpie 的搜索 MCP（不重复造轮子）
       *
       * magpie 已经把"搜索 API（tavily/brave/exa/…）或会搜索的模型"统一成一个
       * `web_search` 工具，而用户**已经配好了密钥**。自己再接一套搜索 API 是重复劳动，
       * 而且会多一个要维护的密钥与限流面。
       *
       * ## 端点与 key 从哪来
       *
       * **复用团队网关的 key**（同一个 magpie 实例）—— 不再新增一套配置。
       * 端点可用 `MAGPIE_SEARCH_URL` 覆盖（默认 magpie 的标准位置）。
       */
      research: async (symbols) => {
        /*
         * ── ① 先看缓存（见 `researchCache` 的说明）──────────────────────
         *
         * 实测一次 agent 调研要 **197 秒**，而新闻不是秒级变化的 ——
         * 让每轮决策都白等 3 分钟是纯浪费，且会把整轮拖到十几分钟。
         */
        const cached = getResearchCache(traderId);
        const age = cached === undefined ? Infinity : Date.now() - cached.at;

        if (cached !== undefined && age < researchTtlMs()) {
          runtimeLogs.write(
            traderId, 'info', 'team',
            `[调研] 用缓存结果（${Math.round(age / 1000)}s 前查到，有效期 ${Math.round(researchTtlMs() / 60_000)} 分钟）`,
          );
          /*
           * ⚠️ **必须把 `keys` 一起返回**（2026-10-15 修 —— 断点②）。
           *
           * 原来这里 `return cached.text`（只给字符串），于是
           * `routedModel` 的 `availableIntelKeys` 恒为 `[]` ——
           * 而它是"裁决官标注情报来源"与"校验它没编造"的**唯一依据**。
           * 整条「情报归因 → 信号失效检测」因此从未通电（实测
           * `trades.intel_keys` 三个机器人 500+ 行全为 `[]`）。
           */
          return { text: cached.text, keys: cached.keys };
        }

        /*
         * ── ①b **后台刷新，决策不等它**（2026-10-13 解耦）──────────────────
         *
         * ## 为什么必须解耦（实测数据）
         *
         * 用户的要求：
         * > 「系统**不再是像现在这样定时去工作**，而是**持续、并发**的工作」
         *
         * 而实测（`#2471`）整轮 **619 秒** —— 因为决策**同步等**调研跑完。
         * 四个猎手即便并发也要约 400 秒（两个一批，每批约 200 秒），
         * 而 `240 秒` 的猎手超时在并发下让**四个全部超时**：
         * ```
         *   [调研] 新闻猎手 未产出：agent 超过 240 秒未返回
         *   （四个都是同一个原因）
         * ```
         *
         * ## 正确形状：调研在后台持续跑，决策读最新结果
         *
         * ```
         *   后台：每 N 分钟跑一次四猎手 → 写进 `researchCache`
         *   决策：读缓存（几乎总是新鲜的）→ **立即返回**
         * ```
         * 于是"持续工作"与"决策不被拖慢"**同时成立**。
         *
         * ⚠️ 缓存**空**时（首次启动）也不阻塞等待 —— 立刻返回一句说明，
         * 让团队知道"这一轮没有新闻材料"。**不能让整轮卡在调研上。**
         */
        ensureResearchRefresher(traderId, symbols, apiKey, (why) => {
          /*
           * ⚠️ **情报触发的提前唤醒** —— 接线在这里，判据在 `refreshResearch` 里。
           *
           * `refreshResearch` / `ensureResearchRefresher` 都是**模块级**函数，
           * 拿不到 `this.running`，所以在这一层（类方法内）注入。
           *
           * ⚠️ 用 optional chaining：机器人可能已经停了（调研是 20 分钟的后台节奏，
           * 期间用户完全可能停掉它）—— 那时 `running` 里没有它，静默跳过是对的。
           *
           * ⚠️ **`requestEarlyCycle` 内部有四道闸**（运行中/团队模式/最小间隔/
           * 只提前不推后）—— 这里只负责"发现值得唤醒的事"，要不要醒由那些闸决定。
           */
          this.running.get(traderId)?.requestEarlyCycle(why);
        });
        /*
         * ⚠️ **判据是"有没有真的查到过东西"，不是"Map 里有没有这一项"**
         *（2026-10-13 实测踩到）。
         *
         * 后台刷新会先写一个 `refreshing: true` 的**占位**（`at: 0`、`text: ''`）——
         * 而第一版这里只看 `cached !== undefined`，于是：
         * ```
         *   [调研] 缓存已过期（29863939 分钟前）—— 先用旧结果，后台正在刷新
         * ```
         * 并**把空字符串当作"旧情报"返回给团队** ——
         * 那比"明说没有材料"更糟：它让 `newscaster` 以为有材料可整理。
         */
        const hasRealCache = cached !== undefined && cached.at > 0 && cached.text.length > 0;
        if (hasRealCache) {
          /* 有**过期**缓存 → 先用它（总比"什么都没有"好），后台已在刷新。 */
          runtimeLogs.write(
            traderId, 'info', 'team',
            `[调研] 缓存已过期（${Math.round(age / 60_000)} 分钟前）—— 先用旧结果，后台正在刷新`,
          );
          /* ⚠️ 同上面那条：keys 必须一起给（否则裁决官无从标注）。 */
          return { text: cached.text, keys: cached.keys };
        }
        runtimeLogs.write(
          traderId, 'info', 'team',
          '[调研] 首次调研在后台进行 —— 本轮**没有新闻材料**（下一轮就会有）',
        );
        /*
         * ⚠️ 没有材料时 `keys` 是 `[]` —— 那会让 `tradingDesk` **不要求**
         * 裁决官标注（见它那段"没有可选键时不该要求标注"的判据）。
         * 这是对的：没有材料就没有键可标。
         */
        return {
          text: '（本轮没有新闻材料：首次调研正在后台进行，下一轮就会有）',
          keys: [],
        };

      },
    });

    return { model, reason: null };
  }

  private async buildModel(aiModelId: number): Promise<{ client: LlmClient; config: ReturnType<typeof aiModels.get> }> {
    const row = aiModels.getWithSecret(aiModelId);
    if (!row) throw new Error(`找不到 AI 模型 ${aiModelId}`);

    const apiKey = this.vault.decryptOptional(row.api_key_enc);
    if (!apiKey && row.provider !== 'custom') {
      throw new Error(`AI 模型「${row.label}」还没有存储 API Key`);
    }

    /*
     * ── 补上这个模型的上下文长度（它是提示词预算的唯一依据）────────────────
     *
     * ## 为什么必须在这里补，而不是在创建模型时
     *
     * `promptTokenBudget(inputTokenLimit)` 把**模型能吃的上下文**换算成提示词预算
     * （1M 的模型 → 80 万；见那段注释）。而 `input_token_limit` 这一列**创建端点
     * 从来不写它** —— `POST /api/ai-models` 只填了 temperature / maxTokens /
     * timeout / maxRetries，于是它一直是建表时的默认值 **0**。
     *
     * 而 `promptTokenBudget(0)` 会退回保守的 **6 万**。也就是说：
     *
     *   · 用户换一个 1M 上下文的新模型 → **预算仍停在 6 万**，九成上下文白给；
     *   · 而且**没有任何症状** —— 机器人照常跑，只是看不见那么多标的。
     *
     * 用户的要求原话是：「**如果后续我更换其他模型（上下文/思考等参数有变动，
     * 得保证系统可用性，会自己调节等等）**」。所以这里做成**自愈**的：
     * 这一列为空时，去问 provider 要一次（`/models` 的 `context_length`）
     * 并**写回数据库** —— 下一次启动就不必再问。
     *
     * ## 为什么失败不阻断启动
     *
     * 拉模型列表是一次网络请求，而它失败的原因（网关不稳、该端点不返回
     * `context_length`、Key 权限不含 models 读取）都与"这台机器人能不能交易"
     * 无关。**读不到就退回保守预算**，而不是让机器人起不来 —— 与
     * `getMaxLeverage()` 读不到档位时的处理同一个原则。
     */
    if (!(row.input_token_limit > 0)) {
      await this.discoverContextLength(aiModelId, row).catch(() => undefined);
    }

    const client = new LlmClient({
      provider: row.provider as never,
      apiKey,
      model: row.model,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      temperature: row.temperature,
      /*
       * ⚠️ **抬到下限**：推理与正文共享这个额度，而推理量随提示词规模增长 ——
       * 16384 的文件已实测被推理吃满、正文 0（见常量上的说明）。
       */
      maxTokens: Math.max(row.max_tokens, MIN_MAX_TOKENS_FOR_REASONING),
      timeoutSeconds: row.timeout_seconds,
      maxRetries: row.max_retries,
      /*
       * **思考等级 `high` —— 实测这是这个模型的最优档，不是"保守值"。**
       *
       * `row` 上没有这一列 —— 它是**所有模型共用的策略**，不是每个模型各配一个。
       *
       * ## 为什么是 high 而不是更高的档（实测，不是推理）
       *
       * 这个 provider 的 `reasoning_effort` 支持
       * `low | medium | high | xhigh | max`（传 `none`/`minimal` 会被 400：
       * "expected one of ..."）。用户提出的问题是：
       * **"开启/关闭思考会不会影响最终决策的质量"** —— 于是直接量它。
       *
       * 两组题（7 道，全部有唯一正确答案、需要多步推导，且取自这个项目真实
       * 遇到的约束：多约束取小、取整损失、扣成本后的盈亏比、保本守卫的连锁后果）：
       *
       *     档位     正确率(简单4题)  正确率(难题3题)  难题推理token  难题平均耗时
       *     low         4/4              3/3            14,294        22.8s
       *     medium      4/4              3/3             7,736        12.8s
       *     high        4/4              3/3             4,906         8.5s
       *     xhigh       4/4              3/3            13,880        21.5s
       *     max         4/4              3/3            10,397        16.3s
       *
       * **五个档位的正确率完全一样**，而 `high` 的推理量最少、耗时最短。
       * 提高档位是**纯开销**（推理涨 2–3 倍、耗时涨 2.5 倍，答案一字不差）；
       * 而**降到 `low` 反而更慢**（14,294 vs 4,906）—— "低档更省"是错的直觉。
       *
       * ## 这个结论的边界（不要把它当万能）
       *
       * 考的都是**有确定答案的计算与约束判断**。真实决策里还有主观部分
       * （趋势结构、信号强弱），那些题量不出来。但**安全关键的那一半**
       * —— 算仓位、判约束、算风险 —— `high` 已经到顶。
       *
       * ⚠️ 不是所有 provider 都认这个参数，所以 `LlmClient` 里有一层降级：
       * 第一次带上，被 400 拒绝就立刻去掉重来一次，并把这次经历记进日志。
       * **一个可选的思考等级，不该让整条决策链失败。**
       */
      reasoningEffort: 'high',
    });

    const probe = await client.testConnection();
    if (!probe.ok) {
      /*
       * ⚠️ **模型不可达不再阻止启动（2026-10-10，用户定的原则）。**
       *
       * 用户的原话：「模型用尽也不应该让我卡在启动\停止页面上，**切换不切换是用户来决定**，
       * 模型用尽那你**启动以后页面上提示就行**了」。
       *
       * 原来这里是 `throw` —— 于是一个额度用尽的模型会让「启动」直接失败：
       * 操作员既起不来、又被卡在那一页上，还得自己琢磨为什么。
       * 而**换不换模型是操作员的决定**，系统不该替他做，
       * 更不该用"起不来"这种形式**逼**他做。
       *
       * 现在只记事实：`recordLlmHealth` 写进 `llm_health:<id>`，界面上的「最近错误」
       * 读的就是它。启动照常继续 —— 模型不可用时那一轮决策会失败，
       * 而**失败显示在页面上**，那才是操作员需要看到的形态。
       * （之后每次模型调用的成败由下面 `tracked.chat` 持续记录。）
       */
      log.warn(`AI 模型「${row.label}」探测失败，但启动继续：${probe.message}`);
      recordLlmHealth(aiModelId, {
        ok: false,
        at: new Date().toISOString(),
        latencyMs: probe.latencyMs,
        error: probe.message.slice(0, 300),
      });
    } else {
      log.info(
        `AI 模型「${row.label}」（${row.provider}/${row.model}）响应正常，耗时 ${probe.latencyMs}ms`,
      );
    }

    /*
     * ⚠️ **把每次调用的成败记下来 —— 否则它只活在日志里。**
     *
     * 见 `LlmHealth` 的注释：网关连着 12 次回"余额不足"时，界面上一个字都没有。
     * 这里用 `Object.create(client)` 而不是展开（`{...client}`）—— 展开只复制
     * **自有属性**，而 `chat` / `testConnection` 都在原型上，展开会把它们丢掉。
     */
    const tracked = Object.create(client) as LlmClient;
    tracked.chat = async (...args: Parameters<LlmClient['chat']>) => {
      try {
        const result = await client.chat(...args);
        recordLlmHealth(aiModelId, {
          ok: true,
          at: new Date().toISOString(),
          latencyMs: result.latencyMs,
        });
        return result;
      } catch (error) {
        recordLlmHealth(aiModelId, {
          ok: false,
          at: new Date().toISOString(),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        });
        throw error;
      }
    };

    return { client: tracked, config: aiModels.get(aiModelId) };
  }

  /* ---------------------------------------------------------------------- */
  /*  Start / stop                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Start one trader, optionally retrying a **transient** failure with backoff.
   *
   * Retrying lives here rather than in `resumePersisted()` so there is exactly one
   * retry loop in the lifecycle: the boot path and any future automatic caller get
   * the same policy, and an operator-initiated start stays instant because the
   * operator is present and can see the error themselves.
   */
  async startTrader(
    traderId: number,
    dryRun: boolean,
    options: { retryTransient?: boolean } = {},
  ): Promise<StartResult> {
    /*
     * ⚠️ **全局熔断必须在"生命周期的最底层"判定，而不是只装在 HTTP 路由上。**
     *
     * `GLOBAL_TRADING_DISABLED` 原来只有两处判定：`/start` 与 `/run-once` 路由。
     * 而开机恢复走的是 `resumePersisted()` → `startTrader()`，**中间没有任何开关判定**
     * —— 于是操作员设了 `GLOBAL_TRADING_DISABLED=true` 并重启（改 env 只能靠重启，
     * 这是唯一的变更途径）之后，**所有原本 running 的机器人会照常用 `dryRun=false`
     * 恢复实盘交易**，而 `index.ts` 还会打印「任何机器人都无法启动」——
     * 一句**事实错误**的日志，让操作员以为已经止血。
     *
     * 放在这里而不是只补在 `resumePersisted()`：这是所有启动路径的唯一收口
     * （路由、开机恢复、以及任何未来的自动调用者），一行判定就能让开关真的生效。
     *
     * ⚠️ 三道守卫的**判定与文案**现在都在 `startGuard()` 里（纯函数，有单测钉住）——
     * 改这里之前先看那个函数上面的说明。
     */
    const trader = traders.get(traderId);
    const guard = startGuard({
      traderId,
      globalTradingDisabled: env.globalTradingDisabled,
      traderExists: trader !== undefined,
      running: this.running.has(traderId),
      starting: this.starting.has(traderId),
    });
    if (!guard.ok) {
      if (env.globalTradingDisabled) {
        log.warn(`机器人 ${traderId} 的启动被拒绝：GLOBAL_TRADING_DISABLED 已设置。`);
      }
      return { ok: false, error: guard.error, preflight: [] };
    }

    if (!trader) return { ok: false, error: `找不到机器人 ${traderId}`, preflight: [] };

    /*
     * 占位必须在**第一个 await 之前**，否则并发 start 会双双通过上面那道检查
     * （见 `starting` 的说明）。`finally` 保证任何出口都释放 —— 启动失败时
     * 也要能重来，否则一次网络抖动就会让这台机器人**再也点不起来**。
     */
    this.starting.add(traderId);
    try {
      this.stopping = false;
      const retry = options.retryTransient === true;

      for (let attempt = 0; ; attempt += 1) {
        const outcome = await this.attemptStart(traderId, trader, dryRun);
        if (outcome.result.ok) return outcome.result;

        const message = outcome.result.error ?? '未知错误';
        const canRetry =
          retry &&
          !outcome.permanent &&
          !this.cancelledStarts.has(traderId) &&
          !this.stopping &&
          attempt < BOOT_RETRY_BACKOFF_MS.length;

        if (!canRetry) return outcome.result;

        const waitMs = BOOT_RETRY_BACKOFF_MS[attempt] ?? 90_000;
        log.warn(
          `机器人 ${traderId} 启动失败（第 ${attempt + 1} 次）：${message}；${Math.round(waitMs / 1000)}s 后重试`,
        );
        runtimeLogs.write(
          traderId,
          'warn',
          'manager',
          `启动失败，${Math.round(waitMs / 1000)} 秒后自动重试（第 ${attempt + 1}/${BOOT_RETRY_BACKOFF_MS.length} 次）：${message}`,
        );
        await this.waitForRetry(waitMs, traderId);
        if (this.cancelledStarts.has(traderId) || this.stopping) return outcome.result;
      }
    } finally {
      this.starting.delete(traderId);
      /*
       * 启动循环已经结束 —— 把那面"取消启动"的旗子**收掉**。
       *
       * `cancelledStarts` 原来只增不减（4 处 `add`、0 处 `delete`），于是
       * "这个机器人被要求停止启动"这条信息会**永久留在集合里**，而它正是
       * `startTrader` 判断能不能重试的依据之一（`!this.cancelledStarts.has(id)`）
       * —— 一旦某个机器人被停止过一次，它以后就再也不会被开机重试恢复。
       *
       * 集合的语义是"**进行中**的启动被取消了"，所以生命周期只能到这里为止。
       */
      this.cancelledStarts.delete(traderId);
    }
  }

  /**
   * 等待下一次重试，但**可以被取消**。
   *
   * 用 1 秒的短切片而不是一次 `setTimeout(waitMs)`：退避最长 90 秒，
   * 而中间任何时刻操作员都可能点"停止"或进程收到 SIGTERM。一次性的长
   * 定时器会让这两个信号都要等满退避才生效 —— 期间机器人还会被启动起来。
   */
  private async waitForRetry(waitMs: number, traderId: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.stopping || this.cancelledStarts.has(traderId)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    }
  }

  private async attemptStart(
    traderId: number,
    trader: NonNullable<ReturnType<typeof traders.get>>,
    dryRun: boolean,
  ): Promise<{ result: StartResult; permanent: boolean }> {
    const checks: PreflightCheck[] = [];

    try {
      /* --- Connection + preflight --------------------------------------- */
      const connection = await this.connectionFor(traderId, trader.exchangeAccountId, dryRun);
      const connectivity = await preflight(connection, { requireCredentials: !dryRun });
      checks.push(...connectivity);

      const blocking = connectivity.filter((c) => !c.ok && c.blocking);
      if (blocking.length > 0) {
        dropConnections(this.connections, traderId);
        const message = blocking.map((c) => `${c.name}: ${c.detail}`).join(' ');
        this.setTraderStatus(traderId, 'error', message);
        return {
          result: { ok: false, error: message, preflight: checks },
          permanent: isPermanentStartFailure(message),
        };
      }

      /* --- Strategy（**可选**）-------------------------------------------- */
      /*
       * ⚠️ **AI 托管的机器人不依赖策略。**
       *
       * 它的参数整份存在 `agent_config_json` 里（由 AI 自己写），策略对它
       * **完全不生效** —— 见下面 `effectiveConfig` 与 `M6`/`M7` 的说明。
       * 所以这里**不能**因为"策略不存在"就抛错：那会让"把默认策略删掉"直接变成
       * "AI 托管机器人启动不了"，而用户的要求恰恰是
       * 「就算策略工坊里面默认策略 — 稳健就算删除、没有任何策略，都不影响智能托管模式」。
       *
       * 这里原来的写法是 `if (!strategyRecord) throw`，而 `strategies.get()` 对
       * `null` 会返回 `undefined` —— 于是报错信息还会是「找不到策略 null」。
       *
       * 固定策略模式下策略仍然**必须**有，但那条约束由**创建/编辑的 API** 把关，
       * 并且这里给一个说人话的错误，而不是让它在别处以奇怪的方式失败。
       */
      const strategyRecord =
        trader.strategyId === null ? undefined : strategies.get(trader.strategyId);
      /*
       * ⚠️ **判据必须是"这个模式是不是 AI 驱动"，不能写死 `'ai_managed'`**
       *（2026-10-12 实测踩到）。
       *
       * 原来的写法是 `trader.mode !== 'ai_managed'`。加了 `ai_team` 之后，
       * 一个新模式的机器人**会被当成"按固定策略运行"**，于是启动时抛
       * 「它引用的策略已不存在」—— 而 AI 团队模式的参数整份由团队自己管，
       * **本来就不该有策略**。实测症状（#11 启动即 error）：
       *
       *     #11 [团队测试] ai_team status=error
       *     last_error=这个机器人按固定策略运行，但它引用的策略已不存在…
       *
       * 而共享包里**早就导出了 `AI_DRIVEN_MODES`** 就是为了这个 ——
       * 让"哪些模式由 AI 驱动"只有一个定义处，而不是散在各层的字符串比较里。
       * 我上一轮在 API 层用了它，却**漏了这里** —— 于是同一个 bug 换个地方又出现。
       */
      if (!isAiDriven(trader.mode) && !strategyRecord) {
        throw new Error(
          '这个机器人按固定策略运行，但它引用的策略已不存在 —— 请为它重新选择一个策略，或改成 AI 托管模式。',
        );
      }
      const config: StrategyConfig = this.configOf(strategyRecord);

      /* --- Model -------------------------------------------------------- */
      /*
       * ⚠️ **把 `config` 一起解构出来**（2026-10-17）：它的 `maxTokens` 就是构造
       * `LlmClient` 时用的那个输出预算，而交易循环的**空正文重试**要靠它放大预算
       *（`DecisionModel.outputBudgetTokens`）。不传的话，那 4 倍放大**不生效** ——
       * 见 `autoTrader.ts` 的 `emptyContentRetryPlan()` 与它上面那段说明。
       *
       * 别名 `modelConfig` 是必需的：上面几行的 `config` 是**策略配置**
       *（`StrategyConfig`），两者同名会直接编译不过。
       */
      const { client, config: modelConfig } = await this.buildModel(trader.aiModelId);
      checks.push({
        name: '语言模型',
        severity: 'ok',
        ok: true,
        detail: '模型已成功响应探测请求。',
        blocking: false,
      });

      /*
       * ── AI 团队模式的**模型出口**（2026-10-12 新增，与智能托管完全隔离）──
       *
       * ## 为什么在这里分叉，而不是改动那个已有的 `model`
       *
       * 用户硬约束：「这次更新是一个全新的项目，和现在智能托管是 2 个东西……
       * **不要影响我现在实盘跑的机器人**」。
       *
       * 所以 `ai_team` 走**另一条构造路径**，而 `strategy` / `ai_managed`
       * 用的那个 `model` 对象**一个字节都不变** —— 后者上面挂着用户的真金白银。
       *
       * ## 出口怎么来的
       *
       * 团队模式需要"一个网关 + 动态模型名"（magpie 是 705 个模型共用一套
       * baseUrl/key）。而 `ai_models` 表是"一条记录 = 一个供应商 + 一个模型"。
       *
       * 所以复用那条记录当**网关出口**：它的 baseUrl/key 就是网关的，
       * 模型名由角色路由在运行时决定（见 `magpieGateway.ts` 的文件头说明）。
       * **这样用户不用学新配置概念** —— 他已经在「AI 模型」里配过 magpie 了。
       */
      const teamBuild =
        trader.mode === 'ai_team'
          ? await this.buildTeamModel(trader.id)
          : { model: null, reason: null };
      const routedTeamModel = teamBuild.model;

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **JEV 模式（实验性）** —— 2026-10-19
       * ══════════════════════════════════════════════════════════════════════
       *
       * 与团队模式同一套「显式报告失败」纪律：Jev 端点不可用 / key 读不到时
       * **不能静默退回单模型**（那会让一台标着「JEV 模式」的机器人实际在用
       * 别的模型跑，而界面看不出异常 —— 正是团队模式踩过的那个坑）。
       *
       * ⚠️ **`jevBuild.model === null` 时也必须让机器人能起来**
       *（与「模型不可达不阻止启动」同一条：说清楚，但别卡住启动）。
       * 那种情况下本轮会产出空决策，而 preflight 里有一条 error 让人看得见。
       */
      const jevBuild =
        trader.mode === 'jev' ? this.buildJevModeModel(trader.id) : { model: null, reason: null };
      const jevModel = jevBuild.model;

      /*
       * ⚠️ **团队模式没能启用时必须【显式报告】，不能静默走回单模型。**
       *
       * ## 复核发现的 P0（2026-10-12）
       *
       * 原来的实现是：`buildTeamModel` 失败 → 返回 `null` → 下面那句
       * `if (routedTeamModel)` 不成立 → **悄悄退回到 `client.complete()`（单模型）**。
       *
       * 后果很严重：一台标着「AI 团队」的机器人，实际在用**一个模型**跑，
       * 而**界面上看不出任何异常** —— 用户以为团队在开会，其实没有。
       * 这直接违背了本文件里写下的承诺「`ai_team` 走另一条构造路径」。
       *
       * 而且触发条件很容易达成：网关端口改了、换了地址、忘了填 Key、模型记录被删
       *（`looksLikeMagpieGateway` 用 `:3425` 子串判断，换端口即失效）。
       *
       * 所以：失败时**必须**同时
       *   ① push 一条 `severity: 'error'` 的 preflight check（页面可见）
       *   ② 写一条 error 级 runtime 日志（日志可见）
       * 并且**如实说明"当前按单模型运行"** —— 而不是只写一句"团队模式未启用"，
       * 那会让人以为"没跑"，而真相是"跑错了东西"。
       *
       * ⚠️ 仍然**不阻断启动** —— 这与「模型不可达不阻止启动」（用户 2026-10-10 定的
       * 「模型用尽那你启动以后页面上提示就行了」）保持一致：
       * 说清楚，但让机器人能起来。
       */
      if (trader.mode === 'ai_team' && teamBuild.reason !== null) {
        const detail = `AI 团队模式未启用：${teamBuild.reason} 当前这台机器人会按**单模型**运行（不是团队）。`;
        checks.push({
          name: 'AI 团队模式',
          severity: 'error',
          ok: false,
          detail,
          blocking: false,
        });
        runtimeLogs.write(trader.id, 'error', 'manager', detail);
        log.warn(`机器人 #${trader.id} ${detail}`);
      }

      /*
       * ⚠️ **JEV 模式失败也必须显式报告**（同团队模式那条纪律）。
       *
       * 后果比团队模式更直接：Jev 是这台机器人**唯一**的决策来源，
       * 没有它 ⇒ 本轮零决策 ⇒ 一台"运行中"的机器人**永远不会开仓**。
       * 如果不说清，用户会以为是"没有机会"，而真相是"决策模型没接上"。
       */
      if (trader.mode === 'jev' && jevBuild.reason !== null) {
        const detail = `JEV 模式未启用：${jevBuild.reason} 这台机器人本轮不会产生任何决策。`;
        checks.push({
          name: 'JEV 模式',
          severity: 'error',
          ok: false,
          detail,
          blocking: false,
        });
        runtimeLogs.write(trader.id, 'error', 'manager', detail);
        log.warn(`机器人 #${trader.id} ${detail}`);
      }

      /* --- Assemble ----------------------------------------------------- */
      const marketData = new MarketDataService(connection.market, connection.registry);

      // A trader created before its exchange credential existed (or created with
      // a hand-typed baseline) would otherwise show a meaningless return
      // percentage forever. Seed it from the real wallet balance on first start.
      if (trader.initialEquity <= 0) {
        const live = await connection.broker.getAccountState().catch(() => null);
        if (live && live.walletBalance > 0) {
          traders.update(traderId, { initialEquity: live.walletBalance });
          const message = `起始权益已从交易所读取：${live.walletBalance.toFixed(2)} USDT`;
          runtimeLogs.write(traderId, 'info', 'manager', message);
          eventBus.publish({
            type: 'log',
            traderId,
            level: 'info',
            message,
            scope: 'manager',
            timestamp: new Date().toISOString(),
          });
        }
      }

      /*
       * --- Config reachability ----------------------------------------------
       *
       * 这个配置在这个账户规模下**究竟能不能开出仓来**。
       *
       * ⚠️ 这条检查是实测逼出来的：机器人空转了 60 多个周期一笔单没开，
       * 而每轮周期都"成功"、日志干净、状态显示 running ——
       * **唯一的现象是"什么都不发生"**。
       *
       * 根因是两条互相矛盾的配置，数字上完全不显眼：
       * 山寨币名义上限 4.55 USDT < 币安最小名义 5 USDT，任何仓位都不成立。
       *
       * 放进预检是因为**这是操作员一定会看到的地方** ——
       * 而"参数不可达"与"市场不好"在控制台上长得一模一样：
       * 前者是配置错误，后者才是策略判断。混为一谈的代价是几十轮空转。
       *
       * ⚠️ **位置很要紧**：必须在读到真实权益之后。放在前面的话它会拿
       * `initialEquity`（可能是 0）去算，于是**这个检查本身会给出错误结论** ——
       * 一个用来防错的东西自己出错，比没有它更糟。
       *
       * **不阻断启动**：某一类标的不可达时另一类可能仍然可交易
       * （实测里 BTC/ETH 可以、山寨币不行）。阻断会让一个还能工作的机器人启动不了。
       */
      /*
       * ⚠️ **必须用「生效配置」，不是策略配置。**
       *
       * AI 托管机器人的参数存在 `agent_config_json`（由 AI 自己写），
       * 策略里的那份**不生效**。第一次实现时我用了策略配置，于是预检报出：
       *
       *     山寨币开不出仓位：名义上限 9.11 × 0.5 = 4.56，低于 minPositionSize=12
       *
       * 而 AI 早把 minPositionSize 调成 5、比例调成 1 —— **那两个数字在生效配置里
       * 根本不存在**。也就是说这个检查**报了一个不存在的问题，同时漏掉了真正的问题**。
       *
       * 一个用来防错的检查自己给出错误结论，比没有它更糟：它会让操作员去修一个
       * 不存在的问题，同时对真问题视而不见。
       */
      const effectiveConfig = (() => {
        const raw = traders.get(traderId)?.agentConfigJson;
        /*
         * ⚠️ **用 `isAiDriven` 而不是写死 `'ai_managed'`。**
         *
         * 这里是"AI 模式下用 `agent_config_json` 当生效配置"的读取点。
         * 写死单模式名的话，`ai_team` 会读不到自己的配置 —— 而它的参数同样
         * 存在那一列（AI 自己管）。**症状是"AI 配的参数没生效"，
         * 而界面上看不出任何异常。**
         */
        if (isAiDriven(trader.mode) && typeof raw === 'string' && raw.length > 0) {
          try {
            const parsedAi = StrategyConfigSchema.safeParse(JSON.parse(raw));
            if (parsedAi.success) return parsedAi.data;
          } catch {
            // 坏 JSON 与 schema 不通过走同一条回落路径。
          }
          // 与 `AutoTrader.refreshAgentState()` 的回落保持一致：坏 AI 配置时用策略配置。
          log.warn(`机器人 #${traderId} 的 AI 配置无法解析，可达性检查按策略配置进行。`);
        }
        return config;
      })();

      const reachEquity = await connection.broker
        .getAccountState()
        .then((s) => s.walletBalance)
        .catch(() => trader.initialEquity);
      /*
       * 候选池的**真实**交易所约束。
       *
       * 全部取自 `registry`（它解析的就是 `fapi/v1/exchangeInfo`），
       * **不接受任何推测的数字** —— 我上一版在这里编了一个
       * `EXCHANGE_MIN_NOTIONAL_USD = 5`，而真值按标的不同（BTC 50、ETH 20、山寨 5），
       * 于是体检恰好漏掉了唯一真正不可达的那一类。
       *
       * 用**配置里的候选池**而不是"全部合约"：体检要回答的是
       * "照这个配置能交易哪些标的"，所以标的集合必须与配置一致。
       */
      const universe = new Set<string>([...effectiveConfig.coinSource.staticCoins]);
      /*
       * ⚠️ **动态候选池在启动时**无法**评估 —— 这里原来写的是
       * `...(useCoinPool ? [] : [])`，两个分支都是空数组。**
       *
       * 那个写法读起来像"忘了写"，它其实是有意的（启动时还没有行情）。
       * 但**有意降级写成了看不出意图的样子**，于是下一个人只会看到两个空分支。
       * 现在把它变成一个有名有姓的事实，后面的报告按它决定措辞。
       */
      const usesDynamicUniverse =
        effectiveConfig.coinSource.sourceType !== 'static' ||
        effectiveConfig.coinSource.useCoinPool ||
        effectiveConfig.coinSource.useOITop;
      const constraints = [...universe]
        .flatMap((symbol) => {
          try {
            const info = connection.registry.require(symbol);
            return [
              {
                symbol,
                minNotional: info.minNotional,
                stepSize: info.stepSize,
                price: 0, // 下面用实时标记价填 —— 价格影响取整后的有效下限。
                isMajor: connection.registry.isMajor(symbol),
              },
            ];
          } catch {
            return [];
          }
        });

      /*
       * 价格必须用**实时标记价**：取整后的有效下限依赖它
       * （HYPE 在 80 时下限 5 会取整到 5.60，在 100 时是 5.00）。
       * 拿不到价格的标的一并跳过 —— 用 0 会除零，用一个旧价会给出错误结论。
       */
      const priced = (
        await Promise.all(
          constraints.map(async (c) => {
            const price = await connection.broker.getMarkPrice(c.symbol).catch(() => 0);
            return price > 0 ? { ...c, price } : null;
          }),
        )
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      const reach = checkConfigReachability({
        equity: reachEquity,
        maxMarginUsagePercent: effectiveConfig.riskControl.maxMarginUsage,
        ratios: {
          major: effectiveConfig.riskControl.btcEthMaxPositionValueRatio,
          altcoin: effectiveConfig.riskControl.altcoinMaxPositionValueRatio,
        },
        minPositionSize: effectiveConfig.riskControl.minPositionSize,
        maxLeverage: {
          major: effectiveConfig.riskControl.btcEthMaxLeverage,
          altcoin: effectiveConfig.riskControl.altcoinMaxLeverage,
        },
        symbols: priced,
      });

      /*
       * 报告形式是"**哪些标的能交易**"而不是"某一类可行吗" ——
       * 后者（"BTC 不行、SOL 行"）没法直接用于决策，前者可以。
       */
      /*
       * ⚠️ 报告里必须说清**评了哪些标的**。
       *
       * 实测撞到过：这里只评了 `staticCoins`（BTC/ETH），而配置里
       * `useCoinPool: true` —— **动态币池那些真正能交易的山寨币根本没被评估**。
       * 于是预检对操作员说"一个都开不出来"，而实际上 SOL/HYPE 是可以的。
       *
       * 启动时拿不到动态币池（它需要先拉行情），**但报告必须诚实说明范围** ——
       * 否则操作员会据此做出错误决定。这与我前面几处犯的错是同一类：
       * **一个说得太满的检查，比一个范围明确的检查更糟。**
       */
      const poolNote = effectiveConfig.coinSource.useCoinPool
        ? `（只评了静态列表；动态币池需要行情，启动时不评估 —— 里面可能有可交易的标的）`
        : '';
      /*
       * ── 「一个都没评到」不等于「都不可交易」 ──────────────────────────────
       *
       * `checkConfigReachability` 的 `ok` 定义是 `tradable.length > 0` ——
       * 那在"评了 N 个、0 个能开"时是对的（有结论：规模不够），但
       * **在"一个都没评"时是错的**：它什么都没看，却产出了
       * 「当前配置下没有可交易的标的」这句总结。
       *
       * 实盘就是这个形状：AI 的配置用动态币池、`staticCoins` 为空 —— 于是
       * `universe` 是空集，而日志每轮报一次"没有可交易的标的"。
       * 那句话会让人去改一个**根本没错**的配置。
       *
       * 所以分两种：
       *   · **用动态池** → `ok`（中性）：这是"未评估"，不是"不可达"；
       *   · **纯静态且列表为空** → 才是真的配置错误（它确实不会交易任何东西）。
       */
      const nothingEvaluated = universe.size === 0;
      checks.push({
        name: '可交易标的',
        severity: nothingEvaluated || reach.ok ? 'ok' : 'warn',
        ok: nothingEvaluated || reach.ok,
        detail: nothingEvaluated
          ? usesDynamicUniverse
            ? '这次没有评估任何标的：配置用的是动态候选池，而它要等到启动后拉到行情才能确定。' +
              '**这不代表没有可交易的标的** —— 真正的候选池在第一个周期才成型。'
            : '配置里一个标的都没有（静态列表为空，也没开动态候选池）—— 这个机器人不会交易任何东西。'
          : reach.summary + poolNote,
        blocking: false,
      });
      // 被挡下的逐个列出（最多 5 个）—— 操作员需要知道是哪些、为什么。
      for (const v of reach.blocked.slice(0, 5)) {
        checks.push({
          name: `不可交易（${v.symbol}）`,
          severity: 'warn',
          ok: false,
          detail: v.reason,
          blocking: false,
        });
      }
      /*
       * ⚠️ **`nothingEvaluated` 时不报"没有可交易的标的"。**
       *
       * 那句总结在"评了 N 个、0 个能开"时是**结论**；在"一个都没评"时是**臆断** ——
       * 而它每轮都会出现在日志里，把人引去改一个根本没错的配置。实盘上正是如此：
       * AI 的配置用动态币池、静态列表为空，于是日志一直在报那句话。
       *
       * 只有**纯静态且列表为空**才是真的配置错误 —— 那种情况单独说，措辞也不同。
       */
      if (!reach.ok && !nothingEvaluated) {
        log.warn(`机器人 #${traderId} 当前配置下没有可交易的标的：${reach.summary}`);
      } else if (nothingEvaluated && !usesDynamicUniverse) {
        log.warn(
          `机器人 #${traderId} 的配置里没有任何候选标的（静态列表为空、也没开动态候选池）—— 它不会交易任何东西。`,
        );
      }

      const model: DecisionModel = {
        /*
         * ⚠️ **当前输出预算**（2026-10-17）：思维链模型的 `reasoning_content` 与正文
         * **共享** `max_tokens`，而 `budgetFor()` 的 4 倍放大**只覆盖 `ModelRouter`
         * 那条路（ai_team）** —— `ai_managed` 直连 `client.complete`，从来没享受过它。
         *
         * 于是"预算被思维链吃光 → `finish_reason=length` + **正文为空**"在 `ai_managed`
         * 上没有兜底：用同一份预算再问一次**必然还是空**（那是结构性截断，不是偶发）。
         *
         * 这里把**构造 `client` 时那个模型记录的 `maxTokens`** 交给交易循环，
         * 它才能在空正文重试时放大预算（`autoTrader.ts` 的 `emptyContentRetryPlan()`）。
         *
         * `?.` 是必要的：`aiModels.get()` 的返回类型可空（`buildModel` 内部已确认
         * 那一行存在，但类型上仍要收一次）。传 `undefined` = **不放大**（行为与改动前
         * 完全一致），所以这里读不到也不会有副作用。
         */
        outputBudgetTokens: modelConfig?.maxTokens,
        complete: async (systemPrompt, userPrompt, options) => {
          /*
           * ⚠️ **团队模式走路由模型；其余模式走原来那一条路（一字未改）。**
           *
           * 判据放在 `complete` 里而不是替换整个 `model` 对象，是为了让
           * **两者的 usage 适配逻辑共用一份** —— 那个"缓存/思考 token 不能在
           * 最后一跳丢掉"的坑（见下面那段注释）只该有一个修复点。
           */
          if (routedTeamModel) {
            return routedTeamModel.complete(systemPrompt, userPrompt, options);
          }
          /*
           * **JEV 模式**：决策完全由 Jev 做出（见 `jevModel.ts` 的文件头）。
           * ⚠️ 放在 `routedTeamModel` 之后、`client.complete()` 之前 ——
           * 前两者互斥（`mode` 只有一个值），所以顺序不影响正确性；
           * 但**必须在 `client` 之前**，否则 Jev 模式会静默走回普通 LLM。
           */
          if (jevModel) {
            return jevModel.complete(systemPrompt, userPrompt, options);
          }
          const result = await client.complete(systemPrompt, userPrompt, options);
          return {
            text: result.text,
            latencyMs: result.latencyMs,
            usage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              /*
               * 把这两个数一路带到落库 —— 见 `autoTrader` 里 `progress` 上的说明。
               * **适配层漏掉它们，前面所有的工作都白做**：数据在最后一跳丢掉，
               * 而界面上什么都不会显示。
               */
              cachedTokens: result.usage.cachedTokens,
              reasoningTokens: result.usage.reasoningTokens,
            },
          };
        },
        /*
         * ══════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **P3 选币必须透传到这个包装对象上**（2026-10-19 实测抓到）
         * ══════════════════════════════════════════════════════════════════
         *
         * ## 症状
         *
         * 用户在「JEV 模式」标签里把「选币方式」设成「让 Jev 从全市场自己选」，
         * 但日志里**从来没有** `[Jev模式] 选币（jev）：…` 那一条 ——
         * 说明 `autoTrader` 里那段 P3 代码**整段被跳过**。
         *
         * ## 根因
         *
         * `AutoTrader` 拿到的 `deps.model` 是**这个包装对象**，不是
         * `createJevDecisionModel()` 返回的那个。而包装对象原来**只有
         * `complete`** —— 于是 `autoTrader` 里的
         * `typeof jevRerank.rerankByJev === 'function'` 探测永远为假。
         *
         * 那是我上一版的设计疏漏：我以为 `deps.model` 就是 `jevModel`，
         * 但它被包了一层。
         *
         * ## 修法
         *
         * 把 `jevModel.rerankByJev` 透传到包装对象上。
         * ⚠️ 只在 `jevModel` 存在时挂（其它三种模式这个属性不存在，
         * `typeof` 探测自然为假，行为逐字节不变）。
         */
        ...(jevModel !== null && jevModel !== undefined
          ? {
              rerankByJev: (jevModel as unknown as { rerankByJev: unknown }).rerankByJev,
            }
          : {}),
      };

      /*
       * AI 智能托管接缝。
       *
       * ⚠️ **总是传**，而不是"只在策略是 ai_managed 时传"。
       *
       * 判据是 `traders.agent_config_json` 非空，而那一列**可以在机器人运行期间
       * 被写**（AI 第一次调参就会写它）。若按启动时的策略 id 决定传不传，
       * 那么一个"启动时还不是 AI 模式、运行中变成 AI 模式"的机器人就永远接不上 ——
       * 而那恰恰是这个模式本来的用法。
       *
       * 传进去是安全的：`AgentRuntime` 自己在非 AI 模式下完全空转
       * （`isEnabled()` 为假时所有方法直接返回）。
       */
      const agentRuntime = new AgentRuntime({
        traderId,
        strategyConfig: () => config,
        /*
         * 选了这个预设就等于"要求 AI 托管"，哪怕它还没改过任何参数。
         *
         * ⚠️ 这个判据是**启动死锁的解药**：只看 `agent_config_json` 非空的话，
         * 而那一列只有 AI 调参才会写，而 AI 只有在跑时才调参 ——
         * 一个刚建的 AI 机器人会安静地什么都不做，且没有任何东西报错。
         */
        /*
         * 判据是**机器人自己的模式**，不是"策略是不是某个预设"。
         *
         * AI 托管本来就不该是一个策略：策略是"一组固定参数"，而 AI 模式的
         * 意思是"没有固定参数" —— 后者不能是前者的一种。挂在策略上还会让它
         * 出现在策略列表里，任何既有机器人都能选中它。
         */
        /*
         * `isAiStrategy` 的语义是"**这个机器人是不是 AI 自己管参数**"
         *（所以它不该被当成一个可选策略）。`ai_team` 同样是 AI 管参数 →
         * 用 `isAiDriven` 而不是写死单模式名。
         */
        isAiStrategy: () => {
          const mode = traders.get(traderId)?.mode;
          return mode !== undefined && isAiDriven(mode);
        },
        model,
        equityNow: () => equity.latest(traderId)?.equity ?? null,
        /*
         * ⚠️ **「被否掉的标的后来走了多少」靠它算。**
         *
         * AI 每轮否掉候选池里绝大多数标的，而它从来没有这些标的后续走势的数据 ——
         * 于是它的入场标准永远得不到校准。它自己在审视里点明了这一点：
         * 「minScore 我没有任何'被滤掉的标的后来是否走了行情'的数据，无依据不动。」
         *
         * 用 15m K 线 × 500 根 ≈ 125 小时，足够覆盖"最近几十轮"的观察窗口。
         * 取**不晚于** `sinceIso` 的最后一根作为起点（那时的价），
         * 与最新一根相比 —— 和 `agentStore` 里那条"`>` 而不是 `>=`"的纪律一致：
         * 宁可少算，也不要把"被否之前就发生的涨跌"算成错过的机会。
         */
        priceChangeSince: async (symbol, sinceIso) => {
          const klines = await marketData.getKlines(symbol, '15m', 500);
          const since = new Date(sinceIso).getTime();
          const before = [...klines].reverse().find((k) => k.openTime <= since) ?? null;
          const latest = klines[klines.length - 1] ?? null;
          if (!before || !latest || before.close <= 0) return null;
          return ((latest.close - before.close) / before.close) * 100;
        },
      });

      const autoTrader = new AutoTrader({
        trader,
        config,
        registry: connection.registry,
        market: connection.market,
        marketData,
        broker: connection.broker,
        model,
        agent: {
          configOverride: () => agentRuntime.configOverride(),
          /*
           * ⚠️ **`reason` 必须透传。** 原来这里是 `() => agentRuntime.triggerReview()`，
           * 于是 `'manual'` 那条分支从写下那天起就没被走到过 —— 而
           * `orchestrator.ts` 里还写着"操作员点立即分析"。见 `requestAgentReview()`。
           */
          triggerReview: (reason) => agentRuntime.triggerReview(reason),
          settleOnly: () => agentRuntime.settleOnly(),
          reviewTrade: (t) => agentRuntime.reviewTrade(t),
        },
      });

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **启动飞行中点「停止」必须真的生效**（外部 issue #143，真实资金）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 原来这里没有任何取消检查
       *
       * `attemptStart()` 的窗口是**几秒到几十秒**（建连接、校时、`exchangeInfo`、
       * 模型探测、拉持仓对账）。操作员在这个窗口里点「停止」时：
       *
       * ```
       *   stopTrader()                   ← 第一句 cancelledStarts.add(traderId)
       *     this.running.get(traderId)   ← undefined（实例还没被写进去）
       *     → 走 else：只写一个 'stopped' 状态就返回
       *   …
       *   attemptStart() 仍在 await 中
       *     this.running.set(...)        ← 照常把实例放进去
       *     await autoTrader.start()     ← 照常起循环，**用真钱开始下单**
       * ```
       *
       * 结果是**界面显示已停止、而机器人真的开单** —— 比"按钮反应慢"严重得多，
       * 它给出的是**已停止的假象**。而 `startTrader` 的 `finally` 还会
       * `cancelledStarts.delete()`，连这条停止意图的痕迹都不留。
       *
       * ## 两道守卫，位置各有用意
       *
       *   · **第一道（下面，`running.set` 之前）**：取消已经发生就别把实例放进
       *     `running` —— 否则 `statusOf()` 会读到一个从没启动过的"运行中"实例。
       *   · **第二道（`autoTrader.start()` 之后）**：启动本身也要等（首轮周期、
       *     用户数据流），期间操作员仍可能点停止 —— 那就立刻把它停掉。
       *
       * `permanent: true` 很关键：`startTrader` 的重试判据是
       * `!outcome.permanent && !cancelledStarts.has(id) && …`，若这里返回 false，
       * "停止"会被重试机制重新拉起来 —— 等于**停止请求被系统否决**。
       */
      if (this.cancelledStarts.has(traderId) || this.stopping) {
        dropConnections(this.connections, traderId);
        this.setTraderStatus(traderId, 'stopped', null);
        runtimeLogs.write(
          traderId,
          'info',
          'manager',
          '启动过程中收到「停止」—— 已放弃本次启动，不会起交易循环。',
        );
        return {
          result: { ok: false, error: '启动过程中被操作员取消。', preflight: checks, cancelled: true },
          permanent: true,
        };
      }

      this.running.set(traderId, autoTrader);
      this.startedAt.set(traderId, Date.now());
      await autoTrader.start();

      /*
       * 第二道：`start()` 本身也要花时间（首轮周期可能已经在下单路上）。
       * 期间收到的停止要立刻兑现 —— 否则同样是"界面已停、实际在跑"。
       *
       * ⚠️ **`persist` 必须传 `true`**（默认值）：这是**操作员点的停止**，
       * 不是进程关闭。`stop(reason, false)` 那个分支的文档写明它专给进程关闭用 ——
       * 因为 `resumePersisted()` 只恢复 `running` / `safe_mode` / `error`，
       * **刻意不恢复 `stopped`**（那被当作人的决定）。传 `false` 会把操作员的
       * 停止意图丢掉，下一次部署或重启就把这台机器人又拉起来。
       */
      if (this.cancelledStarts.has(traderId) || this.stopping) {
        await autoTrader.stop('操作员在启动过程中请求停止', true);
        this.running.delete(traderId);
        this.startedAt.delete(traderId);
        dropConnections(this.connections, traderId);
        this.setTraderStatus(traderId, 'stopped', null);
        runtimeLogs.write(
          traderId,
          'info',
          'manager',
          '启动完成后立刻收到「停止」—— 交易循环已停下。',
        );
        return {
          result: { ok: false, error: '启动完成后被操作员取消。', preflight: checks, cancelled: true },
          permanent: true,
        };
      }

      // Attached after the trader is live, so a stream failure can never prevent
      // the trading loop from starting.
      await this.startUserStream(traderId, connection);

      const mode = dryRun ? '模拟盘' : '实盘';
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **把这次用的 `dryRun` 落库**（2026-10-13 实测安全修复）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 为什么必须落库
       *
       * 否则服务重启后，`resumePersisted` 只能拿到**一个进程级的值**，
       * 于是"操作员用它启动时选模拟盘"这件事**在重启后丢失** ——
       * 测试机器人被静默恢复成实盘（线上 `#11` 真的发生过）。
       *
       * ## ⚠️ 落库失败不能让启动失败
       *
       * 机器人**已经在跑了**（上面 `autoTrader.start()` 已完成）——
       * 此时抛异常会让调用方以为"没启动"，而实际在跑。
       * 那比"下次重启时回落到 env"糟得多。
       * 所以这一条单独包 try/catch，失败只记日志。
       */
      try {
        traders.setDryRun(traderId, dryRun);
      } catch (error) {
        log.warn(
          `机器人 ${traderId} 的纸面模式未能落库（不影响本次运行，但重启后会回落到进程开关）：` +
            `${(error as Error).message}`,
        );
      }
      runtimeLogs.write(traderId, 'info', 'manager', `机器人已启动（${mode}）`);
      eventBus.publish({
        type: 'log',
        traderId,
        level: 'info',
        message: `机器人已启动（${mode}）`,
        scope: 'manager',
        timestamp: new Date().toISOString(),
      });

      return { result: { ok: true, preflight: checks }, permanent: false };
    } catch (error) {
      const message = (error as Error).message;
      log.error(`启动机器人 ${traderId} 失败：${message}`);
      this.running.delete(traderId);
      dropConnections(this.connections, traderId);
      this.setTraderStatus(traderId, 'error', message);
      return {
        result: { ok: false, error: message, preflight: checks },
        permanent: isPermanentStartFailure(message),
      };
    }
  }

  /**
   * Stop a trader's loop **and wait for the cycle already in flight**.
   *
   * `AutoTrader.stop()` now drains the running cycle (see its comment: a cycle
   * that dies mid-way between "entry filled" and "stop placed" leaves an
   * unprotected leveraged position). The map entry is deliberately kept until the
   * drain finishes, so a concurrent `startTrader` cannot slip a second instance
   * in behind this one while it is still writing.
   */
  /**
   * **启动机器人 —— 同步返回，真正的启动在后台继续。**
   *
   * ## 为什么需要它（2026-10-10，用户报的卡顿）
   *
   * 用户的原话：「机器人启动\停止，用户点击以后应该是瞬间完成（起码 UI 页面上
   * 用户感觉是瞬间完成，现在运行中的机器人运行\停止会卡住很久）」。
   *
   * 原来的 `/start` 直接 `await startTrader(...)`：它要先建交易所连接、拉持仓、
   * 对账、再 `this.running.set(...)` —— 这几步实测要几秒到几十秒，而期间
   * `statusOf()` 仍是 `stopped`（那个 id 还没进 `running`）。于是界面表现成
   * **点了启动、什么都没发生**，直到全部完成才跳一下。
   *
   * 现在：**守卫同步判完 → 状态立刻置为 `starting` 并返回**，真正的启动在后台跑；
   * 失败时由启动路径自己写 `error` 状态（那条路径本来就有），界面靠推送看到结果。
   *
   * 守卫**不重复实现**：这里调的就是 `startGuard`，与 `startTrader` 同一个纯函数。
   */
  startTraderAsync(traderId: number, dryRun: boolean): StartResult {
    const trader = traders.get(traderId);
    const guard = startGuard({
      traderId,
      globalTradingDisabled: env.globalTradingDisabled,
      traderExists: trader !== undefined,
      running: this.running.has(traderId),
      starting: this.starting.has(traderId),
    });
    if (!guard.ok) return { ok: false, error: guard.error, preflight: [] };
    if (!trader) return { ok: false, error: `找不到机器人 ${traderId}`, preflight: [] };

    /*
     * ⚠️ **这里不能先 `starting.add` 再调 `startTrader`** —— `startTrader` 自己的
     * 守卫会看到"已经在启动了"而拒绝，启动永远起不来。
     * 所以只写状态（界面立刻变），占位交给 `startTrader` 自己加：
     * 中间**没有 await**，两次调用在同一个同步块里，不存在并发窗口。
     */
    /*
     * **启动代数** —— 每次启动自增。看门狗与回调据此判断"我还是不是当前那一代"，
     * 避免一次陈旧的启动（或它的看门狗）去覆盖后来者的状态（2026-10-11 审查发现）。
     */
    const generation = (this.startGeneration.get(traderId) ?? 0) + 1;
    this.startGeneration.set(traderId, generation);

    this.setTraderStatus(traderId, 'starting', null);

    /*
     * ⚠️ **"卡在启动中"本身是个 bug，必须有兜底（2026-10-10 实测）。**
     *
     * 用户点启动后界面停在「正在启动中」，而且**再点也点不动** —— 因为
     * `startTrader` 的 `starting` 占位一直没释放，守卫就一直回
     * 「该机器人正在启动中」。根因是启动流程里某一步没有返回
     *（模型不可用那条路上有长重试），而**状态与占位都跟着它一起悬住**。
     *
     * 所以加一道看门狗：无论如何，启动要么进 `running`，要么落到 `error`
     * 并释放占位。**"永远停在启动中"不是一种可接受的状态** ——
     * 操作员既看不到结论，也失去了重试的能力。
     */
    const startWatchdog = setTimeout(() => {
      /* 已经有更新的一次启动接管了 → 这个陈旧看门狗什么都不做。 */
      if (this.startGeneration.get(traderId) !== generation) return;
      if (this.running.has(traderId)) return;
      /*
       * ⚠️ **看门狗【不释放】 `starting` 占位（2026-10-11 审查发现）。**
       *
       * 上一版这里删了占位，理由是"否则用户再也点不动"。**那个理由换来了一个更糟的后果**：
       * 慢启动（>90 秒）时占位被提前释放，用户再点一次就能并发出**第二个交易实例**，
       * 而第一个还活着 —— 它既停不掉，也会和新的那个一起下单。
       *
       * 正确的分工：**占位由 `startTrader` 的 `finally` 释放**（谁持有谁释放），
       * 看门狗只负责"把状态说清楚" —— 让操作员看到"启动还在进行中、已超过 N 秒"，
       * 而不是让按钮变成一个可以踩出第二个实例的陷阱。
       *
       * 按钮在此期间点不动是**正确行为**：那一轮启动确实还在飞。
       */
      const message =
        `启动仍在进行中，已超过 ${Math.round(START_WATCHDOG_MS / 1000)} 秒未完成` +
        '（可能是 AI 模型不可用导致的长重试）。请等待它结束；若持续不结束请看服务器日志。';
      log.error(`机器人 ${traderId} ${message}`);
      this.setTraderStatus(traderId, 'error', message);
    }, START_WATCHDOG_MS);
    /* 别让这个定时器拖住进程退出。 */
    startWatchdog.unref?.();

    void this.startTrader(traderId, dryRun)
      .then((result) => {
        clearTimeout(startWatchdog);
        if (this.startGeneration.get(traderId) !== generation) return;
        if (result.ok) return;
        /*
         * ⚠️ **取消不是失败，不要再写 `error`。**
         *
         * 两个取消分支已经各自把状态写成 `stopped`（那是操作员的决定）。
         * 这里再写一次 `error`，就把"被叫停"记成"待恢复的故障" ——
         * 而 `resumePersisted()` 恢复 `{running, safe_mode, error}`，
         * **刻意不恢复 `stopped`**。于是下一次部署/重启，
         * 这台刚被叫停的机器人会被重新拉起并下单。
         *
         * 判据只能是 `result.cancelled`，不能是 `cancelledStarts.has(id)`：
         * 那面旗子在 `startTrader` 的 finally 里已收掉，此时看它永远看不出来。
         */
        if (result.cancelled) {
          log.info(`机器人 ${traderId} 的启动已被取消，状态保持 stopped（不记为 error）。`);
          return;
        }
        log.warn(`机器人 ${traderId} 启动失败：${result.error ?? '未知错误'}`);
        /* 失败必须落到 `error` —— 否则状态会停在 `starting` 上（见看门狗）。 */
        this.setTraderStatus(traderId, 'error', result.error ?? '启动失败');
      })
      .catch((error: unknown) => {
        clearTimeout(startWatchdog);
        if (this.startGeneration.get(traderId) !== generation) return;
        const message = (error as Error).message;
        log.error(`机器人 ${traderId} 启动时抛错：${message}`);
        this.setTraderStatus(traderId, 'error', message);
      });
    return { ok: true, preflight: [] };
  }

  async stopTrader(traderId: number): Promise<void> {
    // Record the operator's intent before doing any async work, so a boot retry
    // parked in `waitForRetry()` aborts instead of starting the trader seconds
    // after it was told to stop.
    this.cancelledStarts.add(traderId);
    const autoTrader = this.running.get(traderId);

    /*
     * ⚠️ **先把"它已停止"定下来，再去做清理（2026-10-10，用户报的卡顿）。**
     *
     * 用户的原话：「机器人启动\停止，用户点击以后应该是瞬间完成（起码 UI 页面上
     * 用户感觉是瞬间完成，现在运行中的机器人运行\停止会卡住很久）」。
     *
     * 原来 `this.running.delete()` 在 `await autoTrader.stop()` **之后** ——
     * 而 `stop()` 要等在途那一轮结束（最多 60 秒，那一轮可能正卡在一次 LLM 调用上）。
     * 界面读的是 `statusOf()`（= `running.get(id)?.currentStatus ?? 'stopped'`），
     * 于是**这 60 秒里页面上还写着"运行中"**，看起来就是"点了没反应"。
     *
     * 顺序反过来之后：状态立刻变 `stopped`，界面立刻翻；清理照常在后面做完。
     * 清理期的机器人在 `running` 里已经不存在，所以并发 `start` 不会撞上半停的实例。
     */
    this.running.delete(traderId);
    this.startedAt.delete(traderId);
    if (autoTrader) {
      /* 掐断在途的 AI 请求 —— 这是"停止"要立即生效的那部分。 */
      autoTrader.abortInFlightCycle();
      this.setTraderStatus(traderId, 'stopped', null);
      await autoTrader.stop();
    } else {
      this.setTraderStatus(traderId, 'stopped', null);
    }
    this.cancelFillReconcile(traderId);
    /*
     * ⚠️ **必须停掉后台调研循环**（2026-10-13 实测发现的资源泄漏）。
     *
     * 实测：`#11` 已 `stopped`，而服务器上**还有 2 个 claude 进程在跑** ——
     * 因为 `researchRefreshers` 只在创建处出现，从未被清理。
     * 后果：机器人停止后后台调研**每 10 分钟照常起 4 个进程**，
     * 不报错、界面看不见，只是安静地吃 CPU/内存（单个约 250MB）。
     */
    stopResearchRefresher(traderId);
    const stream = this.userStreams.get(traderId);
    if (stream) {
      await stream.stop().catch(() => undefined);
      this.userStreams.delete(traderId);
    }
    dropConnections(this.connections, traderId);
    runtimeLogs.write(traderId, 'info', 'manager', '机器人已停止');
  }

  /**
   * Run one cycle immediately, without waiting for the timer.
   *
   * Exposed so an operator can force a re-evaluation (for example right after
   * changing a strategy, or before stepping away from the machine) rather than
   * waiting out the interval.
   */
  async runCycleNow(traderId: number): Promise<string> {
    const autoTrader = this.running.get(traderId);
    if (!autoTrader) throw new Error('该机器人当前未在运行。');
    return autoTrader.runOnce();
  }

  /**
   * 让操作员**现在**就要一次 AI 策略审视（不等事件、不等兜底超时）。
   *
   * 与 `runCycleNow` 是两件不同的事，别混：
   * - `runCycleNow` —— 跑一个**决策周期**（让机器人按当前参数决策一次）
   * - 这个 —— 跑一次**策略审视**（让 AI 反思并决定要不要改参数）
   *
   * ## 为什么需要机器人**在运行**
   *
   * 审视走的是机器人的 `AgentRuntime`（它持有模型客户端与工具依赖），
   * 而这个运行时只在机器人启动后存在。所以停着的机器人**没有可触发的东西** ——
   * 返回一句说清原因的话，而不是静默什么都不做。
   */
  requestAgentReview(traderId: number): { accepted: boolean; note: string } {
    const autoTrader = this.running.get(traderId);
    if (!autoTrader) {
      return {
        accepted: false,
        note: '机器人没有在运行 —— 策略审视需要一个活着的运行时（先「启动」，它会照常按策略交易）。',
      };
    }
    return autoTrader.requestAgentReview();
  }

  /**
   * 熔断器**此刻**的读数 —— 让控制台能回答"它为什么一单都不开"。
   *
   * 机器人**没在运行**时返回 `null`：这个数必须用一份**在内存里的**配置来重算，
   * 而 AI 托管下那份配置来自 `traders.agent_config_json`（与策略表里那份可能不同）。
   * 从数据库另拼一份会算出与交易循环不一致的答案 —— 宁可让调用方知道"不知道"。
   */
  readCircuitBreaker(traderId: number): CircuitBreakerReading | null {
    return this.running.get(traderId)?.circuitBreakerReading() ?? null;
  }

  /**
   * 这台机器人**生效**的杠杆上限 —— 控制台用它当有效杠杆表盘的刻度。
   *
   * ## 为什么必须走「生效配置」
   *
   * AI 托管机器人的参数存在 `agent_config_json`（AI 自己写），策略表里那份
   * **不生效**。这个坑在可达性检查里已经记过一次：那个检查用策略配置算出了
   * 「名义上限 9.11 × 0.5 = 4.56，低于 minPositionSize=12」，而 AI 早把比例
   * 调成了 1 —— **报了一个不存在的问题，同时漏掉真问题**。刻度取错上限，
   * 指针就会停在一个没有意义的位置上。
   *
   * ## 为什么取两者中较大的那个
   *
   * `btcEthMaxLeverage` 与 `altcoinMaxLeverage` 是两个独立上限，而表盘要表达的是
   * **这台机器人的敞口天花板**，不是某一个标的的限制 —— 所以取大的那个。
   *
   * 返回 `null` 表示读不到。调用方应当显示"不知道"，**不要回落成 0**：
   * 0 会让表盘看起来像"完全没加杠杆"，而那恰好是最容易被误读成安全的状态。
   */
  leverageCap(traderId: number): number | null {
    const trader = traders.get(traderId);
    if (!trader) return null;
    /*
     * ⚠️ **AI 托管不需要策略。**
     *
     * 下面那一段本来就会优先用 `agent_config_json`，但它上面有一道
     * `if (!record) return null` —— 于是"策略被删掉"会让杠杆表盘整个变成
     * 「不知道」，而 AI 托管的杠杆上限在它自己的配置里，根本不缺。
     *
     * 所以：没有策略时，AI 托管用默认配置兜底（随后立刻被 `agent_config_json`
     * 覆盖）；固定策略模式仍然返回 `null`（那种情况下确实读不到）。
     */
    const record = trader.strategyId === null ? undefined : strategies.get(trader.strategyId);
    if (!record && !isAiDriven(trader.mode)) return null;
    let config: StrategyConfig = record?.config ?? StrategyConfigSchema.parse({});
    const raw = trader.agentConfigJson;
    if (isAiDriven(trader.mode) && typeof raw === 'string' && raw.length > 0) {
      try {
        const parsed = StrategyConfigSchema.safeParse(JSON.parse(raw));
        if (parsed.success) config = parsed.data;
      } catch {
        // 坏 JSON 与 schema 不通过都回落到策略配置 —— 与可达性检查保持一致。
      }
    }
    return Math.max(config.riskControl.btcEthMaxLeverage, config.riskControl.altcoinMaxLeverage);
  }

  /**
   * Reconcile one trader's ledger against the exchange **without trading**.
   *
   * Needed because the interesting failure is precisely the one a cycle cannot
   * cover: a position whose exchange-side stop or target fired while the trader
   * was stopped. Waiting for a cycle to fix it means the console shows the wrong
   * PnL for as long as the trader stays stopped — which is exactly when someone
   * is looking at it.
   *
   * Deliberately built with a **stub model**: reconciliation reads the exchange's
   * fill history and never consults an LLM, so making that structural means a
   * broken API key can never block the books from being corrected.
   */
  async reconcileTrader(
    traderId: number,
  ): Promise<{
    recovered: number;
    corrected: number;
    /**
     * 尝试修正的笔数与其中"因边界存疑保留本地"的笔数 —— 见
     * `AutoTrader.reconcileTradeHistory()` 的返回值说明。
     *
     * ⚠️ 这两个数必须一路透传到操作员看得见的那条日志：只报 `corrected` 时，
     * 一个恒定的假数字（"每次都是修正 50 笔"）会把"每一轮都在重复尝试同一批
     * 判不出来的回合"这件事藏起来。
     */
    correctedAttempted: number;
    correctedKept: number;
    funding: number;
  }> {
    const trader = traders.get(traderId);
    if (!trader) throw new Error('机器人不存在。');

    /*
     * When the trader is live, reconcile **through the live instance**.
     *
     * Building a second `AutoTrader` here used to run a full ledger pass
     * concurrently with the trading cycle: both read the same `trades` rows and
     * the same positions, and both could book the same close — or one could close
     * a local row the other had just corrected. `runReconcile()` waits for the
     * in-flight cycle, so there is only ever one writer.
     *
     * The stub-model construction below is still used for a trader that is not
     * running, which is the case this endpoint exists for (a position closed
     * while the bot was down), and keeps the structural guarantee that
     * reconciliation never depends on an LLM.
     */
    const live = this.running.get(traderId);
    if (live) return live.runReconcile();

    const connection = await this.connectionFor(traderId, trader.exchangeAccountId, false);
    /* `null` = 不依赖策略（AI 托管）；这里本来就已容错，只是要接受空值。 */
    const strategyRecord =
      trader.strategyId === null ? undefined : strategies.get(trader.strategyId);
    const parsed = strategyRecord
      ? StrategyConfigSchema.safeParse(strategyRecord.config)
      : null;
    const config: StrategyConfig = parsed?.success
      ? parsed.data
      : StrategyConfigSchema.parse({});

    const autoTrader = new AutoTrader({
      trader,
      config,
      registry: connection.registry,
      market: connection.market,
      marketData: new MarketDataService(connection.market, connection.registry),
      broker: connection.broker,
      model: {
        complete: () => Promise.reject(new Error('对账不调用模型')),
      },
    });

    return autoTrader.reconcileTradeHistory();
  }
  /**
   * 操作员手工平掉一个持仓。**无论机器人在跑还是已停止，都必须能用。**
   *
   * ## 为什么不复用 `this.running` 里的实例就够了
   *
   * 机器人停止时 `running` 里没有实例，而**"已停止的机器人有持仓"恰恰是最需要
   * 手工平仓的场景** —— 它不会再自己了结，仓位会一直挂在那里。
   *
   * 所以形状照 `reconcileTrader`：
   *   · 运行中 → 走实例（只有一个写者）
   *   · 已停止 → 建一个**不调模型**的桩实例，只为拿到 broker 与记账能力
   *
   * ## 一个必须处理的冲突
   *
   * 机器人正在跑的时候手工平仓，**下一个周期它可能会立刻重新开一个同样的仓**
   * （它有额度、也认为那个标的有机会）。**那不是 bug，是它的工作。**
   * 但操作员需要知道这件事 —— 所以返回值里带一个 `stillRunning` 标记，
   * 由界面提示"机器人仍在运行，它可能重新开仓；要它别开请先停止"。
   *
   * @returns 成交结果与"机器人是否仍在运行"
   */
  async closePosition(
    traderId: number,
    symbol: string,
  ): Promise<{ avgPrice: number; fee: number; stillRunning: boolean }> {
    const trader = traders.get(traderId);
    if (!trader) throw new Error('机器人不存在。');

    const running = this.running.get(traderId);
    if (running) {
      const result = await running.closeManually(symbol);
      if (!result) throw new Error(`本地没有 ${symbol} 的持仓。`);
      return { ...result, stillRunning: true };
    }

    /*
     * 已停止：建一个一次性实例。
     *
     * 模型换成"永远拒绝"的桩 —— 手工平仓绝不该调用 LLM：
     * 那会让"按一个按钮"变成"等一次模型请求"，而且在模型故障时根本用不了。
     * **操作员的退出路径不能依赖任何外部服务。**
     */
    const connection = await this.connectionFor(traderId, trader.exchangeAccountId, false);
    /* `null` = 不依赖策略（AI 托管）—— 手工平仓同理，绝不能因为策略没了就用不了。 */
    const strategyRecord =
      trader.strategyId === null ? undefined : strategies.get(trader.strategyId);
    const config: StrategyConfig = this.configOf(strategyRecord);

    const autoTrader = new AutoTrader({
      trader,
      config,
      registry: connection.registry,
      market: connection.market,
      marketData: new MarketDataService(connection.market, connection.registry),
      broker: connection.broker,
      model: {
        complete: () => Promise.reject(new Error('手工平仓不调用模型')),
      },
    });

    const result = await autoTrader.closeManually(symbol);
    if (!result) throw new Error(`本地没有 ${symbol} 的持仓。`);
    return { ...result, stillRunning: false };
  }
  /**
   * 平掉该机器人的**全部**持仓，**并撤掉它全部还没成交的挂单**。
   *
   * ## 为什么不做成"把 `__all__` 当币种传下去"
   *
   * 第一版就是那么做的：界面把哨兵 `'__all__'` 当参数发给单币种平仓接口，
   * 于是错误信息变成了「本地没有 __ALL__ 的持仓」—— **内部标记漏到了界面上**。
   *
   * 正确做法是在这里展开成真实币种，**逐个走同一套顺序**
   * （先撤单 → 市价平 → 记账，见 `closeManually`），
   * 并把**实际平掉的币种列表**返回给界面。
   *
   * ## ⚠️ 挂单也是敞口 —— 这一半原来是漏的（2026-10-02 用户报告）
   *
   * 用户的原话：「全部平仓功能似乎不作用于委托挂单」。
   *
   * 核实后确认成立：这里原来只遍历 `positions.open()`（**已成交持仓**），
   * 而 `closeManually()` 在没有持仓时第一句就 `return null` —— 于是
   * **一个只有挂单、没有持仓的机器人点"全部平仓"，什么都不发生**。
   *
   * 而挂单本来就是敞口：它一旦成交就变成持仓，**份额已经许出去了**。
   * 操作员按这个按钮的意思就是"把敞口收回来"，所以撤挂单是它的一部分，
   * 不是附加功能。
   *
   * 撤单的语义走 `AutoTrader.cancelAllPendingEntries()`（与模型撤单同一个判据：
   * **撤单失败时查清那张单是"没了"还是"成了"**，已成交的不关本地记录 —— 那是真仓位）。
   *
   * ## 一个失败不该阻断其余的
   *
   * 平仓是操作员的退出手段。**某一个标的平不掉，不该让其他标的也平不掉** ——
   * 所以逐个 try/catch，把失败的理由带回去，继续平下一个。
   */
  async closeAllPositions(
    traderId: number,
  ): Promise<{
    closed: string[];
    cancelledPending: number;
    failed: Array<{ symbol: string; error: string }>;
    stillRunning: boolean;
  }> {
    const trader = traders.get(traderId);
    if (!trader) throw new Error('机器人不存在。');

    const failed: Array<{ symbol: string; error: string }> = [];

    /*
     * ① 先撤挂单。**放在平仓之前** —— 与 `closeManually` 里"先撤单再平仓"
     * 同一个顺序理由：一个挂单在平仓之后成交，就留下一个没有本地记录的仓位。
     */
    let cancelledPending = 0;
    try {
      const running = this.running.get(traderId);
      if (running) {
        cancelledPending = await running.cancelAllPendingEntries();
      } else {
        /*
         * 已停止：建一个一次性实例（与 `closePosition` 同一条路径）。
         * 模型换成"永远拒绝"的桩 —— 撤单绝不该调用 LLM。
         */
        const connection = await this.connectionFor(traderId, trader.exchangeAccountId, false);
        const strategyRecord =
          trader.strategyId === null ? undefined : strategies.get(trader.strategyId);
        const config: StrategyConfig = this.configOf(strategyRecord);
        const autoTrader = new AutoTrader({
          trader,
          config,
          registry: connection.registry,
          market: connection.market,
          marketData: new MarketDataService(connection.market, connection.registry),
          broker: connection.broker,
          model: { complete: () => Promise.reject(new Error('撤单不调用模型')) },
        });
        cancelledPending = await autoTrader.cancelAllPendingEntries();
      }
    } catch (error) {
      failed.push({ symbol: '(挂单)', error: (error as Error).message });
    }

    /* ② 再平已成交的持仓。 */
    const symbols = [...new Set(positions.open(traderId).map((p) => p.symbol))];
    const closed: string[] = [];

    for (const symbol of symbols) {
      try {
        const result = await this.closePosition(traderId, symbol);
        if (result) closed.push(symbol);
      } catch (error) {
        failed.push({ symbol, error: (error as Error).message });
      }
    }

    return { closed, cancelledPending, failed, stillRunning: this.running.has(traderId) };
  }



  /**
   * Reconcile every trader's ledger, sequentially.
   *
   * Sequential on purpose: each pass reads fills and the income ledger from the
   * same API key, and firing a dozen of them at once at boot would spend the
   * rate-limit budget that live trading needs.
   *
   * One trader failing must not stop the others — a single bad credential would
   * otherwise leave every other book uncorrected.
   */
  async reconcileAllTraders(): Promise<{
    traders: number;
    recovered: number;
    corrected: number;
    correctedAttempted: number;
    correctedKept: number;
  }> {
    let recovered = 0;
    let corrected = 0;
    let correctedAttempted = 0;
    let correctedKept = 0;
    let count = 0;

    for (const trader of traders.list()) {
      try {
        const result = await this.reconcileTrader(trader.id);
        recovered += result.recovered;
        corrected += result.corrected;
        correctedAttempted += result.correctedAttempted;
        correctedKept += result.correctedKept;
        count += 1;
      } catch (error) {
        log.warn(`机器人「${trader.name}」启动对账跳过：${(error as Error).message}`);
      }
    }

    /*
     * ⚠️ **这条是操作员真正看到的那条**（启动时 + 控制台「立即对账」）。
     *
     * 2026-10-17 之前它写的是「修正 ${corrected} 笔」，而 `corrected` 当时数的是
     * "调用过 `applyExchangeFigures` 几次" —— 那些调用**每一笔都可能被内部整笔拒绝**
     * （重建腿边界不可信 ⇒ 保留本地口径）。于是它长期显示一个恒定的
     * 「修正 50 笔」，而账本一个字都没变（用户原话：「每次都是修正 50 笔」）。
     *
     * ## ⚠️ 为什么"只改日志"也值得单独一个提交（这段理由必须留着）
     *
     * 这次改动**不改变账本数字**（被拒的行仍然被拒）—— 它只修"报告"，不改"判定"。
     * 换句话说：
     *
     * > **这不是新故障，而是把一直存在的故障第一次说明白。**
     *
     * 报告与实际动作不符，本身就是一类缺陷（"报了一个没有发生的动作"），
     * 而它的代价恰恰是**让真正的问题不可见**：一个恒定的「修正 50 笔」读起来像
     * "对账在正常工作"，于是没有人会去追「为什么每一轮都要修正同样那 50 笔」。
     * 先把真相说出来，再决定要不要动判定 —— 两者是不同严重度的问题，不要混在一个提交里。
     *
     * 现在三个数分开：尝试 / 生效 / 判不出来。第三种必须显式出现 ——
     * 它不是失败，而是"需要人来判断的边界"，且下一轮还会撞上同一批。
     */
    if (recovered > 0 || corrected > 0 || correctedKept > 0) {
      log.warn(
        `启动对账完成：${count} 个机器人，补录 ${recovered} 笔，` +
          `尝试修正 ${correctedAttempted} 笔（生效 ${corrected} 笔 · 因边界存疑保留本地 ${correctedKept} 笔）`,
      );
    } else {
      log.info(`启动对账完成：${count} 个机器人，账目无需修正`);
    }
    if (correctedKept > 0 && corrected === 0) {
      log.warn(
        `启动对账：尝试修正 ${correctedAttempted} 笔，**一笔都没真的生效** —— ` +
          '全部因"重建腿边界存疑"保留本地口径。这通常意味着成交历史的窗口起点落在持仓中间' +
          '（重建把开/平判反、整条序列错位），或这些行本来就是对的而重建是错的；' +
          '请对照交易所成交明细核查，不要当成已经修好了。',
      );
    }
    return { traders: count, recovered, corrected, correctedAttempted, correctedKept };
  }

  /** Stop everything — used on shutdown, and by the global kill switch. */
  async stopAll(reason = '服务器正在关闭'): Promise<void> {
    if (this.stopping) return;
    /*
     * Cancel every in-flight boot retry *before* anything else.
     *
     * `resumePersisted()` can be sitting in a 90-second backoff when SIGTERM
     * arrives. Without this, the shutdown would clear the loop timers, close the
     * database, and the backoff would then expire and try to start a trader
     * against a closed database — a crash during shutdown that looks like a
     * random failure on the next boot.
     */
    for (const trader of traders.list()) this.cancelledStarts.add(trader.id);
    this.stopping = true;
    /* 停掉自检循环 —— 关闭时不该再开新的查询。 */
    if (this.selfCheckTimer) {
      clearInterval(this.selfCheckTimer);
      this.selfCheckTimer = null;
    }

    await Promise.all(
      [...this.userStreams.entries()].map(async ([id, stream]) => {
        try {
          await stream.stop();
        } catch (error) {
          log.warn(`停止机器人 ${id} 的用户数据流失败：${(error as Error).message}`);
        }
      }),
    );
    this.userStreams.clear();
    /*
     * 还没到点的即时对账一并丢掉：机器人已经不再运行，`applyExchangeFill()`
     * 的第一行就会返回。
     */
    for (const id of [...this.fillReconcileTimers.keys()]) this.cancelFillReconcile(id);

    /*
     * `trader.stop()` waits for the cycle in flight before resolving, which is
     * what makes this shutdown safe: Ctrl+C used to land between "entry filled"
     * and "stop placed", the timer was already cleared, `process.exit(0)` ran
     * immediately, and the account was left holding a leveraged position with no
     * exchange-side stop — the exact state §2.6 forbids. The wait is bounded
     * inside `stop()`, so a wedged exchange call delays shutdown but cannot hang
     * it forever.
     */
    await Promise.all(
      [...this.running.entries()].map(async ([id, trader]) => {
        try {
          /*
           * `persist: false` —— 进程关闭不是"操作员点了停止"。
           *
           * 若这里照常写入 `stopped`，`resumePersisted()` 会把它当成人的决定而
           * 拒绝恢复（见那里的注释），于是**每一次部署或重启都会静默停掉所有
           * 机器人** —— 而且控制台上看起来就像是有人手动停的，没有任何异常提示。
           * 这个 bug 真实发生过。
           *
           * 保留库里的 `running`，下次启动就能恢复。
           */
          await trader.stop(reason, false);
        } catch (error) {
          log.warn(`停止机器人 ${id} 失败：${(error as Error).message}`);
        }
      }),
    );
    this.running.clear();
    this.connections.clear();
    /*
     * `stopping` deliberately stays true: this instance is on its way down, and
     * any boot retry still parked in `waitForRetry()` must abort rather than
     * resurrect a trader against a closing database. `startTrader()` resets the
     * flag itself, so a start issued after a shutdown (the global kill switch can
     * stop traders without ending the process) still works.
     */
    log.info('所有机器人已停止');
  }

  /**
   * Resume every trader that was running before a restart.
   *
   * Called on boot so an unattended host that reboots comes back up trading
   * rather than silently sitting idle.
   */
  async resumePersisted(dryRun: boolean): Promise<void> {
    /*
     * `error` is recovered too, and that is the whole point of F2.
     *
     * A transient failure at boot wrote `error` and nothing ever looked at it
     * again: `resumePersisted()` only resumed `running` / `safe_mode`, so the bot
     * stayed down until a human clicked start. The status is written into the
     * database, which means it *survives the restart that would have fixed the
     * underlying blip* — the most common shape of this latch.
     *
     * `stopped` is still excluded: that status is an operator decision, and
     * starting it would be this code overriding a human.
     *
     * ## ⚠️ `starting` 也必须恢复（外部 issue #147）
     *
     * `starting` **会落库** —— `attemptStart()` 在真正起交易循环之前先
     * `setTraderStatus(traderId, 'starting', null)`（`:3095`，同步写库），
     * 而那之后还要建连接、校时、拉 exchangeInfo、探测模型（**几秒到几十秒**）。
     *
     * 进程若恰好死在那个窗口里（部署重启、OOM、断电）：
     *
     *   · `stopAll()` 只遍历 `this.running`，而这一台**还没进去** → DB 留成 `starting`；
     *   · 看门狗是**内存定时器**，进程一死就没了；
     *   · 本集合不认 `starting` → 不恢复；
     *   · `api/server.ts` 把非 running 的状态覆写成 `'stopped'` → 界面显示**「已停止」**；
     *   · `failedTraders()` 只收 `error` → 不告警。
     *
     * 于是它**既不恢复、也不告警**，而界面上那个"已停止"看起来
     * **就像有人手动停的** —— 没人会去查它为什么停。
     *
     * 加它**不会覆盖任何人的决定**：`starting` 只可能因进程死亡而残留 ——
     * 只要进程活着，看门狗必把它推到 `running` 或 `error`
     *（`startTraderAsync` 的 `.then` / `.catch` 两条路径都写状态）。
     * 这与 `stopped`（人的决定）有本质区别，所以不能一起放宽。
     */
    const resumable = new Set(['running', 'safe_mode', 'error', 'starting']);

    /*
     * 全局熔断期间**不恢复任何机器人**，而且不要把它们标成 `error` ——
     * 那是"启动失败"的语义，会被下一次重启当成待恢复的故障，也会在界面上
     * 误导操作员去排查一个不存在的问题。这里只留一条 warn，然后什么都不做。
     * （真正的收口在 `startTrader()` 里，这一条只是别让状态被写坏。）
     */
    if (env.globalTradingDisabled) {
      log.warn('GLOBAL_TRADING_DISABLED 已设置 —— 跳过开机恢复，不会启动任何机器人。');
      return;
    }

    for (const trader of traders.list()) {
      if (!resumable.has(trader.status)) continue;
      /*
       * ⚠️ **只在这一台被取消时跳过它，在真的停机时才 break —— 而且绝不让
       * 一台机器人的失败拖垮后面的全部。**
       *
       * 2026-10-03 实盘事故：这次循环原来是
       *
       *     if (this.cancelledStarts.has(trader.id) || this.stopping) break;
       *     const result = await this.startTrader(trader.id, dryRun, { retryTransient: true });
       *
       * 两个问题叠在一起：
       *
       *   · `cancelledStarts` 里有**任意一台**的取消，就 `break` 掉整个循环 ——
       *     而它的语义只是"这一台别启动了"（见 `startTrader` 的取消钩子）；
       *   · `startTrader` 的调用**没有 try/catch**，它一抛异常，循环就带着堆栈退出。
       *
       * 后果（实测）：`#9`「AI托管测试」排在前（id 小）并在启动途中出问题，
       * 循环中断，**排在后面的 `#10`「赚大钱」一个日志都没留下**。而 `#10` 是
       * 主账户上的实盘机器人，持有 3 个仓位、6 张保护单 —— **它静默停摆 8 小时**
       * （09:07 最后一轮 → 17:11 人工发现）。这恰好就是这段代码上面那段注释
       * 自己警告过的代价："一个持有杠杆仓位的机器人静默停摆是钱的问题"。
       *
       * 所以：**一台失败 = 标记它 + 继续下一台。**
       * `stopping` 是**全局**停机信号，只有它还配得上 `break`。
       */
      if (this.cancelledStarts.has(trader.id)) continue;
      if (this.stopping) break;

      const recovering = trader.status === 'error';
      log.info(
        recovering
          ? `重启后发现处于 error 状态的机器人「${trader.name}」，正在尝试恢复（原因：${trader.lastError ?? '未知'}）`
          : `重启后正在恢复机器人「${trader.name}」`,
      );

      /*
       * **所有恢复都给重试预算**（原来只有 `error` 状态给）。
       *
       * 原来的理由是一句成本权衡：一个"关机时健康"的机器人应该直接回来，给它
       * 2.5 分钟的重试循环会拖慢后面每一个。**那次实测把这个权衡推翻了**：
       *
       *     22:12:37 重启后正在恢复机器人「AI托管测试」（状态是 running，不是 error）
       *     22:12:49 LLM 第 1/2 次重试 … Cannot reach commandcode: fetch failed
       *     22:13:10 机器人「AI托管测试」恢复失败并已放弃重试
       *     22:14:30 同一个地址恢复正常（0.03 秒 200）
       *
       * 也就是说：**LLM 网关抖了约 100 秒，机器人被永久停在 error**，直到操作员
       * 手动点一次启动。而 `error` 状态下"没人点就永远不跑"正是这段注释开头
       * （F2）要修的那个闩锁 —— 它只是绕了个圈子又回来了。
       *
       * 代价仍然被两层挡着：
       *   · `isPermanentStartFailure()` 的原因（找不到账户、Key 没权限…）**立即放弃**，
       *     不会为它等满预算；
       *   · 重试是**可取消的**（`waitForRetry` 按 1 秒切片），停机不受影响。
       *
       * 而收益的不对称很大：启动慢 2.5 分钟是体验问题，**一个持有杠杆仓位的机器人
       * 静默停摆**是钱的问题。
       */
      /*
       * ⚠️ **整个恢复体包在 try/catch 里** —— `startTrader` 在成功路径上返回
       * `{ok:false}`，但**异常路径同样存在**（网络层、数据库层、任何未预期的 throw），
       * 而它一个异常就会让**后面所有机器人**都得不到恢复。见上面那段 2026-10-03 的说明。
       */
      let result: { ok: boolean; error?: string };
      try {
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **每台机器人用【它自己】的 dryRun，不是那个进程级参数**
         *      （2026-10-13 实测安全修复）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故：测试机器人被重启**静默恢复成实盘**
         *
         * 用户要求"测试必须 `dryRun: true`"，`#11` 也确实以模拟盘启动 ——
         * **直到下一次部署重启服务**：
         * ```
         *   resumePersisted(env.dryRun)   ← 一个进程级开关，恢复【所有】机器人
         *   → env.dryRun = false（服务器 .env 的 DRY_RUN=false）
         *   → #11 被用 false 恢复 → 实盘 🚨
         * ```
         * 线上 `runtime_logs` 证据：`#11 …「机器人已启动（实盘）」`。
         * 它当时 `orders=0`（全 skip）才没造成损失 —— **那是运气，不是保护**。
         *
         * ## 为什么之前是对的、现在错了
         *
         * "一个进程级开关恢复所有机器人"在**所有机器人共用一个开关**时自洽。
         * 而 `#11` 这类**测试机器人必须与实盘 `#10` 用不同的值** ——
         * 那个前提被打破了。
         *
         * ## 修法
         *
         * ```
         *   trader.dryRun === undefined  → 回落到传入的 env 值（既有机器人不变）
         *   trader.dryRun === true/false → 用它（操作员当时的显式选择）
         * ```
         * ⚠️ 这**不是**"恢复时重新读一次 env" —— 那正是错的：
         * 操作员当时的意图必须被记住，哪怕 env 变了。
         */
        const effectiveDryRun = trader.dryRun ?? dryRun;
        if (trader.dryRun !== undefined && trader.dryRun !== dryRun) {
          log.info(
            `机器人「${trader.name}」按它自己记录的纸面模式恢复（dryRun=${effectiveDryRun}）` +
              `—— 与本次进程的 ${dryRun} 不同。`,
          );
        }
        result = await this.startTrader(trader.id, effectiveDryRun, { retryTransient: true });
      } catch (error) {
        result = { ok: false, error: (error as Error).message };
        log.error(
          `机器人「${trader.name}」的恢复过程抛出异常 —— 已跳过它并继续恢复其余机器人：` +
            `${(error as Error).message}`,
        );
      }
      if (result.ok) continue;

      /*
       * Give up **visibly**. The point of F2 is that this state must not be
       * silent, so it goes to three places the operator actually looks: the
       * process log, the console's rolling log pane, and the trader row itself
       * (`status='error'` + `lastError`, which `TradersPage` renders).
       */
      const detail = `启动恢复失败，已停止自动重试，需要人工处理：${result.error ?? '未知错误'}`;
      this.setTraderStatus(trader.id, 'error', detail);
      runtimeLogs.write(trader.id, 'error', 'manager', detail);
      eventBus.publish({
        type: 'log',
        traderId: trader.id,
        level: 'error',
        message: `机器人「${trader.name}」${detail}`,
        scope: 'manager',
        timestamp: new Date().toISOString(),
      });
      log.error(`机器人「${trader.name}」恢复失败并已放弃重试：${result.error}`);
    }

    /* 开机恢复完成后启动自检循环（用户需求 #6 的"持续观察"）。 */
    this.startSelfCheckLoop();
  }

  /**
   * **自检的定时循环**（用户需求 #6 的"持续观察"）。
   *
   * ## 为什么必须定时，不能只靠手动触发
   *
   * 用户的原话：
   *
   * > 「你迭代更新系统得搞智能体团队**持续观察、测试**……
   * >  **不要有任何 BUG，也不要老让我来测试和发现问题，你要自己发现问题自己解决**」
   *
   * 手动触发（`POST /api/traders/:id/selfcheck`）只在**我想起来的时候**跑 ——
   * 那不叫持续观察。而这个系统的运行方式是 7×24 无人值守，
   * 问题最可能在**没人看的时候**发生。
   *
   * ## 为什么是 30 分钟
   *
   * 判据是"多久能发现"与"噪音"的权衡：
   *   · 太密（如 1 分钟）→ 日志里全是"未发现异常"，真问题被淹没；
   *   · 太疏（如 6 小时）→ 裸奔仓位可能挂几个小时没人知道。
   *
   * 30 分钟对**裸奔仓位**这类风险偏长，但那类风险另有更快的兜底
   *（启动对账会补挂保护单）。自检在这里的角色是**兜底的第二层**，
   * 不是唯一防线。
   *
   * ## 只跑确定性层
   *
   * 不调模型 —— 于是它**不花额度、不依赖网关**，可以无条件常开。
   * AI 层将来会挂在这个循环上（见 `runSelfCheck` 的 `ask` 参数）。
   */
  /**
   * **构造自检的 AI 层**（用户需求 #6 里"AI 自检"的那一半）。
   *
   * ## 确定性层与 AI 层的分工
   *
   * | 层 | 抓什么 | 需要模型吗 |
   * |---|---|---|
   * | 确定性 | 裸奔仓位、连续失败、错误刷屏、实验积压 | **不需要** |
   * | **AI（本方法）** | **把线索连起来** | 需要 |
   *
   * 确定性层只能发现"某一项越过了阈值"。而真实故障往往是**几条线索合起来**
   * 才成立的，例如：
   *
   *   · 降级次数高 **+** 延迟升高 **+** 某个 provider 的错误集中
   *     → **首选额度可能耗尽了**；
   *   · 新闻材料为空 **+** 搜索端点 401
   *     → **搜索密钥过期了**（而不是"市场没消息"）；
   *   · 团队调用数少于角色数 **+** 某个阶段没有日志
   *     → **某个角色静默失败了**。
   *
   * 这三条都是**我在过去几轮里人工发现的** —— 而用户明确要求
   * 「不要老让我来测试和发现问题，**你要自己发现问题自己解决**」。
   *
   * ## 用 `system_engineer` 这个角色
   *
   * 它就是用户理想组织里的「**维护系统的程序员**」——
   * 组织架构表里此前标着"规划中"，这个方法让它**真的在岗**。
   *
   * ## 用 T3（最强档）
   *
   * 自检要读日志与数字，而"把几条线索连起来"正是最需要判断力的活。
   * 它每 30 分钟才跑一次 —— 成本可忽略（用户也说了不用考虑费用）。
   *
   * ## 拿不到网关时返回 `undefined`
   *
   * 于是自检**退回确定性层**（而不是整体失败）。这是刻意的：
   * **网关挂掉的时候恰恰最需要自检**，那时更不该因为"AI 层不可用"而什么都不做。
   */
  private buildSelfCheckAsk(): ((prompt: string) => Promise<string>) | undefined {
    let gateway;
    try {
      gateway = resolveTeamGateway(process.env);
    } catch {
      return undefined;
    }
    if (gateway === null) return undefined;

    const router = new ModelRouter({
      call: createMagpieCallFactory({
        baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        /*
         * 自检用**比团队决策更短**的超时与更低的温度：
         *   · 超时 120 秒 —— 它是后台任务，卡住不该拖过一个间隔；
         *   · 温度 0.1 —— 这是"读证据下判断"，不是创意写作。
         */
        timeoutSeconds: SELF_CHECK_TIMEOUT_SECONDS,
        maxRetries: 1,
        temperature: 0.1,
        pluginProvidersPath: process.env.MAGPIE_PLUGIN_PROVIDERS_PATH ?? null,
      }),
    });

    return async (prompt: string): Promise<string> => {
      const result = await router.callByTier(
        tierForRole('system_engineer'),
        [
          {
            role: 'system',
            content:
              '你是这套自动交易系统的「系统工程师」，负责**从运行证据里发现缺陷**。' +
              '你的价值在于**把几条线索连起来**看出单一指标看不出的问题。' +
              '⚠️ 只依据给出的证据，**不要猜测证据里没有的东西** —— ' +
              '编造出的问题会让人去查一个不存在的地方，那比不报更糟。',
          },
          { role: 'user', content: prompt },
        ],
        { baseMaxTokens: 2_048 },
      );
      return result.text;
    };
  }

  private startSelfCheckLoop(): void {
    if (this.selfCheckTimer) return;
    /*
     * 间隔可由 `SELF_CHECK_INTERVAL_MINUTES` 覆盖（默认 30 分钟）。
     *
     * 为什么留这个口子：**自检的合适频率取决于部署形态**
     *（机器人多、日志大时该稀疏些；排查期想密集些）。
     * 而且它让"验证这个循环真的在跑"变得可行 ——
     * 否则要等 30 分钟才能看到一次效果。
     *
     * 钳制在 1–1440 分钟：0 或负数会让 `setInterval` 疯狂空转。
     */
    const raw = Number(process.env.SELF_CHECK_INTERVAL_MINUTES ?? '');
    const minutes = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 1440) : 30;

    const timer = setInterval(() => {
      void this.runSelfCheckSweep();
    }, minutes * 60_000);
    /*
     * 不因为这个定时器把进程吊在退出前 —— 它是**可丢弃的**：
     * 丢掉只是少跑一次自检，不是丢数据。
     */
    timer.unref();
    this.selfCheckTimer = timer;
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️ **启动时立即跑一次**（2026-10-14 加）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * `setInterval` 只在**一个完整间隔之后**才第一次触发。对自检本身那没问题
     *（它是"定期体检"），但对**结清陈旧委托**是问题：
     * ```
     *   部署重启 → 自检循环注册 → 等 30 分钟才第一次 sweep
     *   → 而"结清"就挂在那次 sweep 里
     *   → 部署后半小时内，界面上那几十条"已挂单"仍然在骗人
     * ```
     * 实测：部署后 14 分钟查，#11 的 `NEW` 从 36 涨到 **40**（还在新增），
     * 而结清日志一条都没有 —— 因为 sweep 还没跑过第一次。
     *
     * 而"启动时"恰好是**最该跑一次**的时刻：
     * ```
     *   · 重启前可能留下一批未结清的委托行（进程被杀时正跑到一半）
     *   · 而重启本身就是"决策周期中断"的最大来源
     * ```
     *
     * ⚠️ 用 `void` 异步触发（不阻塞启动）：自检要读交易所，慢几秒不该挡住服务起来。
     * ⚠️ 与定时器共用 `runSelfCheckSweep` 的重入守卫（`selfCheckSweepRunning`），
     * 所以即使两次撞在一起也只会跑一遍。
     */
    void this.runSelfCheckSweep();
    log.info(`自检循环已启动（每 ${minutes} 分钟一次，启动时已先跑一遍）。`);
  }

  /**
   * **停摆审计** —— 把 `/api/health` 已经算出来的 `staleTraders` 落成一条可检索的记录。
   *
   * ## 为什么不新建一套判据
   *
   * `evaluateTraderHealth`（`api/server.ts:437`）就是那个端点在用的纯函数，
   * 判据 = `max(周期 × STALE_CYCLE_MULTIPLIER, STARTUP_GRACE_MS)`，而且它多一道
   * 前提：**该机器人确实由当前进程持有**（否则库里一个残留的 `running` 会被误报 ——
   * 外部 issue #119 就是这个问题）。自己再写一套阈值，迟早与它分叉，而分叉那天没人发现。
   * 连**阈值常量也一起 import**，所以文案里写的是同一个 `2` 与同一个 `300 秒`。
   *
   * ⚠️ **动态导入而不是静态**：`api/server.ts:57` 从本文件导入（`TraderManager` /
   * `readLlmHealth`），静态反向导入会成环。动态导入在本文件已有先例
   * （`refreshResearch` 里对 harness 的那句），而且动态导入拿到的是**已求值完**的模块，
   * `const` 导出不会踩 TDZ。
   *
   * ## 为什么分两级（实盘 / 模拟盘）
   *
   * 用户要的是"**只对会影响真实资金的事发强信号**"。`dry_run=0` 停摆 5.5 小时是钱；
   * 模拟盘停摆同样值得留痕，但不该把真事的强度稀释掉 —— 所以前者 `error`、后者 `warn`。
   * `dry_run` 的解析口径与 `resumePersisted` / `attemptStart` 一致：
   * `trader.dryRun ?? env.dryRun`（机器人自己记的优先，没有才回落进程级环境变量）。
   *
   * ## 为什么"进入记一次、恢复记一次"
   *
   * 这个状态**每 30 分钟的 sweep 都成立**。按事件每轮记一次的结果是日志被同一句话填满 ——
   * 而本项目反复记过那条："**一个每轮都响的告警等于没有告警**"（`emitOnChange` 的注释）。
   * 所以只在**进入**与**解除**各记一条；**持续时长以控制台的常驻横幅为准**
   * （横幅每次轮询都拿最新的 `staleForMs`）。
   *
   * ⚠️ 极端情形下最多晚一个 sweep（30 分钟）才写进日志 —— 实时性由控制台横幅承担，
   * 这一条是**留痕**，不是通道。两者分工写在 `runSelfCheckSweep` 的调用点上。
   */
  private async auditStaleTraders(): Promise<void> {
    const { evaluateTraderHealth, healthContext, STALE_CYCLE_MULTIPLIER, STARTUP_GRACE_MS } =
      await import('../api/server.js');
    const rows = traders.list();
    /*
     * ⚠️ **必须传 `healthContext()`，否则横幅与日志会各说各话**（2026-10-17 · t114）。
     *
     * 这个 context 里有"最近轮次时长分布"与"最新一行是不是**新鲜的** pending"——
     * 正是 `/api/health` 用来区分"一轮正在跑"与"真卡住"的两份证据。
     * 不传的话阈值会退回老的 30 分钟：**横幅不再误报，而 `[停摆]` 日志照样误报**，
     * 那正是 `t99` 之前付出过代价的"两个真相互相矛盾"。
     */
    const verdict = evaluateTraderHealth(rows, Date.now(), this.runningSince(), healthContext());
    const staleIds = new Set(verdict.stale.map((entry) => entry.traderId));

    /* ① 先处理"恢复"：清掉状态位，并留一条"什么时候恢复的"（与"什么时候开始"对称）。 */
    for (const id of [...this.staleNotices.keys()]) {
      if (staleIds.has(id)) continue;
      this.staleNotices.delete(id);
      const row = rows.find((r) => r.id === id);
      const message = `[停摆恢复] #${id}「${row?.name ?? '?'}」已重新完成决策周期 —— 停摆状态解除。`;
      log.info(message, { traderId: id, raw: message });
    }

    /*
     * ② 进入停摆：**文案与级别由纯函数产出**（`buildStaleNotices`），
     * 这里只负责"去重 + 落日志"。抽出去的理由与 `selfcheck.ts` 一样：
     * 判断逻辑是最该被断言的部分，而它不需要一整个 manager 实例才能测。
     */
    for (const notice of buildStaleNotices({
      stale: verdict.stale,
      rows,
      envDryRun: env.dryRun,
      multiplier: STALE_CYCLE_MULTIPLIER,
      graceMs: STARTUP_GRACE_MS,
    })) {
      /* 状态位用级别当值：实盘↔模拟盘之间切换也要重新记一条。 */
      if (this.staleNotices.get(notice.traderId) === notice.level) continue;
      this.staleNotices.set(notice.traderId, notice.level);
      log[notice.level](notice.message, { traderId: notice.traderId, raw: notice.message });
    }
  }

  /**
   * **停摆状态位**（键 = traderId，值 = 记过的级别）。
   *
   * 只有一个用途：让 `auditStaleTraders` 在"**进入**停摆"与"**解除**"时各记一条，
   * 而不是每个 sweep 都重复同一句话（见该方法的说明）。
   * 进程重启后它自然为空 —— 而重启本身就该重新记一条。
   */
  private readonly staleNotices = new Map<number, 'error' | 'warn'>();

  /** 给所有**在跑**的机器人各跑一次自检。 */
  private async runSelfCheckSweep(): Promise<void> {
    /* 上一遍还没跑完就跳过 —— 自检不该自己叠起来。 */
    if (this.selfCheckSweepRunning) return;
    this.selfCheckSweepRunning = true;
    try {
      /*
       * ⚠️ **只查在跑的机器人**。
       *
       * 停掉的机器人"长时间没有成功决策"是**正常**的（操作员关了它），
       * 查它只会产生噪音 —— 而噪音会让人开始忽略自检。
       *（`selfcheck.ts` 里也有这道前提，两处都挡：这里省掉无谓的查询，
       *  那里保证即使被调用也不会误报。）
       */
      const ids = [...this.running.keys()];
      /*
       * AI 层**只构造一次**（懒加载）—— 每次扫都新建一个路由器会丢掉
       * `createMagpieCallFactory` 里的客户端缓存。
       *
       * 构造失败（网关读不到）时保持 `undefined`，于是自检退回确定性层 ——
       * 见 `buildSelfCheckAsk()` 的说明。
       */
      if (this.selfCheckAsk === undefined && !this.selfCheckAskTried) {
        this.selfCheckAskTried = true;
        this.selfCheckAsk = this.buildSelfCheckAsk();
        if (this.selfCheckAsk !== undefined) {
          log.info('自检的 AI 层已就绪（system_engineer 角色）。');
        }
      }

      /*
       * ══════════════════════════════════════════════════════════════════════════
       *  ⭐ **把"停摆"这个已有信号推到人眼前**（2026-10-17 · t99）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 现场（真实资金，本批最贵的一次教训）
       *
       * `#10`「赚大钱」（`dry_run=0`）**连续失败 9 轮 / 331 分钟 ≈ 5.5 小时**，零决策。
       * 而系统**知道**这件事：
       *
       * ```
       *   /api/health → {"ok":false,
       *     "staleTraders":[{"id":10,"name":"赚大钱","staleForMs":2144782,…}],
       *     "reason":"有 1 个正在运行的机器人已超过各自周期的 2 倍仍未完成一轮决策。"}
       * ```
       *
       * **问题不是"没有信号"，而是信号在没人看的地方**：`ok:false` 只发给容器编排器
       *（本部署是 systemd，没人读它），而控制台**连 `staleTraders` 这个字段都没有**。
       * 队长是在做"部署后回读"时**偶然**发现那 5.5 小时的。
       *
       * ## 这一步做什么（范围刻意很小）
       *
       * **不新建第二套判据** —— 直接复用 `/api/health` 判 `ok:false` 用的那个纯函数
       * `evaluateTraderHealth`（判据 = `周期 × 2` 与 `300s` 起步宽限取较大者，且要求
       * 该机器人**确实由当前进程持有**）。另造一个阈值迟早与它分叉，而分叉那天没人会发现。
       *
       * 然后为每一个停摆的机器人留一条**形状稳定、可检索**的记录（见
       * `auditStaleTraders`），并按"**只对会影响真实资金的事发强信号**"分两级：
       * `dry_run=0` → `error`；模拟盘 → `warn`。
       *
       * ⚠️ 它放在 per-trader 循环**之前**：后面那串要读交易所、还要调模型（最慢的部分），
       * 停摆检测不该排在它们后面才跑。
       * ⚠️ 它**只读**（读库 + 读内存里的运行态），不下单、不改状态 ——
       * 与 `settleStaleOrderRecords` 那种"改账"的动作不同。
       */
      await this.auditStaleTraders();

      for (const id of ids) {
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⭐ **结清"交易所已不再挂着"的本地委托行**（2026-10-14 线上 BUG）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故：委托列表在骗人（本地 36 条"已挂单"，交易所 0 条）
         *
         * 线上 `#11`（团队模式）实测：
         * ```
         *   本地 orders status='NEW'       : 36 条
         *   交易所 /fapi/v1/openOrders     :  0 条
         *   交易所 /fapi/v1/openAlgoOrders :  0 条（9 个标的逐个查）
         * ```
         * 用户看到的是「当前委托 28 · 已挂单（待对账）」，而**交易所一张都没有**。
         *
         * ## 为什么它原来不生效
         *
         * 结清逻辑（`settleStaleOrders`）挂在**决策周期的对账**那一步里 ——
         * 而团队模式的决策又慢又长，那个周期路径经常走不到（实测 `#11` 的
         * 对账只跑过 2 次）。**逻辑是对的，只是从未被执行。**
         *
         * ## 为什么放在自检循环里
         *
         * 这个循环是**独立于决策周期**的 30 分钟节奏，而且它的前提是
         * "只查在跑的机器人" —— 正好是"会有新委托产生"的那批。
         * 换句话说：**它一定会跑**，而决策周期不一定。
         *
         * ⚠️ 它只改账（把交易所已不挂着的本地行写成终态），不撤单、不下单 ——
         * 所以放在这里没有并发风险（见 `settleStaleOrderRecords` 的说明）。
         * ⚠️ 放在自检**之前**：自检会读委托状态并据此报告异常，
         * 先结清能让它读到的是**事实**而不是陈旧的行。
         */
        try {
          const trader = this.running.get(id);
          if (trader !== undefined) {
            const settled = await trader.settleStaleOrderRecords();
            if (settled > 0) {
              log.info(`自检前结清 #${id} 的 ${settled} 条陈旧委托记录（交易所侧已不挂着）。`);
            }
          }
        } catch (error) {
          /* 结清失败不该影响自检 —— 它是记账修复，不是自检的输入。 */
          log.warn(`结清 #${id} 的陈旧委托记录失败：${(error as Error).message}`);
        }

        try {
          const result = await runSelfCheck(id, this.selfCheckAsk === undefined ? {} : { ask: this.selfCheckAsk });
          /*
           * 只在**有非 info 的发现**时写一条汇总 —— 否则每 30 分钟一条
           * "未发现异常"会把日志刷满。
           */
          const notable = result.deterministic.filter((f) => f.severity !== 'info');
          if (notable.length > 0) {
            log.warn(
              `自检 #${id}：${notable.length} 项需要注意 —— ${notable.map((f) => f.title).join('；')}`,
            );
          }
        } catch (error) {
          /* 一个机器人自检失败不该影响其它机器人。 */
          log.warn(`自检 #${id} 失败：${(error as Error).message}`);
        }
      }
    } finally {
      this.selfCheckSweepRunning = false;
    }
  }

  /**
   * **自检循环的定时器**（见 `startSelfCheckLoop()`）。
   *
   * `null` = 循环没在跑。用 `unref()` 挂上，所以它**不会**把进程吊在退出前。
   */
  private selfCheckTimer: NodeJS.Timeout | null = null;

  /**
   * 上一遍自检扫过还没结束 —— 用它防止**自检自己叠起来**。
   *
   * 扫一遍要给每个在跑的机器人查日志、决策记录、持仓，最坏情况可能超过
   * 一个间隔（例如机器人很多、日志表很大）。叠起来只会让负载雪上加霜。
   */
  private selfCheckSweepRunning = false;

  /**
   * 自检的 AI 层（懒构造一次，见 `buildSelfCheckAsk()`）。
   *
   * `undefined` = 网关不可用 → 自检只用确定性层。
   */
  private selfCheckAsk: ((prompt: string) => Promise<string>) | undefined;

  /**
   * 是否已经**尝试过**构造 AI 层。
   *
   * ⚠️ 必须与 `selfCheckAsk` 分开记 —— 否则"构造失败"（`undefined`）
   * 会让下一次扫描再试一遍，形成"每 30 分钟重试一次"的隐性循环。
   * 而网关不可用是**持续性**状态，重试没有意义（它自己恢复时会重启进程）。
   */
  private selfCheckAskTried = false;

  /**
   * 处于 `error` 且**没有**在运行的机器人 —— 也就是"自动恢复已经放弃"的那一批。
   *
   * 给 `/api/system` 用。它存在的理由是 F2 的另一半：放弃重试这件事本身必须是
   * 可见的。只看 `runningIds()` 的话，一个启动失败的机器人和一个被操作员
   * 主动停掉的机器人长得一模一样。
   */
  failedTraders(): Array<{ id: number; name: string; lastError: string | null }> {
    return traders
      .list()
      .filter((trader) => trader.status === 'error' && !this.running.has(trader.id))
      .map((trader) => ({ id: trader.id, name: trader.name, lastError: trader.lastError }));
  }
}
