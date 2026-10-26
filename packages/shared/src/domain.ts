import { z } from 'zod';
import type { CoinSourceType, StrategyConfig, TradingMode } from './strategy.js';
import type { Decision } from './decision.js';

/* -------------------------------------------------------------------------- */
/*  Exchanges                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Phase 1 ships Binance USDⓈ-M futures only. The union is intentionally open so
 * further venues can be added without touching call sites.
 */
export const ExchangeIdSchema = z.enum(['binance']);
export type ExchangeId = z.infer<typeof ExchangeIdSchema>;

export const EXCHANGES: ReadonlyArray<{
  id: ExchangeId;
  label: string;
  market: string;
  available: boolean;
}> = [
  { id: 'binance', label: '币安 USDT 本位合约', market: 'USDT 永续合约', available: true },
];

/* -------------------------------------------------------------------------- */
/*  LLM providers                                                              */
/* -------------------------------------------------------------------------- */

export const LlmProviderIdSchema = z.enum([
  'deepseek',
  'opencode',
  'openai',
  'anthropic',
  'gemini',
  'qwen',
  'grok',
  'kimi',
  'minimax',
  'openrouter',
  'commandcode',
  'custom',
]);
export type LlmProviderId = z.infer<typeof LlmProviderIdSchema>;

export interface LlmProviderDescriptor {
  id: LlmProviderId;
  label: string;
  /** Default API base URL. `custom` requires the user to supply one. */
  baseUrl: string;
  /** Auth style drives how the client builds headers. */
  authStyle: 'bearer' | 'x-api-key' | 'query-key';
  /**
   * A few suggested model ids, shown only before the user has supplied a key.
   * Prefer `modelsPath` discovery — a static list goes stale.
   */
  models: string[];
  /** True when the provider speaks the OpenAI `/chat/completions` dialect. */
  openAiCompatible: boolean;
  /** Whether a native strict JSON mode is available. */
  jsonMode: 'json_object' | 'json_schema' | 'none';
  docsUrl: string;
  /** Path appended to `baseUrl` to list available models, e.g. `/models`. */
  modelsPath: string;
  /** How to authenticate against `modelsPath`. */
  modelsAuth: 'bearer' | 'x-api-key' | 'query-key';
  /** Extra headers the models endpoint requires (e.g. `anthropic-version`). */
  modelsHeaders?: Record<string, string>;
  /** Sensible inference defaults, so the user never has to choose numbers. */
  defaults: {
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    maxRetries: number;
  };
  /** True when the provider offers a slow, deliberate reasoning mode. */
  supportsThinking: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Persisted entities                                                         */
/* -------------------------------------------------------------------------- */

export interface User {
  id: number;
  username: string;
  role: 'owner' | 'user';
  createdAt: string;
}

/** Exchange credentials. `apiSecret` never leaves the server in plaintext. */
export interface ExchangeAccount {
  id: number;
  exchange: ExchangeId;
  label: string;
  apiKey: string;
  /** Only ever sent to the client as a boolean-ish hint, never the secret. */
  hasSecret: boolean;
  testnet: boolean;
  /** Read-only keys can be stored but cannot trade. */
  canTrade: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelConfig {
  id: number;
  provider: LlmProviderId;
  label: string;
  model: string;
  baseUrl: string;
  /** Masked on the wire. */
  apiKeyMasked: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxRetries: number;
  /**
   * 模型能吃多大的输入（token）。`0` = **不知道**（服务商没报、用户没填）。
   *
   * ## 它决定候选池能有多大
   *
   * 提示词预算不是独立定的：`candidateBudget()` = 预算 ÷ 每个候选的字符成本。
   * 原来预算硬编码 6 万，于是一个 4 周期 × 30 个点的策略**只能看到 7 个标的** ——
   * 实测某机器人连续 15 轮候选池都是 7 个、15 轮 0 决策，而它挂的模型能吃 100 万。
   *
   * ⚠️ 这一列是**能力上限**（模型物理上能吃多少），不是**你愿意花多少** ——
   * 后者由 `PROMPT_TOKEN_CEILING` 控制（成本考虑）。两个数字分开，因为"能"和
   * "愿意"是两回事：一个 1M 上下文的模型，每小时几十次都塞 80 万 token，
   * 那仍然是真实账单。
   */
  inputTokenLimit: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A model advertised by a provider's own `/models` endpoint.
 *
 * `discovered` distinguishes a live result from a built-in suggestion, so the UI
 * can tell the user which list they are looking at.
 */
export interface DiscoveredModel {
  id: string;
  label?: string;
  /** Context window, when the provider reports one. */
  contextLength?: number;
  discovered: boolean;
}

/** 机器人的运行模式。**这是机器人的属性，不是一个策略** —— 见 `M7_TRADER_MODE` 的注释。 */
/**
 * 机器人的运行模式。
 *
 * ## `ai_team` 与 `ai_managed` 是**两个不同的东西**（用户 2026-10-12 明确要求）
 *
 * 用户原话：
 *
 * > 「这次更新应该是一个**全新的项目**，和现在智能托管是 2 个东西，也就是说你现在的
 * >  更新迭代**不要影响我现在实盘跑的机器人**……等这个更新做完以后新建机器人就应该
 * >  有**除了智能托管外**这次更新的模式」
 *
 * | 模式 | 是什么 | 谁在跑 |
 * |---|---|---|
 * | `strategy` | 固定策略：参数由人对策略配置决定 | — |
 * | `ai_managed` | **智能托管**：单智能体 + 定时轮询，AI 自己调参 | 实盘机器人 #10 `赚大钱` |
 * | `ai_team` | **多智能体团队**：7×24 事件驱动、分工协作、辩论裁决 | `[团队测试] 多智能体` #11 |
 * | `jev` | **JEV 模式（实验性）**：由 Jev 决策模型做**每一个判断** | 待建 |
 *
 * ⚠️ **隔离纪律**：每个新加入的模式必须走**独立代码路径**。
 * 前几个模式的语义一个字都不能改 —— 它们上面挂着用户的真金白银。
 *
 * ## 关于 `jev`（2026-10-19 新增，实验性）
 *
 * 用户的要求是「所有操作都采用 JEV 模型来实现，从选币到交易，一切都由 JEV 自主完成」。
 *
 * ⚠️ **实测发现字面实现不可能**：Jev 的答案只有 `choice` / `score` / `noul`
 * 三种类型化形状，**不产生任何文字、且弱于算术**；而 `Decision` 需要
 * `positionSizeUsd` / `stopLoss` / `takeProfit`（精确数字）与 `reasoning`（必需的文字）。
 *
 * ⇒ 本模式的实际形态是：**代码算好候选档位 → Jev 从档位里选 → 代码把答案翻译成 Decision**。
 *   每一个**判断**都由 Jev 做出，代码只负责算数（Jev 的弱项）与翻译。
 *   完整设计见 `docs/JEV-MODE-DESIGN.md`。
 */
export type TraderMode = 'strategy' | 'ai_managed' | 'ai_team' | 'jev';

/**
 * 需要 AI 自己决策（而不是按固定策略执行）的模式 —— 加新模式时**必须**在这里登记。
 *
 * ⚠️ `jev` **也是 AI 驱动的**：它的每一个判断都来自 Jev 模型。
 * 漏登记会让 `isAiDriven()` 返回 false，进而走到"固定策略"那条路径上
 *（那是完全不同的语义，而且会静默地用一个不存在的策略）。
 */
export const AI_DRIVEN_MODES: readonly TraderMode[] = ['ai_managed', 'ai_team', 'jev'];

/** 这个模式是不是由 AI 驱动。 */
export function isAiDriven(mode: TraderMode): boolean {
  return AI_DRIVEN_MODES.includes(mode);
}

export type TraderStatus = 'running' | 'stopped' | 'starting' | 'error' | 'safe_mode';

export interface Trader {
  id: number;
  name: string;
  /**
   * 绑定的交易所账户 —— **`null` 表示这是一台纯模拟盘机器人**。
   *
   * ## 为什么它可以为空（用户 2026-10-27 需求）
   *
   * 用户原话：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的余额。
   * 也就是说，无需真实账户就能开启模拟盘机器人。」
   *
   * 模拟盘不下真实订单（`BinanceBroker` 的 dryRun 分支全程本地模拟），
   * 余额也由本地台账折算（见 `binance/paperWallet.ts`），所以它**不需要**
   * 任何真实账户。原先这一列是 `NOT NULL`，于是"想先拿模拟盘试试"被卡在
   * "先去交易所注册、拿密钥、填进系统"这一步。
   *
   * ⚠️ **实盘机器人必须有值**：`null` 的机器人启动时会被明确拒绝
   *（它没有凭据可用）。删掉一个交易所账户时，引用它的机器人被置空
   *（`ON DELETE SET NULL`），而不是把机器人连同账本一起删掉。
   */
  exchangeAccountId: number | null;
  aiModelId: number;
  /**
   * 这个机器人引用的策略 —— **`null` 表示它不依赖任何策略**。
   *
   * ## 为什么它可以是空的
   *
   * AI 托管的参数整份存在 `agentConfigJson` 里（由 AI 自己写），策略对它
   * **完全不生效**。原先这一列是 `NOT NULL`，于是建 AI 托管机器人时必须选一个
   * 用它不上的策略 —— 而那个策略又因为外键约束（`ON DELETE RESTRICT`）
   * **永远删不掉**，界面上还会显示成「1 个机器人正在引用它」。
   *
   * 用户的原话：「智能托管模式完全独立出来……就算策略工坊里面默认策略 — 稳健
   * 就算删除、没有任何策略，都不影响智能托管模式（做到完全独立）」。
   *
   * 所以 `mode === 'ai_managed'` 的机器人 `strategyId` 就是 `null`；而固定策略
   * 模式下它是必填的。删掉一个策略时，引用它的机器人会被置空
   * （`ON DELETE SET NULL`），而不是阻止删除、也不是把机器人一起删掉。
   */
  strategyId: number | null;
  /** Minutes between decision cycles. */
  cycleIntervalMinutes: number;
  /**
   * 收益率的分母。
   *
   * ⚠️ 它**不是**"账户里有多少钱" —— 那个语义归 `paperStartingBalance`（模拟盘）
   * 或交易所余额（实盘）。两者分开存是刻意的：`initialEquity` 会在首次启动时
   * 被真实钱包余额覆盖（见 `manager.ts` 的回落逻辑），而操作员填的模拟余额
   * **不该**被任何东西覆盖。
   */
  initialEquity: number;
  /**
   * 模拟盘起始余额（操作员在创建时填的那个数）。`0` = 没填。
   *
   * 只对模拟盘有意义：它是本地钱包的本金，`walletBalance = 起始余额 + 已实现净盈亏`。
   * 实盘机器人忽略这个字段（它读交易所）。
   */
  paperStartingBalance: number;
  status: TraderStatus;
  /** Populated while running. */
  lastCycleAt: string | null;
  /**
   * Monotonic cycle counter, persisted so that the audit trail keeps a single
   * continuous numbering across restarts rather than resetting to zero.
   */
  lastCycleNumber: number;
  lastError: string | null;
  consecutiveFailures: number;
  /**
   * AI 智能托管模式下的参数（JSON），**非空即代表这个机器人由 AI 托管**。
   *
   * 不能用 `strategies.config` 的原因：**一个策略可以被多个机器人共用**，
   * 而 AI 模式下每个机器人的参数是各自演化的 —— 共用会让两个 AI 互相覆盖，
   * 而且那种覆盖看起来完全正常。
   *
   * 为 null 时按 `strategies.config` 跑，行为与以前完全一致。
   */
  agentConfigJson: string | null;
  /**
   * 运行模式。
   *
   * `'strategy'` —— 按 `strategies.config` 的固定参数跑（既有机器人的行为）。
   * `'ai_managed'` —— 由 AI 智能体托管：参数由它自己设定并持续调整，
   *   存在 `agentConfigJson`（按机器人隔离），策略参数被忽略。
   *
   * **这是一个机器人的属性，不是一个策略。** 策略是"一组固定参数"，
   * 而 AI 模式的意思是"没有固定参数" —— 后者不能是前者的一种。
   */
  mode: TraderMode;
  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  **操作员启动这一台时选的"纸面模式"**（2026-10-13 新增，一条安全修复）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么它必须落库
   *
   * 事故：用户要求"测试必须 `dryRun: true`"，`#11` 也确实以模拟盘启动 ——
   * **直到下一次部署重启服务**：
   * ```
   *   resumePersisted(env.dryRun)   ← 一个【进程级】开关，恢复【所有】机器人
   *   → env.dryRun 来自服务器 .env（DRY_RUN=false）
   *   → #11 被用 dryRun=false 恢复 → 实盘 🚨
   * ```
   * 线上 `runtime_logs` 证据：`#11 …「机器人已启动（实盘）」`。
   *
   * ## ⚠️ 三态，`undefined` 与 `false` 必须分得开
   *
   * ```
   *   true      —— 操作员显式选了模拟盘 → 重启后【仍按模拟盘恢复】
   *   false     —— 操作员显式选了实盘   → 重启后【仍按实盘恢复】
   *   undefined —— 从未被指定过 → 回落到进程级 `env.dryRun`（既有行为不变）
   * ```
   * 把 `undefined` 当成 `false` 会把"从未指定"误判成"指定了实盘"，
   * 于是 env 的回落路径被悄悄删掉 —— 那正是本次事故的形态。
   */
  dryRun?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyRecord {
  id: number;
  name: string;
  description: string;
  config: StrategyConfig;
  /** Set when the strategy was cloned from a preset. */
  presetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Trading records                                                            */
/* -------------------------------------------------------------------------- */

export type PositionSide = 'long' | 'short';

/**
 * 保证金模式 —— 币安 USDⓈ-M 的**逐标的账户配置**，不是某个仓位的属性。
 *
 * `'cross'` = 全仓、`'isolated'` = 逐仓。中文标签在展示层（`MARGIN_MODE_LABEL`），
 * 这一层只存机器码（AGENTS §5.2：存机器码，翻译在展示层）。
 *
 * ⚠️ **这个概念的机器码在全仓库有两种写法，必须在一个地方收口。**
 *
 * | 来源 | 写法 |
 * | --- | --- |
 * | 交易所 `positionRisk` / `symbolConfig`（读） | `cross` / `isolated` |
 * | `POST /fapi/v1/marginType`（写） | `CROSSED` / `ISOLATED` |
 * | 本仓库策略配置 `riskControl.marginMode` | `crossed` / `isolated` |
 *
 * 收口在 `normalizeMarginMode()`（`store/repositories.ts`）。**不要**在别处直接比较
 * 字符串：`'cross' === 'crossed'` 是 `false`，而这种比较失败不会抛错 ——
 * 它只会让一个模式被读成"不知道"（或更糟：被读成另一个模式）。
 */
export type MarginMode = 'cross' | 'isolated';

export interface PositionView {
  id: number;
  traderId: number;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  /**
   * 未实现盈亏**对保证金**的百分比 —— ⚠️ **含杠杆，不是价格变动百分比**。
   *
   * 5x 下价格涨 1%，这里是 5%。要和价格口径比，必须走
   * `marginPercentToPricePercent`。
   */
  unrealizedPnlPercent: number;
  /**
   * Best unrealised PnL seen, used by the drawdown guard.
   *
   * **同样是对保证金的口径**（与 `unrealizedPnlPercent` 一致）——
   * 而它是最容易被读错的一个，因为它经常和价格口径的数字并排出现。
   */
  peakPnlPercent: number;
  marginUsed: number;
  /**
   * 该标的**当前**的保证金模式，实时读自交易所的 `positionRisk`（见 `liveExchangeView`）。
   *
   * ⚠️ **这是账户此刻的配置，不是历史快照。** 它是一次实时读数，而保证金模式是
   * **逐标的的账户设置**：一个已经平掉的仓位在这里没有对应行，那个标的的模式也就
   * 读不到（记 `undefined`）。**历史问题（"那张单当时是什么模式"）只能由
   * `OrderRecord.marginType` 回答** —— 界面把两者分开用：落库值优先，缺失时才拿
   * 这一份兜底，并且会明说"这是当前配置"（见 `orderMarginMode()`）。
   *
   * 选填：读不到时是 `undefined`（界面显示 `—`）。
   *
   * ⚠️ **绝不可回落成 `'cross'`。** 币安的默认确实是全仓（官方明文 "All contracts
   * and positions are defaulted to the Cross Margin mode"），但"交易所的默认是 X"
   * 与"我们读到了 X"是两件事 —— 把它填上去等于**替交易所宣布一个我们没验证过的事实**。
   * 与本文件 `marginUsed` 那条（"0 与 undefined 不是一回事"）是同一条纪律。
   */
  marginType?: MarginMode;
  notional: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /**
   * **保护单还在挂载中**（2026-10-19 用户要求）。
   *
   * ## 为什么需要这个字段
   *
   * 用户原话：
   * > 「我刚才看到这单开单的时候提示没有止损，后面又有了好像是系统自动补上，
   * >  但是这显示是不是有问题？…显示要正常不要让我产生误会」
   *
   * ## 那个"没有止损"是什么
   *
   * 一条市价开仓的时间线：
   * ```
   *   t+0s   下单成交（此时持仓存在，但保护单还没发请求）
   *   t+2s   两张条件单挂好
   * ```
   * 页面若在 t+0~t+2 之间刷新，`stopLoss` 已经有值（本地决策时就算好了），
   * **但交易所侧还没有对应的挂单** —— 于是出现两种误导：
   * ```
   *   ① "无止损" 红标  → 用户以为裸奔
   *   ② 显示止损价但交易所其实没有那张单 → 用户以为有保护
   * ```
   *
   * ## 判定方式
   *
   * `openedAt` 距今很近（< `PROTECTION_PENDING_MS`）**且**该持仓的
   * `stopLoss` / `takeProfit` 在 `orders` 表里还没有对应的 `NEW` 行
   * ⇒ 这就是"正在挂"。服务端算好这个布尔值，客户端不再自己推。
   *
   * ⚠️ **它是"未知"而不是"没有"**。所以界面显示「挂单中」，
   * 不能显示「无止损」—— 后者是一个**结论**，而此刻我们并不知道。
   */
  protectionPending?: boolean;
  openedAt: string;
  /** Free-form reason captured at entry, from the model. */
  openReasoning: string;
}

/**
 * 把「对保证金的收益率」换算成「价格变动百分比」。
 *
 * ⚠️ **为什么需要这个函数**：仓库里有两套百分比同时在流动 ——
 * 「价格变动」（`(exit − entry) / entry`）与「对保证金的收益率」
 * （`unrealizedPnl / marginUsed`）。它们**长得一模一样，而数值差一个杠杆倍数**。
 *
 * 实测代价（2026-09-22，持仓 `#95` XRPUSDT 5x）：复盘回执把保证金口径的
 * 「最大浮盈 3.146%」与价格口径的「价格变动」印在**相邻两行**、两边都没写口径 ——
 * 模型于是把 3.146% 当成价格涨幅，反算出 **1.5606** 这个**从未出现的价格**
 * （那 55 分钟里真实最高是 1.5318），并据此写下「浮盈触达目标价区却没兑现」的结论。
 * 而那张止盈单（1.5565）**从来没有被触及过**，它的表现完全正常。
 *
 * 恒等式：`marginUsed = notional / leverage`，所以逐仓下
 * `对保证金的收益率 = 价格变动% × leverage`（精确，不是近似）。
 */
export function marginPercentToPricePercent(percentOnMargin: number, leverage: number): number {
  return Number.isFinite(leverage) && leverage > 0 ? percentOnMargin / leverage : percentOnMargin;
}

export interface OrderRecord {
  id: number;
  traderId: number;
  exchangeOrderId: string | null;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'adjustment';
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  status: string;
  avgPrice: number | null;
  filledQty: number;
  fee: number;
  error: string | null;
  /**
   * 这张单**对应占用的保证金**（USDT 本金）—— 与 `PositionView.marginUsed` 同名同义。
   *
   * 口径 = `|价 × 量| ÷ 杠杆`，两种情形：
   *
   *   · **开仓 / 加仓单**：这一笔**自己**的保证金，即下单那一刻写进
   *     `positions.margin_used` 的同一个数（同一个 `marginOf()`）；
   *   · **平仓 / 止损 / 止盈 / 保护单**：它所属**那张持仓**当时占用的保证金。
   *     这些行上没有成交价（条件单只有触发价），自己重算只会算出另一个口径的数，
   *     所以取持仓行的权威值（`positions.margin_used`）。
   *
   * 也就是说它是"**这一行涉及的仓位压了多少本金**"，而不是"这一张单锁了多少"——
   * 被拒的订单本身当然什么都没锁。
   *
   * ⚠️ **拿不到就是 `undefined`**（界面显示 `—`），**绝不是 `0`**：
   * `0` 会被读成"这笔没占保证金"，那是另一句话。缺失出现在：被拒的开仓单、
   * 没有对应本地持仓的订单、算不出来的名义价值（见 `M13_ORDER_MARGIN_USED`）。
   */
  marginUsed?: number;
  /**
   * 这张单所属标的的**杠杆倍数**（`positions.leverage`）。
   *
   * ## 为什么要有它（2026-10-03，用户指出"倒反天罡"）
   *
   * 用户的原话：「**开仓为什么不显示杠杆？止盈止损却显示杠杆（止盈止损按道理是
   * 不应该显示才对？）倒反天罡了？**」
   *
   * 他说的两件事都对：
   *
   *   · 界面原来按**标的的当前持仓**读音杠杆，而那份列表来自**交易所的真实持仓** ——
   *     挂单还没成交、交易所没有持仓，于是**开仓单读不到、显示 `—`**；
   *   · 保护单（止损 / 止盈）确实属于一个已存在的仓位，反而"读得到"。但
   *     **"杠杆"是仓位的属性，不是那张条件单的属性** —— 在保护单那一行显示 `3x`
   *     会让人以为"这张止损单是 3 倍杠杆"。
   *
   * 所以改由**订单自己带上**这个读数：数据源是本地 `positions`，它**含 `pending`
   * 行**（挂单在系统里是有持仓行的，那张行上就记着杠杆）。
   *
   * 展示规则由界面决定：**只有开仓单显示**（保护单显示 `—`）—— 见
   * `TraderTables.LeverageCell`。
   *
   * ⚠️ **拿不到就是 `undefined`**（界面 `—`），不补默认值 —— 与「保证金模式」列
   * 同一条约定：没读到就画 `—`，不要编一个 1x 或 5x。
   */
  leverage?: number;
  /**
   * 这一行**下单时**该标的的保证金模式（全仓 / 逐仓）—— 落库字段
   * （`orders.margin_type`，迁移 `M14_ORDER_MARGIN_TYPE`）。
   *
   * ## 它的口径
   *
   * 由 `AutoTrader.recordOrder()` 写入：取**本进程最近一次成功应用到该标的**的模式
   * （`setMarginType()` 只有拿到交易所的 ok 才记进 `marginSet`），也就是交易所当时
   * **确认过**的配置。它**不是**从交易所重新读回来的"当前值"。
   *
   * ## ⚠️ 三种取不到的情形 —— 都是 `undefined`（界面显示 `—`），绝不默认成 `'cross'`
   *
   *   · **迁移 v14 之前的历史行**：这一列当时还不存在，读出来是 `NULL`；
   *   · **该标的的模式在这台进程里从未成功设过**：仓位是本进程启动前建的，
   *     或 `setMarginType` 被 `-4048`（该标的有持仓/挂单时不能改模式）挡回来；
   *   · 绕过仓储直接写 SQL 的行。
   *
   * 币安的默认是全仓，但那是"默认"，不是"这一行的事实" —— 补一个 `'cross'` 就是编数
   * （与 `marginUsed` / `M13_ORDER_MARGIN_USED` 同一条纪律）。
   *
   * ## 界面上的兜底：`PositionView.marginType`
   *
   * 订单记录的表格在这一个字段缺失时，会拿该 symbol **当前持仓**的模式顶上去。
   * 两者口径不同（一个是历史、一个是当前），所以界面**只在缺值时**用它，
   * 并且把它标成"当前账户配置"而不是这张单的历史 —— 见 `orderMarginMode()`。
   */
  marginType?: MarginMode;
  createdAt: string;
  updatedAt: string;
}

export interface TradeRecord {
  id: number;
  traderId: number;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  /**
   * **Gross** realised PnL — the exchange's own `realizedPnl`, before costs.
   *
   * This comment previously read "net of fees", which was simply untrue and is
   * the kind of documentation error that teaches every caller a wrong
   * assumption. Costs live in `entryFee`/`fee`/`fundingFee`; use `netPnl` for
   * what the trade actually contributed to the account.
   */
  pnl: number;
  /** Opening-leg commission. */
  entryFee: number;
  /** Closing-leg commission. */
  exitFee: number;
  /** `entryFee + exitFee`. Kept for display convenience. */
  fee: number;
  /** Funding paid or received while the position was open. */
  fundingFee: number;
  /**
   * `pnl − fee + fundingFee`: the real change to the account balance.
   *
   * ⚠️ **资金费是"加"，不是"减"** —— `fundingFee` 本身**带符号**（支付为负、
   * 收取为正），所以恒等式里它是加上去的。这里原来写的是 `pnl − fee − fundingFee`
   * （`TraderStats.totalFunding` 那一处写的是对的），而**一条错符号的注释会教出
   * 第七份错实现** —— 这个项目已经为同一个符号问题踩过一次坑（见 `repositories.ts`
   * 里 `netPnlOf()` 的说明）。
   */
  netPnl: number;
  /** `netPnl` as a percentage of the margin committed. */
  pnlPercent: number;
  /** Why it closed. A stable machine code — see `CloseReason`. */
  closeReason: string;
  /**
   * Where the record came from.
   *
   * `bot` — booked live by the running cycle.
   * `reconciled` — recovered from the exchange's fill history, because the
   * position closed while the process was not running. Both are legitimate, but
   * a reconciled trade is the signal that live bookkeeping missed something.
   */
  source: 'bot' | 'reconciled';
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  /**
   * 这一回合占用的保证金（USDT 本金）= `|entryPrice × quantity| ÷ leverage`。
   *
   * 与 `OrderRecord.marginUsed` 同名同义，派生字段（不落库）：三个输入都在这一行上，
   * 而它必须与建仓那一刻写进 `positions.margin_used`、以及 `pnlPercent` 的
   * 分母是**同一个数** —— 三处共用 `marginOf()`。
   *
   * ⚠️ **算不出来时是 `undefined`**（界面显示 `—`），**不是 `0`** —— 见
   * `OrderRecord.marginUsed` 的说明。
   */
  marginUsed?: number;
  /**
   * 这一回合的**保证金模式**（`cross` = 全仓、`isolated` = 逐仓）。
   *
   * ⚠️ **它是从入场订单那一行 join 出来的**（`orders.margin_type`），不是 `trades`
   * 自己的列 —— `trades` 没有、也不需要这一列：一张成交的保证金模式与它入场时
   * 下单那一刻的账户配置是同一件事，重复落库只会多一处可能不一致的地方。
   *
   * 与 `OrderRecord.marginType` 同一套语义与取值：
   *   · 迁移 v14 之前的入场订单没有记录 → `undefined`（界面显示 `—`）；
   *   · 补录的回合（`source === 'reconciled'`）可能没有匹配的本地订单行 → 同样 `undefined`；
   *   · **取不到就是取不到，绝不默认成 `'cross'`** —— 那等于编一个事实。
   */
  marginType?: MarginMode;
}

/**
 * Why a position was closed.
 *
 * These are **stable machine codes persisted in the database**, deliberately not
 * display text: translating them would rewrite history and make old rows
 * unreadable to the current UI. The console maps them to labels.
 */
export const CLOSE_REASONS = [
  'model_decision', // the model asked to close
  'stop_loss', // the exchange-side stop fired
  'take_profit', // the exchange-side target fired
  'drawdown_guard', // peak-profit giveback rule
  'liquidated', // liquidation or ADL
  'external', // closed outside the bot, reason unknown
  /*
   * 操作员在控制台上手工平的。
   *
   * **必须与 `model_decision` 分开**：那一个是 AI 的决定，这一个是人的决定。
   * 两者的绩效含义完全不同 —— 混在一起会让"这个策略表现如何"这个问题的答案里
   * 混进人的干预，而那正是操作员最需要分清的一件事。
   */
  'manual',
  /*
   * 部分平仓（减仓）。
   *
   * **与 manual 分开**：那一个是"把整个仓位平掉"，这一个是"卖掉一部分"。
   * 混在一起会让"减仓这个动作对这个策略是好是坏"这个问题无法回答 ——
   * 而它恰恰是最需要单独衡量的一类决策。
   */
  'manual_partial',
  /*
   * Entered, but the exchange-side stop could not be established — so the
   * position was market-closed to avoid holding a naked leveraged exposure.
   *
   * A distinct code on purpose: this close is a **cost** the runtime chose to
   * pay, and an operator needs to see how often it happens. Folding it into
   * `external` or `stop_loss` would hide the fact that the entry and the
   * protection disagreed about price.
   */
  'protection_unavailable',
  /*
   * Recovered from the exchange's fill history rather than observed live.
   *
   * A distinct code on purpose: the position certainly closed, but the process
   * was not running to see *which* order did it. Labelling it `stop_loss` or
   * `take_profit` would be inventing a fact, and it would hide the operational
   * signal that live bookkeeping missed a close.
   */
  'reconciled',
  /*
   * 补录的一个回合，但**重建出来的方向字段不可信** —— 金额取自交易所流水。
   *
   * ## 为什么与 `reconciled` 分开
   *
   * 两者描述的不是同一件事：
   *
   *   · `reconciled` —— 重建结果可信（方向、数量、价格都对得上），
   *     只是**进程当时没在跑**，所以没观察到是哪张单平的；
   *   · `reconciled_reversed` —— 重建**对不上**：本地记的方向与交易所流水相反
   *     （典型成因是重建窗口从持仓中间截断，把开/平判反）。
   *     这时**只有金额是可信的**（取自 `income` 流水），方向与价格是推测。
   *
   * 分开的理由与 `manual` / `manual_partial` 那两条一致：把两种可信度不同的
   * 记录混成一个码，会让"这条账目有多可信"这个问题失去答案 ——
   * 而复盘时操作员恰恰需要把"方向可信的补录"与"只信金额的补录"分开看。
   *
   * ⚠️ **加这个码时漏登记进 `CLOSE_REASONS` 曾是一个真实缺陷**（外部 issue #138）：
   * 写入点 `autoTrader.ts` 早就用它了，而本名单与 `CLOSE_REASON_LABELS` 都没有，
   * 于是控制台把它渲染成**未翻译的英文机器码**。`domain.test.ts` 现在有一条
   * 穷尽用例遍历本名单，确保将来新增的码不会再漏标签。
   */
  'reconciled_reversed',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * Chinese labels for the close-reason codes.
 *
 * Lives in the shared package because three layers render it: the server log
 * lines, the prompt sent to the model, and the console. Keeping one map means a
 * new reason cannot be added without every surface picking it up.
 */
export const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  model_decision: '模型主动平仓',
  stop_loss: '触发止损',
  take_profit: '触发止盈',
  drawdown_guard: '回撤守卫平仓',
  liquidated: '爆仓',
  external: '外部平仓',
  protection_unavailable: '保护单缺失（已立即平仓）',
  /*
   * ⚠️ **不是「对账补录」。** 那个词描述的是**系统怎么知道的**（从交易所成交
   * 历史核对出来），而不是**发生了什么** —— 而对着一张成交列表的人要知道的
   * 是后者。「补录」还会让人以为账本出过错（确实出过一次：运行中触发的止损
   * 曾被记成这个来源，那个 bug 已经修了），于是正常情况看起来像故障。
   *
   * 事实是：**机器人没在运行的时候，交易所侧的止盈或止损被触发了**。
   * 成交与盈亏都取自交易所的成交历史，是真实记录。
   */
  reconciled: '机器人未运行时平仓',
  /*
   * ⚠️ **措辞要同时说清「可信的部分」与「不可信的部分」。**
   *
   * 这一行与上面 `reconciled` 的区别只有一点：**方向字段是重建出来的、不可信**，
   * 而金额取自交易所流水（`income`）所以是准的。
   *
   * 所以标签不能只说"补录"（那与 `reconciled` 没区别，操作员分不出两者），
   * 也不能只说"方向不可信"（那会让人以为整条账目都不可信，
   * 而金额恰恰是可信的、账目是对的）。两句都要有。
   */
  reconciled_reversed: '补录·方向不可信（金额取自交易所流水）',
  manual: '手工平仓',
  manual_partial: '减仓（部分平仓）',
};

/**
 * Label for a close reason, falling back to the raw code rather than blank.
 *
 * ## ⚠️ 传 `netPnl` 之后，「触发止损」会被分成两种说法
 *
 * 实测一次真实的困惑：操作员看到两笔成交显示 **盈利**，而平仓原因写着
 * **「触发止损」**，于是判断这是自相矛盾的 bug。而数据两边都对：
 *
 *     ETHUSDT  入场 2634.32  止损位 2660（在成本**之上**）  触发时 +0.17
 *     BNBUSDT  入场 775.11   止损位 778.6（在成本**之上**）  触发时 +0.03
 *
 * 那两笔确实**触发了止损单**，而止损位已经被 `adjust_protection` **上移到成本价之上**
 * —— 触发的结果就是保本或小赚离场。**这是提示词明确要求它做的事**
 * （"把止损提到成本价或更高，等于把这笔交易变成最坏情况不亏"），
 * 是专业做法，不是异常。
 *
 * 问题只在措辞：「触发止损」在中文里天然等于"亏了"。所以调用方**知道盈亏时**
 * 应当把它传进来 —— 那样同一次触发会按结果说成两种话，而且两种都准确。
 *
 * 不传也仍然可用（返回通用的"触发止损"）：有些调用点只拿到机器码
 * （比如日志行、提示词里回放历史），那时宁可用宽泛的说法，也不该猜。
 */
export function closeReasonLabel(code: string, netPnl?: number | null): string {
  /* 入参保持 string：库里可能读到迁移前留下的、或状态码表之后新增的值。 */
  const base = CLOSE_REASON_LABELS[code as CloseReason] ?? code;
  /*
   * 只在**止损**这一类上分叉。止盈触发本来就只会赚钱，不需要区分；
   * 其它原因（模型主动平、回撤守卫、爆仓…）与"止损"这个词无关。
   */
  if (code === 'stop_loss' && typeof netPnl === 'number' && netPnl > 0) {
    return '移动止损（保本离场）';
  }
  return base;
}

/**
 * Chinese labels for trader status codes.
 *
 * Same reasoning as `CLOSE_REASON_LABELS` above, and the same trap: `status` is
 * a **machine code persisted in the database** (`traders.status`), so the stored
 * value must never be translated — only what the operator reads.
 *
 * This map used to live inside the badge component, which meant anything outside
 * that component rendered the raw code. A status event therefore surfaced to the
 * operator as:
 *
 *     机器人 #6 → stopped
 *
 * That is not a cosmetic problem: `stopped` is also what a deliberate operator
 * stop writes, so an English word was the only thing distinguishing "the bot was
 * stopped" from any other status. Putting the map in the shared package means a
 * new status cannot be added without every surface picking up a label.
 */
export const TRADER_STATUS_LABELS: Record<TraderStatus, string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '异常',
  safe_mode: '安全模式',
};

/** Label for a trader status, falling back to the raw code rather than blank. */
export function traderStatusLabel(status: string): string {
  return TRADER_STATUS_LABELS[status as TraderStatus] ?? status;
}

/**
 * Chinese labels for an order's purpose.
 *
 * Same rule as the maps above: `purpose` is persisted in `orders.purpose`, so the
 * **stored value never changes** — only what the operator reads. Before this map
 * existed the order toast rendered the raw code with its underscore swapped for a
 * space, so an operator saw `stop loss · BUY BTCUSDT` instead of
 * `止损 · 多 BTCUSDT`.
 */
export const ORDER_PURPOSE_LABELS: Record<string, string> = {
  entry: '开仓',
  exit: '平仓',
  stop_loss: '止损',
  take_profit: '止盈',
  adjustment: '调整',
};

export function orderPurposeLabel(purpose: string): string {
  return ORDER_PURPOSE_LABELS[purpose] ?? purpose;
}

/**
 * 运行时日志的**来源**，翻译成给操作员看的中文。
 *
 * ## 为什么需要它
 *
 * 日志正文前面原来拼着模块名：`[binance:bootstrap] connected to …`。
 * 那是**给开发者看的** —— 操作员看到 `binance:bootstrap` 不知道那是什么，
 * 看到 `main` 也不知道"主程序"在做什么。
 *
 * ## 与其它标签表同一条纪律
 *
 * 与 `CLOSE_REASON_LABELS` / `ORDER_PURPOSE_LABELS` 一样：
 * **存进库的永远是原码**（`scope` 列，筛选与排查靠它），
 * **翻译只发生在展示层**。翻译表变化不影响历史数据。
 *
 * 认不出的来源**原样显示** —— 不猜。将来有人加了新模块却忘了登记，
 * 界面会露出机器码，那是一个**看得见的提醒**，而不是一句编出来的中文。
 */
export const LOG_SCOPE_LABELS: Record<string, string> = {
  main: '主程序',
  api: '接口服务',
  auth: '登录鉴权',
  db: '数据库',
  store: '数据仓库',
  manager: '机器人管理',
  trader: '交易循环',
  'trader:agent': 'AI 智能体',
  llm: '语言模型',
  'llm:discovery': '模型探测',
  balance: '余额',
  'market:service': '行情服务',
  'binance:bootstrap': '币安 · 启动检查',
  'binance:account': '币安 · 账户',
  'binance:broker': '币安 · 下单',
  'binance:market': '币安 · 行情',
  'binance:rest': '币安 · 接口',
  'binance:ws': '币安 · 推送',
  'binance:userdata': '币安 · 用户数据流',
  'strategy:coins': '选币',
  'strategy:parser': '决策解析',
  'strategy:check': '策略体检',
  simulate: '模拟回放',
  'sim:exchange': '模拟交易所',
  smoke: '冒烟测试',
  'reset-admin': '重置管理员',
};

/** 日志来源的中文标签，认不出时**原样返回**。 */
export function logScopeLabel(scope: string | null | undefined): string {
  if (!scope) return '';
  return LOG_SCOPE_LABELS[scope] ?? scope;
}

/**
 * 日志**级别**的图标。
 *
 * ## 为什么用图标而不是文字
 *
 * 这一栏原来写「信息」/「警告」/「错误」—— 三个词都是一样的宽度，
 * 而**九成以上的日志是"信息"**。一列重复的"信息"占着地方，却什么也没告诉你。
 *
 * 图标占同样的宽度，但**形状本身就能扫**：`⚠️` 和 `❌` 在余光里就认得出来，
 * 而"警告"和"错误"两个字必须逐个读。
 *
 * **图标不替代颜色**：颜色是给"扫一眼"的，图标是给"看清是什么"的，
 * 文字标签留在 `title` 里给屏幕阅读器与新用户。
 *
 * ⚠️ **`info` 刻意用一个小圆点而不是 `ℹ️`。**
 * 它出现得最多，而一个信息量很低的行不该抢走注意力 ——
 * **满屏图标和没有图标是一回事**：都会让人停止阅读。
 */
export const LOG_LEVEL_ICONS: Record<string, string> = {
  info: '·',
  warn: '⚠️',
  error: '❌',
};

/**
 * 日志来源的**图标**，按模块归类。
 *
 * 这一层比中文标签更早被眼睛抓住：`🔌` 是交易所的事、`🧠` 是 AI 的事、
 * `💾` 是存储的事 —— **一眼就能把"哪个子系统在说话"分开**，
 * 而读「币安 · 启动检查」要慢一步。
 *
 * 与标签表同一条纪律：认不出的来源**不给图标**（返回空串），不猜。
 */
export const LOG_SCOPE_ICONS: Record<string, string> = {
  main: '🚀',
  api: '🌐',
  auth: '🔑',
  db: '💾',
  store: '💾',
  manager: '🤖',
  trader: '🔄',
  'trader:agent': '🧠',
  llm: '🧠',
  'llm:discovery': '🔍',
  balance: '💰',
  'market:service': '📈',
  'binance:bootstrap': '🔌',
  'binance:account': '💰',
  'binance:broker': '📤',
  'binance:market': '📈',
  'binance:rest': '📡',
  'binance:ws': '📡',
  'binance:userdata': '📥',
  'strategy:coins': '🎯',
  'strategy:parser': '📋',
  'strategy:check': '🩺',
  simulate: '🎬',
  'sim:exchange': '🎬',
  smoke: '🧪',
  'reset-admin': '🔑',
};

/**
 * 来源的**类别**，用来决定标签配色。
 *
 * 与币种着色同一条纪律：**颜色是辅助定位，身份由图标与文字承担。**
 * 所以认不出的来源归入 `other`，而不是随便挑一个颜色 ——
 * **一个猜出来的颜色比没有颜色更容易误导。**
 */
export type LogScopeKind = 'exchange' | 'ai' | 'data' | 'runtime' | 'other';

export function logScopeKind(scope: string | null | undefined): LogScopeKind {
  if (!scope) return 'other';
  if (scope.startsWith('binance:')) return 'exchange';
  if (scope === 'llm' || scope.startsWith('llm:')) return 'ai';
  /*
   * ⚠️ **类别表要覆盖全部已知来源。**
   *
   * 第一版只列了 exchange / ai / data / runtime 四类的少数几个，
   * 于是 `trader`（交易循环）、`manager`（机器人管理）、`trader:agent`
   * 这些最常出现的来源全部落进 `other` —— **界面上全是一个颜色**，
   * 而"按类别配色"这件事等于没做。
   *
   * 漏掉的不会报错，只会让配色退化成灰色 —— **一个静默失效的视觉设计**。
   */
  if (scope === 'trader:agent' || scope.startsWith('strategy:')) return 'ai';
  if (scope === 'db' || scope === 'store') return 'data';
  if (scope === 'main' || scope === 'api' || scope === 'auth' || scope.startsWith('reset-')) {
    return 'runtime';
  }
  /* 交易循环、机器人管理、行情服务、模拟与测试 —— 都属"运行时"。 */
  if (
    scope === 'trader' ||
    scope === 'manager' ||
    scope === 'balance' ||
    scope.startsWith('market:') ||
    scope === 'simulate' ||
    scope.startsWith('sim:') ||
    scope.endsWith(':check') ||
    scope === 'smoke'
  ) {
    return 'runtime';
  }
  return 'other';
}

/* -------------------------------------------------------------------------- */
/*  智能体审计：三类机器码的中文标签                                            */
/* -------------------------------------------------------------------------- */
/*
 * ## 为什么需要这三张表（用户实测，2026-10-17）
 *
 * 用户截图指出「**智能体审计里面出现英文字符（整个前端UI都应该是中文表述）**」，
 * 屏幕上看到的是 `strategy` / `idle` / `timeout` / `new result` / `ok` / `failed`。
 *
 * 那**不是**"机器契约用了英文"—— 那三个码（`agent_runs.kind` / `.trigger` /
 * `.outcome`）存进库时本来就该是英文，这一点没有错。错的是**它们被直接渲染到了
 * 界面上，而没有经过一次「码 → 中文标签」的映射**。
 *
 * ## 与其它标签表同一条纪律（照抄 `LOG_SCOPE_LABELS` 上方那段）
 *
 * 与 `CLOSE_REASON_LABELS` / `TRADER_STATUS_LABELS` / `ORDER_PURPOSE_LABELS` /
 * `LOG_SCOPE_LABELS` 一样：**存进库的永远是原码**（`kind` / `trigger` / `outcome`
 * 三列，筛选与排查靠它），**翻译只发生在展示层**。
 * 翻译表变化不影响历史数据；认不出的码**原样显示** —— 不猜。
 *
 * ## 为什么放在 `@aq/shared` 而不是面板组件里
 *
 * 与 `TRADER_STATUS_LABELS` 同一个理由（那张表的注释里写着"以前这张表住在徽章
 * 组件里，于是组件之外的任何地方都渲染裸码"）：这三列将来还会被服务端日志、
 * 提示词、以及别的界面复用。表在 shared，**漏一个取值就编译不过**（下面的
 * `Record<联合类型, string>`），而不是等用户在截图上发现。
 *
 * ## ⚠️ 这三张表的穷尽性由两层一起守（t61 之后）
 *
 * **类型层**：`kind` 与 `trigger` 在服务端的**写入点**已经收窄成联合类型
 * （`orchestrator.ts` 的 `recordRun` / `recordExperiment` 收 `AgentRunKind` /
 * `WakeTrigger`，`agentStore.ts` 的 `insert()` 同样收窄）。所以"服务端加了一个
 * 新码"这件事**在写入点就编译不过** —— 那才是根治。
 *
 * 这段注释原先写的是「服务端端口签名被放宽成了 `string`，所以类型层拦不住，
 * 那半边的收口归服务端任务」——**那个任务（t61）已经做完了**，留着旧话会让
 * 下一个人以为这道闸还没接上，从而去加一层多余的运行时校验。
 *
 * **测试层**：`agentRunLabels.test.ts` 用**源码一致性守卫**兜住"重抄的两份名单
 * 会不会分叉" —— 服务端新增一个 `WakeTrigger` / `outcome` 取值而这里没跟上，
 * 测试当场变红（因为 `@aq/shared` 不能反向依赖服务端包，名单只能重抄一份）。
 */

/**
 * `agent_runs.kind` 的**已知取值**。
 *
 * ⚠️ **它是这一列的类型权威**（t61 之后）：服务端的写入点与存储层行类型都
 * 从这里取类型（`orchestrator.ts` 的 `recordRun`、`agentStore.ts` 的
 * `AgentRunRow` 与 `insert()`），所以往写入点塞一个未登记的 `kind`
 * **会当场编译不过** —— 本文件就是那个"名单"。
 *
 * 两个生产写入点都是 `kind: 'strategy'`（`orchestrator.ts` 的 `recordRun` 两处：
 * 策略师一条、每个分析角色各一条）。`team_cycle` / `review` 是**别的调用形态**
 * （夹具与历史记录里出现过，`traderDelete.test.ts` 就写了 `kind: 'review'`）——
 * 一并登记，这样它们上屏时也是中文，而不是靠兜底露码。
 */
export const AGENT_RUN_KINDS = ['strategy', 'team_cycle', 'review'] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

/**
 * `agent_runs.kind` 的中文标签。
 *
 * `Record<AgentRunKind, string>` 而不是 `Record<string, string>`：**漏一个取值
 * 就编译不过**（与 `TRADING_MODE_LABELS` / `MODE_LABEL` 同一条纪律）。
 */
export const AGENT_RUN_KIND_LABELS: Record<AgentRunKind, string> = {
  strategy: '策略轮',
  team_cycle: '团队轮',
  review: '复盘轮',
};

/** 智能体运行类型的中文标签，**认不出的码原样返回**（不猜）。 */
export function agentRunKindLabel(kind: string): string {
  return AGENT_RUN_KIND_LABELS[kind as AgentRunKind] ?? kind;
}

/**
 * 唤醒**触发原因**的取值（`agent_runs.trigger`）。
 *
 * ## 这份名单必须与服务端的 `WakeTrigger` 逐字一致
 *
 * 权威定义在 `packages/server/src/trader/agent/wake.ts`（`export type WakeTrigger`）。
 * 这里**重抄一份**是因为 `@aq/shared` 不能反向依赖服务端包（依赖方向是单向的）。
 * 代价是"两份名单会分叉"—— 而这个代价由 `agentRunLabels.test.ts` 的一条
 * **源码一致性守卫**抵掉：它读服务端的那个 `export type`，把成员抽出来与这里
 * 逐字比对。服务端加一个触发原因而这里没跟上 → **测试变红**，而不是等用户在
 * 截图上看到一个新英文词。
 */
export const WAKE_TRIGGERS = [
  'new_result',
  'losing_streak',
  'drawdown',
  'rejections',
  'timeout',
  'idle',
  'manual',
  'none',
] as const;
export type WakeTrigger = (typeof WAKE_TRIGGERS)[number];

/**
 * 唤醒原因的中文标签。
 *
 * ## ⚠️ 措辞必须与 `wake.ts` 里那条分支的真实语义对齐
 *
 * 标签是给操作员读的，而**读错标签比读英文码更糟**（英文码至少不会骗人）。
 * 三处刻意不照字面直译：
 *
 * · `drawdown` —— 那条分支的触发条件是"权益相对上次判断变化超过阈值"，
 *   而它**既覆盖回撤也覆盖新高**（`wake.ts` 的 `why` 里两种情形都写了）。
 *   写成"回撤触发"会让一个因新高而醒的轮次被读成"账户在亏"。
 * · `timeout` —— 它是**防饿死的兜底**（"即使没有新事件也要审视一次"），
 *   不是某种调用超时。写成"超时"会让人去查一个不存在的故障。
 * · `none` —— 它是"**没有值得唤醒的事件**"，而不是"唤醒了但没触发原因"。
 */
export const WAKE_TRIGGER_LABELS: Record<WakeTrigger, string> = {
  new_result: '成交后唤醒',
  losing_streak: '连续亏损',
  drawdown: '权益显著变化',
  rejections: '被拒过多',
  timeout: '兜底唤醒',
  idle: '长时间没开仓',
  manual: '人工触发',
  none: '未触发',
};

/** 唤醒原因的中文标签，**认不出的码原样返回**（不猜）。 */
export function wakeTriggerLabel(trigger: string): string {
  return WAKE_TRIGGER_LABELS[trigger as WakeTrigger] ?? trigger;
}

/**
 * `agent_runs.outcome` 的取值（服务端 `LoopResult['outcome']`）。
 *
 * 权威定义在 `packages/server/src/trader/agent/loop.ts`。同上，这里重抄一份并由
 * 守卫测试对着那个文件核对。
 */
export const AGENT_RUN_OUTCOMES = ['ok', 'degraded', 'failed'] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

/**
 * 运行结果的中文标签。
 *
 * ## ⚠️ `degraded` 不得译成「失败」
 *
 * `loop.ts` 的注释把三者分得很清楚：
 *
 * ```
 *   ok       —— 模型自己调了 finish，这是一个【结论】
 *   degraded —— 撞上步数上限，【没有结论】，只是停下来了
 *   failed   —— 模型输出坏掉且无法恢复
 * ```
 *
 * 把 `degraded` 写成"失败"会让操作员以为这一轮坏了（该去查），而真相是
 * "它烧完了步数预算、还没来得及给结论"—— 两种情形的处置完全不同
 * （后者该放宽步数预算或精简必读清单）。
 * 所以标签直接说清"没有结论"，而不是给一个笼统的褒贬词。
 */
export const AGENT_RUN_OUTCOME_LABELS: Record<AgentRunOutcome, string> = {
  ok: '已得出结论',
  /*
   * ⚠️ 用**逗号**而不是括号：面板会在标签后面再跟一个 `（原码）`，
   * 写成「未跑完（撞步数上限）」渲染出来就是双括号
   *「未跑完（撞步数上限）（degraded）」—— 实测看到的，读起来很啰嗦。
   */
  degraded: '未跑完，撞到步数上限',
  failed: '失败',
};

/** 运行结果的中文标签，**认不出的码原样返回**（不猜）。 */
export function agentRunOutcomeLabel(outcome: string): string {
  return AGENT_RUN_OUTCOME_LABELS[outcome as AgentRunOutcome] ?? outcome;
}

/**
 * 交易所拒单错误的**中文人话**。
 *
 * ## 为什么需要它
 *
 * 订单记录里原本直接显示原始字符串：
 *
 *     Binance -4130: An open stop or take profit order with GTC...
 *     Binance -4164: Order's notional must be no smaller than ...
 *
 * **那是给开发者看的，不是给操作员看的。** 操作员看到的是英文技术报错，
 * 既不知道发生了什么、也不知道该不该动手 —— 而这一栏存在的唯一意义
 * 就是回答那两个问题。
 *
 * ## 与其它标签表同一条纪律
 *
 * 与 `CLOSE_REASON_LABELS` / `ORDER_PURPOSE_LABELS` 一样：**存进库的永远是
 * 交易所原码原话**（诊断要靠它），**翻译只发生在展示层**。
 * 翻译表变化不影响历史数据。
 *
 * ## 只翻译**已知**的码
 *
 * 认不出的码原样显示并保留原始信息 —— `-4130` 这种是实测撞出来的，
 * 而**猜一个不认识的错误码的含义比不翻译更糟**：它会让操作员
 * 按错误的理解去处理。
 */
export const EXCHANGE_ERROR_LABELS: Record<string, string> = {
  '-4130': '该仓位已有止损或止盈单，不能重复挂 —— 要改价格必须先撤掉原来那张。',
  '-4164': '订单名义价值低于交易所要求的最小值（币安合约约 5 USDT）。',
  '-4120': '这类订单必须走条件单接口，普通下单接口不接受。',
  '-1111': '价格或数量的精度不符合该合约的要求（小数位过多）。',
  '-2019': '保证金不足，无法开仓。',
  '-2021': '触发价会立即成交，交易所拒绝受理。',
  '-2010': '下单被交易所拒绝（通常是余额或参数问题）。',
  '-1003': '请求过于频繁，被交易所限流。',
  /*
   * 双向持仓模式与单向持仓模式的 `positionSide` 对不上。
   *
   * 这一条原来是缺的，所以界面上显示的是交易所的英文原文 ——
   * 而它是**操作者最需要看懂的一条**：它不是"这一笔没成功"，
   * 而是"整个机器人在这个模式下完全下不了单"（连平仓单都会被拒）。
   * 解法也不在机器人这边，而是要去交易所端把持仓模式改回来。
   */
  '-4061': '账户的持仓模式与订单不匹配 —— 双向持仓模式下必须指定多头/空头方向，而本机器人按单向模式下单。请到交易所端把持仓模式改回「单向持仓」。',
};

/** 从交易所错误串里取出错误码。`Binance -4130: ...` → `-4130`。 */
export function exchangeErrorCode(raw: string): string | null {
  const m = /(?:Binance\s+)?(-?\d{3,5})\s*:/.exec(raw);
  return m ? (m[1] as string) : null;
}

/**
 * 把交易所错误渲染成给操作员看的一句话。
 *
 * 认得出错误码时给出中文解释并**保留原始码**（排查要靠它）；
 * 认不出时原样返回，不猜。
 */
export function exchangeErrorLabel(raw: string): string {
  const code = exchangeErrorCode(raw);
  if (!code) return raw;
  const explained = EXCHANGE_ERROR_LABELS[code];
  if (!explained) return raw;
  return `${explained}（${code}）`;
}


/**
 * Chinese labels for exchange order status codes.
 *
 * These are Binance's own values (`NEW` / `FILLED` / …). They stay English in the
 * database and in the API — the console is the only place they get translated,
 * and unknown values fall through unchanged so a new status is never hidden.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  NEW: '已挂单',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '已成交',
  CANCELED: '已撤销',
  CANCELLED: '已撤销',
  REJECTED: '已拒绝',
  EXPIRED: '已过期',
  EXPIRED_IN_MATCH: '已过期（撮合中）',
  /*
   * 补进来的原因：控制台的"终态"集合（`TraderTables.tsx` 的 `TERMINAL_STATUSES`）
   * 里一直有它，标签表却没有 —— 于是同一列里 `EXPIRED_IN_MATCH` 是中文、
   * 它是英文原码。一边中文一边英文比全英文更难读。
   */
  EXPIRED_IN_FUTURES: '已过期（期货）',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * Chinese labels for order types.
 *
 * `STOP_MARKET` / `TAKE_PROFIT_MARKET` are the conditional types the broker
 * routes to `/fapi/v1/algoOrder`; an operator reading a table should not have to
 * know that.
 */
export const ORDER_TYPE_LABELS: Record<string, string> = {
  LIMIT: '限价',
  MARKET: '市价',
  STOP: '止损限价',
  STOP_MARKET: '止损市价',
  TAKE_PROFIT: '止盈限价',
  TAKE_PROFIT_MARKET: '止盈市价',
  TRAILING_STOP_MARKET: '移动止损',
};

export function orderTypeLabel(type: string): string {
  return ORDER_TYPE_LABELS[type] ?? type;
}

/**
 * Chinese labels for account roles.
 *
 * Same rule as the other label maps: the value is a machine code stored in
 * `users.role`, so only the display changes. It used to render raw in the
 * sidebar footer, which showed a bare English `owner` under the username.
 */
export const USER_ROLE_LABELS: Record<string, string> = {
  owner: '拥有者',
  user: '操作员',
};

export function userRoleLabel(role: string): string {
  return USER_ROLE_LABELS[role] ?? role;
}
/** Label for a trading mode. */
export const TRADING_MODE_LABELS: Record<TradingMode, string> = {
  conservative: '稳健',
  aggressive: '进取',
  scalping: '短线',
};

/**
 * Chinese labels for the coin-source machine codes.
 *
 * Same rule as the maps above: `coinSource.sourceType` is a stored contract value
 * (`static` / `coinpool` / `oi_top` / `mixed`) that must never be translated in
 * the database — only what the operator reads. This map did not exist, so the
 * strategy list rendered the **raw code**, and a Chinese console showed a bare
 * `mixed` in the 币种池 column. The editor had its own local copy of the same
 * four labels (`SOURCE_TYPES` in `StrategyFields.tsx`), which is exactly the
 * divergence the shared map exists to prevent.
 */
export const COIN_SOURCE_TYPE_LABELS: Record<CoinSourceType, string> = {
  static: '静态列表',
  coinpool: '动态币种池',
  oi_top: '持仓量领先',
  mixed: '混合（并集）',
  /*
   * **团队模式专用**：分层漏斗（全市场 → 流动性 → 波动区间 → 交给 AI）。
   *
   * 与 `coinpool` 的区别在**层数**：`coinpool` 是一次排序取前 N（一层），
   * 而漏斗是**多层**、且每层的淘汰都能解释（"你的币死在哪一层"）。
   */
  funnel: '分层漏斗（团队模式）',
};

export function coinSourceTypeLabel(sourceType: string): string {
  /* 入参保持 string —— 同 closeReasonLabel：库里可能读到未知值。 */
  return COIN_SOURCE_TYPE_LABELS[sourceType as CoinSourceType] ?? sourceType;
}

/**
 * One complete decision cycle. `systemPrompt` + `userPrompt` + `rawResponse`
 * make every trade fully reproducible after the fact — there is no position
 * without a paper trail.
 */
export interface DecisionRecord {
  id: number;
  traderId: number;
  cycleNumber: number;
  timestamp: string;
  systemPrompt: string;
  userPrompt: string;
  cotTrace: string;
  decisions: Decision[];
  rawResponse: string;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  success: boolean;
  error: string | null;
  /** Wall-clock cost of the model call, milliseconds. */
  aiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * `promptTokens` 里命中上下文缓存的部分。
   *
   * `null` = 服务商没报这个字段（**不知道**）；`0` = 报了，确实没命中。
   * 两者的结论完全相反 —— 前者该换供应商，后者该查提示词。
   */
  cachedTokens?: number | null;
  /** `completionTokens` 里花在思考上的部分。 */
  reasoningTokens?: number | null;
}

export interface ExecutionLogEntry {
  action: string;
  symbol: string;
  /**
   * `submitted` = **已挂单，尚未成交**（限价入场）。
   *
   * ## 为什么不能复用 `ok`
   *
   * `ok` 在生成摘要时被算作"开仓 N"（见 `summarizeExecution`）。而限价挂单
   * **这一轮没有产生持仓** —— 把它记成 `ok` 会让执行摘要说"开仓 1"，而界面上
   * 一个持仓都没有。那正是这个项目花了很多轮在消灭的那类矛盾：
   * **一个字段说"做成了"，另一个字段说"什么都没有"。**
   *
   * 状态名要说实话，摘要才可能说实话。
   */
  /*
   * ⚠️ **新增 `'data'`：它表示"模型主动要了数据"，不是一次交易动作。**
   *
   * ## 为什么不能复用 `'ok'`（2026-10-02）
   *
   * `'ok'` 在生成摘要时被算作"开仓 N"。而模型用 `get_klines` 取数是**纯读取** ——
   * 记成 `'ok'` 会让界面显示"开仓 1"而实际上一笔单都没下，
   * 那正是这个项目反复在消灭的矛盾：**一个字段说"做成了"，另一个字段说什么都没有。**
   *
   * ## 为什么它值得单独一类
   *
   * 用户 2026-10-02：「我打开网页，就能方便快捷**看到模型在做什么**」。
   * "它主动去要了数据"是**最直接的"它在主动工作"的证据** ——
   * 而在此之前它只活在实时事件流里，**翻历史一条都查不到**。
   */
  status: 'ok' | 'submitted' | 'rejected' | 'failed' | 'skipped' | 'data';
  detail: string;
  orderId?: string;
  /** Notional actually filled, when applicable. */
  notionalUsd?: number;
  /**
   * Every place the risk engine overruled the model for this decision.
   *
   * Structured rather than only embedded in `detail` so the console can list
   * them, and so a test can assert that clamping actually happened instead of
   * pattern-matching a sentence.
   */
  adjustments?: string[];
}

/**
 * 某个机器人在某一时刻的权益快照。
 *
 * `equity` 是**归属**权益（`initialEquity + Σ net_pnl + 自己的浮盈`），不是钱包
 * 余额。同一个交易所账户下可以跑多个机器人，它们共用一份凭据、共用一个钱包，
 * 所以钱包余额对它们全都是同一个数 —— 把它写进这里会让一个从未成交的机器人显示
 * 别的机器人挣来的收益率，也会让一个已停止的机器人的数字随着邻居交易而变。
 * 账户（共享钱包）的权益另存 `accountEquity` / `accountUnrealizedPnl`。
 */
export interface EquitySnapshot {
  traderId: number;
  timestamp: string;
  /**
   * 归属权益：**本机器人自己的交易**挣来的那部分。
   *
   * `initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈`。机器人没成交时
   * 就等于 `initialEquity`（平的），停止后不再变化。
   */
  equity: number;
  /**
   * 账户的可用余额。
   *
   * 它和 `marginUsed` 都是**账户级**的量：自由保证金是共享钱包的属性，按机器人
   * 拆分没有意义（交易所也不提供这个口径）。保留在这里是为了记录快照当时的账户
   * 状态，不要把它当成"这个机器人的可用余额"。
   */
  availableBalance: number;
  /** 本机器人自己持仓的浮动盈亏，不是账户的总浮盈。 */
  unrealizedPnl: number;
  /** 账户级：被持仓与挂单占用的初始保证金。 */
  marginUsed: number;
  /** 本机器人自己的未平仓合约数。 */
  openPositions: number;
  /** 账户（共享钱包）的权益 —— `totalMarginBalance`，同一账户下所有机器人共用。 */
  accountEquity: number;
  /** 账户的总浮动盈亏，用于对账展示；风控高水位读的是 `accountEquity − accountUnrealizedPnl`。 */
  accountUnrealizedPnl: number;
}

export interface TraderStats {
  traderId: number;
  /**
   * 归属权益（默认口径）：`initialEquity + realizedPnl + unrealizedPnl`。
   *
   * 不是账户余额 —— 见 `accountEquity`。
   */
  equity: number;
  initialEquity: number;
  totalReturnPercent: number;
  realizedPnl: number;
  /**
   * Gross realised PnL before costs — the sum of the exchange's own
   * `realizedPnl` per round-trip.
   *
   * `realizedPnl` above is the **net** figure; this is the other half of the
   * breakdown so the console can show where the money went.
   */
  grossRealizedPnl: number;
  /** Total commission paid, both legs of every round-trip. */
  totalFees: number;
  /** Total funding paid (negative) or received (positive). */
  totalFunding: number;
  unrealizedPnl: number;
  /**
   * 该机器人所属**交易所账户**（共享钱包）的权益，来自最近一条快照。
   *
   * 之所以单独给出而不是让界面用 `equity` 顶替：同一账户下的多个机器人读数是
   * 同一个数，混在一起就没法分辨"这个机器人挣了多少"和"账户里有多少钱"。
   * 没有快照时为 0。
   */
  accountEquity: number;
  totalTrades: number;
  /**
   * Winning trades as a **percentage in 0–100**, not a 0–1 fraction.
   *
   * Named with the unit on purpose. The field used to be called `winRate` with
   * no unit, the server returned a percentage while three console pages assumed
   * a fraction, and each multiplied by 100 again — one win out of one trade
   * rendered as **10000.0%**. A name that carries its unit makes that class of
   * mistake impossible to reintroduce silently.
   */
  winRatePercent: number;
  /** Closed trades that finished in profit. */
  wins: number;
  /**
   * Closed trades that did not.
   *
   * Sent explicitly rather than derived on the client from `winRatePercent`,
   * which is lossy: rounding a percentage back into a count is how "1 trade"
   * became "100 盈".
   */
  losses: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPercent: number;
  sharpeRatio: number | null;
  bestTrade: number;
  worstTrade: number;
  openPositions: number;
  cyclesRun: number;
  uptimeHours: number;
}

/**
 * 熔断的两种类型。**它们的解除方式完全不同，不能用一个布尔值概括。**
 *
 *   · `daily_loss`     —— 按单日结算，跨过零点自动恢复
 *   · `total_drawdown` —— **没有"按日"这个概念**：它比较的是历史最高水位与当前
 *     权益，要等权益涨回门槛以内才解除。**空仓时权益不会自己变化，所以它不会
 *     自行恢复** —— 需要操作员处理
 */
export type CircuitBreakerKind = 'daily_loss' | 'total_drawdown' | 'none';

/**
 * 熔断器在某一时刻的读数。
 *
 * ## 它为什么不挂在 `TraderStats` 上
 *
 * `TraderStats` 是**仓储层**算出来的纯统计（它只读数据库）。而熔断读数依赖
 * **运行时真实生效的那份配置**（AI 托管下它来自 `traders.agent_config_json`，
 * 与策略表里的那份可能不同）与**进程内的最新权益** —— 让仓储去重算它，
 * 既多两次查询，又可能算出与交易循环不一致的答案。
 *
 * 所以它由 API 层从运行时组装，与 `/stats` 的响应合并（见 `GET /api/traders/:id/stats`）。
 */
export interface CircuitBreakerReading {
  blocked: boolean;
  kind: CircuitBreakerKind;
  /** 面向操作员的一句话：为什么被拦。`blocked` 为假时是空串。 */
  reason: string;
  /** 当前权益较历史最高水位回撤了多少（**0–100 的百分数**，不是小数）。 */
  drawdownPercent: number;
}

/* -------------------------------------------------------------------------- */
/*  Live event bus (server → browser)                                          */
/* -------------------------------------------------------------------------- */

/**
 * 服务端 → 浏览器的事件。
 *
 * ## ⚠️ `replay` —— "这是历史，不是刚发生"
 *
 * WebSocket 连接建立时，服务端会重放最近 30 条事件，**免得新打开的页面是空的**
 * （见 `server.ts` 的 `/api/events`）。那些事件**本来是几分钟甚至几小时前发生的**，
 * 而客户端原来把它们和实时事件一视同仁 —— 于是**每刷新一次页面，右下角就弹一轮
 * 「已平仓 ETHUSDT」「委托 · 平仓」的通知**，内容还是过时的。
 *
 * 一个每次刷新都误报的界面，等于训练操作员忽略通知 —— 而通知里本来该有
 * 「刚刚平了一笔」这种要及时看见的东西。
 *
 * 所以重放的事件带上这个标记：**数据照填**（持仓、权益、状态需要初值），
 * **但不触发通知、也不重复追加日志**。两类事件的差别不在内容，在**它们是不是
 * 刚刚发生的** —— 而那正是界面做不做提示的依据。
 */
type Replayable<T> = T & {
  /** 服务端在连接建立时重放的历史事件。**不要**为它弹通知或追加日志。 */
  replay?: true;
};

export type ServerEvent = Replayable<
  | { type: 'trader_status'; traderId: number; status: TraderStatus; detail?: string }
  | { type: 'cycle_start'; traderId: number; cycleNumber: number; timestamp: string }
  | { type: 'cycle_end'; traderId: number; cycleNumber: number; summary: string; success: boolean }
  /*
   * **一轮**内部**的实时步骤**（2026-10-10，用户提的观测需求）。
   *
   * 用户的原话：「智能模式下，每一期最近决策里面能展开（就像你 DSH 一样），
   * 能折叠实时显示当前步骤（默认是缩起来的，用户可以手动展开），
   * 这样用户可以手动展开看系统到底在做什么，也可以判断系统到底是否正常工作」。
   *
   * 它**不落库**：这是"现在在做什么"，只需要活到这一轮结束。
   * 落库的结论由 `decision` 那条事件给（它带 `executionLog`）。
   */
  | {
      type: 'cycle_step';
      traderId: number;
      cycleNumber: number;
      level: 'info' | 'warn' | 'error';
      message: string;
      at: string;
      /**
       * **哪个智能体做的这一步**（`ai_team` 模式才有）。
       *
       * 用户 2026-10-12 要求团队看板「直观显示**有哪些智能体，都是什么分工，都在做什么**」。
       * 没有这个字段，界面上只有一串按时间排的日志 —— 看不出"谁在干活"。
       *
       * `null`/缺省 = 这一步不属于某个角色（普通/智能托管模式的步骤，或调度层）。
       */
      role?: string | null;
      /**
       * **处于哪个阶段**（团队模式的编排阶段）。
       *
       * `dispatch`（派发）· `analysis`（并行分析）· `debate`（对抗辩论）·
       * `verdict`（裁决）· `execute`（执行）
       *
       * 界面靠它把步骤**分组**显示，而不是一条流水账。
       */
      phase?: string | null;
    }
  | { type: 'decision'; traderId: number; record: DecisionRecord }
  | { type: 'positions'; traderId: number; positions: PositionView[] }
  | { type: 'order'; traderId: number; order: OrderRecord }
  | { type: 'trade'; traderId: number; trade: TradeRecord }
  | { type: 'equity'; traderId: number; snapshot: EquitySnapshot }
  | {
      type: 'log';
      traderId: number | null;
      level: 'info' | 'warn' | 'error';
      message: string;
      /**
       * 记录来源的**稳定机器码**（模块名，例如 `binance:bootstrap`）。
       *
       * ## 为什么它是单独一个字段，而不是拼进 `message`
       *
       * 原来服务端把 `[${scope}]` 拼在正文最前面，于是界面上显示的是
       * `[binance:bootstrap] loaded 528 tradable USDT-M perpetual contracts` ——
       * **一个内部模块名加一句英文**。
       *
       * 那有两个问题：
       *   · **机器码出现在给人看的文本里**（本项目在别处已经统一纠正过这件事：
       *     展示层翻译，存库的永远是原码）
       *   · 拼进去之后**界面再也分不出哪一段是来源、哪一段是正文**，
       *     于是连"把来源翻译成中文"都做不到
       *
       * 所以来源单独传，由展示层翻译。原始码仍然完整保留 —— 筛选与排查靠它。
       */
      scope?: string;
      timestamp: string;
    }
>;

/* -------------------------------------------------------------------------- */
/*  自然日边界（北京时间）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 北京时间的 UTC 偏移。
 *
 * **常量而不是查时区库**：中国自 1991 年起不实行夏令时，UTC+8 是恒定的。
 * 引入 Intl 或时区数据库只为这一件事，代价远大于收益。
 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 北京时间「今天 0:00」对应的 **UTC 时刻**（ISO 字符串）。
 *
 * ## 算法
 *
 * 把时间戳平移 +8 小时后，它读起来就是北京时间的钟面；按天取整；
 * 再平移回去得到 UTC。三步都**不依赖服务器**的时区设置。
 *
 * ## 为什么返回值是 UTC ISO
 *
 * 库里存的一律是 UTC ISO（本项目的一条纪律），所以比较也必须用 UTC ——
 * 变的只是**边界的定义**，不是存储格式。
 *
 * @example
 *   // 北京时间 2026-09-19 07:30（= UTC 2026-09-18 23:30）
 *   beijingDayStartIso(Date.parse("2026-09-18T23:30:00Z"))
 *   // → "2026-09-18T16:00:00.000Z"  也就是北京时间 9-19 00:00
 */
export function beijingDayStartIso(nowMs: number = Date.now()): string {
  const shifted = nowMs + BEIJING_OFFSET_MS;
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStart - BEIJING_OFFSET_MS).toISOString();
}

/** 北京时间「今天 0:00」的毫秒时间戳。 */
export function beijingDayStartMs(nowMs: number = Date.now()): number {
  return Date.parse(beijingDayStartIso(nowMs));
}
