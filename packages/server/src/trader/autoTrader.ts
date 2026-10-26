import {
  closeReasonLabel,
  isCloseAction,
  isAdjustAction,
  isCancelPendingAction,
  isSkipAction,
  isResizeAction,
  isOpenAction,
  normalizeSymbol,
  orderPurposeLabel,
  exchangeErrorCode,
  type CloseReason,
  type CircuitBreakerReading,
  type Decision,
  type EquitySnapshot,
  type ExecutionLogEntry,
  type MarketSnapshot,
  type OrderRecord,
  type PositionView,
  type StrategyConfig,
  type Trader,
  type TraderStatus,
  type Kline,
  type Timeframe,
} from '@aq/shared';
import type { BinanceBroker, ExchangePosition } from '../binance/broker.js';
import type { PositionSide } from '@aq/shared';
import type { AccountState } from '../binance/account.js';
import type { BinanceMarketData } from '../binance/market.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { BinanceApiError, type BinanceAlgoStatus } from '../binance/types.js';
import { eventBus } from '../events.js';
import { createLogger } from '../logger.js';
import { LlmError } from '../llm/errors.js';
import type { MarketDataService } from '../market/service.js';
import { shouldMoveStopToBreakeven } from '../risk/breakeven.js';
import {
  checkCircuitBreakers,
  RiskEngine,
  shouldCloseForDrawdown,
  type CircuitBreakerVerdict,
} from '../risk/engine.js';
import { selectCandidates } from '../strategy/coins.js';
import { parseDecisionResponse, hasDecisionBlock, sortDecisions } from '../strategy/parser.js';
import {
  extractToolCalls,
  runDecisionTool,
  type DecisionToolDeps,
} from './decisionTools.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildUserPromptParts,
  closeReasonBreakdown,
  PROMPT_PERFORMANCE_WINDOW_HOURS,
  PROMPT_RECENT_CLOSE_COUNT,
  promptTokenBudget,
  summariseRules,
  type PromptMemory,
  type PromptLesson,
  type PromptPosition,
  type PromptContext,
  type PromptRejection,
} from '../strategy/prompt.js';
import type { JevAccountState } from './jevModel.js';
import { jevBool, jevEnum, jevNumber } from './control.js';
import { last } from '../market/indicators.js';
import { isMajorSymbol, type DecisionAction } from '@aq/shared';
import { agentMemory } from '../store/agentStore.js';
import {
  attributedEquity,
  aiModels,
  decisions as decisionStore,
  equity as equityStore,
  marginOf,
  normalizeMarginMode,
  orderIdIn,
  shouldTrustReconciledQuantity,
  orders as orderStore,
  ownUnrealizedPnlOf,
  positions as positionStore,
  resolveOrderMarginUsed,
  settings,
  TERMINAL_ORDER_STATUSES,
  tradeEvents,
  traders as traderStore,
  trades as tradeStore,
} from '../store/repositories.js';
import { rankPlatformHistory } from '../strategy/platformHistory.js';
import { applyAgentPatch } from './agent/patch.js';
import { rankConsensus } from '../strategy/consensus.js';
import { pickAtrSeries } from '../strategy/atrPeriod.js';
import { clampNextCheckMinutes, nextCycleDelayMs } from './cycleSchedule.js';
import {
  BAR_MINUTES,
  pendingTimeoutMinutes,
  timeframeBarMinutes,
} from './pendingTimeout.js';
import { averageRoundTripCostPercent } from '../strategy/costs.js';
import { entryFillStats } from '../strategy/entryStats.js';
import {
  addToWatchlist,
  decayWatchlist,
  watchlistSymbols,
  type WatchlistEntry,
} from '../strategy/watchlist.js';
import {
  reconstructRoundTrips,
  roundTripKey,
  roundTripQueryKey,
  type ReconstructedTrade,
} from './roundTrips.js';
import { commissionsInWindow, fundingInWindow, fundingSince, netPnlOf, realizedInFills, realizedInWindow } from '../binance/income.js';

const log = createLogger('trader');

/** Row shape returned by the position repository — inferred to avoid a dup type. */
type PositionRow = ReturnType<typeof positionStore.open>[number];

/**
 * 例行对账回看多久。
 *
 * 30 天。这个窗口只需要覆盖「这个机器人还可能需要对账的成交」，不需要覆盖它
 * 全部的历史 —— 见 `reconcileTradeHistory()`。取 30 天而不是贴着一个周期，
 * 是因为交易所的 `/fapi/v1/userTrades` 只能按时间范围拉：窗口太窄会让一个
 * 长时间没动的标的彻底滑出视野（而它可能刚被交易所侧止损平掉），
 * 30 天既远大于任何一次真实的停机窗口，又把每轮对账的查询量固定在常数级别。
 * 更早的东西由周期性深对账兜底。
 */
const RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 一轮决策的硬上限（60 分钟）。超过它，执行锁被强制释放。
 *
 * ⚠️ **这是 2026-10-02 为一个"静默停摆 8.5 小时"的事故加的。**
 *
 * `tick()` 的第一句是 `if (this.cycleInFlight) return;` —— **它直接返回且不排下一次**。
 * 所以只要有一个 `await` 永远不 resolve，机器人就再也不会产生任何一轮：
 * 状态显示 `running`，日志里还在打上游重试，而 `decision_records` 一条新记录都没有。
 *
 * ## ⚠️ 2026-10-07：这个数从 20 分钟改成 60 分钟
 *
 * 原来写着"实测一轮正常耗时 1–9 分钟，所以 20 分钟不会误杀正常的长轮次"。
 * **那个前提已经过期了** —— 同一份代码，一轮现在是 **5–35 分钟**：
 *
 * ```text
 * 910 轮实测：1–2min 225 次 · 2–5min 236 次 · 5–10min 121 次
 *             10–20min 44 次 · >20min 7 次 · 最长 2142.7s（35.7 分钟）
 * ```
 *
 * 变慢的原因是我把提示词从 11 万 token 提到了 50 万（候选池 8→20、上下文上限→80 万），
 * 而**同一份上下文在一轮里会被重复发送约 12.7 倍**（多轮取数，每次带全部历史）。
 * 吞吐是服务商侧固定的，所以耗时随输入线性增长。
 *
 * ## 后果（用户报的"无法正常运行"）
 *
 * 20 分钟的上限**恰好落在分布的中段偏右** —— 于是大量轮次跑到一半被强行中止：
 * `决策超时中止 2 次`、`decision_records` 里最新一轮停在 37 分钟前、
 * 而 `traders.status` 仍然显示 `running`。**机器人"在跑但什么都不做"。**
 *
 * 60 分钟的依据：实测最大 35.7 分钟，留了近一倍余量；而它仍然能兜住
 * "某个 await 永远不 resolve"那个原始事故（那种情况下永远不会有结果，
 * 早中止晚中止都只是释放锁的时机问题）。
 */
export const CYCLE_HARD_TIMEOUT_MS = 60 * 60_000;

/**
 * 允许"被中止但还没真正结束"的轮次上限。
 *
 * 达到它时 `tick()` **不再开始新轮** —— 见 `tick` 里那段说明：
 * 短暂停摆（可见、可处理）好过内存被累积的僵尸轮次拖死（不可见）。
 *
 * 2 这个数：一轮正常 1–9 分钟，所以同时有 2 轮"超时未结束"已经是异常状态；
 * 而 2 轮各持 138K 字符量级的上下文仍然安全，再多就开始危险了。
 */
export const MAX_ZOMBIE_CYCLES = 2;

/**
 * 两次参数改动之间至少隔多久。
 *
 * 30 分钟 = 它自己的一个决策周期。理由是**让每一次改动都经过一轮完整的
 * 决策循环再被评估**：改完立刻再改，等于没有任何一次改动被检验过。
 */
export const PARAM_CHANGE_MIN_INTERVAL_MS = 30 * 60_000;

/** 一小时内最多改几次参数。 */
export const PARAM_CHANGE_MAX_PER_HOUR = 2;

/**
 * 账本对账的容差 —— **绝对下限 + 权益的 0.1%，取较大者**。
 *
 * ## 为什么固定的 1 美分在两个方向上都是错的（2026-10-02 实测）
 *
 * 权益 21.92 的账户报出差额 **0.0101** —— 只比原来那个固定值多 **0.0001 美元**，
 * 却挂起一条 ERROR 级"账目与交易所对不上"。而它对应的相对偏差是 **0.046%**，
 * 远在噪声里（开仓那一刻的持有成本口径差就足够产生它）。
 *
 *   · **小账户**：1 美分是 0.046%（$21.92）→ 日常噪声就触发，
 *     这条告警于是变成背景噪声，**真漏记出现时没人再看它**；
 *   · **大账户**：1 美分是 0.0001%（$10,000）→ 一笔真实的漏记可能远大于它，
 *     但"大于 1 美分"这条线拦不住任何东西，**该报的没报**。
 *
 * 相对分量取 0.1%：对 $21.92 是 0.022（比噪声高、比真漏记低），
 * 对 $10,000 是 10 美元（与"一笔最小成交手续费 0.0005 的千倍量级"相称）。
 *
 * `equity <= 0`（读不到）时退回绝对下限 —— 宁可这一刻严一点，也不要让对账失去判据。
 */
export const LEDGER_GAP_TOLERANCE_ABS = 0.01;
export const LEDGER_GAP_TOLERANCE_RELATIVE = 0.001;

export function ledgerGapTolerance(equity: number): number {
  const relative =
    Number.isFinite(equity) && equity > 0 ? equity * LEDGER_GAP_TOLERANCE_RELATIVE : 0;
  return Math.max(LEDGER_GAP_TOLERANCE_ABS, relative);
}

/**
 * 每多少个对账回合做一次覆盖全生命周期的深对账。
 *
 * 24 轮。以默认 15 分钟周期算约 6 小时一次，对「停机期间被交易所止损平掉」
 * 这种必须补录的事件来说足够及时；同时把 O(历史) 的扫描从每轮一次降到每天
 * 4 次。这个值**不能取太大**：深对账是「+0.6563 那笔完全没被记账」的唯一
 * 修复路径，间隔越长，账面与账户不一致持续的时间就越长。
 */
const FULL_RECONCILE_EVERY_PASSES = 24;

/**
 * 两条权益快照差在这以内就算"同一个数"（浮点末位不算变化）。
 *
 * 用绝对容差而不是相等：`equity` 是"初始 + Σ已实现 + 浮盈"算出来的，
 * 浮盈那一路经过价格换算，同一个持仓在同一个价位上重算可能差在 1e-12 量级 ——
 * 那不该被当成"账户动了"。
 */
const SNAPSHOT_SAME_TOLERANCE = 1e-9;

/**
 * 持仓与权益都没变时，最多隔多久记一条**心跳**快照。
 *
 * 没有心跳，长时间空仓会在权益曲线上留下断档 —— 那看起来像"机器人没在跑"，
 * 而它其实一直在跑。2 小时对一台 45 分钟一轮的机器人是"每 2–3 轮一条"，
 * 既保住了"我还在"的证据，又不会把曲线铺成一堆重复的点。
 *
 * 完整理由见 `recordEquity()`。
 */
const SNAPSHOT_HEARTBEAT_MS = 2 * 60 * 60 * 1000;

/**
 * 结清一张本地委托之前，它至少要有多"老"。
 *
 * ## 为什么需要这个宽限
 *
 * "这张单还在不在"的权威答案是交易所的挂单列表，但那是一次**读**：一张单从我们记下它
 * （`created_at`）到它出现在 `/fapi/v1/openOrders` / `/fapi/v1/openAlgoOrders` 里，
 * 中间可能有极短的时延（请求在途、两次读之间的竞态）。没有这个下界，一次刚好排在
 * 下单之后的读就会把**刚挂上去的保护单**判成"已经不在交易所"，在账面上把保护单抹掉 ——
 * 而 §2.6 存在的意义就是不让一个没有保护的杠杆仓位变得看不见。
 *
 * ## 为什么是 2 分钟
 *
 * 下界要远大于任何一次交易所读写的耗时（亚秒到几秒，相差两个数量级），
 * 又要小到让真正已经撤销的行不会长期挂在界面上：默认周期 15 分钟，最短 1 分钟，
 * 所以一行脏数据最多多显示一两轮就会被结清。
 */
export const ORDER_SETTLE_GRACE_MS = 2 * 60_000;

/**
 * 一个决策周期里，模型最多能**主动索要几次数据**。
 *
 * 每次索要都是一次完整的模型调用（实测单次输入 10 万+ token），而且发生在
 * 决策周期的**热路径**上 —— 无限轮会让一轮的耗时和成本失控。
 *
 * 3 轮覆盖了正常需求（"先要 1m 确认是不是刚启动，再要 4h 看那个结构位"），
 * 提示词里也把它写明，免得模型以为可以一直要。
 */
export const MAX_DATA_ROUNDS = 3;

/**
 * 提示词里给模型看多少条**自己复盘出来的教训**。
 *
 * ⚠️ 这个数从"按候选池遍历到 8 条"改成了"按时间取最近 8 条"（见
 * `buildPromptLessons` 的说明）：**条数没变，变的是"取哪 8 条"。**
 * 旧口径下只有候选池排名前 4 的标的有机会，最新的教训常常一条都进不来。
 */
export const PROMPT_LESSON_LIMIT = 8;

/**
 * **正文一个字都没有**时的重试要求（实盘缺陷，2026-10-17）。
 *
 * ## 为什么与既有的"截断重试"那句分开
 *
 * 既有那句是"你上一条回复里**没有 `<decision>` 块**……请**先写 `<reasoning>`
 * （简短即可）**，然后立刻写 `<decision>` 块" —— 它假设模型**写了一些东西**、
 * 只是没写到决策块。
 *
 * 而 `ai_managed` 线上遇到的形态是**正文一个字都没有**（`finish_reason=length`
 * + `content` 为空）：输出预算被思维链吃光。此时再要求它"先写 `<reasoning>`"
 * 等于**让它再吃一遍预算** —— 思维链的长度不由指令控制（材料 21 万字符），
 * 而重试用的是同一份预算。所以那种情况下重试**必然再次为空**。
 *
 * ## 这一条要求什么
 *
 * · **不要写 `<reasoning>` 块**（把它要输出的正文压到最小）；
 * · **不要复述材料**（材料已在提示词里，复述是纯浪费）；
 * · **立刻给 `<decision>`**，哪怕是一个空数组。
 *
 * ⚠️ **诚实标注**：对把思维链放在 `reasoning_content` 的模型，提示词**不能关掉
 * 它的内部思考** —— 这一条只能压缩"它写出来的那部分"。真正的结构性修复是
 * **加大输出预算**（见 `DecisionModel.outputBudgetTokens` 与
 * `boostedOutputBudgetFor`）。两条一起用：预算拿得到就放大，拿不到就至少把
 * "写出来的部分"压到最小。
 */
const EMPTY_CONTENT_RETRY_PROMPT =
  '你上一条回复**正文是空的** —— 输出预算被思考吃光了，一个字都没写出来。' +
  '这次**不要写 `<reasoning>` 块、也不要复述任何材料**。' +
  '直接输出 `<decision>` 块（`<decision>` 与 `</decision>` 之间是一个 JSON 数组）：' +
  '要做动作就写那几个对象，不做动作就写 `[]`。' +
  '**这是硬要求：没有 `<decision>` 块这一轮就算失败，什么都不会被执行。**';

/** 既有的"有内容、但没写出 `<decision>` 块"的重试要求（本次一字未改）。 */
const TRUNCATED_RETRY_PROMPT =
  '你上一条回复里**没有 `<decision>` 块**（很可能是因为思考太长、把输出预算用完了）。' +
  '请**直接给出结论**：先写 `<reasoning>`（简短即可），然后立刻写 `<decision>` 块。' +
  '如果你这一轮不打算做任何动作，`<decision>` 里写一个空数组 `[]` 就够了 —— **不要省略这个块**。';

/**
 * 空内容重试时把输出预算放大到**当前的多少倍**。
 *
 * `4` 与 `llm/modelRouter.ts` 的 `REASONING_BUDGET_MULTIPLIER` 同值：
 * `ai_managed` 这条路径**从来没享受过** `budgetFor()` 对思维链模型的 4 倍放大
 * （那个函数只被 `ModelRouter` 调用），所以这一次放大同时补上"缺失的那一次"
 * 与"重试的加倍"。
 *
 * 不取更大：预算越大、思维链也越长（"步骤重复"的经典形状），
 * 而且供应商报的上限之外没有意义。
 */
const EMPTY_CONTENT_BUDGET_MULTIPLIER = 4;

/**
 * 空内容重试能请求的**最大**输出预算 —— 一个硬上界，防止"预算越加越大"。
 *
 * 取值依据是本仓实测过的最高配置（`strategy/parser.ts` 里记着"max_tokens 已经是
 * 131072、而实际在 ~58K 就被网关截断"）。再往上加没有意义，而且可能被供应商
 * 直接以 400 拒掉 —— 那会让重试连"再用一次原预算"的机会都没有。
 */
const MAX_OUTPUT_BUDGET_TOKENS = 131_072;

/**
 * 空内容重试要用的输出预算；**给不出基准值时返回 `undefined`**（= 不覆盖）。
 *
 * 三条边界（都有用例）：
 * · 拿不到基准（`undefined` / 0 / 负数 / NaN）→ `undefined`，**绝不猜**；
 * · 正常放大 4 倍；
 * · 撞上硬上界就取上界。
 *
 * 拆成导出的纯函数是为了让它可被直接单测 —— 这段判断错了会静默缩小预算，
 * 而"静默缩小"正是这个缺陷本身。
 */
export function boostedOutputBudgetFor(currentBudget: number | undefined): number | undefined {
  if (typeof currentBudget !== 'number' || !Number.isFinite(currentBudget) || currentBudget <= 0) {
    return undefined;
  }
  return Math.min(currentBudget * EMPTY_CONTENT_BUDGET_MULTIPLIER, MAX_OUTPUT_BUDGET_TOKENS);
}

/**
 * **正文为空时的重试计划** —— 提示词与预算覆盖一次算清（纯函数，可直接单测）。
 *
 * ## 为什么抽成纯函数
 *
 * 这段判断有**两个方向都会出错**的分支，而两条错了都不会报错、只会静默劣化：
 *
 * · 拿"有内容但没写完"的情形去要求"不要写 `<reasoning>`" → 削弱它的推理；
 * · 拿不到基准预算却硬传一个值 → 可能把预算**缩小**（比不修更糟）。
 *
 * 抽出来之后它们各有断言（见 `autoTrader.test.ts` 里那一组用例），
 * 而不必为了测这两句话去搭一整套交易循环夹具。
 */
export function emptyContentRetryPlan(input: {
  /** 模型这一轮返回的正文。 */
  text: string;
  /** 实现当前的输出预算（`undefined` = 读不到）。 */
  outputBudgetTokens: number | undefined;
}): {
  /** 正文是否**完全为空**（= 输出预算被思维链吃光的确证信号）。 */
  firstTextEmpty: boolean;
  /** 重试时用的 user 提示词。 */
  retryPrompt: string;
  /** 重试要请求的输出预算覆盖；`undefined` = 不传该字段（行为不变）。 */
  maxTokens: number | undefined;
  /** 给 `emit('warn', …)` 的一句话；**空串**表示这一轮不是空正文。 */
  note: string;
} {
  const firstTextEmpty = input.text.trim().length === 0;
  if (!firstTextEmpty) {
    /* 有内容、只是没写到 `<decision>` 块 —— 沿用既有那句，**一个字都不改**。 */
    return {
      firstTextEmpty: false,
      retryPrompt: TRUNCATED_RETRY_PROMPT,
      maxTokens: undefined,
      note: '',
    };
  }

  const maxTokens = boostedOutputBudgetFor(input.outputBudgetTokens);
  return {
    firstTextEmpty: true,
    retryPrompt: EMPTY_CONTENT_RETRY_PROMPT,
    maxTokens,
    note:
      maxTokens === undefined
        ? '模型这一轮正文为空（输出预算被思考吃光）—— 重试时会要求它跳过思维链直接给决策块。' +
          '（读不到当前输出预算，所以这次没能加大它。）'
        : `模型这一轮正文为空（输出预算被思考吃光）—— 重试时把输出预算从 ` +
          `${input.outputBudgetTokens} 加到 ${maxTokens}，并要求它跳过思维链直接给决策块。`,
  };
}

/** 提示词里"你自己复盘出来的教训"的一条。 */
export interface PromptLessonLike {
  symbol: string;
  closeReason: string;
  netPnl: number;
  lesson: string;
}

/**
 * 从 `agent_memory` 的**按时间倒序**快照里挑要进提示词的教训。
 *
 * ⚠️ 抽成纯函数是为了**可测**：这段逻辑出过一个很隐蔽的 BUG（见下），
 * 而它藏在 `AutoTrader` 的私有方法里、又依赖数据库外键，很难写一条干净的用例。
 *
 * ## 那个 BUG（2026-10-02 实测）
 *
 * 旧实现是"遍历候选池顺序 → 每标的取 2 条 → 满 8 条停"：
 *
 *     for (const symbol of symbols) { ... }     // 候选池按 24h 成交额降序
 *
 * 三者叠加的后果：**只有候选池排名前 4 左右的标的**的教训能进提示词。
 * HYPEUSDT 常排第 14 位，于是它的教训永远进不了 —— 而区块标题写"最新在前"。
 *
 * 实测：`#90`（15:22 写下 HYPE 的回吐教训，"不解决留利"那句）在 `#1851`
 * （16:02 的决策轮）提示词里**完全找不到**。
 *
 * 所以现在的口径是：**按时间取最近 N 条**（输入即已按 id DESC 排好）。
 * 这样"最新学到的"一定到达现场；代价只是老标的的旧教训可能被挤出 ——
 * 而旧教训针对的是当时的行情，本来就更不相关。
 */
export function selectPromptLessons(
  recent: readonly PromptLessonLike[],
  limit: number = PROMPT_LESSON_LIMIT,
): PromptLessonLike[] {
  return recent.slice(0, Math.max(0, limit)).map((m) => ({
    symbol: m.symbol,
    closeReason: m.closeReason,
    netPnl: m.netPnl,
    lesson: m.lesson,
  }));
}

/**
 * 「这张单**已经不存在了**」的交易所状态 —— 限价入场对账用。
 *
 * ⚠️ **判断顺序很重要**：调用方必须先看 `executedQty > 0`，再看这张表。
 * 因为 `CANCELED` 也可能是**部分成交之后被撤**（撤销剩余），而 `EXPIRED` 同理
 * （IOC 剩余过期）。**先问"成交了多少"，再问"单还在不在"** —— 反过来会把一个
 * 已经成交了一部分的入场当成"从未发生"，那笔真实持仓就没人管了。
 *
 * `PARTIALLY_FILLED` 不在表里：它还活着，继续等。
 */
const TERMINAL_GONE_STATUSES: ReadonlySet<string> = new Set([
  'CANCELED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'REJECTED',
]);


/**
 * 走 Algo 端点的条件单类型。
 *
 * 就是 `/fapi/v1/order` 会以 `-4120` 拒掉的那几种（见 `binance/types.ts`），
 * 它们的最终状态只能用 `/fapi/v1/algoOrder` 回读。
 */
const CONDITIONAL_ORDER_TYPES = new Set([
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]);

/**
 * 条件单的 `algoStatus` → `orders.status` 里的订单状态。
 *
 * 必须翻译：`orders.status` 那一列存的是**订单**状态（`FILLED` / `CANCELED` / …），
 * 而 Algo 端点报的是它自己的状态词表（`FINISHED` / `TRIGGERED` / …），两者只有 `NEW`
 * 一个词重合。把 `FINISHED` 原样写进那一列的话：控制台既没有它的中文标签，终态集合里
 * 也没有它 —— 一张已经触发成交的止损会继续以"已挂单"的样子留在「当前委托」里，
 * 也就是这次要修的显示缺陷换个状态码重演一遍。
 *
 * `TRIGGERED` 同样记为成交：走到这里的前提是本地已经没有任何该标的的持仓，
 * 而 `closePosition=true` 条件单的唯一作用就是平掉整个仓位 —— 它触发了、仓位也没了，
 * 这一张就是成交了。
 */
const ALGO_FINAL_ORDER_STATUS: Partial<Record<BinanceAlgoStatus, string>> = {
  FINISHED: 'FILLED',
  TRIGGERED: 'FILLED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
};

/* -------------------------------------------------------------------------- */
/*  Injected model interface                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the LLM client the trader depends on.
 *
 * Declared structurally rather than importing the concrete client so the trading
 * loop stays testable with a stub and does not couple to any provider.
 */
export interface DecisionModel {
  complete(
    systemPrompt: string,
    userPrompt: string,
    /**
     * ⚠️ **可选的中止信号 —— 硬超时靠它真正取消在途请求。**
     *
     * 没有它时，"超时"只能做到"不再等"：那一轮仍在后台跑、并永久持着
     * 138K 字符量级的上下文。今天（2026-10-02）服务器正是因为这类僵尸轮次
     * 累积到内存耗尽。见 `inCycle` 的说明。
     *
     * **可选**是为了不破坏测试桩与回放器 —— 它们多数不实现这个参数，
     * 而那没关系：生产实现（`manager.ts` 的适配层）会把它一路穿到 `fetch`。
     */
    options?: {
      signal?: AbortSignal;
      /**
       * **本次调用的输出预算覆盖**（不传 = 用实现自己的默认值）。
       *
       * ## 为什么交易循环需要它（实盘缺陷，2026-10-17）
       *
       * 思维链模型的 `reasoning_content` 与正文**共享**输出预算
       * （`llm/client.ts` 的 `chat()` 有实测：`mt=16/128 → content=null`、
       * `mt=512` 才有正文）。而 `budgetFor()` 那套"思维链模型放大 4 倍"
       * **只被 `llm/modelRouter.ts` 调用** —— `ai_managed` 走的是
       * `manager.ts` 里的 `client.complete(...)`，**根本不经过 `ModelRouter`**
       * ⇒ 那 4 倍放大**完全不覆盖 `ai_managed`**（= 实盘 #10 的模式）。
       *
       * 后果：预算被思维链吃光 → `finish_reason=length` + **正文为空**
       * → 这一轮零决策；而"用同一份预算再问一次"必然还是空（结构性截断）。
       *
       * 所以重试必须能**加大预算**。基准值由 `outputBudgetTokens` 提供
       * （循环自己不知道实现在用多大的预算，也不该去猜 —— 猜小了会把预算
       * 缩小，比不修更糟）。
       */
      maxTokens?: number;
    },
  ): Promise<{
    text: string;
    latencyMs: number;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      /** 命中缓存的输入 token；`null` 表示服务商没报这个字段。 */
      cachedTokens?: number | null;
      /** 花在思考上的输出 token（已计入 completion）。 */
      reasoningTokens?: number | null;
    };
  }>;

  /**
   * 这个模型**当前的输出预算**（token）—— 只在"空内容重试要加大预算"时用。
   *
   * 可选：不提供时，空内容重试退化为"同预算再问一次 + 更严格的重试要求"，
   * **不会报错、也不会改变正常路径**（见 `boostedOutputBudgetFor`）。
   *
   * ⚠️ **为什么需要它、而不是循环自己去猜**：输出预算在 `LlmClient` 构造时定死
   * （来自 `ai_models.max_tokens`）。循环若猜一个绝对值，猜小了会把预算**缩小**
   * （比不修更糟），猜大了可能被供应商以 400 拒掉。只有实现自己知道那个数。
   *
   * 生产由 `manager.ts` 的适配层提供（那里的 `config.maxTokens` 就是构造
   * `LlmClient` 时用的同一个值）。
   */
  outputBudgetTokens?: number;

  /**
   * 多消息版本 —— **缓存能不能命中就靠它**。
   *
   * `complete(system, user)` 内部就是 `chat([system, user])`，所以这只是把底层
   * 已经支持的能力暴露出来。区别在于**前缀的长度**：
   *
   *   · 两条消息时，`user` 里任何一处变化都会让整个 `user` 段退出缓存；
   *   · 拆成「稳定段 / 占位 / 变动段」之后，稳定段**逐字节不变**，于是它是
   *     可缓存前缀的一部分。
   *
   * 实测差距：本产品的 AI 托管只命中 5%（只有 system 那 2300 token 进了缓存），
   * 而追加式结构的会话能到 99%。见 `buildUserPromptParts()`。
   *
   * 可选：测试用的桩可以只实现 `complete`，调用方会回落到它。
   */
  chat?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    /** 与 `complete` 同一套可选项（空内容重试要能加大预算）。 */
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<{
    text: string;
    latencyMs: number;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      cachedTokens?: number | null;
      reasoningTokens?: number | null;
    };
  }>;
}

export interface AutoTraderDeps {
  trader: Trader;
  config: StrategyConfig;
  registry: SymbolRegistry;
  market: BinanceMarketData;
  marketData: MarketDataService;
  broker: BinanceBroker;
  model: DecisionModel;
  /**
   * 一轮决策的硬超时（毫秒）。默认 {@link CYCLE_HARD_TIMEOUT_MS}（60 分钟）。
   *
   * ⚠️ **存在的唯一理由是让超时路径可测。** 20 分钟的常量没法在用例里等 ——
   * 而"超时之后会发生什么"（中止那一轮、僵尸计数、到上限就不再开新轮）
   * 恰恰是最需要被测试钉住的部分：第一版就是因为没测这条路径，
   * 才会把"只放锁不取消"这种会累积内存的写法发到线上。
   */
  cycleHardTimeoutMs?: number;
  /**
   * AI 智能托管接缝（**可选**）。
   *
   * 不传时交易循环的行为与以前**完全一致** —— 这是刻意的：老机器人不该因为
   * 这一层存在而有任何变化。它是"挂在交易循环上的一个能力"，不是它的一部分。
   *
   * 只在两个点被用到：进周期时问一次"要不要审视"、平仓后请它复盘。
   */
  agent?: AgentHook;
}

/**
 * 平仓时传给复盘员的事实。
 *
 * **这些字段是实测逼出来的。** 最初只传了 `tradeId` / `symbol` / `closeReason` / `netPnl`，
 * 于是复盘员的结论只能是「**数据不足**，无法判定这笔的盈亏归因」——
 * 而它列的缺口（持仓时间、浮盈回撤轨迹、手续费占比）**全都在这份事实里**。
 *
 * **让 AI 说「数据不足」是调用方的责任，不是它的。**
 */
export interface ReviewTradeFacts {
  tradeId: number;
  symbol: string;
  closeReason: string;
  /** 净盈亏（毛 − 手续费 − 资金费）。 */
  netPnl: number;
  /** 毛盈亏。与净额一起看才知道成本吃掉了多少。 */
  grossPnl: number;
  /** 手续费合计（开仓侧 + 平仓侧）。 */
  fee: number;
  /**
   * 持仓期间达到过的最大浮盈百分比。
   *
   * **判断「止盈 / 移动止损是否设晚了」的唯一依据。**
   * 没有它，复盘员分不清「正常波动的保护性离场」与「利润回吐」——
   * 而这两者的改法完全相反。
   *
   * ⚠️ **口径是「对保证金」的，含杠杆 —— 不是价格涨幅。**
   *
   * 这条以前没写，代价是实测过的：`#95`（XRPUSDT 5x）记下 3.146%，
   * 模型把它当成价格涨幅、反算出 1.5606 这个从未出现的价格，
   * 于是得出一张从未被触及的止盈单「失效」的结论。
   * 展示时必须同时给 `leverage`（`marginPercentToPricePercent` 要用）。
   */
  peakPnlPercent: number;
  /** 该仓位的杠杆倍数 —— 换算上面那个「对保证金」的口径要用到它。 */
  leverage: number;
  /** 持仓时长（分钟）。 */
  holdMinutes: number;
  entryPrice: number;
  exitPrice: number;
  /**
   * 开仓时刻（ISO）。
   *
   * 用途是**回查那一轮的决策记录**：实测复盘员明确指出
   * 「缺少入场逻辑、周期与当时的趋势/关键位背景，无法判定这次止损是
   * 设得过紧被正常波动打掉，还是入场方向本就错误」——
   * **而那个入场理由就在 `decision_records.decisions[].reasoning` 里。**
   *
   * 没有它，复盘员永远只能在这两种结论之间含糊 —— 而两者的改法完全相反。
   */
  openedAt: string;
  /**
   * **开仓时计划的**止损价（`positions.stop_loss`），与 {@link takeProfit} 成对。
   *
   * ## 为什么必须有（2026-10-03，AI 自己点名的缺口）
   *
   * 复盘员在 `#104`（WLDUSDT）里写下：
   *
   * > 「记录的开仓止损应为 0.5440（-2.16%），实际平仓价却是 0.5516（-0.845%），
   * >  两者相差约 1.2%，说明实际止损位被收紧/挂错或成交记录有误，
   * >  **本次亏损无法区分是『趋势判断错』还是『止损设置/执行错』**。」
   *
   * 而真相是：那笔的止损**就是 0.552**（决策 `c15` 写的就是 0.552、挂单触发价也是
   * 0.552、成交 0.5516 是 0.07% 的正常滑点）——**它没有挂错**。
   * 它引用的 `0.544` 是**同一标的上一笔**（`#275`）的止损，**它把两笔记混了**。
   *
   * 它为什么会混：这几项事实里**从来没有"计划的止损"**，它只能从
   * `get_lessons` 的同标的历史记忆里找一个数 —— 而那个数属于**别的交易**。
   *
   * 这正是本接口开头那条原则的又一次适用：
   * **「让 AI 说『数据不足』是调用方的责任，不是它的。」**
   * 它想区分"止损设错"与"方向就错"，而这两者的改法完全相反 ——
   * 那就必须把区分它们所需的数字给它，而不是让它去历史里猜。
   */
  stopLoss: number | null;
  /** **开仓时计划的**止盈价（`positions.take_profit`）。用途见 {@link stopLoss}。 */
  takeProfit: number | null;
}

/**
 * 交易循环对智能体的全部认知。**刻意只有五个方法** ——
 * 接口越小，"交易被智能体影响"的可能面就越小。
 */
export interface AgentHook {
  /**
   * AI 模式下应当生效的配置；非 AI 模式返回 `null`（调用方继续用策略配置）。
   *
   * 这是"AI 下发的参数真的被用上"的唯一出口。
   */
  configOverride: () => StrategyConfig | null;
  /**
   * 进周期时问一次"要不要审视"。**不阻塞** —— 实现方保证不 await。
   *
   * `reason: 'manual'` 表示**操作员明确要求现在就想一次**：它绕过冷却与事件判据，
   * 但不绕过每小时预算（见 `runStrategyReview` 的 `force`）。
   */
  triggerReview: (reason?: 'cycle' | 'manual') => void;
  /** 结算等待中的参数实验（每笔平仓后最该做）。 */
  settleOnly: () => void;
  /** 一笔平仓之后请复盘员写因果结论。**不阻塞。** */
  reviewTrade: (trade: ReviewTradeFacts) => void;
}

/**
 * 一个周期边走边累积的审计内容。
 *
 * 字段与 `decisionStore.log()` 的入参一一对应，只少了 `success` —— 它是从
 * `error` 推出来的（非空即失败），避免出现"success = true 但带着一条错误"这种
 * 自相矛盾的记录。
 */
interface CycleProgress {
  systemPrompt: string;
  userPrompt: string;
  cotTrace: string;
  decisions: Decision[];
  rawResponse: string;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  /** 非空即代表本轮失败；内容就是给操作员看的那句话。 */
  error: string | null;
  aiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /*
   * 缓存命中与思考 token。
   *
   * 这两个数决定"这一轮钱花在哪"：缓存命中价是未命中价的 1/50，
   * 而输出价是缓存命中价的 200 倍。少了它们，成本问题只能靠猜。
   */
  cachedTokens: number | null;
  reasoningTokens: number | null;
  /**
   * 这一轮模型**主动索要**过的数据（`get_klines ETHUSDT 1m ×120` 这样的短句）。
   *
   * 存在的理由与工具调用记录一样：事后要能回答"**它当时到底看了什么**"。
   * 没有这个字段，一轮"要了三次数据"的决策在事后看起来和"什么都没要"一模一样 ——
   * 而**要了什么**恰恰决定了它的结论值不值得信。
   */
  dataRequests: string[];
}

/**
 * 行情空窗的固定说明。
 *
 * 单独的常量：它同时被"选币为空"这条早退路径与测试断言用到，散在两处就会走样。
 */
const MARKET_DATA_UNAVAILABLE_MESSAGE =
  '行情数据不可用：本轮没有任何可用行情快照（选币为空，或所有候选标的的行情都取不到），' +
  '因此没有向模型提问、也没有下单。通常是交易所行情接口暂时不可用，机器人会在下一轮自动重试；' +
  '若连续多轮如此，请检查网络与交易所连通性。';

/* -------------------------------------------------------------------------- */
/*  Auto trader                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One trader's autonomous loop.
 *
 * The cycle is deliberately ordered so that risk-reducing work happens before
 * risk-adding work, and so that every cycle leaves a complete audit record even
 * when it fails:
 *
 *   1. authoritative account + position state from the exchange
 *   2. reconcile local records against reality
 *   3. mechanical protections (drawdown guard) — these never ask the model
 *   4. circuit breakers
 *   5. build the candidate universe and market snapshots
 *   6. ask the model
 *   7. parse, then subject every proposal to the hard risk engine
 *   8. execute closes, then opens
 *   9. persist the decision, the orders, the trades and an equity point
 */

/**
 * **事件驱动唤醒**的目标延迟 —— 收到重要事件后大约多久重新评估。
 *
 * 45 秒而不是"立刻"：成交推送会在几秒内来好几帧（部分成交、保护单触发、
 * 仓位更新），而**账本要先对齐**（`manager.scheduleFillReconcile` 有 5 秒防抖）。
 * 给一点时间让状态稳定，再让团队看 —— 否则它会基于"半更新的账本"做判断。
 */
const EARLY_WAKE_DELAY_MS = 45_000;

/**
 * 两次事件驱动唤醒之间的**最小间隔**。
 *
 * ⚠️ 这是防死循环的闸门，不是性能优化。
 *
 * 调研里 MAST 分类法的实测数据：**步骤重复占 15.7%**。
 * 而"成交 → 唤醒 → 决策 → 又成交 → 又唤醒"正是最典型的重复形状。
 * 3 分钟意味着：即使行情剧烈到连续成交，团队最多每 3 分钟重新评估一次，
 * 而**不会**陷入"刚决策完又被唤醒"的紧循环。
 */
const EARLY_WAKE_MIN_GAP_MS = 3 * 60_000;

/**
 * **进程关闭时**等一轮跑完的上限（毫秒）。
 *
 * ## 为什么比"操作员点停止"的 60 秒长得多
 *
 * 两种意图的等待成本完全不同（见 `stop()` 里的说明）：
 *
 * | 场景 | 谁在等 | 上限 |
 * |---|---|---|
 * | 操作员点停止 | **人**在屏幕前等 | 60 秒（再长就是"点了没反应"）|
 * | 部署 / 进程关闭 | **没人**在等 | 3 分钟（一轮实测 1–5 分钟）|
 *
 * ## 为什么是 3 分钟
 *
 * 实测一轮团队决策 1–5 分钟（见设计文档的性能记录），而**大部分轮次在 1 分钟内**。
 * 3 分钟覆盖了绝大多数轮次，同时把最坏情况（卡住的轮次）限制在部署脚本
 * 能接受的范围里。
 *
 * ⚠️ **这个值要与 systemd 的 `TimeoutStopSec` 匹配** —— 如果 systemd 在 90 秒时
 * 就 SIGKILL，那这里写 3 分钟也不会真的等到。deploy 脚本会设置它。
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3 * 60_000;

/**
 * **该不该因为一个事件提前唤醒** —— 纯函数，四条闸门都在这里。
 *
 * ## 为什么抽成纯函数
 *
 * 这四条闸门全是**防死循环**的（MAST 实测：步骤重复占 15.7%），
 * 而它们嵌在一个需要真实数据库、交易所、模型的类里**几乎没法测**。
 * 抽出来之后每一条都能被单独钉住 —— 而"少一条闸门"的后果是
 * **机器人自己把自己唤醒到死循环**，那是灾难性的。
 *
 * @param input.mode          机器人模式（只有 `ai_team` 开启）
 * @param input.running       是否在跑
 * @param input.cycleInFlight 是否有一轮正在执行
 * @param input.nextCycleAt   原定下一次的时刻（`null` = 没有排期）
 * @param input.lastEarlyWakeAt 上次唤醒生效的时刻（`null` = 从未）
 * @param input.now           当前时刻（注入，便于测试）
 */
export function shouldEarlyWake(input: {
  mode: string;
  running: boolean;
  cycleInFlight: boolean;
  nextCycleAt: number | null;
  lastEarlyWakeAt: number | null;
  now: number;
}): { wake: boolean; reason: string } {
  /* 闸门 0：没在跑 → 什么都不做。 */
  if (!input.running) return { wake: false, reason: '机器人未在运行' };

  /*
   * 闸门 1：**只对 AI 团队模式**。
   *
   * 用户硬约束：「你现在的更新迭代**不要影响我现在实盘跑的机器人**：赚大钱」
   *（`#10` 是 `ai_managed`）。对它在成交后插一次额外决策会**改变它的行为** ——
   * 那正是用户说不要的。
   */
  if (input.mode !== 'ai_team') return { wake: false, reason: '只有 AI 团队模式使用事件驱动唤醒' };

  /* 闸门 2：正在跑一轮 → 让它跑完（它本来就会重新评估）。 */
  if (input.cycleInFlight) return { wake: false, reason: '上一轮仍在执行' };

  /* 闸门 3：**最小间隔** —— 防"成交 → 唤醒 → 决策 → 成交"的紧循环。 */
  if (
    input.lastEarlyWakeAt !== null &&
    input.now - input.lastEarlyWakeAt < EARLY_WAKE_MIN_GAP_MS
  ) {
    return { wake: false, reason: '距上次唤醒太近（防死循环）' };
  }

  /*
   * 闸门 4：**只提前不推后** —— 已经排在更早的时刻就不动它。
   *
   * ⚠️ `nextCycleAt === null` 是**唤醒**而不是挡下（实测时被这条测试抓到）。
   *
   * `null` 的含义是"**当前没有下一次排期**"（`scheduleNextCycle` 排出定时器时写它，
   * 定时器触发时清它）。而"没有排期"意味着**没有任何人会来看这个账户** ——
   * 那时候收到成交事件，最该做的是**叫醒它**，而不是按"快到了"挡掉。
   *
   * 第一版写成 `null → remaining = 0 → 挡下`，方向正好反了。
   */
  if (input.nextCycleAt !== null && input.nextCycleAt - input.now <= EARLY_WAKE_DELAY_MS) {
    return { wake: false, reason: '原定周期本来就快到了' };
  }

  return { wake: true, reason: 'ok' };
}

/**
 * **持仓剧变的触发阈值**（百分比，2026-10-13）。
 *
 * ## 为什么是 3%
 *
 * 它必须同时满足两个约束：
 * ```
 *   ① 明显大于正常的分钟级波动 —— 否则震荡市里天天触发（那不是信号）；
 *   ② 小于"一个值得重新评估"的幅度 —— 否则错过机会。
 * ```
 * 3% 是这两个约束的**保守交集**。
 *
 * ⚠️ 可由 `AQ_SHARP_MOVE_PERCENT` 覆盖 ——
 * "多大的波动值得看一眼"取决于标的与周期，硬编码一个值不合适。
 */
const SHARP_MOVE_THRESHOLD_PERCENT = 3;

/**
 * **候选池异动的阈值**（2026-10-14 加）—— 比持仓那条高。
 *
 * ## 为什么两者必须不同
 *
 * 它们要回答的问题不一样：
 * ```
 *   持仓（3%）：「我这个仓位是不是要出事了」  → 该早看
 *   候选（5%）：「市场里是不是出现了新机会」  → 值得打断当前节奏才看
 * ```
 * 用一个阈值会让**空仓的机器人被大量无关波动反复唤醒** ——
 * 而每次唤醒都是一次真实调用 + 真实 token（`DEFAULT_WAKE_POLICY.hourlyBudget`
 * 就是为这件事设的上限）。
 *
 * ⚠️ 可由 `AQ_CANDIDATE_MOVE_PERCENT` 覆盖（"多大的波动算机会"取决于行情）。
 */
const CANDIDATE_MOVE_THRESHOLD_PERCENT = 5;

/**
 * **行情剧变检测**（2026-10-13 加）—— "持续工作"缺的最后一块。
 *
 * ## 之前缺的是什么
 *
 * 已有的提前唤醒只有**一个**触发源：
 * ```
 *   manager.ts   autoTrader.requestEarlyCycle('有成交')
 * ```
 * 也就是说：**只有在【成交】之后**团队才会提前醒来。
 *
 * 而真正需要"立刻看一眼"的情形里，**大多数没有成交**：
 * ```
 *   · 持仓标的突然拉升 8% —— 该考虑止盈/移动止损，但没成交就不唤醒
 *   · 大盘急跌 —— 该考虑减仓，但没成交就不唤醒
 *   · 一个候选突破 —— 该考虑开仓，但没成交就不唤醒
 * ```
 * 于是团队**只能等到下一个周期**（最长 120 分钟）。
 *
 * ## 判据：**相对基准价的变动幅度**
 *
 * 用"上次评估时的价格"作基准，而不是"前一分钟价格"——
 * 后者会在震荡市里疯狂触发（1 分钟的噪音不是信号）。
 *
 * ⚠️ **必须配一道冷却期**（调用方负责）：行情单边时价格会**持续**偏离基准，
 * 若只看幅度，每轮都会触发 —— 而那是"同一件事重复唤醒"。
 *
 * @param input.moves     各标的相对基准价的百分比变动
 * @param input.threshold 触发阈值（百分比，取绝对值）
 * @returns 触发原因（`null` = 不触发）
 */
export function detectSharpMove(input: {
  moves: ReadonlyArray<{ symbol: string; changePercent: number }>;
  threshold: number;
}): string | null {
  const hits = input.moves
    .filter((m) => Number.isFinite(m.changePercent) && Math.abs(m.changePercent) >= input.threshold)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  if (hits.length === 0) return null;
  const top = hits[0]!;
  const dir = top.changePercent > 0 ? '涨' : '跌';
  const more = hits.length > 1 ? `（另有 ${hits.length - 1} 个标的同向剧变）` : '';
  return `${top.symbol} ${dir} ${Math.abs(top.changePercent).toFixed(2)}%${more}`;
}

/**
 * **安全解析 `positions.intel_keys`**（2026-10-12）。
 *
 * ## 为什么不能直接 `JSON.parse`
 *
 * 这个字段来自 DB，而 DB 里的内容**可能不是合法 JSON**：
 * · 老行（M17 之前）默认 `'[]'` —— 那个没问题；
 * · 但如果将来有人手改过、或某次写入被截断，`JSON.parse` 会**抛错**，
 *   而它发生在**平仓路径**上 —— 一笔正常的平仓会因为一个附属字段而失败。
 *
 * **附属的统计字段绝不该让主流程失败。**
 *
 * ## 为什么坏值降级成 `[]`（而不是跳过这笔成交）
 *
 * `[]` 的语义是"**纯技术面成交**" —— 那是**保守且安全**的降级：
 * 最坏结果是"这笔成交没被计入某个消息面信号的统计"，
 * 而不是"这笔成交没被记账"。
 */
function parseIntelKeysOf(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}
export class AutoTrader {
  private timer: NodeJS.Timeout | null = null;
  /**
   * **持仓剧变监控的定时器**（2026-10-13 加）。
   *
   * 与 `timer`（决策循环）**完全分开** —— 它的职责只有一个：
   * 每隔一段时间问一次"我手上的仓位是不是发生了值得重新评估的变化"，
   * 是就调 `requestEarlyCycle()` 把决策循环提前叫醒。
   *
   * ## 为什么必须是独立循环
   *
   * 决策循环的间隔**由模型自己定**（1–120 分钟）。而"持仓突然跌了 8%"
   * 这件事**不等模型排期** —— 它可能发生在刚排完 120 分钟之后。
   * 若等下一轮才发现，**止损可能已经被打掉了，而团队还在按"持有"思考**。
   *
   * ⚠️ 它**只在 `ai_team` 模式启动**（见 `startMoveWatch`）——
   * 用户硬约束：不能改变现有实盘机器人（`#10 赚大钱` 是 `ai_managed`）。
   */
  private moveWatchTimer: NodeJS.Timeout | null = null;
  /**
   * **各标的的基准价**（`symbol → 价格`）—— 上次评估时记下的。
   *
   * ⚠️ 基准要"跟着评估走"，而不是"跟着时间走"：
   * 用"1 分钟前的价格"做基准会在震荡市里疯狂触发，
   * 而**1 分钟的噪音不是要重新评估的理由**。
   */
  private moveBaseline = new Map<string, number>();
  /**
   * **上一个周期算出来的候选池**（2026-10-14 加）—— 供 `candidateWatchSymbols()` 用。
   *
   * ⚠️ 为什么复用"上一轮算过的"而不是每 60 秒重算一次：
   * 候选池的算法要拉币池成交额 + 持仓量（多次请求 + 排序），
   * 而**"哪些标的值得看"在 15 分钟内几乎不会变**。
   * 每 60 秒重算一次买不到任何新信息，只会烧权重
   *（`rest.ts` 的 `weightLimitPerMinute` 是所有请求共享的）。
   *
   * ⚠️ 它是**快照、不是结论**：机器人刚启动时是空数组，
   * 那时 `candidateWatchSymbols()` 会退回配置里的 `staticCoins`。
   */
  private lastCandidateSymbols: readonly string[] = [];
  private running = false;
  /**
   * 模型这一轮要求的"下次什么时候再看盘"（分钟）。
   *
   * ⚠️ **为什么要有实例字段**：它由**决策解析**产生（`tick` 的中段），
   * 而真正用来排期的是 `finally` —— 那里拿不到 `parsed` 的局部作用域。
   *
   * 每轮开始前必须清空，否则"这一轮它没提要求"会**继承上一轮的要求**，
   * 而那是一个很难在日志里看出来的错误（行为上表现为"偶尔莫名其妙地变慢"）。
   */
  private requestedNextCheckMinutes: number | undefined;
  private cycleInFlight = false;
  /**
   * 上一次**事件驱动唤醒**真的生效的时刻。
   *
   * ⚠️ 只在"真的重排了"时才更新 —— 否则被忽略的请求会不断刷新这个时间戳，
   * 把后续真正的唤醒也一起挡掉（那会表现为"偶尔不唤醒"，很难查）。
   *
   * 作用见 `requestEarlyCycle()` 的第一道闸：防"成交 → 唤醒 → 决策 → 成交"
   * 这种紧循环（MAST 实测：步骤重复占 15.7%）。
   */
  private lastEarlyWakeAt: number | null = null;
  /**
   * 当前那一轮的 `AbortController`。
   *
   * ⚠️ 存在的理由：**硬超时必须真的取消那一轮**，而不只是放弃等待它。
   * 见 `inCycle` 里那段说明 —— 只放锁会让卡住的轮次变成永久持着
   * 138K 字符提示词的僵尸，累积起来把进程拖死。
   */
  private abortCurrentCycle: AbortController | null = null;
  /**
   * 有多少轮"超时了但还没真正结束"。
   *
   * ## 为什么需要这个计数
   *
   * `abort()` 是请求取消，不是保证终止 —— 如果某个 `work()` 卡在非网络的
   * `await` 上，它可能不理会 abort。那时唯一的安全阀是**不再开始新轮**：
   * 宁可短暂停摆（状态可查、错误会写进记录），
   * 也不要让一个不断累积的内存泄漏把整个进程拖死（**那在界面上看不见**）。
   */
  private zombieCycles = 0;

  /**
   * 每个"状态位"最近一次记下的文案。
   *
   * 用于 `emitOnChange()`：状态没变就不再记。键是状态位名（例如 `circuit-breaker`），
   * 值是上次记的文案 —— 文案变了（例如亏损比例变了）也算变化，会重新记一条，
   * 这样操作者既不会被重复刷屏，也不会漏掉数值的实质变化。
   */
  private stateNotices = new Map<string, string>();

  /**
   * 已经设过的**保证金模式**（symbol → 模式）。
   *
   * 存在的理由：`setMarginType` 要在**零持仓零挂单**时才能调，而一个标的的模式
   * 设好之后就不该反复调（每次都是一次签名请求，而且 `-4046` 重复设置虽然无害，
   * 但那是白花权重）。只在新标的、或模式配置变了时才真正打这一枪。
   *
   * 只活在进程内：**重启后重新设一遍是对的** —— 交易所侧可能被别的东西改回去。
   */
  private marginSet = new Map<string, string>();

  /**
   * 已经**告警过**的"方向反了的重建回合"（键 = `入场单→出场单`）。
   *
   * ⚠️ 同一个反向回合**每一轮对账都会再遇到一次**：它的成因是"成交历史的窗口起点落在
   * 持仓中间"（`getUserTrades(symbol, 500)` 拿不到窗口起点时的持仓），而这个起点
   * 在我们能读到的历史里是**固定的** —— 所以每一轮都会重建出同一个反向回合、
   * 每一轮都会被丢弃、每一轮都会想告警一次。
   *
   * 丢弃是对的（那种回合的价格/方向/盈亏全都不可信）；但**每轮刷一条 WARN**
   * 会让日志看起来像在持续出错，而且会把真正的新问题淹掉。
   * 所以：**同一个键只 WARN 一次**，之后降为 debug。
   */
  private reversedTripNotices = new Set<string>();

  /**
   * 交易所允许的最大杠杆（symbol → 值）。**本进程缓存**，由周期开头预取。
   *
   * 为什么要有它：`RiskEnvironment` 的字段都是**同步**的（风控引擎不 await），
   * 而档位要从交易所读。所以取数发生在周期开头（`prefetchLeverageCaps`），
   * 这里只存结果给引擎同步查。
   *
   * 为什么缓存不用失效：档位是**交易所对账户的授信**，几分钟内不会变，
   * 而它变化时（比如开户满 30 天）下一轮重启或下一次预取自然会取到新的。
   * 每轮重取也不贵（weight 1），但没必要为每个候选各取一次。
   */
  private leverageCapCache = new Map<string, number>();
  /**
   * 非 `null` 时**本轮不下任何单** —— 账户处于双向持仓模式。
   *
   * ## 为什么需要它
   *
   * 双向模式（Hedge Mode）下币安要求每张单都带 `positionSide: 'LONG' | 'SHORT'`，
   * 而这个机器人一律发 `'BOTH'`，于是**每一笔下单都被拒**：`-4061`。
   * **平仓单也一样**（`reduceOnly` 不豁免 `positionSide`），所以是彻底瘫持。
   *
   * 原来 `ensurePositionMode()` 检测得到、但只记日志不阻止，周期照跑 ——
   * 从"账户被改"到"人看到日志"最多 30 分钟，这期间每次决策都白跑。
   *
   * ## 两条设置它的路径
   *
   * 1. **主动检查**（每 10 轮一次，为了不扰动模拟盘的墙钟）
   * 2. **下单失败时识别 `-4061`** —— 这一条才是关键：
   *    它让机器人**在第一次失败时就知道**，而不是再等最多 30 分钟。
   */
  private positionModeBlocked: string | null = null;
  /**
   * 已经跑过多少次对账。决定这一次是「例行浅对账」还是「全量深对账」。
   *
   * 见 `reconcileTradeHistory()`：浅对账只覆盖最近有活动的标的与账目，
   * 深对账才扫全生命周期。计数器是进程内的 —— 重启后第一次对账一定是深对账
   * （`0 % N === 0`），正好覆盖「停机期间发生的平仓」。
   */
  private reconcilePasses = 0;
  /**
   * Resolves when the cycle that currently holds `cycleInFlight` has finished.
   *
   * The flag alone is enough to keep the timer from overlapping itself, but two
   * other things mutate the same books — an operator stopping the trader and the
   * `/reconcile` endpoint — and both used to act while a cycle was mid-flight.
   * Stop could return while the cycle was still placing orders (the process then
   * exited and shut down without closing it), and reconcile ran a **second**
   * `AutoTrader` in parallel with the live one, so both could read the same
   * position and book the same close twice.
   *
   * Holding the promise makes "is a cycle running?" an awaitable question, which
   * is what lets shutdown and reconciliation serialise against it instead of
   * guessing.
   */
  private cyclePromise: Promise<void> | null = null;
  private cycleNumber: number;
  private consecutiveFailures = 0;
  private status: TraderStatus = 'stopped';
  private readonly risk = new RiskEngine();

  constructor(private readonly deps: AutoTraderDeps) {
    // Resume numbering so the audit trail stays continuous across restarts.
    this.cycleNumber = deps.trader.lastCycleNumber;
    this.consecutiveFailures = deps.trader.consecutiveFailures;
    // 默认就是策略配置；AI 模式下每个周期开头会被刷成 AI 下发的那份。
    this.activeConfig = deps.config;

    /*
     * ⚠️ **候选池的大小由这一行决定。**
     *
     * 提示词预算原来硬编码 6 万，而候选池 = 预算 ÷ 每个候选的字符成本 ——
     * 一个 4 周期策略因此**只能看到 7 个标的**。实测某机器人连续 15 轮候选池
     * 都是 7 个、15 轮 0 决策，而它挂的模型能吃 100 万 token。
     *
     * 现在按模型自己报的输入上限算（`promptTokenBudget` 会 clamp 到
     * `[6万, 20万]`：下限保住既有行为，上限是成本）。
     *
     * 在这里算一次而不是每轮算：`aiModelId` 是机器人的属性，运行期不会变。
     */
    const modelLimit = aiModels.get(deps.trader.aiModelId)?.inputTokenLimit ?? 0;
    this.promptBudget = promptTokenBudget(modelLimit);

    /*
     * ⚠️ **把"每个标的已确认的保证金模式"从数据库恢复**（2026-10-18 修）。
     *
     * `marginSet` 原本只活在内存里，重启就清空。而 `recordOrder` 用它决定订单记录里
     * 「保证金模式」那一列写什么 —— 于是**每次部署之后，平仓/止损单的模式列就变成空白**。
     * 实测（线上 #11）：exit 37 笔缺 21、stop_loss 132 笔缺 12、entry 103 笔缺 0；
     * 同一标的 TIAUSDT 19 笔有值 9 笔无值 —— 正是"重启前 / 重启后"的分界。
     *
     * ## 这条只影响显示，不改变任何设置行为
     *
     * · `executeOpen` 里那段 `if (this.marginSet.get(symbol) !== wantedMode)` 仍然照旧：
     *   恢复出来的值等于想设的值时**跳过那次调用**（省一次权重）——
     *   而如果交易所侧被别处改过，下一次真正想改时仍会打到交易所。
     * · 拿不到（新标的、或历史订单里没有该标的）就保持空 Map，行为与改动前一致。
     *
     * 用 try/catch 兜住：**启动流程不能因为一个"显示用的缓存"而失败**。
     */
    try {
      for (const [symbol, mode] of orderStore.latestMarginTypeBySymbol(deps.trader.id)) {
        this.marginSet.set(symbol, mode === 'cross' ? 'crossed' : 'isolated');
      }
    } catch {
      /* 读不到就当作空 —— 与改动前一致，只是那一列会空。 */
    }
  }

  /**
   * 这一轮组装提示词用的 token 预算（见构造函数里的说明）。
   *
   * 它同时决定三件事：候选池能放多少个、选币阶段裁多少、以及最终发出去的请求多大。
   */
  private readonly promptBudget: number;

  /**
   * **本周期生效的配置** —— 交易路径全部读它，不再直接读 `this.deps.config`。
   *
   * 为什么要有这个字段而不是每次访问都调 `agent.configOverride()`：
   *
   *  - 那样每周期会读**六次**数据库并解析六次 JSON（配置在交易路径上被读六处）；
   *  - 更要紧的是，**同一周期内读到不同的配置会让行为无法解释** ——
   *    比如风控按 A 配置放行、下单按 B 配置取整。一次刷新、周期内不变，才可推理。
   */
  private activeConfig: StrategyConfig;

  /**
   * 最近一次跑周期时的**账户权益与历史最高水位**，供控制台回答
   * "它为什么一单都不开"。
   *
   * ## 为什么记这一份而不是让 `/stats` 自己算
   *
   * 周期里本来就在算这两个数（熔断器要用）。而 `/stats` 自己算要两趟查询
   * （今日已实现盈亏、历史最高水位），而这个端点每 5–12 秒被每个机器人拉一次 ——
   * `node:sqlite` 是同步的，那些查询会跑在**驱动交易循环的同一条事件循环**上。
   *
   * ## 它为什么不是"上一轮的结论"
   *
   * 只记**输入**（权益与高水位），不记裁决结果 —— 裁决在读取时用
   * `this.activeConfig` 重算，这样熔断解除（例如入金）之后控制台会立刻反映出来，
   * 而不是挂着一条过期的"被熔断"直到下个周期。
   */
  private lastBreakerInput: { equity: number; highWater: number } | null = null;

  /**
   * 刷新本周期生效的配置，并在 AI 模式下触发一次审视判断。
   *
   * `deps.agent` 不存在时这里**什么都不做** —— 老机器人的行为不受任何影响。
   */
  private refreshAgentState(): void {
    const agent = this.deps.agent;
    if (!agent) return;
    const override = agent.configOverride();
    if (override) this.activeConfig = override;
    // 不 await：审视可能跑几十秒，不能把 3 分钟的周期撑长。
    agent.triggerReview();
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  get currentStatus(): TraderStatus {
    return this.status;
  }

  /**
   * 这个实例此刻是不是在**纸面模式**下跑 —— 由 broker 决定。
   *
   * ## 为什么必须能读出来
   *
   * `dryRun` 是**每次启动时传进去的参数**（`POST /traders/:id/start` 的 body，
   * 默认 `true`），**不持久化**。也就是说"这台机器人现在花的是真钱还是假钱"
   * 在启动之后**只存在于运行中的实例里** —— 数据库、列表、页头都看不到。
   *
   * 实测代价（本轮部署之后）：用 API 启动时忘了带 `{"dryRun": false}`，
   * 机器人以纸面模式跑了一整轮（开仓、挂保护单、被强制平仓，全是模拟的），
   * 而顶栏那个徽章读的是**进程级**的 `env.dryRun`，它显示「实盘」。
   * 两个说法不一致，而**没有任何一处**能看出这个机器人在模拟。
   */
  get isDryRun(): boolean {
    return this.deps.broker.isDryRun;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setStatus('starting', null);

    const mode = await this.deps.broker.ensureOneWayMode().catch((error) => ({
      changed: false,
      warning: `无法读取持仓模式：${(error as Error).message}`,
    }));
    if (mode.warning) this.emit('warn', mode.warning);

    this.setStatus('running', null);
    this.emit('info', `机器人「${this.deps.trader.name}」已启动`);

    /*
     * ── 首次决策：**看上次决策过了多久**，而不是无条件立刻跑 ──────────────
     *
     * ## 用户报的问题（2026-10-12）
     *
     * > 「你改代码的时候（提交更新部署代码到服务器后，服务器会重启对吧，
     * >  这时候运行中的机器人会被停止-启动，导致**决策周期刷新**……
     * >  就例如我运行中的赚大钱，**这一分钟才运行了 AI 分析，你下一分钟更新了程序，
     * >  机器人会被重新启动又马上进行分析**，你自己看着修，
     * >  不要为了机器人正常而影响你更新，**应该是两全其美**」
     *
     * ## 原来的写法为什么错
     *
     * 原来这里是无条件的：
     *
     *     void this.tick();            // ← 每次启动都立刻跑一轮
     *     this.scheduleNextCycle();
     *
     * 那句注释写的是「Run the first cycle immediately so the operator is not left waiting」
     * —— 对**操作员手动点启动**是对的（他想马上看到结果），
     * 但对**部署重启**是错的：机器人一分钟前刚跑完，重启后又跑一轮。
     *
     * 后果不只是"多花一次 AI 调用"：**决策周期被打乱**（AI 可能说"5 分钟后再看"，
     * 却被重启打断），而且每次部署都这样，累积起来就是"一直在重复分析同一段行情"。
     *
     * ## 修法：按 `lastCycleAt` 算剩余时间
     *
     * · **从没跑过**（`lastCycleAt` 为空）→ 立刻跑（首次启动，操作员在等）；
     * · **距上次不足一个周期** → 只排定时器等**剩余**时间（不重复分析）；
     * · **已超过一个周期**（停机很久）→ 立刻跑（行情已经变了，该看新的）。
     *
     * ⚠️ 这才叫"两全其美"：**操作员手动启动仍立刻看到结果**（新机器人或停机已久），
     * 而**部署重启不会打断正在跑的节奏**。
     *
     * ## 为什么用 `lastCycleAt` 而不是"进程内是否跑过"
     *
     * `lastCycleAt` 是**落库的**（`traders.last_cycle_at`），所以它跨重启有效 ——
     * 而"进程内标记"在重启后就丢了，等于没修。
     */
    const lastCycleAtMs = this.deps.trader.lastCycleAt
      ? new Date(this.deps.trader.lastCycleAt).getTime()
      : null;
    const cycleMs = Math.max(1, this.deps.trader.cycleIntervalMinutes) * 60_000;
    const elapsedMs = lastCycleAtMs === null ? Number.POSITIVE_INFINITY : Date.now() - lastCycleAtMs;

    /*
     * **持仓剧变监控**（2026-10-13 加）—— 见 `moveWatchTimer` 的说明。
     * 只对 `ai_team` 启动（用户硬约束：不改现有实盘机器人的行为）。
     */
    void this.startMoveWatch();

    if (elapsedMs >= cycleMs) {
      /* 从没跑过，或者停机超过一个周期 —— 立刻跑（操作员在等 / 行情已变）。 */
      void this.tick();
      this.scheduleNextCycle();
    } else {
      /*
       * 距上次不足一个周期 —— **只等剩余时间**，不重复分析。
       *
       * 日志要说清"为什么没有立刻跑"，否则操作员会以为启动卡住了
       *（这正是原来那句注释想避免的体验问题）。
       */
      const waitMs = cycleMs - elapsedMs;
      this.emit(
        'info',
        `距上次决策仅 ${Math.max(0, Math.floor(elapsedMs / 60_000))} 分钟（周期 ${this.deps.trader.cycleIntervalMinutes} 分钟）` +
          ` —— 不重复分析，约 ${Math.ceil(waitMs / 60_000)} 分钟后进行下一轮。`,
      );
      this.nextCycleAt = Date.now() + waitMs;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.nextCycleAt = null;
        void this.tick();
        this.scheduleNextCycle();
      }, waitMs);
    }
  }

  /**
   * **下一轮决策的预定触发时刻**（epoch 毫秒；没有排程时为 `null`）。
   *
   * ## 为什么由服务端给，而不是让界面自己算
   *
   * 用户 2026-10-07 的要求：「能在这里加入一个倒计时吗？让我明显知道下一轮决策剩余周期」。
   *
   * 界面自己算只能拿"上一轮的时间 + 配置里的周期"，而**实际延迟还取决于两件界面看不到的事**：
   *
   *   · **模型自己要求的间隔**（`requestedMinutes`）—— 它可以说"这个突破正在形成，5 分钟后再叫我"，
   *     也可以说"这行情没意思，一小时后再看"。那**不是配置值**。
   *   · **失败时的短重试** —— 上游 5xx 之后不该白等一整个周期。
   *
   * 两者都只在 `scheduleNextCycle()` 里算得出来。所以**在排出定时器的那一刻**把
   * 真实触发时刻记下来，由 API 带给界面 —— 界面只负责每秒刷新显示，不做推算。
   * **推算出来的倒计时会骗人**（模型说 5 分钟、界面显示 60 分钟），那比没有倒计时更糟。
   */
  public nextCycleAt: number | null = null;

  /**
   * 排下一次周期 —— **用自续期的 `setTimeout` 链，不用 `setInterval`。**
   *
   * ## 为什么必须换掉 `setInterval`
   *
   * 原来这里是一句 `setInterval(() => tick(), cycleIntervalMinutes * 60_000)`，
   * 间隔在**启动那一刻读一次就固定住了**。
   *
   * 于是「决策周期由 AI 调整」这件事在**结构上不可能** ——
   * AI 就算改了那个值，也要等机器人重启才生效，而重启不是它能做的。
   * 用户实测看到的「每次 AI 周期还都是 3 分钟」，根因就在这里。
   *
   * **自续期的写法让每一轮都重新读一次当前值**，AI 改完下一轮就生效。
   *
   * ## 为什么是"跑完再排下一次"，而不是"先排好再跑"
   *
   * 周期本身耗时不定（模型调用几秒到几十秒）。固定间隔的 `setInterval`
   * 在周期比间隔还长时会**重叠执行** —— 那意味着同一时间有两个决策在跑，
   * 而它们会读同一份持仓、可能各下一单。**串行是这里唯一安全的选择。**
   */
  private scheduleNextCycle(retrySoon = false, requestedMinutes?: number): void {
    if (this.timer) clearTimeout(this.timer);
    /*
     * 每次排期都**重新读**数据库里的值 —— 那是 AI 改完之后的真实值。
     *
     * 读失败时退回启动时那份（`deps.trader`），不让一次数据库抖动
     * 把周期变成 NaN 或 0 而疯狂空转。
     */
    let minutes = this.deps.trader.cycleIntervalMinutes;
    try {
      const fresh = traderStore.get(this.deps.trader.id);
      if (fresh && Number.isFinite(fresh.cycleIntervalMinutes)) {
        minutes = fresh.cycleIntervalMinutes;
      }
    } catch {
      /* 用启动时那份 */
    }
    /*
     * ⚠️ **失败的轮次用短间隔重试**（`retrySoon`）——
     *
     * 用户 2026-10-01 的截图：控制台上连着两条「失败 · AI 服务不可用」（#542、#543），
     * 而那是**上游偶发**故障（同轮内的 2 次重试都撞上同一段窗口）。
     * 系统原来的行为是"失败 → 等一整个周期（30 分钟）"，
     * 于是**服务商抖动几分钟，代价是一小时**。
     *
     * 实测同一份日志：`#1777` 下一轮就成功了 —— 上游恢复得很快，
     * 只是没人早一点再问它一次。
     *
     * 这不是退避（那会掩盖问题、拖慢恢复），而是**只提前、不推后**：
     * 正常轮次仍按 AI 设定的周期走，见 `cycleSchedule.ts`。
     */
    /*
     * ⚠️ **模型自己要求的"下次什么时候再看"优先**（`requestedMinutes`）。
     *
     * 用户 2026-10-02 的原话：
     *
     *   「不是系统喂给 AI 什么，AI 就只能**定时定点**的去做，这不是智能，
     *     也不是 AI，这是传统机器人了。」
     *   「会像真人一样，**决定何时做什么事情**。」
     *
     * 在此之前这一行只有配置里的周期 —— 它没法说"这个突破正在形成，5 分钟后再叫我"，
     * 也没法说"这行情没意思，一小时后再看"。而**这两件事都是交易判断本身**。
     *
     * 边界与"失败时取较小者"的规则都在 `nextCycleDelayMs` 里（单一处）。
     * 传 `undefined` 表示它没提这个要求 —— 那是**不同的意图**，不能当成 0。
     */
    const delayMs = nextCycleDelayMs({
      failed: retrySoon,
      cycleIntervalMinutes: minutes,
      ...(requestedMinutes === undefined ? {} : { requestedMinutes }),
    });
    /* 记下真实触发时刻供界面倒计时（见 `nextCycleAt` 的说明）。 */
    this.nextCycleAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      /*
       * ⚠️ **触发时立刻清空** —— 否则一轮正在跑的时候，界面会拿"已经过去的那个时刻"
       * 继续算，显示成 `0:00` 并一直不动。清空之后组件不渲染（`null` → 不显示），
       * 等这一轮跑完排出下一次时再出现。
       */
      this.nextCycleAt = null;
      void this.tick();
    }, delayMs);
  }


  /**
   * **事件驱动的提前唤醒** —— 让"不等定时"这件事真正落地。
   * ## 用户的要求（这是本方法存在的理由）
   *
   * > 「系统**不再是像现在这样定时去工作**，而是持续、并发的工作，增加盈利的可能」
   * > 「举例子：总管委派子代理去做市场调研……然后做相应的动作
   * >  （**开仓、平仓、调仓**等等）」
   *
   * ## 缺的到底是哪一块
   *
   * 系统已经有两者：
   *   · **AI 可以要求"下次什么时候再看"**（1–120 分钟，见 `cycleSchedule.ts`）；
   *   · **成交后立刻对齐账本**（`manager.scheduleFillReconcile`）。
   *
   * 但没有的是：**成交（尤其是止损被打掉）之后，决策循环并不知道**。
   * 账本已经对了，而团队要等到下一个周期（最长 120 分钟）才重新评估。
   * 那意味着：**仓位已经没了，团队还在按"持有"思考。**
   *
   * ## 为什么只对 `ai_team` 开启（刻意的边界）
   *
   * 用户有一条硬约束：
   *
   * > 「你现在的更新迭代**不要影响我现在实盘跑的机器人**：赚大钱」
   *
   * `#10 赚大钱` 是 `ai_managed`。对它在成交后插一次额外决策**会改变它的行为**
   *（多一次模型调用、可能多一次调仓判断）—— 而那正是用户说不要的。
   *
   * 所以门开在**新模式**上：`ai_team` 拿到事件驱动，现有模式的行为**逐字节不变**。
   * 等新模式的这套机制在真实盘上验证够了，再考虑是否推广。
   *
   * ## 防死循环（这是必须的，不是可选的）
   *
   * 调研里 MAST 分类法的实测数据：**步骤重复占 15.7%**。
   * 而"成交 → 唤醒 → 决策 → 又成交 → 又唤醒"正是最典型的重复形状。
   * 三道闸：
   *
   *   ① **最小间隔** `EARLY_WAKE_MIN_GAP_MS` —— 上一次唤醒太近就不理；
   *   ② **只提前不推后** —— 已经排在更早的时刻时什么都不做；
   *   ③ **在飞轮次不打断** —— `cycleInFlight` 时不重排（否则会把正在跑的轮次切碎）。
   */
  requestEarlyCycle(reason: string): void {
    /*
     * 读数据库而不是内存里的快照 —— **模式是可以被操作员改的**，
     * 而"改完模式之后事件驱动还按旧模式跑"会是一个很难查的偏差。
     */
    let mode: string = this.deps.trader.mode;
    try {
      const fresh = traderStore.get(this.deps.trader.id);
      if (fresh) mode = fresh.mode;
    } catch {
      /* 读失败就用启动时那份 */
    }

    const verdict = shouldEarlyWake({
      mode,
      running: this.running,
      cycleInFlight: this.cycleInFlight,
      nextCycleAt: this.nextCycleAt,
      lastEarlyWakeAt: this.lastEarlyWakeAt,
      now: Date.now(),
    });
    if (!verdict.wake) {
      /*
       * 被挡下时**不写日志** —— 这条路径在行情剧烈时会被频繁触发，
       * 每次都写会把自己的日志刷掉（而"闸门挡下了"本身不是异常）。
       */
      return;
    }

    this.lastEarlyWakeAt = Date.now();
    this.emit('info', `收到重要事件（${reason}）—— 提前重新评估，不等原定周期`);
    /*
     * `requestedMinutes` 传 1（`MIN_NEXT_CHECK_MINUTES` 的下界）——
     * 走同一个调度入口，于是"界面倒计时""AI 请求优先"这些行为都一致。
     */
    this.scheduleNextCycle(false, 1);
  }

  /**
   * **启动持仓剧变监控**（2026-10-13 加）—— "持续工作"缺的最后一块。
   *
   * ## 为什么需要它（与 `requestEarlyCycle` 的分工）
   *
   * 已有的提前唤醒只有一个触发源：**成交**。而真正需要"立刻看一眼"的情形里，
   * **大多数没有成交**：
   * ```
   *   · 持仓标的突然拉升 8% —— 该考虑止盈/移动止损，但没成交就不唤醒
   *   · 大盘急跌 —— 该考虑减仓，但没成交就不唤醒
   * ```
   * 于是团队**只能等到下一个周期**（最长 120 分钟）——
   * 而**止损可能已经被打掉了，团队还在按"持有"思考**。
   *
   * ## 边界（刻意收窄，理由都是实测）
   *
   * · **只对 `ai_team`** —— 用户硬约束：不改现有实盘机器人（`#10` 是 `ai_managed`）；
   * · **只看【已持仓】的标的** —— 请求数有界（持仓数通常 0–3），
   *   而不是"扫描 500 个候选"（那会变成另一个行情轮询器）；
   * · **基准价跟着【评估】走，不跟着时间走** —— 见 `moveBaseline` 的说明。
   *
   * ⚠️ 间隔可用 `AQ_MOVE_WATCH_SECONDS` 覆盖（默认 60 秒）——
   * 留这个口子是为了**能验证它真的在跑**（否则要等一分钟才看到一次效果）。
   */
  private async startMoveWatch(): Promise<void> {
    if (this.moveWatchTimer !== null) return;
    /* 只对 AI 团队模式 —— 见上面"边界"。 */
    let mode: string = this.deps.trader.mode;
    try {
      const fresh = traderStore.get(this.deps.trader.id);
      if (fresh) mode = fresh.mode;
    } catch {
      /* 读失败就用启动时那份 */
    }
    if (mode !== 'ai_team') return;

    const raw = Number(process.env.AQ_MOVE_WATCH_SECONDS ?? '');
    const seconds = Number.isFinite(raw) && raw >= 10 ? Math.min(raw, 3600) : 60;

    const timer = setInterval(() => {
      void this.checkPositionMoves();
    }, seconds * 1000);
    /* 不因为这个定时器把进程吊住 —— 它是可丢弃的。 */
    timer.unref();
    this.moveWatchTimer = timer;
    this.emit('info', `持仓剧变监控已启动（每 ${seconds} 秒检查一次，只在 AI 团队模式）。`);
  }

  /** 停止监控（`stop()` 时调用）。 */
  private stopMoveWatch(): void {
    if (this.moveWatchTimer !== null) {
      clearInterval(this.moveWatchTimer);
      this.moveWatchTimer = null;
    }
    this.moveBaseline.clear();
  }

  /**
   * **这一轮该盯哪些候选标的**（2026-10-14 加）。
   *
   * ## 取哪个来源
   *
   * 优先用**上一个周期真正算过的候选池**（`lastCandidateSymbols`）——
   * 那是"团队此刻认为值得看"的标的，比重新查一遍币池更准也更便宜。
   *
   * 装不满时再用配置里的 `staticCoins` 兜底：机器人**刚启动、还没跑过一轮**
   * 时前者是空的，而那时恰恰需要盯住"配置里点名的标的"。
   *
   * ⚠️ **上限 20 个**：这不是性能约束（一次 `premiumIndex` 就能覆盖全市场），
   * 而是**噪音约束** —— 盯 500 个标的时，任何一个涨 5% 都会唤醒团队，
   * 而那种唤醒绝大多数没有价值。真正的候选池（`coinPoolLimit`）本来就 ≤15。
   */
  private candidateWatchSymbols(): string[] {
    const seen = new Set<string>();
    for (const s of this.lastCandidateSymbols) {
      if (s.length > 0) seen.add(s);
      if (seen.size >= 20) break;
    }
    if (seen.size === 0) {
      for (const s of this.deps.config.coinSource?.staticCoins ?? []) {
        if (s.length > 0) seen.add(s);
        if (seen.size >= 20) break;
      }
    }
    return [...seen];
  }

  /**
   * **检查一次持仓剧变** —— 有的话把决策循环提前叫醒。
   *
   * ⚠️ **不抛错**：这是一个后台监控，它失败不该影响任何东西
   *（下一轮决策仍会照常评估）。
   */
  private async checkPositionMoves(): Promise<void> {
    try {
      if (!this.running) return;
      const traderId = this.deps.trader.id;
      const open = positionStore.open(traderId);

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **一次调用拿全市场价格，同时盯【持仓】与【候选池】**
       *      （2026-10-14 扩展 —— 补上"持续工作"缺的那一半）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 原来缺的是什么
       *
       * 原来这里在**没有持仓时直接 `return`**：
       * ```
       *   if (open.length === 0) { this.moveBaseline.clear(); return; }
       * ```
       * 理由是"没持仓就没有持仓剧变可言" —— 那句话本身对，但它**默认了
       * 唯一值得唤醒的事就是"已有仓位的价格动了"**。
       *
       * 而这个文件上面的注释（`detectSharpMove` 的文件头）**自己就点出了相反的例子**：
       * ```
       *   · 一个候选突破 —— 该考虑开仓，但没成交就不唤醒
       * ```
       * 于是就出现了一个**结构性盲区**：
       * ```
       *   空仓时（最该找机会的时候）→ 监控什么都不做
       *   → 只能等 15 分钟定时器 → 而"7×24 持续找机会"恰恰要求它别干等
       * ```
       *
       * ## 为什么现在这样做是【零额外成本】的
       *
       * 实测（2026-10-14）：`GET /fapi/v1/premiumIndex` **不带 `symbol` 时
       * 一次返回全市场 930 个标的**的标记价与资金费率（`market.ts` 的注释
       * 也写着 "With no symbol, Binance returns the whole universe in one weighted call"）。
       *
       * 所以：
       * ```
       *   改前：逐个持仓调 getMarkPrice → N 次请求（N = 持仓数）
       *   改后：一次 premiumIndex()     → 1 次请求（覆盖持仓 + 候选池 + 全市场）
       * ```
       * **盯的标的变多了，请求数反而变少了** —— 这是这次改动能成立的关键。
       *
       * ## 盯谁
       *
       * ```
       *   · 已持仓的标的  → 阈值用 `SHARP_MOVE_THRESHOLD_PERCENT`（3%）—— 保护仓位
       *   · 候选池的标的  → 阈值用 `AQ_CANDIDATE_MOVE_PERCENT`（默认 5%，更高）
       * ```
       * ⚠️ **候选的阈值必须比持仓高**，因为两者要回答的问题不同：
       * ```
       *   持仓："我这个仓位是不是要出事了"     → 3% 就该看一眼
       *   候选："市场里是不是出现了新机会"     → 5% 才值得打断当前节奏
       * ```
       * 用同一个阈值会让空仓的机器人**被大量无关波动反复唤醒**（那是噪音，
       * 而噪音的代价是真实调用 + 真实 token）。
       *
       * ⚠️ 无持仓时不再 `return` —— 但仍要清掉**已离场标的**的基准，
       * 否则下次再持有它时会拿一个很旧的价格比对（那会误报"剧变"）。
       */
      const held = new Set(open.map((p) => p.symbol));
      const watch = new Set<string>(held);
      for (const s of this.candidateWatchSymbols()) watch.add(s);

      /* 已不在盯的标的：清基准（避免下次持有它时拿旧价比对）。 */
      for (const symbol of [...this.moveBaseline.keys()]) {
        if (!watch.has(symbol)) this.moveBaseline.delete(symbol);
      }
      if (watch.size === 0) return;

      /*
       * ⚠️ 读全市场（一次请求）。失败时**什么都不做** —— 下一轮会重试，
       * 而"用空价格表当成价格没动"会把基准悄悄清掉。
       */
      const universe = await this.deps.market.premiumIndex().catch(() => []);
      if (universe.length === 0) return;
      const priceOf = new Map<string, number>();
      for (const row of universe) {
        const price = Number(row.markPrice);
        if (Number.isFinite(price) && price > 0) priceOf.set(row.symbol, price);
      }

      const heldMoves: Array<{ symbol: string; changePercent: number }> = [];
      const candidateMoves: Array<{ symbol: string; changePercent: number }> = [];
      for (const symbol of watch) {
        const price = priceOf.get(symbol);
        if (price === undefined) continue;
        const base = this.moveBaseline.get(symbol);
        /*
         * 第一次见到这个标的：只记基准，**不判断** ——
         * 否则"刚开仓/刚进候选"会被误判成"剧变"（因为没有基准可比）。
         */
        if (base === undefined || !(base > 0)) {
          this.moveBaseline.set(symbol, price);
          continue;
        }
        const changePercent = ((price - base) / base) * 100;
        (held.has(symbol) ? heldMoves : candidateMoves).push({ symbol, changePercent });
      }

      const heldReason = detectSharpMove({
        moves: heldMoves,
        threshold: Number(process.env.AQ_SHARP_MOVE_PERCENT ?? '') || SHARP_MOVE_THRESHOLD_PERCENT,
      });
      const candidateReason = detectSharpMove({
        moves: candidateMoves,
        threshold: Number(process.env.AQ_CANDIDATE_MOVE_PERCENT ?? '') || CANDIDATE_MOVE_THRESHOLD_PERCENT,
      });
      const reason = heldReason ?? candidateReason;
      if (reason === null) return;

      /*
       * ⚠️ **触发后立刻重置基准** —— 否则价格持续偏离时会**反复触发**
       *（那是"同一件事重复唤醒"，而 `EARLY_WAKE_MIN_GAP_MS` 只能挡住其中一部分）。
       */
      for (const symbol of watch) {
        const price = priceOf.get(symbol);
        if (price !== undefined) this.moveBaseline.set(symbol, price);
      }
      this.requestEarlyCycle(
        `${heldReason !== null ? '持仓剧变' : '候选异动'}：${reason}`,
      );
    } catch (error) {
      /* 后台监控失败不该影响任何东西 —— 下一轮决策仍会照常评估。 */
      this.emit('warn', `持仓剧变监控失败（不影响决策）：${(error as Error).message}`);
    }
  }

  /**
   * **记下这一轮各标的的价格作为剧变基准**（`tick` 成功拿到行情后调用）。
   *
   * ⚠️ 基准必须**跟着评估走** —— 那正是"重新评估过了，从现在开始算"的语义。
   * 若基准不更新，一个持续偏离的价格会让监控每轮都触发。
   */
  private rememberMoveBaseline(snapshots: ReadonlyArray<{ symbol: string; price: number }>): void {
    for (const s of snapshots) {
      if (Number.isFinite(s.price) && s.price > 0) this.moveBaseline.set(s.symbol, s.price);
    }
  }

  /**
   * Stop the loop and **wait for the cycle already running** to finish.
   *
   * Returning while a cycle is mid-flight is what let a shutdown land between
   * "entry filled" and "stop placed": the process exited, the timer was already
   * cleared so nothing would retry, and the account was left holding an
   * unprotected leveraged position (§2.6). Waiting here means the protection
   * order is either in place or the position has been flattened before `stop()`
   * resolves — which is the state shutdown needs in order to be safe.
   */
  /**
   * @param reason 停止原因，写进日志。
   * @param persist 是否把 `stopped` 写进数据库。
   *
   * `persist: false` 是给**进程关闭**用的，不是给"操作员点了停止"用的，
   * 这个区分很关键：
   *
   * `resumePersisted()` 只恢复 `running` / `safe_mode` / `error`，**刻意不恢复
   * `stopped`** —— 因为那被当作操作员的决定，自动启动它等于代码推翻人。
   *
   * 但关闭流程也会走 `stop()`。如果它照样写 `stopped`，那么**每一次部署或重启
   * 都会把所有机器人变成"操作员手动停止"**，重启后不再恢复 —— 机器人就此静默
   * 停摆，而控制台上看不出任何异常（状态显示为 stopped，像是有人点过）。
   *
   * 这个 bug 真实发生过：加了优雅停机之后，一次部署就静默停掉了正在跑的机器人。
   * 关闭是进程行为，不是人的决定，所以它不该留下"人的决定"这个痕迹。
   */
  async stop(reason = '操作员手动停止', persist = true): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    /* 持仓剧变监控也要停 —— 否则它会对已停止的机器人调用 requestEarlyCycle。 */
    this.stopMoveWatch();
    /*
     * ⚠️ **先把在途那一轮掐断，再去等它结束（2026-10-10，用户报的卡顿）。**
     *
     * 用户的原话：「机器人启动\停止，用户点击以后应该是瞬间完成……如果点了停止按钮，
     * 如果此时有运行中的 AI 请求也应该是立即终止」。
     *
     * 原来这里直接 `await waitForIdle()` —— 而那一轮可能正卡在一次 LLM 调用上
     * （实测单轮 1.8–9.9 分钟，硬超时更是 60 分钟），于是"点停止"要干等
     * 最多 `waitForIdle` 的 60 秒。**操作员点的是"停"，得到的却是"再等等"。**
     *
     * `abortCurrentCycle` 本来就有 —— 硬超时那条路径一直在用它真的拆掉在途请求
     *（见 `inCycle` 里那段注释：abort 会把 `work()` 掀掉）。所以这里只是
     * **让操作员的意图走同一条路**，而不是新造一个取消机制。
     *
     * 为什么可以安全地掐：那一轮此刻要么还没下单（纯 LLM 等待），要么在等交易所回执。
     * abort 影响的是 HTTP 等待，**不会撤销已经发出的下单请求** —— 已成交的仓位
     * 仍由对账与保护单兜住（`waitForIdle` 之后仍然照常等它收尾）。
     *
     * ---
     *
     * ## ⚠️ 但**进程关闭不能掐**（2026-10-12 修正，用户要求的"两全其美"）
     *
     * 用户的原话：
     *
     * > 「你改代码的时候（提交更新部署代码到服务器后，服务器会重启对吧，
     * >  这时候运行中的机器人会被停止-启动……**这个你得自己看着修**……
     * >  不要为了机器人正常而影响你更新，**应该是两全其美**」
     *
     * 实测证据（生产日志）：
     *
     * ```
     *   01:08:33  停止时上一轮决策未在时限内结束，可能留下未挂保护单的仓位
     *   01:08:41  机器人已启动（实盘）      ← 部署在 01:08 打断了一轮决策
     * ```
     *
     * **掐断正是那个窗口的成因**：一轮跑到"入场已成交、保护单还没挂"时被掐掉，
     * 循环也停了（`this.running = false`），于是**没有任何人会去补那张保护单** ——
     * 直到下一次启动对账才补上。中间那段就是**裸奔窗口**。
     *
     * 而"操作员点停止"与"部署重启"是**两种不同的意图**：
     *
     * | 场景 | 谁在等 | 该怎么做 |
     * |---|---|---|
     * | 操作员点停止（`persist=true`）| **人**在屏幕前等 | **立刻掐断**（要快）|
     * | 部署/进程关闭（`persist=false`）| **没人**在等 | **让它跑完**（可以等）|
     *
     * 所以掐断只在 `persist === true` 时做。
     */
    if (persist) {
      this.abortCurrentCycle?.abort();
    }
    const drained = await this.waitForIdle(persist ? 60_000 : SHUTDOWN_DRAIN_TIMEOUT_MS);
    if (!drained) {
      /*
       * The wait is bounded so a wedged exchange call cannot hang shutdown
       * forever — but a timeout must be **loud**, because the state it leaves is
       * the dangerous one: the cycle may be sitting between "entry filled" and
       * "stop placed", and the next cycle that would have fixed it can never run
       * now that the loop is stopped. That needs a human.
       */
      this.emit(
        'error',
        `停止时上一轮决策未在时限内结束，可能留下未挂保护单的仓位。请人工核对交易所持仓与挂单。`,
      );
    }
    if (persist) this.setStatus('stopped', null);
    this.emit('info', `机器人「${this.deps.trader.name}」已停止（${reason}）`);
  }

  /**
   * Resolve once no cycle is running.
   *
   * `timeoutMs` bounds the wait so shutdown can never hang forever on a stuck
   * exchange call — but it returns `false` in that case rather than pretending
   * the cycle finished, so the caller can say so in the log.
   */
  /**
   * **立刻中止在途的那一轮决策**（拆掉正在等待的 LLM 请求）。
   *
   * 给操作员的"停止"用：那条路径不该干等一轮跑完（见 `stop()` 里的说明）。
   * 幂等，没有在途轮次时是空操作。
   */
  abortInFlightCycle(): void {
    this.abortCurrentCycle?.abort();
  }

  async waitForIdle(timeoutMs = 60_000): Promise<boolean> {
    const pending = this.cyclePromise;
    if (!pending) return true;
    return Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private setStatus(status: TraderStatus, error: string | null): void {
    this.status = status;
    traderStore.setStatus(this.deps.trader.id, status, error);
    eventBus.publish({
      type: 'trader_status',
      traderId: this.deps.trader.id,
      status,
      ...(error ? { detail: error } : {}),
    });
  }

  /**
   * 记一条属于本机器人的日志。
   *
   * ⚠️ **只走 logger 这一条路径**，不要在这里再 `runtimeLogs.write()` 与
   * `eventBus.publish()` 一次。
   *
   * 原来三样都做，而 `log[level]()` 会触发全局 sink（`server.ts` 的
   * `setLogSink`），sink 同样写库、同样推事件 —— 于是**一条日志变成两条库记录
   * 加两个前端事件**，界面上同一句话出现两遍。而且两条记录的归属还对不上：
   * sink 那条 `trader_id = NULL`（并带上 scope 前缀），这里那条才有真实 id。
   *
   * 现在把归属通过 `meta` 交给 sink，由它统一落盘与推送：
   *   · `traderId` —— 这条日志属于哪个机器人
   *   · `raw`      —— 不带机器人名前缀的原文（stdout 仍用带前缀的版本，
   *                   数据库与界面里则由 `trader_id` 表达归属，不必重复写名字）
   */
  private emit(level: 'info' | 'warn' | 'error', message: string): void {
    log[level](`[${this.deps.trader.name}] ${message}`, {
      traderId: this.deps.trader.id,
      raw: message,
    });
    /*
     * ⚠️ **一轮里发生的每一件事，顺带作为"当前步骤"推给界面（2026-10-10）。**
     *
     * ## 为什么挂在 `emit` 上，而不是在一轮的六个节点各写一次
     *
     * `emit` 本来就是"这一轮发生了什么"的唯一出口 —— 取数、模型调用与重试、
     * 执行、挂保护单、对账**全都走它**。挂在六个节点上意味着六处各自漂移；
     * 挂在这里则**自动覆盖未来新增的每一个步骤**，一行都不用改。
     *
     * ## 归属哪一轮：用 `cyclePromise` 判断，不加任何状态位
     *
     * `cyclePromise` 非空**恰好等价于**"有一轮在跑"（`inCycle` 里赋值、`finally` 清）。
     * 所以不需要额外的 set/clear，也就没有"异常路径忘了清"的那种 bug ——
     * 轮次外的日志（启动、对账、错误）不会被误当成某轮的步骤。
     *
     * **不落库**：它只活到这一轮结束（结论由 `decision` 事件带 `executionLog` 落库）。
     */
    if (this.cyclePromise !== null) {
      eventBus.publish({
        type: 'cycle_step',
        traderId: this.deps.trader.id,
        cycleNumber: this.cycleNumber,
        level,
        message,
        at: new Date().toISOString(),
      });
    }
  }

  /**
   * 只在**状态发生变化**时记一条，状态没变就不记。
   *
   * 用于"每个周期都成立"的状态（熔断生效、候选池被预算裁剪）。它们**每轮都会
   * 再次成立**，按事件每轮写一次的结果是：日志被同一句话填满，真正的异常被埋掉
   * —— 一个每轮都响的警告等于没有警告。
   *
   * 只在**进入**该状态时记一次；状态解除后再进入会重新记一次（这正是操作者
   * 需要知道的两个时刻：什么时候开始的、什么时候结束的）。
   *
   * `key` 用来区分不同的状态位（同一个机器人可能同时有多条这类状态）。
   */
  /*
   * `level` 含 `'error'`：有些**持续成立**的状态本身就是错误的，而不是"注意一下"。
   *
   * 加这条的直接原因是总账校验（`ledger-gap`）—— 「平台的账与交易所对不上」
   * 意味着账本不可信、而 AI 正照着它决策。把这种状态降级成 `warn` 只是为了让
   * 它挤进旧签名，那是**让告警去迁就类型**，正好反了。
   */
  /**
   * 只在**状态变化**时记一条 —— 同一个 key 下内容没变就不再记。
   *
   * ## ⚠️ `stateKey`：比较用的键**不必**等于写进日志的那句话
   *
   * 原来这里拿**整条 `message`** 当比较键。那对"文本固定"的告警是对的，但对
   * **句子里带数字**的那种就失效了：数字每轮都在变，于是"状态没变就不再记"
   * 永远不成立。
   *
   * 实测的代价：总账校验那条告警的差额在 `0.0119` 与 `0.0202` 之间来回，
   * 于是它**每一轮都写一条 error** —— 从 17:17 一直刷到 18:32，上百条。
   * 而它要说的其实是同一件事（"有持仓，所以差一个未平仓的持有成本"）。
   * **一个每轮都响的告警等于没有告警**，这个文件里已经为同一件事写过三回注释。
   *
   * 所以调用方可以传一个**不含数字的稳定键**（比如 `'ledger-gap'`）；
   * 状态真正解除时由 `clearStateNotice()` 清掉，下次进入会重新记一条。
   */
  private emitOnChange(
    key: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    stateKey?: string,
  ): void {
    const probe = stateKey ?? message;
    if (this.stateNotices.get(key) === probe) return;
    this.stateNotices.set(key, probe);
    this.emit(level, message);
  }

  /** 状态解除：下一次再进入时会重新记一条。 */
  private clearStateNotice(key: string): void {
    this.stateNotices.delete(key);
  }

  /**
   * 确保账户处于**单向持仓模式**，偏离了就改回来。
   *
   * 为什么每个周期都查一遍而不是只在启动时查：见 `runCycleBody` 里调用处的注释 ——
   * 简言之，这个模式只可能被机器人之外的东西改回去，而"下不了单但状态显示
   * running"是最危险的一种故障形态。
   *
   * 日志只在**状态变化**时写：正常（本来就是单向）时一次都不写。
   */

  /**
   * 预取交易所对这批标的**实际允许**的最大杠杆。
   *
   * ## 为什么值得每轮取一次
   *
   * 官方口径：能设的最大杠杆 = min(名义价值所在档的 `initialLeverage`, 账户级限制,
   * symbol 上限)。而**账户级那一项对子账户是硬的** —— 官方 FAQ：普通用户
   * 2025-08-12 之后新建的子账户，合约杠杆**不超过 5x**。
   *
   * 也就是说：**同一份策略配置，跑在主账户上能用 20x，跑在子账户上只能 5x。**
   * 在此之前引擎只认配置值，于是模型提 20x 会被交易所拒（`-4203`/`-4209`），
   * 而它收到一句**自己无法预先算出来**的拒绝。
   *
   * ## 取舍
   *
   * `weight 1`／次，一个周期最多几个标的 —— 与"模型反复提一个注定被拒的杠杆、
   * 白烧一整轮决策"相比，这个成本可以忽略。读失败什么都不做（引擎退回只用配置上限），
   * **不会让交易停下来**。
   */
  private async prefetchLeverageCaps(symbols: readonly string[]): Promise<void> {
    const unique = [...new Set(symbols)];
    await Promise.all(
      unique.map(async (symbol) => {
        /* 同一个进程里取过一次就够了：这是交易所对账户的授信，不会几分钟就变。 */
        if (this.leverageCapCache.has(symbol)) return;
        const cap = await this.deps.broker.getMaxLeverage(symbol).catch(() => null);
        if (cap !== null && cap > 0) this.leverageCapCache.set(symbol, cap);
      }),
    );
  }

  /**
   * 参数改动的频率闸门：返回 `null` 表示放行，否则返回**要如实回喂给模型**的拒绝原因。
   *
   * 完整理由见 `applyPatch` 里那段说明 —— 一句话：决策轮每 30 分钟一轮、
   * 每轮可调 3 次，没有闸门时一天能改 144 次，参数会振荡而任何改动都来不及被验证。
   *
   * 记账放在 `settings` 里（同一前缀 `param_change:`），所以**重启不清零** ——
   * 否则一次重启就等于把配额重置，而那正是"频繁部署让抖动更严重"的形态。
   */
  private paramChangeGate(traderId: number): string | null {
    const now = Date.now();
    const recent = this.recentParamChanges(traderId, now);

    const last = recent[0];
    if (last !== undefined && now - last < PARAM_CHANGE_MIN_INTERVAL_MS) {
      const waited = Math.round((now - last) / 60_000);
      return (
        `距离上一次参数改动只过了 ${waited} 分钟（下限 ` +
        `${Math.round(PARAM_CHANGE_MIN_INTERVAL_MS / 60_000)} 分钟）—— ` +
        '请先把上一次改动的结果看完再动它：改完立刻再改，等于两次都没被检验过。'
      );
    }
    if (recent.length >= PARAM_CHANGE_MAX_PER_HOUR) {
      return (
        `这一小时已经改过 ${recent.length} 次参数（上限 ${PARAM_CHANGE_MAX_PER_HOUR}）—— ` +
        '参数不是主要矛盾，先把注意力放回这一轮的行情上。'
      );
    }
    return null;
  }

  /** 最近一小时内**成功**的参数改动时间戳（新→旧）。 */
  private recentParamChanges(traderId: number, now: number): number[] {
    try {
      const raw = settings.get(`param_change_log:${traderId}`);
      if (!raw) return [];
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && now - t < 60 * 60_000)
        .sort((a, b) => b - a);
    } catch {
      /* 读不到就当"没改过"—— 少一层限制好过让整个决策失败。 */
      return [];
    }
  }

  /** 记一次成功的参数改动（供下一轮的闸门判断）。 */
  private noteParamChange(traderId: number): void {
    const now = Date.now();
    const recent = this.recentParamChanges(traderId, now);
    settings.set(`param_change_log:${traderId}`, JSON.stringify([now, ...recent].slice(0, 20)));
  }

  private async ensurePositionMode(): Promise<void> {    const mode = await this.deps.broker.ensureOneWayMode().catch((error) => ({
      changed: false,
      warning: `无法读取持仓模式：${(error as Error).message}`,
    }));

    if (mode.changed) {
      this.emit('warn', '账户此前处于双向持仓模式，已自动改回单向 —— 否则每一笔下单都会被交易所拒绝（-4061）。');
      this.positionModeBlocked = null;
      this.clearStateNotice('hedge-mode');
      return;
    }
    if (mode.warning) {
      /*
       * ⚠️ **不只是记一条日志，还要真的拦住下单。**
       *
       * 这里原来只有 `emitOnChange(...)` + `return` —— 周期照跑，
       * 于是每一笔决策都带着 `positionSide: 'BOTH'` 撞上 `-4061`。
       * 那三行的注释早就写明了「下不了单但状态显示 running 是最危险的一种故障形态」，
       * 而当时的实现只做到了"记录"。
       */
      this.positionModeBlocked = mode.warning;
      // 改不了（有持仓或挂单）——这是**持续成立**的状态，按变化记一次。
      this.emitOnChange('hedge-mode', 'warn', mode.warning);
      return;
    }
    this.positionModeBlocked = null;
    this.clearStateNotice('hedge-mode');
  }

  /**
   * Mark a cycle as in flight for its whole duration.
   *
   * One place owns the flag and the promise so they can never disagree: the flag
   * is what stops the timer from overlapping itself, and the promise is what lets
   * `stop()` and the reconcile endpoint wait for the cycle to finish instead of
   * writing the books underneath it.
   *
   * ## ⚠️ 为什么必须有硬超时（2026-10-02 实测：卡了 8.5 小时）
   *
   * 在此之前这里是一个**无超时**的包装 —— 而 `tick()` 的第一句是
   * `if (this.cycleInFlight) return;`：**它直接返回，并且不排下一次**。
   *
   * 所以只要有一个 `await` 永远不 resolve（网络连接半死、流读不到 EOS、
   * 上游网关既不回包也不断开），就会发生这件事：
   *
   *   1. `cycleInFlight` 永远是 `true`；
   *   2. 每次 `tick` 都在第一句返回，**不排下一次**；
   *   3. 于是机器人"看起来在跑"（状态 `running`），而**实际上一轮都不再发生**。
   *
   * 实测形态：`decision_records` 从 02:06 起再没有新条目，而日志里
   * 05:22 / 06:28 / 08:23 / 09:12 都还在打 "524 重试" ——
   * **八小时半里它每 30 分钟只是"被叫醒、发现上一轮还在、然后什么都不做"。**
   *
   * `AbortSignal.timeout` 管得住 `fetch` 本身，但"读到流结束"那一步在某类连接上
   * 不保证被 abort 唤醒。**一个无超时的等待没有义务去分辨是哪种情况** ——
   * 所以这里给它一个上限：宁可让已经卡住的轮次被释放（最坏是两轮重叠，
   * 而保护单在交易所侧兜底），也不要让整个机器人静默停摆。
   */
  private async inCycle<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.cycleInFlight = true;
    let done: () => void = () => undefined;
    this.cyclePromise = new Promise<void>((resolve) => {
      done = resolve;
    });
    /*
     * ⚠️ **超时必须真的取消那一轮，而不是只放锁。**
     *
     * ## 第一版留下的隐患（2026-10-02 服务器故障当天发现）
     *
     * 第一版只是 `Promise.race([work(), timeout])` —— 超时后 `finally` 释放了
     * `cycleInFlight`，**而 `work()` 仍在后台跑**。当时的注释写的是
     * 「最坏是两轮重叠，而保护单在交易所侧兜底」—— 那句话只算了**交易风险**，
     * 没算**内存**：
     *
     *   · 一轮的提示词是 138K 字符量级 + LLM 响应 + 工具数据；
     *   · 若那一轮**永远不结束**（它正是被判定为"卡住"才超时的），
     *     它就永久持着这些内存；
     *   · 而每一轮超时都会再留下一个。今天 524 超时频繁 →
     *     **僵尸轮次累积 → 内存耗尽**。
     *
     * 这与"释放执行锁"的初衷相反：加超时是为了**避免停摆**，
     * 而它顺带引入了一条**新的崩溃路径**。
     *
     * ## 现在的做法
     *
     * 给 `work()` 传一个 `AbortSignal`，超时时 `abort()` ——
     * LLM 客户端本来就接 `AbortSignal`（它用 `AbortSignal.timeout` 管单次调用），
     * 所以这一次中止会真的把在途请求拆掉、让 `work()` 抛错并退出。
     *
     * `this.zombieCycles` 是**兜底**：即使某个 `work()` 仍然没有响应 `abort`
     * （例如卡在非网络的位置），它也会被计数；达到上限时**不再开始新轮** ——
     * 宁可短暂停摆（用户看得见、上一轮的错误会写进状态），
     * 也不要让进程被一个不断累积的泄漏拖死（那是**看不见**的）。
     */
    this.abortCurrentCycle = new AbortController();
    const signal = this.abortCurrentCycle.signal;
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          /* 真的取消在途请求 —— 不只是放弃等待。 */
          this.abortCurrentCycle?.abort();
          /*
           * 记一笔"僵尸"：abort 是请求取消而不是保证终止。
           * 若那一轮之后真的结束了，`work()` 的 `.finally` 会把它减回来。
           */
          this.noteZombieCycle();
          reject(
            new Error(
              `一轮决策超过 ${Math.round((this.deps.cycleHardTimeoutMs ?? CYCLE_HARD_TIMEOUT_MS) / 60_000)} ` +
                '分钟仍未结束，已中止该轮并释放执行锁（下一轮照常排期）。',
            ),
          );
        }, this.deps.cycleHardTimeoutMs ?? CYCLE_HARD_TIMEOUT_MS);
      });
      return await Promise.race([
        work(signal).finally(() => {
          /*
           * 那一轮真的结束了 —— 如果它曾被记成僵尸，这里撤销。
           * 正常路径下 `zombieCycles` 根本不会被加过，这个减法是无害的。
           */
          if (this.zombieCycles > 0) this.zombieCycles -= 1;
        }),
        timeout,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.cycleInFlight = false;
      this.cyclePromise = null;
      this.abortCurrentCycle = null;
      done();
    }
  }

  /**
   * 记账"一轮超时了、而它还在后台跑"。
   *
   * 与 `inCycle` 分开写，是因为它要在**超时那一刻**记账，
   * 而 `inCycle` 的 `finally` 是**立刻**执行的（`Promise.race` 抛了就走到 finally）——
   * 两者之间隔着"那一轮实际上还在不在"。
   */
  private noteZombieCycle(): void {
    this.zombieCycles += 1;
    this.emit(
      'warn',
      `有一轮决策被中止后仍未真正结束（当前 ${this.zombieCycles} 轮）。` +
        '达到 2 轮时系统会暂停开启新轮 —— 短暂停摆好过内存被累积的僵尸轮次拖死。',
    );
  }

  /**
   * 熔断器**此刻**的读数 —— 让控制台能回答"它为什么一单都不开"。
   *
   * ## 为什么需要它
   *
   * 熔断生效时，`runCycle` 会**跳过整个决策周期**（连模型都不问），只把原因写进
   * 那一轮的 `executionLog`。于是操作员看到的是：状态 **running**、决策流里一条
   * `skipped`、权益一动不动 —— 而页面上的任何一处都没有说"它被熔断了、怎么解除"。
   * 实测这件事在生产上静默持续了 15 个周期。
   *
   * ## 为什么用当前配置重算，而不是回放上一轮的结论
   *
   * 熔断可能因为**外部原因**解除（入金、或 AI 调高上限）。回放旧结论会让控制台
   * 挂着一条过期的"被熔断"，而操作员刚往账户里打了钱。
   *
   * 还没跑过任何周期时返回"未熔断" —— 那时确实没有可判定的输入，
   * 而不是"确认没有熔断"。
   */
  circuitBreakerReading(): CircuitBreakerReading {
    const input = this.lastBreakerInput;
    if (!input) return { blocked: false, kind: 'none', reason: '', drawdownPercent: 0 };

    const drawdownPercent =
      input.highWater > 0 ? Math.max(0, ((input.highWater - input.equity) / input.highWater) * 100) : 0;
    /*
     * ⚠️⚠️ **必须用 `effectiveConfig()` 而不是 `activeConfig`**（2026-10-19）。
     *
     * ## 实盘症状
     *
     * ```
     *   界面横幅：「已触发熔断，暂不开新仓…（上限 5%）」
     *   同一时刻：周期 #19 正常开仓 3 个
     * ```
     * **两处说的是不同的事** —— 因为：
     * ```
     *   决策循环（能交易）  → 用 config（JEV 覆盖后的 30%）✅
     *   这个读方法（横幅）  → 用 activeConfig（原始 5%）     ❌
     * ```
     * 用户看到横幅以为停摆，实际在交易 —— 比"真的停摆"更让人困惑。
     *
     * ⇒ 两处统一走 `effectiveConfig()`，它们从此说同一件事。
     */
    const config = this.effectiveConfig();
    const verdict = checkCircuitBreakers(config, input.equity, {
      dailyRealizedPnl: tradeStore.realizedPnlToday(this.deps.trader.id),
      highWaterEquity: input.highWater,
    });

    return {
      blocked: verdict.blocked,
      kind: verdict.kind,
      // 与 `executionLog` 用的是同一个函数 —— 两处必须说同一件事。
      reason: describeBreaker(verdict, config),
      drawdownPercent: Math.round(drawdownPercent * 100) / 100,
    };
  }

  /**
   * **本轮真正生效的配置** —— 所有地方都该读它，而不是 `activeConfig`。
   *
   * ## 为什么需要这个函数（2026-10-19 实盘两次踩坑）
   *
   * 我先后把 JEV 的覆盖写在两个地方，两次都漏了别的消费者：
   * ```
   *   第一次写在 riskConfig  → 熔断读 config，没生效（连续 4 轮白跳）
   *   第二次写在决策循环里  → circuitBreakerReading 读 activeConfig，横幅仍显示旧值
   * ```
   * 根因是同一个：**"覆盖配置"这件事没有一个统一入口**，
   * 于是每个读配置的地方都得记得自己覆盖一次 —— 漏一处就是一个 bug。
   *
   * ⇒ 现在有唯一入口：`effectiveConfig()`。
   *   `activeConfig` 只在"装配期"用，运行期一律走这里。
   */
  private effectiveConfig(): StrategyConfig {
    if (this.deps.trader.mode !== 'jev') return this.activeConfig;
    return {
      ...this.activeConfig,
      circuitBreaker: {
        ...this.activeConfig.circuitBreaker,
        maxDailyLossPercent: Math.max(0, jevNumber('max_daily_loss_percent')),
      },
    };
  }

  /**
   * 让操作员**现在**就要一次策略审视。
   *
   * ## 为什么需要它
   *
   * `triggerReview` 从写下那天起就带着 `'manual'` 这条分支，`orchestrator.ts`
   * 的注释也写着"强制唤醒（操作员点"立即分析"）"—— **但那条路径从来不可达**：
   * 三个生产调用点（本文件的 `refreshAgentState`、`manager.ts` 的接线）全都没传参数，
   * 于是永远走 `'cycle'`。注释在描述一个不存在的能力。
   *
   * 后果不是"少一个按钮"，而是**操作员在等一个不会发生的审视**：AI 只在事件
   * （连亏、被拒、新结果）或 60 分钟兜底时才醒，想让它"现在就看一眼"没有任何办法。
   * 而"AI 睡着了/它到底在想什么"恰恰是操作员最需要能确认的事。
   *
   * ## 它不绕过什么
   *
   * 让路的是冷却与事件判据（那是操作员的明确意图）；**每小时预算照旧** ——
   * 否则一个手滑的连点就能把当天的 LLM 预算烧光。
   *
   * ## 为什么返回一个"请求已发出"而不是结果
   *
   * 审视是**异步**的（可能跑几十秒），而且它仍然可能被预算挡下。所以这里只能说
   * "请求已经发出、去哪里看结果"，**不能说"它正在审视"** —— 那是编造。
   */
  requestAgentReview(): { accepted: boolean; note: string } {
    const agent = this.deps.agent;
    if (!agent) {
      return { accepted: false, note: '这个机器人不是 AI 托管模式 —— 它没有可审视的策略。' };
    }
    agent.triggerReview('manual');
    return {
      accepted: true,
      note: '已请求一次策略审视。它异步执行、且仍受每小时调用预算限制 —— 结果会出现在「最近决策」面板。',
    };
  }

  /**
   * Run exactly one cycle, outside the timer.
   *
   * Used by the console's "run now" action and by integration tests. Unlike
   * `tick()` it does not swallow failures, so a caller sees the real error.
   */
  async runOnce(): Promise<string> {
    if (this.cycleInFlight) throw new Error('上一轮决策尚未结束，请稍后再试。');
    return this.inCycle(async (signal) => {
      this.cycleNumber += 1;
      const summary = await this.runCycle(this.cycleNumber, signal);
      traderStore.recordCycle(this.deps.trader.id, this.cycleNumber, 0);
      /*
       * ⚠️ 与 `tick()` 成功分支同一处遗漏 —— `error` 也必须能回到 `running`。
       * 这两行是同一个判断的两份拷贝，理由见那一处的注释。
       */
      if (this.status === 'safe_mode' || this.status === 'error') {
        this.setStatus('running', null);
      }
      return summary;
    });
  }

  /**
   * **结清"交易所已不再挂着"的本地委托行** —— 供外部节奏调用。
   *
   * ## 为什么需要这个公开入口（2026-10-14 线上实测抓到的 BUG）
   *
   * `settleStaleOrders()` 原来只挂在**决策周期的对账**里。而线上 `#11`
   * （团队模式）实测：**36 条本地 `NEW` 委托，而交易所侧 0 条**
   *（`/fapi/v1/openOrders` 与 `/fapi/v1/openAlgoOrders` 都查过）。
   *
   * 逐条复刻它的判据，**它本来能结清全部 36 条**：
   * ```
   *   ① candidates（够老 + 非终态）      : 36 条
   *   ② activeProtectionIds（open 持仓）:  0 个
   *   ③ 交易所挂着                       :  0 条 → 可结清 36
   * ```
   * 也就是说**逻辑是对的，只是从未被执行** —— 因为团队模式的决策周期
   * 又慢又长，而结清挂在周期的对账那一步里。
   *
   * 所以给它一个**独立于决策周期**的入口，由 `manager` 的**自检循环**
   *（每 30 分钟，那条路径即使决策卡住也一定会跑）调用。
   *
   * ⚠️ 它只改账：既不撤单、也不重挂保护单，唯一依据是交易所自己说那张单还在不在
   *（见 `settleStaleOrders()` 的完整说明）。
   */
  async settleStaleOrderRecords(): Promise<number> {
    return this.settleStaleOrders();
  }

  /**
   * Run the ledger reconciliation pass, serialised against any running cycle.
   *
   * The `/reconcile` endpoint used to build a **second** `AutoTrader` over the
   * same exchange account and let it run while the live one was mid-cycle. Both
   * then reconciled the same position concurrently: both could see the position
   * gone, both could book the close, and one of them could close the local row
   * the other had just closed. Two writers, one ledger.
   *
   * Serialising means an in-flight cycle finishes (and books what it is going to
   * book) before the correction pass reads the ledger — so the pass corrects
   * rather than races.
   */
  async runReconcile(): Promise<{
    recovered: number;
    corrected: number;
    correctedAttempted: number;
    correctedKept: number;
    funding: number;
  }> {
    const idle = await this.waitForIdle();
    if (!idle) {
      // The cycle is stuck on something slow rather than finished. Skipping is
      // safe: the cycle reconciles at its own head, and this pass is a repair,
      // not a source of truth. Racing it would be the actual damage.
      this.emit('warn', '上一轮决策未在等待时限内结束，本次对账跳过，避免与交易周期并发写账。');
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **但"结清陈旧委托"必须照跑**（2026-10-14 线上实测抓到的 BUG）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故：团队模式的委托列表在骗人（本地 36 条"已挂单"，交易所 0 条）
       *
       * 线上实测（`#11`）：
       * ```
       *   本地 orders 表 status='NEW'  : 36 条
       *   交易所 /fapi/v1/openOrders   :  0 条
       *   交易所 /fapi/v1/openAlgoOrders: 0 条（9 个标的逐个查）
       * ```
       * 用户看到的是「当前委托 28 · 已挂单（待对账）」，而**交易所一张都没有**。
       *
       * ## 为什么只有团队模式出问题
       *
       * ```
       *   #10（ai_managed）: 本地 NEW 4 条 · 持仓 2   ← 正常
       *   #11（团队）      : 本地 NEW 36 条 · 持仓 0  ← 全是孤儿
       * ```
       * 因为**团队模式的决策慢**（多智能体讨论 3–5 分钟）：
       * ```
       *   决策跑不完 → `cycleInFlight` 长期为真 → 这个 `!idle` 分支一直命中
       *   → reconcileTradeHistory() 整个被跳过
       *   → 挂在它里面的 settleStaleOrders() 永不执行
       *   → 孤儿委托永远不被结清
       * ```
       * 实测日志：#11 的对账**只跑过 2 次、跳过 1 次**，而 `settleStaleOrders`
       * 的结清日志**一条都没有**。
       *
       * ## 为什么结清可以安全地跑（而整个对账不能）
       *
       * `settleStaleOrders()` 的契约（见它的注释）：
       * ```
       *   · 只改账 —— 既不补撤单、也不重挂保护单
       *   · 唯一依据是【交易所自己】说这张单还在不在
       *   · 它读挂单列表、把交易所已不挂着的本地行写成终态
       * ```
       * 也就是说它**不写任何"交易所侧的事实"**，只写"本地记录的最终状态"。
       * 而上面那个 `!idle` 守卫的目的是"**避免与交易周期并发写账**" ——
       * 那指的是**成交与持仓的账**（`trades` / `positions`），
       * 而委托行的终态是**幂等的**（`orders.update()` 只把它推向终态，
       * 重复执行结果相同）。
       *
       * ⚠️ 保守起见仍然**只跑这一件事**，不跑 `reconcileTradeHistory()` 的其余部分 ——
       * 那些确实会与周期竞争（它们改 `trades` / `positions`）。
       */
      await this.settleStaleOrders().catch((error) => {
        log.warn(
          `[${this.deps.trader.name}] 对账被跳过时结清陈旧委托失败（不影响本周期交易）：${(error as Error).message}`,
        );
      });
      return { recovered: 0, corrected: 0, correctedAttempted: 0, correctedKept: 0, funding: 0 };
    }
    return this.reconcileTradeHistory();
  }

  /**
   * 交易所刚推来一条**成交** —— 现在就把账本对齐，而不是等下一个周期。
   *
   * ## 为什么需要它（实测故障，不是设想）
   *
   * 用户数据流此前是**纯告警**：`onOrderUpdate` 只写一行日志，账本完全由每
   * `cycleIntervalMinutes`（生产里 45 分钟）一轮的周期对账刷新。于是：
   *
   *  · **交易所侧的止损/止盈触发后，账本死在上一轮周期那一刻。** 控制台在最长
   *    45 分钟里显示「当前持仓 0、委托全部待对账」，历史成交里也没有那一笔。
   *    实测 21:17:15 与 21:27:38 两笔保本止损成交，直到 21:46 操作员手动点
   *    「对账」才入账 —— 界面那 26 分钟里说的是**已经不存在的事**。
   *  · 更贵的是**入场限价单成交**：转正与挂保护单在同一段代码里
   *    （`settlePendingEntries`），而它只在周期开头跑。也就是说从成交到挂上
   *    交易所侧止损之间，敞口是**裸的**，时长等于"到下一个周期还有多久"。
   *    实测 HYPEUSDT 那一笔成交后近半小时没有任何保护单。
   *
   * 记账本身没有实时性问题，缺的只是一个**触发** —— 推送早就在手上了。
   *
   * ## 为什么不是让 WS 回调直接写库
   *
   * 因为那就成了「两个写者一个账本」。这里走 `waitForIdle()`，与
   * `runReconcile()` 同一条理由：周期正在跑时**直接返回**，它自己在这一遍里
   * 会做完全同样的事；抢进去只会让两边互相覆盖。套接字断掉也只是退回原来的
   * 行为（下一个周期对账），不会更差。
   *
   * ## 为什么这里不判断"机器人是否在运行"
   *
   * 调用方（`TraderManager.scheduleFillReconcile`）拿的是 `running` 表里的实例，
   * 停机会把还没到点的触发一并取消 —— 所以"只对运行中的机器人做"这条约束已经
   * 在唯一调用点上成立了。这里再判一次是**第二份拷贝**，而它的代价是"成交后
   * 对齐一次"这件事没法被直接调用与验证。对账本身幂等且串行，停机时多对齐一次
   * 也不是坏事。
   */
  async applyExchangeFill(): Promise<void> {
    if (!(await this.waitForIdle())) return;

    const exchangePositions = await this.effectivePositions().catch((error) => {
      log.warn(
        `[${this.deps.trader.name}] 成交后对齐账本时读持仓失败（下一个周期仍会补上）：${(error as Error).message}`,
      );
      return null;
    });
    if (!exchangePositions) return;

    await this.reconcileAgainstExchange(exchangePositions).catch((error) => {
      log.warn(
        `[${this.deps.trader.name}] 成交后对齐账本失败（下一个周期仍会补上）：${(error as Error).message}`,
      );
    });
  }

  /**
   * 把本地账本对齐到交易所 —— 周期开头那一遍的两个对账步骤，单独成一段。
   *
   * ## 为什么要抽出来
   *
   * 因为它现在有**两个触发时机**：周期开头，以及交易所推来成交的时候
   * （`applyExchangeFill`）。两处要做的必须是同一件事，而这一串的顺序是
   * **被理由锁死的**，不是随手排的：
   *
   *  · `settlePendingEntries` 必须排在 `reconcilePositions` **之前** ——
   *    前者知道那张单是我们自己挂的、以及当初打算用的止损止盈，后者只能看到
   *    "多了一个仓位"、保护单要靠猜。对调会让仓位**没有任何保护单**。
   *  · `reconcilePositions` 必须排在 `reconcileTradeHistory` **之前** ——
   *    前者能用本地仓位行定出真实的平仓原因（止损 / 止盈 / 模型主动），后者
   *    只能记成「对账补录」。对调会让真实原因永远丢失。
   *
   * 抄一份到别处就意味着这两条约束迟早只在一边成立，所以这里只留一份。
   */
  private async reconcileAgainstExchange(exchangePositions: ExchangePosition[]): Promise<void> {
    await this.settlePendingEntries().catch((error) => {
      log.warn(`[${this.deps.trader.name}] 待成交对账失败（不影响本周期其余工作）：${(error as Error).message}`);
    });
    await this.reconcilePositions(exchangePositions);

    // 历史兜底：只负责"仓位那一遍解释不了"的部分 ——
    // 进程没在跑的时候发生的平仓。它可能无事可做，这是正常的。
    await this.reconcileTradeHistory(false).catch((error) => {
      log.warn(`[${this.deps.trader.name}] 成交对账失败（不影响本周期交易）：${(error as Error).message}`);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Cycle driver                                                           */
  /* ---------------------------------------------------------------------- */

  private async tick(): Promise<void> {
    if (!this.running) return;
    // A cycle that overruns its interval must not overlap the next one — that
    // would double-count positions and duplicate orders.
    if (this.cycleInFlight) {
      this.emit('warn', '上一轮决策仍在执行，跳过本次调度');
      return;
    }
    /*
     * ⚠️ **僵尸轮次太多时不要再开新轮。**
     *
     * `inCycle` 的硬超时会 `abort()` 掉在途请求并释放执行锁；而 `abort` 是
     * **请求取消、不是保证终止**。如果某个 `work()` 卡在不理会 abort 的位置，
     * 它就永久持着那一轮的提示词（138K 字符量级）与响应。
     *
     * 累积的后果是**进程被内存拖死** —— 而那种故障在界面上看不见
     * （状态还是 running、日志还在打），比"暂停开新轮"危险得多。
     * 所以这里宁可短暂停摆：错误会写进状态、你能看见并处理。
     */
    if (this.zombieCycles >= MAX_ZOMBIE_CYCLES) {
      this.emitOnChange(
        'zombie-cycles',
        'error',
        `已有 ${this.zombieCycles} 轮决策被中止后仍未结束（上限 ${MAX_ZOMBIE_CYCLES}），` +
          '本轮不再开始新的决策 —— 继续累积会把进程的内存耗尽。' +
          '请检查数据库日志里最近那几轮的中止记录，必要时重启服务。',
      );
      return;
    }
    this.clearStateNotice('zombie-cycles');

    const traderId = this.deps.trader.id;
    /*
     * ⚠️ **这一轮是否失败** —— `finally` 里的排期据此决定用"正常周期"还是"短间隔重试"。
     * 上游偶发的 5xx/限流不该让机器人白等一整个周期（见 `scheduleNextCycle`）。
     */
    let failed = false;
    /*
     * ⚠️ **每轮开始清空"它要求的下次间隔"。**
     *
     * 如果不清：这一轮在**解析之前**就失败时（模型调用失败、行情拉不到），
     * `finally` 会读到**上一轮**留下的值 —— 于是"这轮什么都没问出来"却按
     * 上一轮的要求排期。行为上表现为"偶尔莫名其妙地变快或变慢"，
     * 而日志里看不出任何异常。
     */
    this.requestedNextCheckMinutes = undefined;

    try {
      await this.inCycle(async (signal) => {
        this.cycleNumber += 1;
        eventBus.publish({
          type: 'cycle_start',
          traderId,
          cycleNumber: this.cycleNumber,
          timestamp: new Date().toISOString(),
        });

        const summary = await this.runCycle(this.cycleNumber, signal);
        this.consecutiveFailures = 0;
        traderStore.recordCycle(traderId, this.cycleNumber, 0);
        /*
         * ⚠️ **成功一轮就要回到 `running` —— `error` 也必须能回来。**
         *
         * 这里原来只认 `safe_mode`：
         *
         *     if (this.status === 'safe_mode') this.setStatus('running', null);
         *
         * 而 `error` 是**单次**失败的标记（连续失败到阈值才升到 `safe_mode`，
         * 见下面 `catch` 里那两个分支）。于是路径是：**一次瞬时的模型输出截断
         * → 状态被设成 `error` → 永远回不去**，只有"重启机器人"能清掉它。
         *
         * 实测后果：机器人一直在正常跑（每 45 分钟一轮、不断产出决策），
         * 而 `/traders/9` 顶部挂着一条红色大横幅说它出了故障 ——
         * **界面与事实不符**，而且是一条自己不会消失的告警。
         *
         * `safe_mode` 同样该在这里恢复：一轮成功就说明"反复失败"的那个条件
         * 已经不成立了。原来只列出它的名字，是因为写这行的时候只想到了它。
         */
        if (this.status === 'safe_mode' || this.status === 'error') {
          this.setStatus('running', null);
        }

        eventBus.publish({
          type: 'cycle_end',
          traderId,
          cycleNumber: this.cycleNumber,
          summary,
          success: true,
        });
      });
    } catch (error) {
      this.consecutiveFailures += 1;
      /* ⚠️ 标记这一轮失败了：`finally` 里据此用**短间隔**重试（见 `scheduleNextCycle`）。 */
      failed = true;
      const message = (error as Error).message;
      this.emit('error', `第 #${this.cycleNumber} 轮决策失败：${message}`);
      traderStore.recordCycle(traderId, this.cycleNumber, this.consecutiveFailures);

      const threshold = this.activeConfig.circuitBreaker.safeModeAfterFailures;
      if (this.consecutiveFailures >= threshold) {
        // Repeated failures usually mean a rejected key, an exhausted balance or
        // a model outage. Stop opening new positions until something changes.
        this.setStatus('safe_mode', message);
        this.emit('error', `连续失败 ${this.consecutiveFailures} 次，已进入安全模式`);
      } else {
        this.setStatus('error', message);
      }

      eventBus.publish({
        type: 'cycle_end',
        traderId,
        cycleNumber: this.cycleNumber,
        summary: message,
        success: false,
      });
    } finally {
      /*
       * **跑完再排下一次** —— 见 `scheduleNextCycle`。
       *
       * 排在这里（`finally`）而不是成功分支里：一轮失败也必须继续跑，
       * 否则一次网络抖动会让机器人永远停在那里，而状态还显示 `running`。
       */
      /*
       * ⚠️ **把"它要求的间隔"交给排期，并立刻清空。**
       *
       * 清空是必须的：下一轮如果它没提这个要求，`undefined` 应当意味着
       * "退回配置周期"，而不是继承上一轮留下的值 —— 后者表现为
       * "偶尔莫名其妙地变慢"，而那种 bug 在日志里几乎看不出来。
       */
      const requested = this.requestedNextCheckMinutes;
      this.requestedNextCheckMinutes = undefined;
      if (this.running) {
        this.scheduleNextCycle(failed, requested);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  One full decision cycle                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * 跑一个周期，并保证**无论发生什么都写出恰好一条审计记录**。
   *
   * ## 为什么落库点必须在这里
   *
   * 原来写记录是周期里的第 11 步，位置在模型调用与执行**之后**，而且硬编码
   * `success: true, error: null`。于是任何一种中途失败 —— 模型调用抛错（欠费、
   * 被服务商拒绝、网络故障）、交易所拒单、行情取不到 —— 都会直接退出
   * `runCycle()`，**一条记录都不写**：决策流里什么都看不到。实盘上正在发生的就是
   * 这件事，一个欠费的模型供应商让每一轮都失败，而操作员在控制台上看不到任何迹象；
   * `decision_records.success` / `error` 两列从一开始就在，只是从来没有被写过。
   *
   * 现在的结构是：
   *
   *   1–12 步本体（`runCycleBody`）→ 把已经拿到的内容填进 `progress`
   *   第 11 步落库                → 本方法里**唯一**的一次 `decisionStore.log()`
   *   失败继续抛                  → `tick()` 的连续失败计数与安全模式不变
   *
   * 唯一的那次写入放在本体**之后**，是为了让"一个周期恰好一条记录"成为结构性
   * 保证：本体抛错也好、正常结束也好，都走同一个落库点。第 12 步（刷新与权益快照）
   * 因此排在落库之前执行；它只做对账与展示快照、不下任何单，所以
   * "先减少风险、后增加风险"的顺序（§2.9）没有变化。
   */
  private async runCycle(cycleNumber: number, signal?: AbortSignal): Promise<string> {
    const traderId = this.deps.trader.id;

    /*
     * 本轮**已经拿到的东西**，边走边填。
     *
     * 记录必须做到"部分成功也留痕"：如果行情与模型调用都成功了、只有执行那一步抛了，
     * 提示词、思维链、决策与执行日志还是要照样落库。等最后再拼一个完整对象做不到
     * 这一点 —— 任何一步抛错都会把后面所有字段一起丢掉，而操作员看到的又会是一条
     * "什么都没发生"的失败，正是本次要修的那个观测空洞的另一种形态。
     */
    const progress: CycleProgress = {
      systemPrompt: '',
      userPrompt: '',
      cotTrace: '',
      decisions: [],
      rawResponse: '',
      executionLog: [],
      candidateSymbols: [],
      error: null,
      aiLatencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      dataRequests: [],
    };

    /** 失败发生在哪一段。只在错误类型本身说明不了问题时才用得上（见 `describeCycleFailure`）。 */
    const state = { phase: 'bookkeeping' as CycleFailurePhase };
    /** 抛出的原始错误：记录落库之后要原样继续抛出去。 */
    let thrown: unknown = null;
    let summary: string | null = null;

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️ **先落一行"本轮已开始"，轮次末尾再补成终态**（2026-10-17，方案 A）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：订单真实存在，审计记录不存在
     *
     * 实测（`#10`，两个部署窗口）：
     *
     * ```text
     *   05:49:16 SIGTERM ← 部署；该轮已下 ZECUSDT SELL LIMIT（orders #2005, 05:46:47）
     *   06:04:02 SIGTERM ← 部署；该轮已下 INJUSDT BUY LIMIT（orders #2012, 06:00:14）
     *   decision_records ：停在 813（05:21:04）      ← 两个真实订单、零条审计记录
     * ```
     *
     * 机制：落库原来**只在轮次末尾**（本方法第 11 步，全文件唯一一次
     * `decisionStore.log()`），而一轮实测 **1304 秒（21.7 分钟）**
     * （`decision_records.ai_latency_ms`），`SHUTDOWN_DRAIN_TIMEOUT_MS` 只有 **3 分钟** ——
     * 排空等不到一轮跑完。于是**每次部署都吃掉一整轮 + 丢那一轮的全部审计**，
     * 而订单是真的发出去了。事后无法回答"这笔单为什么下"（§2.2 的留痕）。
     *
     * ## 为什么这样改（而不是改调度器或拉长排空）
     *
     * · **不改 `tick()` / `scheduleNextCycle()`**：动态验证已证明"早退 + 无条件排下一次"
     *   是对的（`void this.tick()` 之后紧跟 `scheduleNextCycle()`）；动它只会引入重复调度。
     * · **不拉长 `SHUTDOWN_DRAIN_TIMEOUT_MS`**：一轮 21.7 分钟，拉长会让**部署挂 21 分钟**，
     *   而 systemd 的 `TimeoutStopSec` 会先杀掉进程 —— 等于把问题从"丢记录"换成"部署卡住"。
     * · 所以**只改落库时机**：先写一行 pending，末尾 UPDATE 成终态。
     *
     * ## 三个必须守住的点
     *
     * ① **一轮一行**：`begin()` 用 `(trader_id, cycle_number)` 作幂等键
     *    （`decisions.findByCycle()`）；末尾只 `finish()` 那一行，**不再 insert**。
     * ② **终态更新失败不得静默**：`finish()` 返回 `{ updated }`，`false` 说明那一行
     *    已经不在了（被裁剪 / id 拿错）—— 见下面那段 warn。
     * ③ **正常路径逐字段等价**：`finish()` 的入参与原来 `log()` 的入参一一对应，
     *    写的是同一批列。区别只有一个：`timestamp` 现在记的是**轮次开始时刻**
     *    （原来记的是结束时刻），这恰恰是更准确的口径 —— 它让"这一轮什么时候开始的"
     *    在提前落库那一刻就确定下来，也让 `last_cycle_at` 与它不再混为一谈。
     *
     * ⚠️ **`pending` 行本身的价值**：一次消掉两个观测空洞 ——
     *   · 审计链：订单与"它属于哪一轮"能对上（`cycle_number` 已在行里）；
     *   · 停摆判据：能看到"这一轮正在进行中"，而不是"八小时没有新记录"。
     */
    const audit = decisionStore.begin({ traderId, cycleNumber });
    if (!audit.created) {
      /*
       * 同一 `cycle_number` 已经有行了。正常路径不该发生（周期号单调递增），
       * 它意味着**上一轮没用 `finish()` 收尾就被打断、而本轮复用了同一个号**
       * （例如进程重启后从 `last_cycle_number` 继续）。这时**复用那一行**而不是插第二行 ——
       * "一轮一行"是不变量，宁可覆盖一个未完成的形状。
       */
      log.warn(
        `[${this.deps.trader.name}] 第 #${cycleNumber} 轮已有一行审计记录（#${audit.id}），本次复用它而不是新增一行 —— ` +
          '通常意味着上一轮在收尾之前就被打断了（进程重启 / SIGTERM）。',
      );
    }

    try {
      summary = await this.runCycleBody(cycleNumber, progress, state, signal);
    } catch (error) {
      thrown = error;
      progress.error = describeCycleFailure(error, state.phase);
    }

    /* --- 11. Persist the audit record ------------------------------------ */
    // 没有硬编码的 `success`：`progress.error` 非空就是失败。"一个周期恰好一条"
    // 由"本方法只有一个写入点"保证，而不是靠调用方自觉。
    //
    // ⚠️ 2026-10-17 起这里**不再 insert**，而是把开头那一行补成终态 —— 见上面
    // `decisionStore.begin()` 那段事故说明。字段与入参逐项对应，没有少任何一列。
    const finished = decisionStore.finish({
      id: audit.id,
      ...progress,
      success: progress.error === null,
    });
    if (!finished.updated) {
      /*
       * ⚠️ **这一行没能被补完 —— 必须留痕，不能静默。**
       *
       * 两种成因：① 它被裁剪掉了（保留上限 500 行 + 每 50 次写裁一次，
       * 一轮 21 分钟的机器人不会撞上，但长期卡死再恢复时可能）；
       * ② id 被别处改写。
       *
       * 无论哪种，事实都是**这一轮的终态（决策/执行/耗时）没有落库**，
       * 而 `begin()` 那行会永久停在"进行中"的形状。用 warn 说出来，
       * 否则又变成"审计记录悄悄不完整"—— 那正是本任务要消灭的东西。
       */
      log.warn(
        `[${this.deps.trader.name}] 第 #${cycleNumber} 轮的审计记录（#${audit.id}）在收尾时已不存在 —— ` +
          '本轮的决策与执行日志**没有落库**。通常是这一行被保留策略裁掉了；' +
          '若反复出现，请检查 decision_records 的保留上限与实际周期长度。',
      );
    }

    const recordId = audit.id;
    const record = decisionStore.get(recordId);
    if (record) eventBus.publish({ type: 'decision', traderId, record });

    /*
     * 失败要**继续抛出去**。
     *
     * `tick()` 的连续失败计数、安全模式，以及操作员在日志里看到的那句话，全都建立
     * 在"runCycle 会抛错"这个前提上。在这里吞掉异常等于顺手改掉了失败策略 ——
     * 本次改动只负责把失败**记录下来**，不负责改变机器人的行为（不加退避、不熔断、
     * 不猜重试次数：供应商欠费时每一轮重试本来就是对的，充值后自然会恢复）。
     */
    if (thrown) throw thrown;
    return summary ?? '';
  }

  /**
   * 一个完整决策周期的 1–12 步本体。
   *
   * 与 `runCycle()` 分成两个方法，是为了让"记录恰好写一条"成为**结构性**保证：
   * 落库点在 `runCycle()` 里，且只有一个，本体无论抛错还是正常结束都经过它。
   * 写在一个方法里的话，异常路径就必须在本体中间再补一次写入，而"一个周期写两条"
   * 或"一条都不写"又会重新变成可能。
   *
   * 本体只额外做一件事：把已经拿到的内容填进 `progress`。行情为空这类
   * "什么也没做、但不是异常"的结束方式，把说明写进 `progress.error` 后正常返回 ——
   * **刻意不抛错**，因为抛错会推进 `tick()` 的连续失败计数并可能把机器人送进安全
   * 模式，那是行为变更；这里只补记录。
   */
  private async runCycleBody(
    cycleNumber: number,
    progress: CycleProgress,
    state: { phase: CycleFailurePhase },
    signal?: AbortSignal,
  ): Promise<string> {
    const traderId = this.deps.trader.id;

    /*
     * --- 0. AI 托管：刷新本周期生效的配置，并问一次"要不要审视" --------
     *
     * ⚠️ **必须在读配置之前**，而且只能在这里刷一次。
     *
     * 顺序错了（比如放在下面那行之后）会导致本周期用旧配置跑，
     * 而下一周期又突然换新 —— 那种"配置晚一拍生效"的行为很难追，
     * 因为每一轮看起来都正常。
     *
     * `deps.agent` 不存在时这个调用什么都没做，所以老机器人不受影响。
     */
    this.refreshAgentState();
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **JEV 模式的熔断阈值必须在这里覆盖**（2026-10-19 实盘抓到）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 我犯的错
     *
     * 我把 `circuitBreaker` 的覆盖写进了 `riskConfig`（第 4597 行那个），
     * 而**熔断读的是 `config`（这一行）** —— 两个不同的对象：
     *
     * ```
     *   config      → checkCircuitBreakers(config, ...)   熔断用这个
     *   riskConfig  → this.risk.review(decisions, {...})  风控引擎用那个
     * ```
     * ⇒ 用户在界面上把熔断从 5% 改成 30%，**界面上显示 30%，实际仍按 5% 拦**。
     *
     * ## 实盘症状
     *
     * ```
     *   10:45 部署（熔断 5% → 30%）
     *   10:54 周期15  skip_cycle「上限 5%」   ← 还在按 5% 拦
     *   11:09 周期16  skip_cycle「上限 5%」
     *   ⇒ 一天里连续 4 轮白白跳过，Jev 一次都没被问
     * ```
     *
     * ## 修法
     *
     * 在 `config` 这一层就覆盖 —— 它是本轮所有下游（熔断、风控、提示词）
     * 共同的源头。**覆盖在源头，就不会有"某条路径忘了"的洞。**
     */
    const config = this.effectiveConfig();

    /* --- 1. Authoritative account state ---------------------------------- */
    const account = await this.deps.broker.getAccountState();

    /* --- 2a. 持仓模式自愈 ------------------------------------------------- */
    /*
     * ⚠️ 这一处是**必需的**，不是保险。
     *
     * 账户一旦处于双向持仓（hedge）模式，而我们所有订单都带
     * `positionSide=BOTH`，下单就会失败：
     *
     *     Binance -4061: Order's position side does not match user's setting
     *
     * **这个模式只可能从机器人之外被改** —— 我们全仓库只有一处写它，
     * 且写的是 `'false'`（`broker.ts` 的 `ensureOneWayMode`）。
     * 也就是说：有人在币安 App 里改过，或者另一个工具在用同一个账户。
     *
     * 原来只在 `start()` 里纠正一次。于是账户被改回去之后，机器人会
     * **一直下不了单，直到下一次重启** —— 实测 17:23 那次失败时，最后一次
     * 纠正停留在 15:42，中间隔了近 1 小时 40 分钟。而它的状态仍是
     * `running`，**从监控上看不出它已经无法交易**，这比报错本身更危险。
     *
     * 现在每个周期开头检查一次。代价可以接受：`ensureOneWayMode()` 内部先调
     * `isHedgeMode()`（**1 次 API 调用**），不是双向模式就立即返回 —— 每周期
     * 1 次调用相对 2400/分钟 的权重上限可以忽略。换来的是**一个周期内自愈**。
     *
     * 只在**状态真的变化**时记日志（见 `emitOnChange`），否则又会变成每周期刷屏。
     */
    /*
     * 每 10 个周期（约 30 分钟）查一次就够 —— 持仓模式很少变，
     * 而且这个检查**会让周期多一次 API 往返**。
     *
     * 为什么不在每个周期都查：模拟盘把数天压缩进约 40 秒墙钟，
     * **它对墙钟敏感**，每周期多一次 await 会明显减少模拟出的周期数，
     * 进而让依赖价格路径的校验（止盈/止损是否触发）失去代表性。
     * 生产里这点开销可以忽略，但没必要为了可以忽略的收益去扰动验证闸门。
     *
     * 自愈时间因此是"最多 30 分钟"，而不是"直到下一次重启"（实测曾达 1 小时 40 分）。
     */
    /*
     * ⚠️ **每个周期都查。**
     *
     * 原来这里是 `if (cycleNumber % 10 === 1)`，理由是"模拟盘对墙钟敏感，
     * 每周期多一次 await 会减少模拟出的周期数"。**而那个顾虑不成立**：
     * `ensureOneWayMode()` 的第一行就是 `if (this.dryRun) return` ——
     * 模拟盘下它**根本不发请求**，连一次 await 的往返都没有。生产里那一次
     * API 往返可以忽略。所以每周期查的成本是零，而漏查的代价很大：
     *
     * 实测：账户在两次检查之间被机器人之外的东西改成双向模式，而 `#29`
     * （离上次检查 8 轮）发出了一笔真实下单 —— 交易所回 `-4061`，
     * 那笔决策白跑。**"下不了单但状态显示 running"是这个文件自己警告过
     * 最危险的故障形态，而每 10 轮一次的检查恰好留出了那个窗口。**
     */
    await this.ensurePositionMode();

    /* --- 2. Reconcile local records against reality ---------------------- */
    /*
     * ⚠️ **顺序要紧：先按仓位推断原因，再拿成交历史兜底。**
     *
     * 这两步都会把"一笔还没入账的回合"记进 `trades`，但**能给出的信息不一样**：
     *
     * · `reconcilePositions` 手上有**本地仓位行**，能用 `detectCloseReason()`
     *   判断这笔到底是触发了止损、止盈，还是模型主动平的；
     * · `reconcileTradeHistory` 只有交易所的成交记录，判断不出原因，只能记成
     *   `reconciled`（对账补录）。
     *
     * 原来的顺序是历史在前。于是**止损在交易所触发时**：历史那一遍先发现这笔
     * 未入账的回合、按 `reconciled` 记下；等仓位那一遍再跑，本地仓位已经没了、
     * 无事可做 —— **真实的平仓原因永远不会被确定**。
     *
     * 实测三笔运行中发生的平仓全部记成了「对账补录」
     * （POWERUSDT / SYNUSDT / LSKUSDT）。这不只是标签不好看：模型的
     * 「最近平仓」区块看到的是"对账补录"而不是"触发止损"，而那个区块存在的
     * 意义正是让它把**自己当时的理由**与**实际结果**对上 —— 标签错了，
     * 学习信号就废了一半。
     *
     * 对调**不降低覆盖**，三种情况都验过：
     *   · 运行中触发止损 → 仓位这一遍定出真实原因；历史那一遍被
     *     `findDuplicate()` 拦住，不会重复记账。
     *   · 进程离线期间平仓（没有本地仓位行）→ 仓位这一遍无事可做，
     *     历史那一遍照旧兜底记 `reconciled`，**行为与以前完全一致**。
     *   · 完全在两个周期之间开平 → 同上。
     *
     * `settleStaleOrders()`（结清陈旧保护单）挂在历史那一遍里，它的注释要求
     * "仓位先被处理" —— 对调之后这个前提**更强**了，仍然满足。
     */
    const exchangePositions = await this.effectivePositions();
    /*
     * ⚠️ **限价入场的对账必须排在仓位对账之前。**
     *
     * 两者都会看到"交易所上多了一个仓位"，但**知道的东西不一样**：这里知道
     * 那张单是我们自己挂的、以及当初打算用的止损止盈；`reconcilePositions`
     * 只能看到"多了一个仓位"，说不出它是怎么来的 —— 它会收养它（那是它的
     * 兜底职责），但**保护单要靠猜**。
     *
     * 先跑这里，仓位就带着它的止损止盈转正；后跑的话，这次转正会找不到
     * pending 行，而那个仓位**没有任何保护单、也没人知道它本该有一个**。
     * 那是 §2.6 说的最糟状态。
     */
    await this.reconcileAgainstExchange(exchangePositions);

    /* --- 3. Mechanical protections --------------------------------------- */
    const closedByGuard = await this.applyDrawdownGuard();
    /*
     * 保本止损与回撤守卫并列，都在问模型之前。
     *
     * 理由与 `applyDrawdownGuard` 的类注释相同：**保护已实现的利润，
     * 恰恰是模型可靠地判断错的那件事。** 而且它是纯机械的 ——
     * "浮盈达到 N% 就把止损移到成本价"没有任何需要判断的成分。
     *
     * 放在回撤守卫**之后**：那一条是"浮盈回吐太多就落袋"（平仓），
     * 这一条是"这笔不再可能亏"（移止损）。先平仓、后移止损，
     * 与 §2.9「减少风险的工作先于增加风险的工作」一致 ——
     * 虽然移止损也是减少风险，但平仓减少得更多，让它先判定。
     */
    await this.applyBreakevenGuard().catch((error) => {
      // 机械保护失败不该让整个周期失败 —— 既有的止损单仍然有效。
      log.warn(`[${this.deps.trader.name}] 保本止损检查失败（不影响本周期交易）：${(error as Error).message}`);
    });

    /*
     * --- 3.5 挂太久的限价入场单 -------------------------------------------
     *
     * 模型能撤单（`cancel_pending`），但那要求它**每轮都记得回头看**这件事 ——
     * 而"一张挂单还该不该等"恰恰是它容易往后放的那类判断。
     *
     * 与 `applyBreakevenGuard` 同一类：**保护一个已经做出的判断，恰恰是模型
     * 可靠地判断错的那件事。** "等太久了就撤"没有需要判断的成分。
     *
     * 放在机械保护这一组里、且**在问模型之前** —— 撤掉的额度可以给这一轮的
     * 新机会用（与 `ACTION_PRIORITY` 把 `cancel_pending` 排在最前同一个理由）。
     */
    await this.expireStalePendingEntries().catch((error) => {
      log.warn(`[${this.deps.trader.name}] 挂单超时检查失败（不影响本周期其余工作）：${(error as Error).message}`);
    });

    /* --- 4. Circuit breakers --------------------------------------------- */
    /*
     * The watermark is the *realised* peak, not the mark-to-market peak.
     *
     * `account.equity` is margin balance, so it carries the open positions'
     * unrealised PnL. Feeding that into the watermark made one unrealised spike
     * permanent: price wicks up, the watermark records the wick, price comes
     * back, and every following cycle reports a drawdown that never happened —
     * so `maxTotalDrawdownPercent` blocks every new entry for good, with only a
     * log line to say why.
     *
     * The current figure stays `account.equity` on purpose: an *open* loss is
     * real money at risk, and a guard that only noticed closed losses would let
     * the account bleed through a single losing position. What must not inflate
     * the peak is unrealised *profit*.
     */
    const highWater = equityStore.realizedHighWaterMark(traderId);
    const breaker = checkCircuitBreakers(config, account.equity, {
      dailyRealizedPnl: tradeStore.realizedPnlToday(traderId),
      highWaterEquity: highWater,
    });
    /*
     * 留下这一份输入，供 `/stats` 回答"它为什么一单都不开" —— 见字段上的说明。
     * 只记输入、不记结论：结论在读取时按**当前**配置重算。
     */
    this.lastBreakerInput = { equity: account.equity, highWater };
    if (breaker.blocked) {
      // 每轮都成立的**状态**，只在进入时记一次（详见 emitOnChange 的说明）。
      this.emitOnChange('circuit-breaker', 'warn', breaker.reason);
    } else {
      // 解除：先记一条"恢复"，再清掉状态，这样"什么时候恢复的"也有记录。
      if (this.stateNotices.has('circuit-breaker')) {
        this.clearStateNotice('circuit-breaker');
        this.emit('info', '熔断已解除，恢复正常决策。');
      }
    }

    /* --- 5. Refresh state after the guard's closes ----------------------- */
    const livePositions = await this.effectivePositions();
    const localPositions = positionStore.open(traderId);

    /*
     * 熔断生效 + 手上没有任何仓位 = 本轮**不可能**有任何可执行的动作，
     * 因此跳过这一轮的全部昂贵工作。
     *
     * 为什么以前不是这样：熔断在步骤 4 检查，却到步骤 8 才真正拦截决策 ——
     * 中间隔着"抓 11 个标的的行情（每个约 5,159 tokens）+ 构建 5.8 万 token
     * 提示词 + 请求模型"。于是熔断生效期间，每个周期都在**付费生成一批注定被
     * 丢弃的决策**。实测：约 134 万 tokens/小时，产出为零，而熔断按"单日"
     * 计算，可能持续数小时。
     *
     * ⚠️ 条件必须是「**且没有任何仓位**」，不能只看熔断：
     * 熔断只拦新开仓，**不拦平仓**。有仓位时模型必须继续跑，因为它的决策里
     * 可能有平仓 —— 那时省下的钱会变成没平掉的风险敞口。
     *
     * 本地与交易所两边的持仓都为空才跳过：两边不一致时保守地照常跑，
     * 宁可多花一次调用的钱，也不要跳过一轮本该处理的对账/平仓。
     *
     * 早退方式与"行情为空"一致：写进 `progress.error` 后**正常返回**，
     * 不抛错，所以连续失败计数与安全模式完全不受影响。
     */
    /*
     * 每小时开仓额度是否已用满。
     *
     * 在**跳过判据之前**读，而不是等到组装提示词时 —— 判据要用它。
     * 只能读一次：分头读会得到两个可能不一致的数字，而"模型看到 2/3、
     * 风控按 3/3"这种不一致会让模型提出注定被拒的请求。
     */
    const entriesLastHour = tradeEvents.entriesThisHour(traderId);
    const quotaExhausted = entriesLastHour >= config.throttle.maxEntriesPerHour;

    if ((breaker.blocked || quotaExhausted) && livePositions.length === 0 && localPositions.length === 0) {
      await this.recordEquity(account, livePositions);
      /*
       * ⚠️ 说明写进 `executionLog`，**不写 `progress.error`**。
       *
       * `progress.error` 的契约是「非空即代表本轮失败」（`success: progress.error === null`）。
       * 而熔断拦住开仓**不是失败，是系统在正常工作** —— 往失败字段里塞正常状态，
       * 会让成功率统计虚低、让监控把正常状态报成故障，然后有人去追一个不存在的
       * 问题。这类"语义用错字段"的代价，比一次多花的模型调用钱更贵。
       *
       * `executionLog` 是记录"这一轮实际发生了什么"的地方，而 `skipped`
       * 正是它的合法取值之一（与熔断拒绝决策时用的是同一个状态）。
       */
      /*
       * 说清**是哪个条件**触发的跳过，并给出解除它的条件。
       *
       * ⚠️ **三种情况的解除方式各不相同，不能合并成一句。**
       *
       * 这段注释原来写的是"两个条件"（熔断 / 额度）—— 但**熔断自己就有两种**，
       * 而它们的解除方式完全不同：
       *
       *   · `daily_loss`     —— 按单日结算，跨过零点自动恢复
       *   · `total_drawdown` —— **没有"按日"这个概念**：它比较的是历史最高水位与
       *     当前权益，要等权益涨回门槛以内才解除。**而空仓时权益不会自己变化，
       *     所以它不会自行恢复** —— 需要操作员处理
       *   · 额度            —— 按小时滚动
       *
       * 实测代价：一个被**总回撤**熔断的机器人，连续 15 个周期每一轮都在
       * `executionLog` 里写着「熔断按单日结算，跨过零点后自动恢复」。
       * 那句错误的信息会让操作员**安心地不去处理**，而它永远不会恢复 ——
       * 这比不写原因更糟。
       */
      /*
       * 一句话说清"为什么被拦、以及怎么解除"。
       *
       * `describeBreaker` 与 `/stats` 那边共用 —— **两处必须说同一件事**，
       * 否则操作员会在面板上看到一种说法、在决策流里看到另一种。
       */
      const why = breaker.blocked
        ? describeBreaker(breaker, config)
        : `本小时开仓额度已用满（${entriesLastHour} / ${config.throttle.maxEntriesPerHour} 笔），` +
          '额度按小时滚动，最迟下一个整点恢复。';

      progress.executionLog = [
        {
          action: 'skip_cycle',
          symbol: '—',
          status: 'skipped',
          detail:
            `${why}且当前没有任何持仓。` +
            '本轮没有向模型提问、也没有下单 —— 此时模型不可能给出任何可执行的动作，' +
            '跳过请求是为了不产生无谓的 token 开销。',
        },
      ];
      return breaker.blocked ? '熔断生效且空仓，本轮跳过模型请求。' : '本小时额度已满且空仓，本轮跳过模型请求。';
    }

    /* --- 6. Candidate universe + market snapshots ------------------------ */
    // 从这里到快照就绪之间抛出的都是普通 `Error`（行情层不发明错误类型），
    // 失败说明里的类别全靠这个阶段标记。
    state.phase = 'market';
    const held = localPositions.map((p) => p.symbol);

    /*
     * --- 6.0 取全市场视图（**必须在选币之前**）----------------------------
     *
     * ⚠️ **顺序是有原因的**：第 2 层「深潜」只能放 15-20 个标的，而 8 个榜合起来
     * 有几十个名字。所以"该给谁完整行情"需要一个依据 —— **多个榜同时指向的那个**
     * （既在涨幅榜又在波动率榜 = 涨得多**且**在剧烈波动），比只在成交额榜里
     * 出现（大盘币人人都能上）更值得看。
     *
     * 要算这个共识就得**先有榜**，而榜要并进候选池就得在 `selectCandidates` **之前**取。
     * 两者都走 `getUniverse()` 的**缓存**，所以提前取**不产生额外请求**。
     */
    const marketOverview = await this.deps.marketData.fullMarketOverview().catch((error) => {
      log.warn(`全市场概览拉取失败（本轮不渲染这一段）：${(error as Error).message}`);
      return [];
    });
    const rankings = await this.deps.marketData
      .topRankings({ minQuoteVolume24h: config.coinSource.minQuoteVolume24h })
      .catch((error) => {
        log.warn(`市场聚焦榜拉取失败（本轮不渲染这一段）：${(error as Error).message}`);
        return undefined;
      });

    /*
     * ⚠️ **共识标的** —— 出现在**两个以上**榜里的那些。
     *
     * 它只是**排序依据**，不是"推荐"：单榜标的仍然在候选池里（只是排在后面），
     * 因为"哪些不值得看"该由模型决定（用户原则：**模型是大脑，系统只是手脚**）。
     * 这里只把**共振度 ≥2 的几个**强制请进深潜层 —— 它们最可能在预算裁剪里被挤掉。
     */
    const consensusSymbols = rankings
      ? rankConsensus({
          boards: [
            { label: '成交额', symbols: rankings.quoteVolume.map((r) => r.symbol) },
            { label: '涨幅', symbols: rankings.gainers.map((r) => r.symbol) },
            { label: '跌幅', symbols: rankings.losers.map((r) => r.symbol) },
            { label: '波动率', symbols: rankings.volatility.map((r) => r.symbol) },
            { label: '资金费极值', symbols: rankings.fundingExtreme.map((r) => r.symbol) },
          ],
          limit: CONSENSUS_LIMIT,
        })
          .filter((r) => r.boards >= 2)
          .map((r) => r.symbol)
      : [];

    /*
     * ⚠️ **模型上一轮点名的标的也进候选池**（第 3 层「索取」的下半段）。
     *
     * 候选池**每轮重选** —— 模型这一轮从「全景」或 `screen_symbols` 里发现的东西，
     * 若不点名，下一轮就不在了。这个清单就是让**它的发现留下来**
     * （用户的原则：模型是大脑，系统只是手脚）。
     *
     * 它和 `held`（持仓）、`consensusSymbols`（共识）走同一条路：都通过 `mustInclude`
     * 强制进池，并在 `selectCandidates` 的裁剪里被 `mustKeep` 保护 ——
     * 否则"点名了却被预算裁掉"与没点名完全一样，而模型无从知道。
     */
    const watchedBefore = readWatchlist(traderId);
    const watched = watchlistSymbols(watchedBefore);
    /*
     * 用完就把这份清单往前推一轮：到期的（remaining 到 0）自动消失。
     * **递减而不是清空**是有意的 —— 它连续几轮盯同一个标的是常态，
     * 每轮都要求它重新点名是多余的（而且它不一定记得）。
     */
    if (watchedBefore.length > 0) writeWatchlist(traderId, decayWatchlist(watchedBefore));

    const selection = await selectCandidates(config, this.deps.marketData, {
      /*
       * ⚠️ **只有持仓是"必保"的** —— 模型必须能管理自己手上的东西，
       * 裁掉它就只能盲目持有。
       */
      mustInclude: held,
      /*
       * ⚠️ 共识标的与模型点名的是**优先**，不是必保 —— 见 `coins.ts` 里 `preferred`
       * 的说明。第一版把它们塞进了 `mustInclude`，于是 `mustKeep` 替它们占位、
       * 裁剪再也裁不到，候选池**无声膨胀**：实测 20 → 25 个、
       * 提示词 229,567 → 288,523 字符、决策耗时 145 → 397 秒（6.6 分钟）。
       *
       * **优先 ≠ 必保**：它们排在最前、最可能进池，但预算不够时让位。
       */
      preferred: [...consensusSymbols, ...watched],
      /* 候选池的大小直接由它决定 —— 见构造函数里 `promptBudget` 的说明。 */
      budgetTokens: this.promptBudget,
      /*
       * ── **漏斗每层的淘汰写进日志**（2026-10-12 接线）──────────────────────
       *
       * 用户的要求：
       * > 「交易所有 500 个可以交易的币……**层层筛选**」
       *
       * 而"层层筛选"要真的有用，操作员必须能回答一个问题：
       * **「我的币为什么没被看到？」**
       *
       * 若不写日志，漏斗就是一个**黑盒** —— 用户看到候选池里只有 8 个标的，
       * 却不知道那 8 个是怎么从 500 个里选出来的、更不知道自己关心的那个
       * 死在哪一层。那正是"感觉不是给人看的"。
       *
       * 只在 `funnel` 模式下会触发（另两种模式走 `coinpool`，不传这个回调）。
       */
      onFunnelReport: (stages, survivors) => {
        const detail = stages
          .map((s) => `${s.name}: ${s.input}→${s.output}（淘汰 ${s.dropped}）`)
          .join(' · ');
        /*
         * ⚠️ 用 `this.emit()` 而不是 `runtimeLogs.write()` —— 见 `emit()` 的说明：
         * **只走 logger 这一条路径**，否则一条日志会变成两条库记录加两个前端事件
         *（界面上同一句话出现两遍），而且归属还对不上。
         */
        this.emit('info', `[漏斗] ${detail} · 最终 ${survivors} 个候选`);
      },
    });

    let snapshots = await this.deps.marketData.buildSnapshots(
      selection.symbols,
      config.indicators,
      selection.sourcesBySymbol,
    );

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  **P3：让 Jev 参与选币**（2026-10-19 用户要求）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 用户原话：
     * > 「加一个让 JEV 自己选」
     * > 「我感觉 P3 可以做，这模型成本忽略不计了」
     *
     * ## 三种模式（用户可在「JEV 模式」标签里切换）
     *
     * ```
     *   code   → 完全不调 Jev（默认，零额外成本）
     *   hybrid → 代码先筛（成交额+OI）→ Jev 打分 → 机会差时收缩候选
     *   jev    → 同上（候选池已由策略决定）
     * ```
     *
     * ## ⚠️ 为什么做的是「整体机会闸门」而不是"逐个挑选"
     *
     * 实测发现：`score` 是对**整段 state** 打分，不是对 state 里每一项分别打分。
     * 要让每个标的有独立分数必须**每个问一次**（N 次调用，成本线性上升）。
     *
     * ⇒ 本实现做「整体机会质量闸门」：
     * ```
     *   Jev 说"今天整体没机会" ⇒ 收缩候选（省掉后续 N 次逐币问询）
     *   Jev 说"有机会"        ⇒ 保留原顺序
     * ```
     * 真正的"逐个挑选"仍然发生在后面的 `decideForCandidate`（每标的问 5 个问题）。
     * 这比"假装能给每个标的打分"诚实，而且省 token。
     *
     * ## 失败时
     *
     * Jev 调用失败 ⇒ **保留原始候选**（不收缩、不中断）。
     * 选币失败不该让整轮没有候选 —— 那会让机器人静默停摆。
     */
    if (this.deps.trader.mode === 'jev') {
      const selectMode = jevEnum('coin_select');
      
      if (selectMode !== 'code') {
        const jevRerank = this.deps.model as {
          rerankByJev?: (
            candidates: ReadonlyArray<{
              symbol: string;
              price: number;
              change24hPercent: number;
              atr: number;
              rsi7?: number;
            }>,
            keepTop: number,
          ) => Promise<{ symbols: string[]; failed: boolean }>;
        };
        if (typeof jevRerank.rerankByJev === 'function') {
          const keepTop = Math.max(1, Math.floor(jevNumber('max_candidates')));
          const result = await jevRerank.rerankByJev(
            snapshots.map((snap) => {
              const atrKey = Object.keys(snap.primary.atr)[0];
              const rsiKey = Object.keys(snap.primary.rsi)[0];
              return {
                symbol: snap.symbol,
                price: snap.price,
                change24hPercent: snap.priceChangePercent24h,
                atr: atrKey !== undefined ? (last(snap.primary.atr[atrKey] ?? []) ?? 0) : 0,
                rsi7:
                  rsiKey !== undefined
                    ? (last(snap.primary.rsi[rsiKey] ?? []) ?? undefined)
                    : undefined,
              };
            }),
            keepTop,
          );
          if (result.symbols.length > 0 && result.symbols.length < snapshots.length) {
            const kept = new Set(result.symbols);
            const before = snapshots.length;
            snapshots = snapshots.filter((snap) => kept.has(snap.symbol));
            this.emit(
              'info',
              `[Jev模式] 选币（${selectMode}）：${before} 个候选 → ${snapshots.length} 个`,
            );
          } else if (!result.failed) {
            this.emit(
              'info',
              `[Jev模式] 选币（${selectMode}）：Jev 认为整体有机会，保留全部 ${snapshots.length} 个候选`,
            );
          }
        }
      }
    }

    /*
     * --- 预取交易所的杠杆上限 --------------------------------------------
     *
     * 风控引擎的 `exchangeMaxLeverageOf` 是**同步**的（引擎不 await），所以档位
     * 必须在进入风控之前取好 —— 放到"用到时再取"已经晚了，那时在引擎内部。
     *
     * **只为本轮候选取**：一个周期最多几个请求（weight 1/次），而它决定
     * "模型提的杠杆到底能不能设" —— 子账户是 5x、名义价值分档还会更低。
     * 读失败不影响任何事（引擎退回只用配置上限）。
     */
    await this.prefetchLeverageCaps(snapshots.map((s) => s.symbol));

    /*
     * ⚠️ **把"交易所对这个账户的实际授信"交给模型**（不只是喂给风控钳制）。
     *
     * 币安：`能设的最大杠杆 = min(名义档位 initialLeverage, 账户级限制, symbol 上限)`，
     * 而**账户级那一项对子账户是硬的** —— 新建子账户不超过 5x，主账户通常远高于此。
     * 这个数原来只喂给风控引擎（下面的 `exchangeMaxLeverageOf`），**从没进过提示词**，
     * 于是模型只看到配置里写死的 5x，永远不会想到"交易所允许更高，我可以调上去"。
     *
     * 用户 2026-10-01 准备换主账户，明确要求"不要 AI 不知道能挂更高"。
     *
     * 只报**本轮候选**的授信（不是缓存里所有历史标的）：提示词里多一行无关标的
     * 就多一分噪声，而模型只会对候选下注。
     */
    const leverageCaps: Record<string, number> = {};
    for (const s of snapshots) {
      const cap = this.leverageCapCache.get(s.symbol);
      if (cap !== undefined && cap > 0) leverageCaps[s.symbol] = cap;
    }

    /*
     * 候选评分门槛 —— 在**构建提示词之前**筛掉不值得看的标的。
     *
     * 实测单次决策的提示词是 69,678 字符 / 48,005 tokens，而其中相当一部分是陪跑的。
     * 门槛为 0 时这条完全不动（既有策略行为不变）。
     *
     * ⚠️ 没有分数的快照**放行**，不是滤掉：
     * 那种情况说明评分路径没跑到（比如调用点不同），
     * 而**宁可多看一个，也不要把可能的机会静默丢掉** —— 后者是看不见的损失。
     *
     * 被滤掉的写进进度与决策记录，**不是静默丢弃** ——
     * 门槛太严会让机器人不交易，而那正是这个系统里最难发现的一类失效。
     */
    const gate = config.coinSource.minScore;
    let gateDropped: string[] = [];
    if (gate > 0) {
      /*
       * ⚠️ **持仓标的永远不参与评分门槛。**
       *
       * 门槛回答的是"这个标的值不值得**开**新仓"，而"要不要继续持有/平掉"
       * 是另一个问题 —— 那个决定必须基于真实行情，不该因为"它现在的分数低"
       * 而连看都不看。
       *
       * 原来的写法会把持仓标的也滤掉，后果是一串连锁：
       *
       *   1. 被滤掉的标的不在 `snapshots` 里 → `snapshotBySymbol` 里没有它；
       *   2. `toPositionView()` 取不到快照，`markPrice` **回落到开仓价**
       *      （`snapshot?.price ?? row.entry_price`），于是**未实现盈亏算成 0**；
       *   3. 模型看到的是"这笔持仓浮盈 +0.00"，而它可能正在亏 —— **假事实**；
       *   4. 若所有候选都被滤掉，`snapshots.length === 0` 会直接早退，
       *      **那一轮连持仓都不管**。
       *
       * 门槛越严，这个洞越容易踩到 —— 而"机器人不交易"正是这个系统里
       * 最难发现的一类失效（见下面 gateDropped 的注释）。
       */
      const heldSymbols = new Set(held);
      const kept = snapshots.filter(
        (s) => heldSymbols.has(s.symbol) || (s.score ? s.score.total >= gate : true),
      );
      gateDropped = snapshots
        .filter((s) => !heldSymbols.has(s.symbol) && s.score && s.score.total < gate)
        .map((s) => s.symbol);
      if (gateDropped.length > 0) {
        this.emitOnChange(
          `score-gate:${gate}`,
          'info',
          `评分门槛 ${gate}：滤掉 ${gateDropped.length} 个标的（${gateDropped.slice(0, 6).join('、')}${gateDropped.length > 6 ? ' 等' : ''}），保留 ${kept.length} 个。持仓标的不参与门槛。`,
        );
      }
      snapshots = kept;
    }

    /*
     * ⚠️ **标上"当前账户规模能不能开这个标的"** —— 见 `MarketSnapshot.tradability`。
     *
     * 实测（2026-09-30）：`#1462` 里模型提 BTCUSDT 被交易所下限直接拒掉
     * （「仓位名义价值 $20.00 低于最低要求 $50.00」），而 BTC 每轮都在候选**第一位**、
     * 拿着约 10KB 的完整多周期序列 —— 那些数据它永远用不上。
     * 标上之后 `prompt.ts` 只给它摘要并写明原因：大盘背景还在，浪费没了。
     */
    this.annotateTradability(snapshots, account.equity);

    progress.candidateSymbols = snapshots.map((s) => s.symbol);
    /*
     * ⚠️ 同时记给**后台监控**用（`candidateWatchSymbols()`）——
     * 它每 60 秒跑一次，而候选池每 15 分钟才算一次，所以这里存一份快照。
     * 见 `lastCandidateSymbols` 的说明（为什么复用而不是重算）。
     */
    this.lastCandidateSymbols = progress.candidateSymbols;

    if (snapshots.length === 0) {
      await this.recordEquity(account, livePositions);
      /*
       * 行情为空同样要留下记录 —— 这是本次修复要补的观测空洞的第二种形态：
       * 一个什么都没做的周期在决策流里也必须看得见。写进 `progress.error`
       * 之后**正常返回**而不是抛错，连续失败计数与安全模式因此完全不变。
       *
       * ## ⚠️ 但"没有行情"有三个完全不同的原因，不能只报一句话
       *
       * 原来这里一律写 `MARKET_DATA_UNAVAILABLE_MESSAGE`，而那段话把原因归给
       * 「通常是交易所行情接口暂时不可用……请检查网络与交易所连通性」。
       *
       * 实测代价：一个新建的机器人，币种来源是默认的「固定清单」而清单是**空的**
       * —— 它每轮都选不出任何标的，日志却说"检查网络"。而那段话把操作员（以及
       * 读同一份日志的 AI）指向了错误的方向：网络是通的，是**配置从来没被填过**。
       *
       * 三种原因要操作员做的事完全不同，所以分开报：
       *   · 选币本身为空 + 固定清单为空 → **去填清单**（配置问题）
       *   · 选币本身为空 + 其它来源     → **去放宽门槛**（门槛问题）
       *   · 选出了标的但拿不到行情     → 这才是网络/接口问题
       */
      const source = config.coinSource;
      const staticListEmpty = source.sourceType === 'static' && source.staticCoins.length === 0;
      if (selection.symbols.length === 0) {
        progress.error = staticListEmpty
          ? '选币结果为空：币种来源是「固定清单」，而清单里一个币种都没有 —— 到「策略工作室」把清单填上，' +
            '或把来源改成「币池」。这不是行情接口的问题，下一轮也不会自己好转。'
          : `选币结果为空：来源「${source.sourceType}」本轮没有选出任何标的` +
            `（24h 成交额门槛 ${source.minQuoteVolume24h}、持仓量门槛 ${source.minOpenInterestUsd} —— ` +
            '可能是门槛把全部候选滤掉了）。到「策略工作室」放宽门槛。';
      } else if (gateDropped.length > 0 && gateDropped.length >= selection.symbols.length) {
        progress.error =
          `选币选出了 ${selection.symbols.length} 个标的，但全被评分门槛 ${gate} 滤掉 —— ` +
          '门槛设得比这批标的的实际得分还高，机器人会一直不交易。把「候选评分门槛」调低或设为 0（关闭）。';
      } else {
        progress.error = MARKET_DATA_UNAVAILABLE_MESSAGE;
      }
      return '没有可用的行情数据，本轮未产生任何决策。';
    }

    const snapshotBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));
    /*
     * **把这一轮的价格记成剧变基准**（2026-10-13）。
     *
     * ⚠️ 基准必须**跟着评估走** —— 语义是"从现在开始，涨跌多少才值得再看一眼"。
     * 若不更新，一个持续偏离的价格会让监控每轮都触发（同一件事重复唤醒）。
     */
    this.rememberMoveBaseline(snapshots.map((s) => ({ symbol: s.symbol, price: s.price })));

    /* --- 7. Ask the model ------------------------------------------------ */
    const promptPositions = this.buildPromptPositions(localPositions, snapshotBySymbol);
    const oiRanking = config.indicators.enableOiRanking
      ? await this.deps.marketData.getOiRanking(15).catch(() => [])
      : [];

    /*
     * ⚠️ 第 0 层「全景」与第 1 层「聚焦」的取数**已经在前面（6.0）做完了** ——
     * 因为"共识标的"要用榜，而共识要在选币之前算出来。
     * 两个都在 `marketOverview` / `rankings` 变量里，这里不再重复取。
     */

    /*
     * 最近成交**只读一次**，两个用途共用：按标的聚合的「本平台历史」，以及往返成本。
     * 分头读会多打一次库，而且两份数据理论上可能不一致。
     */
    const recentTrades = tradeStore.list(traderId, 500);

    /*
     * ⚠️ **第 1 层第七个维度「本平台历史」**：按标的聚合本平台自己的成交。
     *
     * 它是八个维度里唯一"关于自己"的 —— 交易所只给市场数据，而"我在这里做过几笔、
     * 结果如何"只有平台知道。样本量门槛 3 笔：更少的样本里，胜率只是噪声。
     * 上限 6 行（两端各 3）：再多会挤掉真正该看的东西。
     */
    const platformHistory = rankPlatformHistory({
      trades: recentTrades.map((t) => ({ symbol: t.symbol, netPnl: t.netPnl })),
      minTrades: 3,
      limit: 6,
    });

    /*
     * ⚠️ **往返成本**：模型那类「保本/锁盈上移」规则的判据是**价格浮盈 %**，
     * 而它把止损移到"比入场价好一点点"时，那"一点点"必须覆盖这个数 ——
     * 否则被扫掉就是净亏，与方向判断对不对无关（那是算术）。
     *
     * 实测 2026-09-30 ZECUSDT：止损上移到只锁 0.048%，而往返成本 0.070%
     * → 毛 +0.0042、手续费 0.0148 → **净 -0.0106**。
     * 模型自己的复盘两次都写了这条教训，但**决策那一刻它手里没有这个数字**。
     */
    const roundTripCostPercent = averageRoundTripCostPercent(
      recentTrades.map((t) => ({ entryPrice: t.entryPrice, quantity: t.quantity, fee: t.fee })),
    );

    /*
     * ⚠️ **挂单成交统计**：模型看不到自己的挂单成效。
     *
     * 用户 2026-10-01 观察到「每次开单都是限价单…经常挂了都无法成交…好像在浪费时间和 token」，
     * 而真实数据证实了：**限价入场单撤单率 64%**（78 撤 / 44 成交），市价单 100% 成交。
     *
     * 它知道"挂满 N 分钟会自动撤"这条规则，但从没看到"我过去挂的单六成都没成交" ——
     * 于是每轮都在重复"挂回踩位 → 超时撤掉 → 下一轮再挂"。
     */
    const entryOrders = orderStore
      .list(traderId, 300)
      .filter((o) => o.purpose === 'entry')
      .map((o) => ({
        type: o.type,
        status: o.status,
        waitMinutes:
          o.createdAt && o.updatedAt
            ? (Date.parse(o.updatedAt) - Date.parse(o.createdAt)) / 60_000
            : null,
      }));
    /*
     * ⚠️ **被撤的限价单：撤单之后价格有没有回到那个挂价位。**
     *
     * ## 这是 2026-10-02 补的一列，它推翻了一句原来写在提示词里的结论
     *
     * 原文说被撤是因为"挂价离当时的市价偏远"。而实测最近 10 张被撤的限价单：
     *
     *     未触及（撤对了）        2 张
     *     撤后价格又回到挂价位    8 张   ← **80%**
     *
     * **它挂的价大多数是对的，是撤得太早。** 它撤单的理由永远是「45 分钟时限内
     * 预期走不到」—— 而现实给了 24 小时。
     *
     * ## 代价与上限
     *
     * 每张要一次 K 线请求，所以**只查最近 3 张**（一轮最多 3 个请求，
     * 相对 2400/分钟的权重上限可以忽略）。查不到就跳过 —— 统计少一张样本，
     * 也好过让这一轮因为一个附加统计而失败。
     */
    const canceledChecks: Array<{ wouldFill: boolean }> = [];
    for (const order of orderStore
      .list(traderId, 300)
      .filter(
        (o) =>
          o.purpose === 'entry' &&
          String(o.type).toUpperCase() === 'LIMIT' &&
          String(o.status).toUpperCase() === 'CANCELED' &&
          typeof o.price === 'number' &&
          o.price > 0 &&
          o.updatedAt,
      )
      .slice(0, 5)) {
      try {
        const since = Date.parse(String(order.updatedAt));
        /*
         * 拉最近 500 根 15m（≈ 5 天），再**按时间过滤出撤单之后**的那些 ——
         * `getKlines` 不接受起始时间，过滤必须自己做。
         *
         * ⚠️ **窗口为什么要 5 天而不是 1 天**：第一版只拉 96 根（24 小时），
         * 实测线上"检查了最近 **1** 张" —— 因为那 63 张撤单大多发生在更早，
         * 一根都没进窗口。**一个样本的统计等于没有统计**，而它会把
         * "0%" 当成事实读进去（那比不显示更糟）。
         *
         * 500 根是一次请求（币安单次上限 1500 根），权重代价可以忽略。
         */
        const candles = await this.deps.marketData.getKlines(
          String(order.symbol),
          '15m' as Timeframe,
          500,
        );
        const after = candles.filter((k) => Number(k.closeTime) >= since);
        if (after.length === 0) continue;
        const limitPrice = Number(order.price);
        canceledChecks.push({
          wouldFill: after.some((k) => limitPrice >= k.low && limitPrice <= k.high),
        });
      } catch {
        /* 读不到就少一个样本 —— 不让一个附加统计影响这一轮。 */
      }
    }
    const entryStats = entryFillStats(entryOrders, canceledChecks);

    /*
     * ⚠️ **连续多少轮没开过一次仓** —— 从最近的决策记录倒着数。
     *
     * 模型每次亏损复盘都会加一条"这种情况别做"（那是对的），而**规则只增不减**：
     * 可做集合随时间单调收缩。实测 2026-10-01 连续 10+ 轮 0 开仓、最近一次成交在 21 小时前，
     * 而它**看不见这件事** —— 每一轮的思考都是局部的。
     *
     * 上限 40 轮：再往前数没有意义（那超出了提示词要提醒的范围），
     * 而且 `decisionStore.list` 本身有分页上限。
     */
    let idleCycles = 0;
    for (const record of decisionStore.list(traderId, 40)) {
      const taken = (record.decisions ?? []).some((x) => String(x.action).startsWith('open'));
      if (taken) break;
      idleCycles += 1;
    }
    const idleSince = decisionStore.list(traderId, Math.max(1, idleCycles))[idleCycles - 1];
    const idleNetPnl =
      idleSince === undefined
        ? undefined
        : recentTrades
            .filter((t) => t.closedAt !== null && Date.parse(String(t.closedAt)) >= Date.parse(String(idleSince.timestamp)))
            .reduce((sum, t) => sum + t.netPnl, 0);

    /*
     * 本小时的已开仓数只读一次，两处用同一个数：提示词的「本周期约束」区块与风控的
     * `entriesLastHour`。分头读会得到两个可能不一致的数字，而模型看到 2/3、风控按 3/3
     * 拒绝，正是"看不见的约束"换一种形态。
     */
    // 已在步骤 4 之前读取（跳过判据要用），此处不再重复读 —— 分头读会得到两个可能不一致的数字。
    const memory = this.buildPromptMemory(
      traderId,
      config,
      entriesLastHour,
      snapshots.map((s) => s.symbol),
    );

    const promptContext = {
      traderName: this.deps.trader.name,
      cycleNumber,
      now: new Date(),
      config,
      /*
       * **交易所对这个标的的最小名义额**（2026-10-12 修一个真 BUG）。
       *
       * 提示词里有一段"帮你把风险规则联立算一遍"，它原来把最低名义
       * **硬编码成 20** —— 而真实风控用的是
       * `max(minPositionSize, minNotionalOf(symbol))`（交易所下限按 symbol 查）。
       *
       * 后果实测（`#11`，权益 20.75、`minPositionSize=12`）：
       * ```
       *   提示词算出 0.415 ÷ (20 × 1.5) = 止损上限 1.38%
       *   真实口径   0.415 ÷ (12 × 1.5) = 止损上限 2.31%
       * ```
       * **低估 40%** → 模型得出"上限 < 下限（1.5×ATR）"→ **连续 11+ 轮零决策**。
       *
       * ⚠️ 用**与风控引擎同一个数据源**（`registry`）—— 两处口径必须一致，
       * 否则又会分叉出同类 BUG（本项目在"两处各算一遍"上踩过多次）。
       */
      minNotionalOf: (symbol: string) => this.deps.registry.minNotional(symbol),
      /*
       * ⚠️ **AI 托管时不能替它预设交易性格。**
       *
       * `buildSystemPrompt` 会按这个标志决定第 2 段写什么：非托管时注入写死的
       * `MODE_GUIDANCE`（「模式：稳健……保住本金压倒一切」），托管时改成
       * 「交易风格 —— 由你自己判断」。
       *
       * 实测 `#9` 修之前的样子：角色句说「对资金保持保守」、MODE_GUIDANCE 又说
       * 一遍「稳健/保住本金压倒一切」、而它自己写的 `entryStandards` 里还抄了
       * 第三遍 —— **三层都在替它回答一个本该它自己回答的问题。**
       *
       * ── ⚠️⚠️ **`ai_team` 也必须算"托管"**（2026-10-13 修一个真 BUG）────────
       *
       * ## 原来写的是 `mode === 'ai_managed'` —— 于是 `ai_team` 被漏掉了
       *
       * 后果（实测 `#11`，55 轮零决策后抓到的）：
       * ```
       *   system_prompt 含"由你自己判断"? **false**
       *   system_prompt 含"稳健"?        **true**   ← conservative 那段确实生效了
       * ```
       * 也就是说团队模式的机器人一直在吃**系统写死的"稳健"性格**：
       * ```
       *   「保住本金压倒一切。宁可交易更少、质量更高。」
       *   「当信号互相冲突时，正确的动作是 `wait`。」
       *   「错过一波行情不花一分钱；一笔糟糕的入场不是。」
       * ```
       * **而裁决官正是引用了它**（原文）：
       * > 「账户与模式不允许赌：权益仅20.75U、**conservative**、逐仓、无持仓……
       * >  **40轮空仓不是必须打破的错误。**」
       *
       * ## 为什么这是 BUG 而不是"配置如此"
       *
       * 用户的需求 ③ 明确说了：
       * > 「系统**不再设置内置风控**（我的想法是既然都要做这么智能了，
       * >  那么**风格也应该由一个智能体来负责**，而不是系统内置简单风控规则）」
       *
       * `tradingMode` 是**系统预设的风格档**（稳健/进取/短线）——
       * 让团队模式吃它，等于**系统替智能体回答了"该多保守"这个问题**。
       * 而 `defaultAiTeamConfig()` 里那些数值（`minConfidence: 0`、
       * `minRiskRewardRatio: 0`、`maxMarginUsage: 100`）**全都放开了** ——
       * 说明本意就是"不预设"，**只有这一段文本漏了**。
       *
       * ## 修法：两种托管模式都走"由你自己判断"
       *
       * ```
       *   ai_managed → 风格由你自己判断
       *   ai_team    → 风格由你自己判断（团队里那由**风控官**负责把关）
       *   strategy   → 仍然按 tradingMode 注入（固定策略需要它，行为不变）
       * ```
       * ⚠️ **`strategy` 模式的行为逐字节不变** —— 那是写死策略的人真的选了那一档。
       */
      aiManaged: this.deps.trader.mode === 'ai_managed' || this.deps.trader.mode === 'ai_team',
      account: {
        equity: account.equity,
        availableBalance: account.availableBalance,
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
        /*
         * ⚠️ **待成交的限价入场也要占名额。**
         *
         * `livePositions` 是**交易所已经存在的仓位** —— 而一张挂着的限价单
         * 一根都没成交，所以它不在里面。但**它是已经承诺出去的风险**：
         * 价格一过来它就变成持仓，而那时可能已经有 `maxPositions` 个仓位了。
         *
         * 不加这一项的话，`maxPositions: 3` 管不住「3 个挂单 + 3 个持仓 = 6 个敞口」。
         * 挂单与持仓在"占多少风险额度"这件事上**是同一件事**，只是时间不同。
         */
        positionCount: livePositions.length + positionStore.pending(traderId).length,
        /*
         * 外部交易活动 —— 见 `PromptAccountInfo` 上的说明。
         *
         * 读的是**最近一次对账的结论**（存在 `settings` 里），而不是本轮
         * 对账的返回值：对账不一定每轮都跑，而模型每轮都需要知道这件事。
         */
        ...readForeignActivity(traderId),
      },
      positions: promptPositions,
      candidates: snapshots,
      oiRanking,
      marketOverview,
      rankings,
      /*
       * 「持仓量增长」维度是否开着 —— 关着时渲染层会告诉模型"这个能力存在、怎么开"。
       * 这里如实传配置值：**不替模型打开它**（那是它的判断），只是不把能力藏起来。
       */
      oiRankingEnabled: config.indicators.enableOiRanking,
      platformHistory,
      /*
       * ⚠️ **周期长度是"事实"，必须告诉模型** —— 它的时间类规则要按这个尺度换算。
       * 实测（2026-09-30）：它写的「入场后第一次醒来检查」在本机器人 30 分钟周期下
       * 变成了"开仓就平"（BTC 上 78.7% 的情况下 30 分钟内根本涨不到 0.25%）。
       */
      cycleIntervalMinutes: this.deps.trader.cycleIntervalMinutes,
      /*
       * ⚠️ 往返成本要进提示词的**持仓区块**：模型的锁盈规则用价格 % 做判据，
       * 而"止损锁住的浮盈是否覆盖成本"决定了它是净赚还是净亏。见上面取数处的说明。
       */
      roundTripCostPercent,
      /* 交易所对这个账户的实际杠杆授信 —— 换主账户后它会变高，模型要据此决定是否调高配置。 */
      leverageCaps,
      /* 挂单成交统计 —— 让它看见自己的挂单成效，而不是每轮重复同一个动作。 */
      entryStats,
      /* 连续观望的轮数 —— 规则只增不减会让它最终排除一切，这个事实要摆出来。 */
      idleCycles,
      ...(idleNetPnl === undefined ? {} : { idleNetPnl }),
      /*
       * 它自己的规则规模 —— 模型没有刻度：只写不删，也看不到"我的规则多大了"。
       * 实测 9 天内从 1,841 涨到 9,618 字符（5.2 倍），同期开单率 48% → 8%。
       */
      ...summariseRules(this.activeConfig.promptSections),
      memory,
      /*
       * ⚠️ **选币阶段裁掉了多少，必须告诉模型。**
       *
       * `selectCandidates` 会返回 `trimmedFrom`（按候选上限截断前的数量），
       * 但在这之前它被直接丢掉了 —— 于是模型看到"候选标的（11 个）"，
       * 而配置里其实是 25 个，**它无从知道池子被裁过**。
       *
       * 更糟的是提示词第 9 条明确鼓动它"如果连续几轮在同样的标的上找不到机会，
       * 问题可能在你选标的的方式"—— 于是它会在一个**被静默裁过的池子**上
       * 做归因，然后去改一个本来没问题的参数。
       */
      universeTrimmedFrom: selection.trimmedFrom,
      /*
       * ⚠️ **待成交的限价单要进提示词。**
       *
       * 没有它，模型**不知道自己在等什么** —— 它会为一笔已经挂好的入场重复提案，
       * 或者干脆忘了这件事。而持仓那一区读的是 `positionStore.open()`
       * （只含已成交），所以挂单必须单独传。
       *
       * `waitingMinutes` 用 `opened_at` 算：那一列在挂单时写的是**挂出时刻**，
       * 所以它就是"等了多久"。
       */
      pendingEntries: positionStore.pending(traderId).map((row) => ({
        symbol: row.symbol,
        side: row.side === 'long' ? ('long' as const) : ('short' as const),
        quantity: row.quantity,
        limitPrice: row.entry_price,
        waitingMinutes: Math.max(0, (Date.now() - Date.parse(row.opened_at)) / 60_000),
        stopLoss: row.stop_loss,
        takeProfit: row.take_profit,
        reasoning: row.open_reasoning,
        waitMinutes: row.wait_minutes ?? null,
      })),
    };

    const systemPrompt = buildSystemPrompt(promptContext);
    /*
     * ⚠️ **拆成「稳定段 / 占位 / 变动段」三条消息 —— 缓存命中率就靠这一步。**
     *
     * 原来这里是一句 `buildUserPrompt(ctx, budget)` 拼出**一整条** user 消息，
     * 而它的第一行是 `时间：<ISO>` —— 每轮都不同，于是从第一个字符起前缀就分叉，
     * 整条消息（4.7 万 token）全部按全价计费。实测 `cached_tokens 2304 / prompt_tokens 49394`
     * —— **只有 system 那一段命中了 5%**。
     *
     * 拆开之后前缀变成：`system` + `稳定段`，两者都只在**成交之后**才变，
     * 于是连续多轮之间逐字节相同、进缓存。中间那条 assistant 占位是必要的：
     * 它让最后一条仍是 `user`，模型看到的仍是"一轮新的输入"，而不是两段连贯的
     * 用户指令叠在一起。
     */
    const { stable: stablePrompt, volatile: volatilePrompt } = buildUserPromptParts(
      promptContext,
      this.promptBudget,
    );
    const userPrompt = stablePrompt.length > 0 ? `${stablePrompt}\n\n${volatilePrompt}` : volatilePrompt;

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  **JEV 模式专用：附加结构化输入块**（2026-10-19）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 为什么要有这个块
     *
     * Jev **不读散文** —— 它的输入是一段紧凑摘要，输出是三种类型化答案
     *（`choice` / `score` / `noul`，见 `docs/JEV-MODE-DESIGN.md`）。
     * 而 `renderUserPrompt()` 产出的是**给 LLM 读的中文散文**，
     * 从里面用正则抠"价格是多少"是脆弱的（配置一变就静默抠错）。
     *
     * ⇒ 在**仅 Jev 模式**下追加一个结构化 JSON 块，由 `jevModel.ts` 解析。
     *
     * ## ⚠️ 三条硬约束
     *
     * ```
     * ① 只在 mode === 'jev' 时追加 —— 其余三种模式的 prompt 逐字节不变
     * ② 追加在【末尾】—— 不破坏前缀缓存（那段 4.7 万 token 的稳定段）
     * ③ 块内只放"算档位需要的最小字段"—— 不是行情全集
     * ```
     *
     * ## 为什么 `heldSide` 要在这里算
     *
     * 本模式只做"开仓 / 跳过"，已有持仓的标的要跳过（不叠加）。
     * 那个判断需要**持仓列表**，而 `jevModel` 只拿得到 prompt 文本。
    /*
     * ══════════════════════════════════════════════════════════════════
     *  **把账户状态交给 Jev**（2026-10-19 用户要求）
     * ══════════════════════════════════════════════════════════════════
     *
     * 用户原话：
     * > 「给JEV 判断里面现在有没有实际仓位？（如果开很多仓位了JEV不知道
     * >  又一直要开仓的情况，你研究一下到底要投喂哪些数据最合理，
     * >  你要考虑实际真实情况）」
     *
     * ## 线上实测的症状
     *
     * ```
     *   00:30 那轮：Jev 提议开仓 6 个，而 maxEntriesPerCycle = 2
     *   ⇒ 风控拒掉 4 个，日志里全是 rejected:open_xxx
     *   04:xx 那轮：已持仓 4/4，Jev 仍在提议开仓
     *   ⇒ 「已达最大同时持仓数（4/4）」被拒
     * ```
     * **它不知道额度，所以不会"挑最好的"，只会"随便提一堆"。**
     * 那浪费了它唯一的价值 —— 判断哪个机会最好。
     *
     * ## ⚠️ 给结论而不是原始数字
     *
     * Jev 不擅长算术。所以 `canOpenMore` 是**算好的**，
     * 而不是让它自己用 `maxPositions - openPositions`。
     */
    const jevAccountState: JevAccountState | undefined =
      this.deps.trader.mode === 'jev'
        ? (() => {
            const maxPositions = Math.max(1, Math.floor(jevNumber('max_positions')));
            const maxPerCycle = Math.max(1, Math.floor(jevNumber('max_entries_per_cycle')));
            const maxPerHour = Math.max(1, Math.floor(jevNumber('max_entries_per_hour')));
            const equity = promptContext.account.equity;
            const marginUsed = promptContext.account.marginUsed;
            const openPositions = promptContext.positions.length;
            return {
              equity,
              openPositions,
              maxPositions,
              canOpenMore: Math.max(0, maxPositions - openPositions),
              /* 已算好的百分比 —— 不让 Jev 自己做除法。 */
              marginUsedPercent: equity > 0 ? (marginUsed / equity) * 100 : 0,
              marginLimitPercent: promptContext.config.riskControl.maxMarginUsage,
              entriesThisCycle: 0,
              maxEntriesPerCycle: maxPerCycle,
              entriesThisHour: entriesLastHour,
              maxEntriesPerHour: maxPerHour,
              heldSymbols: promptContext.positions.map((p) => ({
                symbol: p.position.symbol,
                side: p.position.side === 'long' ? ('long' as const) : ('short' as const),
              })),
            };
          })()
        : undefined;
    const jevInput =
      this.deps.trader.mode === 'jev'
        ? buildJevInputBlock(promptContext, this.promptBudget, jevAccountState)
        : '';
    const promptForModel = jevInput === '' ? userPrompt : `${userPrompt}\n\n${jevInput}`;

    /*
     * 提示词在**发请求之前**就填进进度对象：这是"部分成功也留痕"的关键一步 ——
     * 模型调用抛错（欠费 / 被拒 / 网络）时，操作员仍然能拿到这一轮原本要问什么。
     */
    progress.systemPrompt = systemPrompt;
    progress.userPrompt = promptForModel;

    /*
     * ⚠️ **前缀稳定性是缓存命中的全部前提** —— 这里曾经用一段临时诊断
     * （段落级哈希 + 段首行）确认过它，结论记在这里，诊断本身已删除：
     *
     *   · **provider 的行为**（直接实验）：前缀不变命中 **97%**，前缀分叉归零。
     *     只改尾部、只在前缀末尾加空格都不影响；但把 `system` 改一个字符就归零。
     *   · **修复前**：`cached_tokens` 稳定在 **8,192–8,448** —— 那大致就是
     *     `systemPrompt` 的大小，也就是说 `stable` 段**从没进过缓存**。
     *     根因是「最近平仓」把时间渲染成「3 小时前」（`now` 每轮都变）。
     *   · **修复后**：`cached_tokens` 升到 **9,856**（system + stable 都命中）。
     *
     * 所以：**`stable` 段里绝不允许出现"相对于现在"的东西**（相对时间、
     * 轮次、计数器、余额）。每轮变的内容一律放 `volatile`。
     * 用例在 `prompt.test.ts` 的「stable 段必须与「现在几点」无关」。
     *
     * 另外记一个不是 bug 的事实：这块提示词的**大头是行情数据**
     * （`volatile` 约 21 万字符 / 12.4 万 token），而它每轮都在变、**物理上
     * 无法缓存**。所以整体命中率只能是 `(system+stable)/总量 ≈ 6%` 这个量级 ——
     * 想再提高只能减少行情数据，而那会削弱判断。**能力优先，所以到此为止。**
     */

    const startedAt = Date.now();
    state.phase = 'model';
    /*
     * 有 `chat` 就用它（真客户端有），没有就回落到 `complete`（测试桩）。
     *
     * 回落不是"降级"而是为了不改动已有的桩：`complete` 内部本来就是
     * `chat([system, user])`，两条消息也能跑，只是缓存命中差一些。
     */
    let response = this.deps.model.chat
      ? await this.deps.model.chat([
          { role: 'system', content: systemPrompt },
          ...(stablePrompt.length > 0
            ? [
                { role: 'user' as const, content: stablePrompt },
                /*
                 * 占位回复。它的内容不重要（模型不会把它当成指令），重要的是
                 * **它把最后一条推回 `user`** —— 否则两条 `user` 会连成一段，
                 * 而 `stable` 与 `volatile` 的语义边界就消失了。
                 */
                { role: 'assistant' as const, content: '（已读取当前状态与历史。）' },
              ]
            : []),
          { role: 'user', content: volatilePrompt },
        ])
      : await this.deps.model.complete(systemPrompt, promptForModel, { signal });

    /*
     * ── 按需取数：模型可以在给结论之前主动要数据 ─────────────────────────
     *
     * ## 为什么要有这一段
     *
     * 在此之前，这个周期开始时批量取好的那些数据就是模型的**全部世界** ——
     * 它看了 1h 觉得没机会，而 1m 图上刚放量突破，**它没有任何办法去要那张图**。
     * 真人交易员是反过来的：先扫一眼候选，**再针对性地去翻**那个让他起疑的
     * 币、那个关键周期的图。
     *
     * ## 为什么是"最多 3 轮"而不是无限
     *
     * 每要一次都是一次完整的模型调用（**实测单次输入 10 万+ token**），
     * 而这一步发生在**决策周期的热路径上**。无限轮次会让一轮决策的耗时和成本
     * 失控。3 轮足够覆盖"先要 1m 确认启动、再要 4h 确认结构"这种正常需求，
     * 而提示词里也明确告诉它"最多 3 次，一次要够"。
     *
     * ## token 用量必须累计
     *
     * `progress` 里的用量是给操作员看"这一轮花了多少"的。只记最后一次调用
     * 会让**要了数据的那几轮凭空消失** —— 而那恰好是最贵的那几轮。
     */
    let finalResponse = response;
    const toolDeps: DecisionToolDeps = {
      klines: (symbol, timeframe, count) =>
        this.deps.marketData.getKlines(
          symbol,
          timeframe as Timeframe,
          count,
        ) as Promise<Kline[]>,
      candidates: async () => snapshots.map((s) => s.symbol),
      /*
       * 第 3 层「索取」：**按模型自己的条件筛全市场**。
       * 走全市场快照的缓存，所以它每多要一次筛选，代价只有那几行文本。
       */
      screenSymbols: (criteria) => this.deps.marketData.screenSymbolsForModel(criteria),
      /*
       * 第 3 层「索取」的下半段：**点名**。
       *
       * 收下就写回 `settings`，下一轮 `selectCandidates` 会把它们并进 `mustInclude`。
       * 装不下时如实回报 `rejected` —— 假装记下会让模型下一轮直接找不到，
       * 而它会以为自己看过了（比当场被拒更糟）。
       */
      requestDeepAnalysis: async ({ symbols, reason }) => {
        const current = readWatchlist(traderId);
        const next = addToWatchlist({
          current,
          symbols,
          ...(reason ? { reason } : {}),
          ttlRounds: WATCHLIST_TTL_ROUNDS,
          maxSize: WATCHLIST_MAX_SIZE,
        });
        writeWatchlist(traderId, next);

        const acceptedSet = new Set(watchlistSymbols(next));
        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const raw of symbols) {
          const symbol = raw.trim().toUpperCase();
          if (!symbol) continue;
          (acceptedSet.has(symbol) ? accepted : rejected).push(symbol);
        }
        return { accepted, rejected };
      },
      /*
       * ⚠️ **改自己的参数 —— 决策轮的这条通道是 2026-10-02 为一个死锁加的。**
       *
       * 实测：账户所有者写了"单笔风险可以用到权益 5%"（见于 `customPrompt`），
       * 而它在 `#1836` 的思考里说：
       *
       * > 「账户所有者要求把单笔风险预算改为 5%，**但本轮无 `set_params` 工具可用**，
       * >   按现有 2% 预算执行」
       *
       * 决策轮看得到指示、却没有改规则的权限；复盘轮有权限、而它用另一套 system
       * 提示词、看不到那份指示 —— **模型被夹在中间，只能一直用 2% 熬着。**
       *
       * **守卫与落库都走同一套既有路径**（`applyAgentPatch` + `traders.saveAgentConfig`），
       * 所以结构性上限（杠杆/名义/保证金/持仓数）仍由代码强制，被钳制时如实回喂。
       * 这不是给模型开旁路，而是把**它本来就有的权限**接到它做决策的地方。
       */
      applyPatch: async (patch, reason) => {
        /*
         * ⚠️ **配额：同一小时内最多改 N 次，且两次之间至少隔 M 分钟。**
         *
         * ## 为什么需要它
         *
         * 这条通道是 2026-10-02 才接到决策轮的（在那之前它只在复盘轮、
         * 且受 `callsThisHour` 的小时预算约束）。决策轮的 `set_params`
         * **本来没有任何频率限制**：它在按需取数的循环里，每轮最多 3 次，
         * 每 30 分钟一轮 —— 一天理论上可以改 **144 次**。
         *
         * 复盘轮不存在这个问题：它一次审视改一次、然后**等结果**
         * （`agent_experiments` 就是为验证那次改动而记的）。
         * 决策轮如果每轮都顺手改一下，参数会**振荡** ——
         * 而"改完立刻又改"让任何改动都来不及经过一轮完整交易去验证。
         *
         * ## 它不限制"能不能改"，只限制"改得多频繁"
         *
         * 用户的原则是"模型是大脑"，所以这里**不判断改什么、也不要求理由充分**
         * （那是它自己的事）。拦的只是**频率** —— 与限流同类，
         * 属于系统的职责，而不是对判断的干预。
         *
         * 被拦时**如实回喂**（与 `clamps` 同一个理由）：不告诉它，
         * 它会以为改成了、并在下一轮基于一个错误前提继续推理。
         */
        const gate = this.paramChangeGate(traderId);
        if (gate !== null) {
          return { applied: false, rejected: gate, clamps: [] };
        }

        const current = this.activeConfig;
        const result = applyAgentPatch(current, patch);
        if (result.rejected === null) {
          /*
           * 落库走 `setAgentConfig`（AI 模式靠"这一列非空"判定），
           * 与复盘轮的 `ports.saveConfig` 是同一条路径。
           */
          traderStore.setAgentConfig(traderId, JSON.stringify(result.config));
          this.activeConfig = result.config;
          /*
           * ⚠️ **审计也要落一条** —— 否则它下一轮回看自己的历史时看不到这次调整，
           * 而"AI 调了参但历史里没有"正是复盘轮 `recordExperiment` 存在的原因。
           * 这里记进 `settings`（与账本检查同一个稳定键前缀），保证可追溯。
           */
          settings.set(
            `param_change:${traderId}:${Date.now()}`,
            JSON.stringify({ at: new Date().toISOString(), reason, patch, clamps: result.clamps }),
          );
          /* 记进频率闸门的账本 —— 只有**成功**的改动才算，被守卫拒绝的不占配额。 */
          this.noteParamChange(traderId);
          log.info(`[${this.deps.trader.name}] 决策轮里改了参数：${reason}`, {
            patch,
            clamps: result.clamps,
          });
        } else {
          log.warn(`[${this.deps.trader.name}] 决策轮里的参数改动被守卫拒绝`, {
            reason,
            patch,
            rejected: result.rejected,
          });
        }
        return {
          applied: result.rejected === null,
          rejected: result.rejected,
          clamps: result.clamps,
        };
      },
    };

    /*
     * 用量从**第一次调用**起累加。
     *
     * 用一个独立的累加器而不是直接改 `response.usage` —— 后者是模型客户端返回的
     * 对象，改它会让"这一轮的真实用量"和"最后一次调用的用量"这两个不同的东西
     * 混成一个，而账目恰恰要能分开看。
     */
    let totalPrompt = response.usage.promptTokens;
    let totalCompletion = response.usage.completionTokens;
    let totalCached: number | null = response.usage.cachedTokens ?? null;
    let totalReasoning: number | null = response.usage.reasoningTokens ?? null;
    const dataRequests: string[] = [];

    for (let dataRound = 1; dataRound <= MAX_DATA_ROUNDS; dataRound += 1) {
      const calls = extractToolCalls(finalResponse.text);
      if (calls.length === 0) break;

      const outcomes = await Promise.all(calls.map((call) => runDecisionTool(call, toolDeps)));
      const summaries = outcomes.map((o) => o.summary);
      dataRequests.push(...summaries);

      this.emit(
        'info',
        `按需取数 #${dataRound}：${summaries.join('、')}（这一轮还会再问一次模型）`,
      );

      /*
       * 与上面那次调用同样的回落：有 `chat` 就用它，没有（测试桩）就用 `complete`。
       * 回落时把工具结果直接拼进 user 提示词 —— 两条消息也能跑，只是缓存命中差。
       */
      const askAgain = (extra: string) =>
        this.deps.model.chat
          ? this.deps.model.chat([
              { role: 'system', content: systemPrompt },
              ...(stablePrompt.length > 0
                ? [{ role: 'user' as const, content: stablePrompt }]
                : []),
              { role: 'user', content: volatilePrompt },
              { role: 'assistant', content: finalResponse.text },
              { role: 'user', content: extra },
            ])
          : this.deps.model.complete(systemPrompt, `${userPrompt}\n\n${extra}`);

      const followUp = await askAgain(
        `你要的数据：\n\n${outcomes.map((o) => o.text).join('\n\n')}\n\n` +
          '现在给出你的最终结论 —— 输出 `<reasoning>` 与 `<decision>` 两个块。' +
          (dataRound >= MAX_DATA_ROUNDS
            ? '**取数次数已经用完，不要再写工具调用。**'
            : `还可以再要 ${MAX_DATA_ROUNDS - dataRound} 次数据，或者直接给结论。`),
      );

      totalPrompt = (totalPrompt ?? 0) + (followUp.usage.promptTokens ?? 0);
      totalCompletion = (totalCompletion ?? 0) + (followUp.usage.completionTokens ?? 0);
      totalCached = (totalCached ?? 0) + (followUp.usage.cachedTokens ?? 0);
      totalReasoning = (totalReasoning ?? 0) + (followUp.usage.reasoningTokens ?? 0);

      finalResponse = followUp;
    }

    progress.promptTokens = totalPrompt;
    progress.completionTokens = totalCompletion;
    progress.cachedTokens = totalCached;
    progress.reasoningTokens = totalReasoning;
    /*
     * 延迟：**取过数就用端到端**（那才是这一轮真实的等待时间，模型被问了不止一次），
     * 没取数就沿用客户端报的读数。
     */
    progress.aiLatencyMs =
      dataRequests.length > 0 ? Date.now() - startedAt : response.latencyMs || Date.now() - startedAt;
    progress.dataRequests = dataRequests;

    /*
     * ⚠️ **把最终那次回复交回去给下面的解析用。**
     *
     * 循环里每一轮的结果在 `finalResponse`；而下面 8.Parse 读的是 `response.text`。
     * 少了这一行，**要过数据的那一轮会被判成"没有 `<decision>` 块"** ——
     * 因为 `response` 还是第一轮那条只带 `<tool>` 的回复。
     * （实测：这条路径第一次跑就踩了，用例当场抓到。）
     */
    response = finalResponse;

    /* --- 8. Parse -------------------------------------------------------- */
    state.phase = 'parse';
    /*
     * ⚠️ **没有 `<decision>` 块 = 这一轮失败，不能往下走。**
     *
     * `parseDecisionResponse` 找不到 `<decision>` 时会**逐步放宽**：先试围栏代码块、
     * 再试"整段回复里第一个括号配平的区域"。那是为诊断路径设计的宽容（健康检查要能
     * 回答"模型到底吐了什么"），但**交易路径用它会出事**：
     *
     *   · 模型在 `<reasoning>` 里写一个示例或假设性的 JSON（很常见），而响应又被
     *     输出长度截断、没写出真正的 `<decision>` —— 那段散文里的 JSON 会被当成
     *     真实提案送进风控。而系统提示词自己就带着**两份字段完整、confidence 82/78
     *     的范例**，只要方向恰好成立，**它可能真的开出一笔仓**。
     *   · 兜底只试**第一个**配平区域。推理里先出现 `RSI[14]` 这种方括号时，
     *     它会返回 `[14]` 并放弃继续找后面真正的决策数组。
     *
     * 判据函数 `hasDecisionBlock()` 早就写好了，但**只有健康检查用它** ——
     * 交易路径一次都没用。同一个失败在诊断里被判失败、在交易里被判成功，
     * 这本身就是信号：**该信的是那个更严的判据。**
     *
     * 抛错而不是"当作 0 条决策"：后者会让这一轮记成 `success`、把
     * `consecutiveFailures` 清零，**安全模式因此永远不触发**（而健康检查那边
     * 判它是失败）。截断是模型失败的一种，就该按失败计数。
     */
    if (!hasDecisionBlock(response.text)) {
      /*
       * ⚠️ **先重试一次，再判失败。**
       *
       * 实测两次截断（`#104`、`#119`）的 `completionTokens` **都正好是 16,384**
       * —— 那是输出上限，而其中约 15,000 是**思考**。也就是说：**思考把输出预算
       * 吃光，正文一个字都没写出来。**
       *
       * 原来的处理是直接抛错、这一轮跳过。而实测两次都发生在**轮次稀少的时段**
       * （45 分钟一轮），等于白等一整轮。**而重试一次的成本远低于等 45 分钟**：
       * 这类截断是**一次性**的（换一次生成通常就正常了），不是模型"不会做"。
       *
       * ## 重试时说什么
       *
       * 一句**具体的**要求，而不是"再试一次"：明确告诉它**上一条没有产出结论**、
       * 以及**这次要直接给**。与工具回执那段用的是同一个手法 ——
       * 把"哪里不对"说清楚，比说"请重试"有用得多。
       *
       * ## 第二次仍然失败才按失败计数
       *
       * 截断是模型失败的一种，**必须按失败计数**（否则安全模式永远不触发）。
       * 所以这里只是"多给一次机会"，不是"把失败藏起来"：两次都没有 `<decision>`
       * 就照旧抛错。用量两次都累加 —— 那两笔钱都花了。
       */
      /*
       * ⚠️ **两种失败要模型做的事不一样，提示词与预算也必须分开。**
       *
       * 判断本身收在 `emptyContentRetryPlan()` 里（纯函数，可单测）：
       * · 正文**完全为空** → 预算被思维链吃光 → 换 `EMPTY_CONTENT_RETRY_PROMPT`
       *   （不写思维链、不复述材料、立刻给决策块）**并且放大输出预算**；
       * · 有内容、只是没写到 `<decision>` → 沿用原来那句、**逐字节不变、不动预算**。
       */
      const plan = emptyContentRetryPlan({
        text: response.text,
        outputBudgetTokens: this.deps.model.outputBudgetTokens,
      });
      const retryPrompt = plan.retryPrompt;
      const retryBudget = plan.maxTokens;
      /* 空正文时把"预算从多少加到多少"如实说出来 —— 那是这一轮为什么失败的排障入口。 */
      if (plan.firstTextEmpty) this.emit('warn', plan.note);
      /* 只在真的算得出来时才覆盖；`undefined` 表示"不传这个字段"（行为不变）。 */
      const retryOptions: { signal?: AbortSignal; maxTokens?: number } =
        retryBudget === undefined ? { signal } : { signal, maxTokens: retryBudget };

      let retry: typeof response;
      try {
        retry = this.deps.model.chat
          ? await this.deps.model.chat(
              [
                { role: 'system', content: systemPrompt },
                ...(stablePrompt.length > 0
                  ? [{ role: 'user' as const, content: stablePrompt }]
                  : []),
                { role: 'user', content: volatilePrompt },
                { role: 'assistant', content: response.text || '（上一条回复为空。）' },
                { role: 'user', content: retryPrompt },
              ],
              retryOptions,
            )
          : await this.deps.model.complete(
              systemPrompt,
              `${userPrompt}\n\n${retryPrompt}`,
              retryOptions,
            );
      } catch (error) {
        log.warn(`[${this.deps.trader.name}] 截断后的重试调用失败：${(error as Error).message}`);
        retry = response;
      }

      /* 重试的用量照常累加 —— 不管它成不成功，那笔钱都花了。 */
      totalPrompt = (totalPrompt ?? 0) + (retry.usage.promptTokens ?? 0);
      totalCompletion = (totalCompletion ?? 0) + (retry.usage.completionTokens ?? 0);
      totalCached = (totalCached ?? 0) + (retry.usage.cachedTokens ?? 0);
      totalReasoning = (totalReasoning ?? 0) + (retry.usage.reasoningTokens ?? 0);

      /* 保留第一次那份用于诊断 —— 第二次也失败时它的长度是判断依据。 */
      const firstText = response.text;
      response = retry;

      if (hasDecisionBlock(response.text)) {
        log.info(
          `[${this.deps.trader.name}] 第一次回复没有 <decision> 块（输出被截断），重试后拿到了结论。`,
        );
        this.emit('warn', '模型这一轮第一次回复被截断，已自动重试并拿到结论。');
      } else {
        /*
         * 第二次仍然没有 —— 照旧抛错，而且**把两次的长度一起报出来**：
         * 那是判断"是不是该去调大输出上限"的唯一依据。
         */
        throw new Error(
          '这一轮模型的输出被截断了，没有形成任何交易决策（重试一次仍然如此）—— 已安全跳过。' +
            `持仓与已经挂出的委托不受影响。两次输出分别 ${firstText.length} 与 ${response.text.length} 字符；` +
            '反复出现请把该模型的「最大输出 Token」调大。',
        );
      }
    }
    const openPositionMap = new Map<string, 'long' | 'short'>(
      localPositions.map((p) => [p.symbol, p.side as 'long' | 'short']),
    );
    const parsed = parseDecisionResponse(response.text, {
      candidateSymbols: new Set(snapshots.map((s) => s.symbol)),
      openPositions: openPositionMap,
      allowUnlistedCloses: true,
      /*
       * ⚠️ **挂单的标的也要豁免"必须在候选池里"那条。**
       *
       * 一条挂单最需要被撤的时候，往往正是它**掉出候选池**的时候 ——
       * 那意味着这一轮它不再是个机会，而当初挂它的理由也就不成立了。
       * 不传这个的话：标的掉出候选池 → 撤不掉 → 它一直占着持仓名额。
       */
      pendingSymbols: new Set(positionStore.pending(traderId).map((p) => p.symbol)),
    });

    progress.cotTrace = parsed.cotTrace;
    progress.decisions = parsed.decisions;
    progress.rawResponse = parsed.rawResponse;

    /*
     * ⚠️ **模型自己要求的"下次什么时候再看盘"**（`next_check_in_minutes`）。
     *
     * 用户 2026-10-02：「不是系统喂给 AI 什么，AI 就只能定时定点的去做…
     * 会像真人一样，**决定何时做什么事情**。」
     *
     * 赋值而不是 `??=`：`undefined`（它这轮没提）必须**覆盖**掉上一轮的值。
     * 边界钳制在 `nextCycleDelayMs` 里做，这里只如实转交。
     */
    this.requestedNextCheckMinutes = parsed.nextCheckInMinutes;
    if (parsed.nextCheckInMinutes !== undefined) {
      /* 不在这里报"配置周期"是多少 —— 那一行会在 `scheduleNextCycle` 里重新读库，
         这里拿到的可能是启动时的旧值，写进日志就是一条不准确的事实。 */
      log.info(
        `[${this.deps.trader.name}] 模型要求 ${parsed.nextCheckInMinutes} 分钟后再看盘。`,
      );
    }

    const executionLog: ExecutionLogEntry[] = parsed.rejected.map((r) => ({
      action: r.action,
      symbol: r.symbol,
      status: 'rejected' as const,
      detail: r.reason,
    }));
    // 同一个数组对象：下面每 push 一条，进度对象里也是最新的（step 10 的失败条目同理）。
    progress.executionLog = executionLog;

    /*
     * ⚠️ **"模型主动去要了数据"必须落进审计日志 —— 否则它翻历史查不到。**
     *
     * 用户 2026-10-02：「我打开网页，就能方便快捷**看到模型在做什么**」。
     *
     * 而"它动手去挖数据"是**最直接的"它在主动工作"的证据**：在此之前这条信息
     * 只走 `this.emit('info', …)`（实时事件流）—— 页面刷新之后就没了，
     * 历史里一条都查不到。于是操作员无法分辨这两种轮次：
     *
     *   · "它只是把系统喂的 20 个候选看了一遍"（被动）；
     *   · "它自己决定去拉 XRP 的 15m 与 1h"（主动）。
     *
     * 而这两种轮次正是用户那条判断的分界线（「系统喂给 AI 什么，AI 就只能
     * 定时定点的去做…这不是智能」）。所以它值得一个稳定的审计条目。
     *
     * `status: 'data'` 而不是 `'ok'`：`'ok'` 会被执行摘要算成"开仓 N"，
     * 而取数是**纯读取** —— 记成开仓会让界面出现一个不存在的仓位。
     */
    for (const request of dataRequests) {
      executionLog.push({
        action: 'wait',
        symbol: '-',
        status: 'data',
        detail: `模型主动取数：${request}`,
      });
    }

    /*
     * ⚠️ **"它自己定了下次什么时候看盘"必须让操作员看得见。**
     *
     * 用户 2026-10-02 的两条要求是连在一起的：
     *
     *   「会像真人一样，**决定何时做什么事情**」（能力）
     *   「我打开网页，就能方便快捷看到模型在做什么」（可见性）
     *
     * 这条新能力如果只写进服务器日志，操作员根本无从判断"它到底有没有在用这个自由" ——
     * 而那正是用户抱怨过的情况：**"要我去点开看大段的思考过程"**。
     *
     * ## 为什么走 `emit` 而不是 `executionLog`
     *
     * 我第一版是往 `executionLog` 里 push 一条 `{status:'ok'}` 的 —— **那是错的**：
     * `summarizeExecution` 把 `ok` 算作"开仓 N"，于是界面上会显示"开仓 1"
     * 而实际上一笔单都没下。那正是这个项目反复在消灭的那类矛盾：
     * **一个字段说"做成了"，另一个字段说"什么都没有"。**
     *
     * `emit('info', …)` 是**事件流**（界面实时日志），与执行结果完全解耦 ——
     * 同一轮里"按需取数"那条通知走的就是这条路。
     */
    if (parsed.nextCheckInMinutes !== undefined) {
      const clamped = clampNextCheckMinutes(parsed.nextCheckInMinutes);
      this.emit(
        'info',
        `它自己定了下一轮的观察时间：${parsed.nextCheckInMinutes} 分钟后` +
          (clamped !== parsed.nextCheckInMinutes ? `（已钳到 ${clamped} 分钟）` : '') +
          ' —— 没有等配置的周期。',
      );
    }

    /* --- 9. Hard risk review --------------------------------------------- */
    state.phase = 'risk';
    const orderedDecisions = sortDecisions(parsed.decisions);
    const gatedDecisions = orderedDecisions;

    /*
     * 待成交的挂单（`status='pending'`）。
     *
     * ⚠️ **必须单独递给风控**：它们**不是持仓**，`positionStore.open()` 看不到，
     * 所以 `positions` 里没有它们。不递的话风控对"这个标的已经有一张单在等成交"
     * 一无所知 —— 于是下一轮模型可以对同一标的再开一笔，成交后撞唯一索引
     *（交易所两份敞口、本地一行账）。判据与理由见 `risk/engine.ts` 第 0b 步。
     *
     * 查一次、两处用：下面 `positionCount`（挂单也占名额）与 `pendingSymbols`。
     */
    const pendingRows = positionStore.pending(traderId);

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **JEV 模式的「出手门槛」必须注入风控配置**（2026-10-19 线上抓到）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 症状
     *
     * 用户在「JEV 模式」标签里把「出手门槛」设成「有机会就做」（= 20），
     * 但决策仍然被风控拒掉：
     * ```
     *   AGTUSDT 置信 46 → rejected
     *   AVAUSDT 置信 22 → rejected
     *   GTCUSDT 置信 20 → rejected
     * ```
     *
     * ## 根因
     *
     * 风控读的是 `config.riskControl.minConfidence`（来自 `defaultJevConfig()`，
     * 值是 **40**）—— 而那个值**只有策略配置能改，界面上改不了**。
     *
     * `jevModel.ts` 里的 `readMinConfidence()` 只在**决策阶段**提前放弃，
     * 但它管不到风控那道门 ⇒ 于是出现"我设了 20，但 20 还是被拒"。
     *
     * ## 修法
     *
     * 在把 config 交给风控之前，**用 JEV 选项覆盖 `minConfidence`**。
     *
     * ⚠️ **只在 `mode === 'jev'` 时覆盖** —— 其它三种模式的配置必须逐字节不变
     *（`#10` 那台实盘在上面跑）。
     *
     * ⚠️ 这不是"绕过风控" —— 风控仍然是唯一执行路径，只是**它的输入来自
     *   用户刚设的那个值**，而不是一个他看不到的策略默认值。
     */
    const riskConfig =
      this.deps.trader.mode === 'jev'
        ? {
            ...config,
            riskControl: {
              ...config.riskControl,
              minConfidence: jevNumber('min_confidence'),
              /*
               * 盈亏比门槛同样来自 JEV 选项 —— 否则用户把「止盈止损比」
               * 设成 1.5 而风控仍要求 1.5 以上（恰好相等时浮点误差会误拒）。
               * 减 0.01 给浮点留余量。
               */
              minRiskRewardRatio: Math.max(
                0,
                jevNumber('min_rr') - 0.01,
              ),
              /*
               * ══════════════════════════════════════════════════════════════════
               *  ⚠️⚠️ **最小名义价值必须跟着账户规模走**（2026-10-19 线上抓到）
               * ══════════════════════════════════════════════════════════════════
               *
               * ## 症状
               *
               * 决策名义 **3.74 U**，而 `defaultJevConfig()` 的
               * `minPositionSize` 是 **12 U** ⇒ 3.74 < 12 ⇒ **全被拒**。
               * 日志里只写 `rejected`，看不到原因。
               *
               * ## 为什么会矛盾
               *
               * ```
               *   账户 21.2 U × 单笔上限 30% = 6.36 U   ← 我加的保护
               *   策略要求单笔 ≥ 12 U                  ← 策略默认值
               * ```
               * 两者**不可能同时满足** ⇒ 这台机器人永远开不了仓。
               *
               * 而 12 U 那个默认值是为"几百 U 的账户"定的 ——
               * 对小账户它是硬阻塞。
               *
               * ## 修法
               *
               * 最小名义取 `min(策略值, 权益 × 10%)`。
               * 权益 21.2 时 = 2.12 U ⇒ 3.74 U 能过。
               * 权益 500 时 = 50 U（策略值 12 更小，取 12）⇒ 行为不变。
               *
               * ⚠️ **下限 1 U** —— 交易所对多数标的最小名义是 5 U，
               * 但那是 `minNotionalOf(symbol)` 的事（`registry` 里有真实值），
               * 这里只是"策略层不要再加一道更严的"。
               */
              minPositionSize: Math.max(
                1,
                Math.min(config.riskControl.minPositionSize, account.equity * 0.1),
              ),
              /* 最大同时持仓数也来自 JEV 选项（2026-10-19 用户要求）。 */
              maxPositions: Math.max(1, Math.floor(jevNumber('max_positions'))),
              /* 保证金占用上限也来自 JEV 选项（2026-10-19，解决"想开却开不了"）。 */
              maxMarginUsage: Math.min(100, Math.max(1, jevNumber('max_margin_usage'))),
              /*
               * ⚠️ **移动止损的两个参数也来自 JEV 选项**（2026-10-19 实盘数据驱动）。
               *
               * ## 为什么必须可调
               *
               * 实盘 17 笔**全部是止损离场，止盈 0 次触发**：
               * ```
               *   平均盈 +0.21U，平均亏 -0.82U  ⇒ 盈亏比 1:3.85（应该 2:1）
               * ```
               * 根因是 `breakevenTriggerPercent: 3` + `trailingStopPercent: 1`：
               * 浮盈刚过 3% 就把止损移到保本，价格回落 1% 就离场 ——
               * 赚 0.9% 就跑，而止盈设在 +5%~11% 永远到不了。
               *
               * ⇒ 默认改成 8% / 3%，并允许操作员按行情调。
               */
              breakevenTriggerPercent: Math.max(0, jevNumber('breakeven_trigger_percent')),
              trailingStopPercent: Math.max(0, jevNumber('trailing_stop_percent')),
            },
            /*
             * ⚠️ **开仓节流也来自 JEV 选项**（2026-10-19 用户要求）。
             *
             * 用户截图指出「开仓节流：本周期已开 2 仓（上限 2）」——
             * 那个 2 来自 `defaultJevConfig().throttle.maxEntriesPerCycle`，
             * **界面上改不了**。
             *
             * ⚠️ `throttle` 是 `riskControl` 的**兄弟字段**（不是子字段），
             * 所以要在这一层展开，而不是塞进 `riskControl` 里。
             */
            throttle: {
              ...config.throttle,
              maxEntriesPerCycle: Math.max(1, Math.floor(jevNumber('max_entries_per_cycle'))),
              maxEntriesPerHour: Math.max(1, Math.floor(jevNumber('max_entries_per_hour'))),
            },
            /*
             * ⚠️ **单日亏损熔断阈值也来自 JEV 选项**（2026-10-19 用户要求）。
             *
             * 用户原话：「熔断改成可配置的，设立一个30%先」
             *
             * ## 原来为什么不行
             *
             * 那个 5% 写死在 `defaultJevConfig().circuitBreaker.maxDailyLossPercent`，
             * **界面上改不了**。实盘一天亏到 11% 就触发熔断停摆 ——
             * 而用户要的是「激进能好测试他能力」，5% 让他一天只能看十几个样本。
             *
             * ⚠️ **0 = 关闭**（与 `maxDailyLossPercent` 的既有约定一致）。
             *   用户设 0 时这条熔断完全不生效 —— 那是他的选择，但代码里
             *   必须如实传 0，不能偷偷兜底成某个安全值。
             */
            /*
             * ⚠️ `circuitBreaker` **不在这里覆盖** —— 熔断读的是 `config`
             *（本轮开头那一处），不是 `riskConfig`。
             *
             * 2026-10-19 的教训：我原来在这里覆盖，界面上显示 30% 而实际按 5% 拦，
             * 连续 4 轮 skip_cycle。**覆盖要放在所有下游的共同源头**，
             * 放在某个消费者身上就必然漏掉别的消费者。
             */
          }
        : config;

    const verdict = this.risk.review(gatedDecisions, {
      config: riskConfig,
      account: {
        equity: account.equity,
        availableBalance: account.availableBalance,
        marginUsed: account.marginUsed,
        /* 待成交的挂单也占名额 —— 见上面 `PromptAccountInfo` 那处的完整说明。 */
        positionCount: livePositions.length + pendingRows.length,
      },
      positions: new Map(
        localPositions.map((p) => [p.symbol, this.toPositionView(p, snapshotBySymbol)]),
      ),
      /* 挂单不是持仓 —— `positions` 里没有它们，风控判"同标的重入"要这个集合。 */
      pendingSymbols: new Set(pendingRows.map((p) => p.symbol)),
      snapshots: snapshotBySymbol,
      minNotionalOf: (symbol) => this.deps.registry.minNotional(symbol),
      quantityFor: (symbol, notionalUsd, price) =>
        this.deps.registry.notionalToQuantity(symbol, notionalUsd, price),
      /* 「上取一档」—— 向下取整恰好掉到最低名义之下时用它，见 `engine.ts` 那一段。 */
      quantityUpFor: (symbol, quantity) => this.deps.registry.roundQuantityUp(symbol, quantity),
      entriesThisCycle: 0,
      entriesLastHour,
      /*
       * 手续费感知门槛用的费率。**实测优先**（窗口内的 Σ手续费 / Σ名义价值），
       * 读不到成交时留 null，由引擎回落到配置的兜底费率 —— 提示词里那条硬性约束
       * 用的是同一个取值规则，两边不会各说各话。
       */
      roundTripFeeRate: memory.performance.roundTripFeeRate,
      /*
       * ⚠️ **交易所实际允许的杠杆上限** —— 与配置里那个取小。
       *
       * 在此之前引擎只用配置值：配置写 20x 就照 20x 批，然后 `setLeverage` 被
       * 交易所拒（子账户 5x、名义价值分档还会更低）。而**同一份配置跑在主账户与
       * 子账户上的结果是不同的** —— 子账户那条限制（普通用户 2025-08-12 后新建的
       * 不超过 5x）在这之前完全不可见。
       *
       * ## 为什么是同步回调 + 预热
       *
       * `RiskEnvironment` 的字段都是同步的（引擎不 await），所以这里查的是
       * **本进程这一轮已经预取好的缓存**；缓存没命中就返回 null（= 不知道），
       * 于是只用配置上限 —— **与以前的行为完全一致，读不到不会让交易停下来**。
       *
       * 预取发生在周期开头（`prefetchLeverageCaps`），只为**本轮候选**取，
       * 一个周期最多几个请求，而且档位在几分钟内不会变。
       */
      exchangeMaxLeverageOf: (symbol) => this.leverageCapCache.get(symbol) ?? null,
    });

    for (const rejection of verdict.rejected) {
      executionLog.push({
        action: rejection.decision.action,
        symbol: rejection.decision.symbol,
        status: 'rejected',
        detail: rejection.reason,
      });
    }

    /*
     * ⚠️ **落库的决策必须是"风控处置过"的那一份，不是"模型提的"那一份。**
     *
     * `progress.decisions` 是在**风控之前**赋的值（见上面 `state.phase = 'parse'`
     * 之后那几行），而 `parseDecisionResponse` 给每条决策的 `adjustments` 一律填 `[]`
     * （`parser.ts`）。于是风控真正做过的事 —— 名义被削到多少、杠杆被压到几倍、
     * 加了什么限制 —— **全部丢失**：
     *
     *   · 模型下一轮继续按"我提的 $200 / 20 倍已经执行"推理，而实际上被压成了
     *     $40 / 5 倍。它因此**无法从"结果不如预期"里学到任何东西** —— 它归因的
     *     那个动作根本没有发生。这是"AI 看到假事实"的另一种形态，而且更隐蔽：
     *     假的那个数字是**它自己刚写的**。
     *   · 复盘员那条「风控当时记下的调整」**永远渲染不出来**（`runtime.ts` 读的
     *     就是这里，而这里恒为空数组）—— 一个写了却永远不会显示的字段。
     *   · 审计上，`decision_records.decisions` 回答不了"最终批准并下单的是什么"，
     *     而那正是这张表存在的理由。
     *
     * 风控是"模型提议、运行时裁决"里的裁决方（§2.1）。**裁决结果必须回到记录里**，
     * 否则那条设计原则在数据上不成立。
     *
     * 用 `action:symbol` 作键：风控在同标的同动作上不会给出两条裁决，而
     * `verdict.approved` 的顺序已经被 `sortDecisions` 重排过，按位置对不上。
     */
    const adjustmentsByDecision = new Map<string, string[]>();
    for (const approved of verdict.approved) {
      if (approved.adjustments.length > 0) {
        adjustmentsByDecision.set(`${approved.action}:${approved.symbol}`, approved.adjustments);
      }
    }
    if (adjustmentsByDecision.size > 0) {
      progress.decisions = parsed.decisions.map((d) => {
        const adjustments = adjustmentsByDecision.get(`${d.action}:${d.symbol}`);
        return adjustments ? { ...d, adjustments } : d;
      });
    }

    /* --- 10. Execute ----------------------------------------------------- */
    // 普通 `Error`（网络层、响应解析）在这个阶段抛出，就是"订单没有得到交易所确认"。
    state.phase = 'execute';
    let entriesTaken = 0;
    let exitsTaken = closedByGuard;
    /**
     * 已挂出、等待成交的限价入场（**不是开仓**）。
     *
     * 与 `entriesTaken` 分开数：那一轮**没有产生持仓**，把它算进"开仓"会让
     * 操作员去持仓列表找一个不存在的仓位 —— 正是这个项目一直在消灭的那类矛盾。
     * 但也不能不报：**"什么都没做"和"挂了一张单在等"是两件事**。
     */
    let limitSubmissions = 0;
    /** 撤掉的待成交挂单（**不是平仓** —— 撤单没有产生任何成交）。 */
    let cancelsTaken = 0;
    let cooldownBlocked = 0;

    /*
     * ⚠️ **账户处于双向持仓模式时，一个单都不要下。**
     *
     * 币安的双向模式（Hedge Mode）要求每一张单都带 `positionSide: 'LONG' | 'SHORT'`，
     * 而这个机器人只推理单向模式、一律发 `positionSide: 'BOTH'` —— 于是**每一笔
     * 下单都会被拒**：`-4061 Order's position side does not match user's setting`。
     *
     * **平仓单也一样被拒**（`reduceOnly` 并不豁免 `positionSide`），
     * 所以这不是"少赚"，是**整个机器人瘫持**：开不了、平不了、保护位也挂不上。
     *
     * ## 为什么原来没挡住
     *
     * `ensurePositionMode()` 早就检测得到这个状态，但它**只记一条日志就 return**，
     * 周期照跑。而检查每 10 轮才做一次（为了不扰动模拟盘的墙钟），
     * 于是从"账户被改成双向"到"人看到日志"最多 30 分钟，
     * **这期间每一笔决策都白跑一趟、还会在交易所侧留下一串失败**。
     *
     * 它上面三行的注释其实已经写明了这个风险 ——
     * **「下不了单但状态显示 running 是最危险的一种故障形态」** ——
     * 只是当时的实现只做到了"记录"，没做到"阻止"。
     *
     * ## 为什么放在这里而不是风控引擎里
     *
     * 风控引擎是纯函数，它不知道账户的持仓模式（那是交易所侧的状态，
     * 需要一次 API 往返）。而这里是**已经知道**这个事实的地方 ——
     * 与"模型提议，运行时裁决"同一条思路：模型没错，是当前环境不允许。
     */
    const modeBlocked = this.positionModeBlocked;

    for (const decision of verdict.approved) {
      if (modeBlocked !== null) {
        progress.executionLog.push({
          action: decision.action,
          symbol: decision.symbol,
          status: 'rejected',
          detail:
            `${modeBlocked}本轮没有任何下单 —— 在双向持仓模式下，` +
            '开仓、平仓与保护单都会因为 positionSide 不匹配而被交易所拒绝（-4061）。' +
            '请到交易所端把持仓模式改回「单向持仓」，机器人会在下一次检查时自动恢复。',
        });
        continue;
      }

      /*
       * ⚠️ 这一行曾经把 `adjust_protection` 静默吃掉。
       *
       * 它原来只放行 open / close —— 于是"调保护位"这类新动作
       * **会被当成 no-op 跳过，而且不留任何记录**：
       * 模型以为它把止损提上来了，执行日志里却什么都没有。
       *
       * 这正是我在 `isAdjustAction` 注释里警告过的失效模式，而它真的发生了。
       * **所以这里不再用"白名单"式的静默跳过** —— 认不出的动作走下面那个
       * `else` 分支，报一条失败，而不是消失。
       */
      /*
       * ⚠️ **`hold` / `wait` 是"已知的不操作"，不是"不认识的动作"。**
       *
       * 我为了修「认不出的动作被静默跳过」而加了这段兜底，**但把两者混为一谈了**：
       *
       *   · `hold` —— 模型明确说"维持现状"。它没有任何要执行的东西，
       *     **静默跳过本来就是正确行为**
       *   · `wait` —— 模型明确说"这里没有仓位，不做任何事"。同上
       *   · 真正该报错的是**代码里不存在、或解析器没映射的动作** ——
       *     那种情况下模型以为它做了什么，而系统什么也没做
       *
       * 混在一起的后果：**每一轮 `hold` 都在生产上记一条"执行失败"** ——
       * 实测在「最近决策」里显示成红色的「✕ 执行失败 / 不认识的决策动作「hold」」，
       * 而那一轮什么都没做错。
       *
       * **一个把正常行为报成错误的检查，会让人不再相信错误提示。**
       */
      if (decision.action === 'hold' || decision.action === 'wait' || isSkipAction(decision.action)) {
        /*
         * 明确的不操作 —— 不记日志，也不占执行计数。
         *
         * ⚠️ **`skip` 必须在这个早退里**，否则它会落到下面那条"不认识的决策动作"
         * 检查上，每轮十几条 `skip` 全部被记成**执行失败**。那正是这个文件上面
         * 那段注释刚讲过的事故：`hold` 曾经被这样报了一个月的红字，
         * "而那一轮什么都没做错"。
         *
         * 它与 `hold`/`wait` 的区别不在执行（三者都是什么都不做），而在**它落了库**：
         * 一条带着 `setupScore` 的 `skip` 是"我看过这个标的、按我的尺子打了几分"，
         * 那是以后校准入场门槛唯一的凭据。执行层对它什么都不做，正是它要的语义。
         */
        continue;
      }

      if (
        !isOpenAction(decision.action) &&
        !isCloseAction(decision.action) &&
        !isAdjustAction(decision.action) &&
        !isResizeAction(decision.action) &&
        !isCancelPendingAction(decision.action) &&
        !isSkipAction(decision.action)
      ) {
        executionLog.push({
          action: decision.action,
          symbol: decision.symbol,
          status: 'failed',
          detail: `不认识的决策动作「${decision.action}」—— 已拒绝执行。`,
        });
        continue;
      }

      /*
       * ⚠️ **熔断与安全模式必须拦住"任何增加敞口的动作"，包括加仓。**
       *
       * 原来这三条判据都写在 `isOpenAction(...)` 里面，而 `isOpenAction` 只认
       * `open_long` / `open_short`。于是 `add_to_position` 直接落到下面的执行分支
       * ——**单日亏损熔断或总回撤熔断生效期间，模型仍然可以加仓扩大敞口**。
       *
       * 而熔断为什么还有机会轮到模型：早退判据要求"空仓"（见上面 `breaker.blocked`
       * 那段），**有仓位时模型每轮都会被问到**。也就是说这条路径不是理论上的：
       * 一笔浮亏中的持仓正好是加仓最"有理由"的时候。
       *
       * 提示词那边还写着加仓"与新开仓共用同一批上限"—— 模型因此会合理地以为
       * 熔断也挡着它。**它没有。**
       *
       * 与 §2.9 一致：熔断期间只允许**减少**风险的动作（平仓、减仓、调整保护单）。
       */
      const isRiskIncreasing = (action: DecisionAction): boolean =>
        isOpenAction(action) || action === 'add_to_position';

      if (isRiskIncreasing(decision.action)) {
        // Circuit breakers and safe mode take precedence over any model intent.
        if (breaker.blocked) {
          executionLog.push({
            action: decision.action,
            symbol: decision.symbol,
            status: 'skipped',
            detail: breaker.reason,
          });
          continue;
        }
        if (this.status === 'safe_mode') {
          executionLog.push({
            action: decision.action,
            symbol: decision.symbol,
            status: 'skipped',
            detail: '当前处于安全模式，在模型恢复正常之前禁止开新仓与加仓。',
          });
          continue;
        }
      }

      /* 冷却只针对"开新仓"：平掉之后短时间内不该重新建仓，而加仓本来就是既有仓位。 */
      if (isOpenAction(decision.action) && this.isInCooldown(decision.symbol)) {
        cooldownBlocked += 1;
        executionLog.push({
          action: decision.action,
          symbol: decision.symbol,
          status: 'skipped',
          detail: `该标的处于再入冷却期（平仓后 ${config.throttle.reentryCooldownMinutes} 分钟内不可再入场）。`,
        });
        continue;
      }

      try {
        /*
         * ⚠️ **撤单排在最前，而且必须显式分支。**
         *
         * 这个链式分派的最后一个分支是"当成开仓"。`cancel_pending` 掉进去
         * 会被真的当成一笔开仓去执行 —— 那比"静默什么都不做"更糟。
         * `decision.ts` 里已经为同一个坑写过三次注释。
         */
        if (isCancelPendingAction(decision.action)) {
          const outcome = await this.executeCancelPending(decision);
          executionLog.push(outcome);
          if (outcome.status === 'ok') cancelsTaken += 1;
        } else if (isCloseAction(decision.action)) {
          const outcome = await this.executeClose(decision, 'model_decision');
          executionLog.push(outcome);
          if (outcome.status === 'ok') exitsTaken += 1;
        } else if (isAdjustAction(decision.action)) {
          const outcome = await this.executeAdjust(decision);
          executionLog.push(outcome);
        } else if (decision.action === 'add_to_position') {
          const outcome = await this.executeAdd(decision);
          executionLog.push(outcome);
          if (outcome.status === 'ok') entriesTaken += 1;
        } else if (decision.action === 'reduce_position') {
          const outcome = await this.executeReduce(decision);
          executionLog.push(outcome);
        } else {
          const outcome = await this.executeOpen(decision, snapshotBySymbol.get(decision.symbol));
          executionLog.push(outcome);
          if (outcome.status === 'ok') entriesTaken += 1;
          /* 挂单不是开仓 —— 分开数，见 `limitSubmissions` 的说明。 */
          if (outcome.status === 'submitted') limitSubmissions += 1;
        }
      } catch (error) {
        const detail = (error as Error).message;
        this.emit('error', `${decision.action} ${decision.symbol} 执行失败：${detail}`);
        executionLog.push({
          action: decision.action,
          symbol: decision.symbol,
          status: 'failed',
          detail,
        });

        /*
         * ⚠️ **在第一次 `-4061` 上就认清"账户被改成了双向模式"。**
         *
         * 那是唯一一个**必须等一次失败才能知道**的状态：主动检查要花一次
         * API 往返，而且为了不扰动模拟盘的墙钟只每 10 轮做一次 ——
         * 于是从"账户被改"到"人看到日志"最多 30 分钟，这期间每次决策都白跑。
         *
         * 而这里是所有下单失败汇聚的**唯一位置**（开仓、平仓、加仓、减仓、
         * 挂保护、调保护都走这一个 `catch`），所以识别一次就够，
         * 不用去每个 `execute*` 里各写一遍。
         *
         * 认出之后**本周期剩下的单也不再尝试**，并且从这里开始的每一轮
         * 都不会再下单 —— 见执行阶段开头的 `modeBlocked` 拦截。
         */
        if (exchangeErrorCode(detail) === '-4061' && this.positionModeBlocked === null) {
          this.positionModeBlocked =
            '账户当前是双向持仓模式（Hedge Mode），而本机器人只按单向持仓模式下单。';
          this.emit(
            'error',
            '账户已被改成**双向持仓模式**，这个机器人无法在这种模式下交易：' +
              '它一律发送 positionSide=BOTH，而双向模式要求 LONG/SHORT，' +
              '于是每一笔下单（包括平仓单）都会被交易所拒绝（-4061）。' +
              '**已停止下单**，请到交易所端把持仓模式改回「单向持仓」；' +
              '改回之后机器人会在下一次检查时自动恢复。',
          );
        }
      }
    }

    /*
     * --- 11.5 执行回执 ----------------------------------------------------
     *
     * 把"刚才真的发生了什么"（成交价、成交量、失败原因）交回给模型，
     * 让它**在成交之后**再决定一次 —— 而这一轮只允许调保护位与撤单。
     *
     * ⚠️ **放在落库（第 11 步）之后、刷新（第 12 步）之前**：回执可能改掉保护位，
     * 而随后第 12 步的持仓快照要反映那个改动。
     */
    const followed = await this.followUpAfterExecution({
      systemPrompt,
      stablePrompt,
      volatilePrompt,
      log: executionLog,
      progress,
      snapshots: snapshotBySymbol,
      /*
       * ⚠️ 账户读数要传进去（外部 issue #117）：回执里的 `adjust_protection`
       * 现在**要过风控引擎**，而引擎的判据需要账户（保证金占用等）。
       * 用本轮刚读到的权威值，而不是在这里重新拉一遍。
       */
      account: {
        equity: account.equity,
        availableBalance: account.availableBalance,
        marginUsed: account.marginUsed,
      },
    }).catch((error) => {
      log.warn(`[${this.deps.trader.name}] 执行回执失败（不影响已完成的下单）：${(error as Error).message}`);
      return [] as ExecutionLogEntry[];
    });
    if (followed.length > 0) {
      executionLog.push(...followed);
      /* 回执里撤掉的单、改了的保护位都算"这一轮做过的事"，摘要要说实话。 */
      cancelsTaken += followed.filter((f) => f.action === 'cancel_pending' && f.status === 'ok').length;
    }

    /* --- 12. Refresh and snapshot ---------------------------------------- */
    /*
     * 第 12 步排在落库（第 11 步）之前，见 `runCycle()` 的说明：这样它自己抛错时
     * 也会写成一条失败记录，而不是留下一条写着"成功"的记录。它只做对账与展示
     * 快照，不下任何单。
     *
     * 阶段标记回到 `bookkeeping`：这里读到的是交易所的持仓 / 账户，抛错意味着对账
     * 失败，而不是"订单被拒"。
     */
    state.phase = 'bookkeeping';
    const finalPositions = await this.effectivePositions().catch(() => livePositions);
    await this.reconcilePositions(finalPositions);

    const finalAccount = await this.deps.broker.getAccountState().catch(() => account);
    await this.recordEquity(finalAccount, finalPositions);

    eventBus.publish({
      type: 'positions',
      traderId,
      positions: positionStore
        .open(traderId)
        .map((p) => this.toPositionView(p, snapshotBySymbol)),
    });

    const parts = [
      `${parsed.decisions.length} 条决策`,
      `开仓 ${entriesTaken}`,
      `平仓 ${exitsTaken}`,
    ];
    /* 挂单单独报 —— 它既不是"开仓"也不是"什么都没做"。 */
    if (limitSubmissions > 0) parts.push(`挂单 ${limitSubmissions}（等成交）`);
    /* 撤单也单独报 —— 它没有产生任何成交，不是"平仓"。 */
    if (cancelsTaken > 0) parts.push(`撤单 ${cancelsTaken}`);
    if (cooldownBlocked > 0) parts.push(`${cooldownBlocked} 条被冷却期拦截`);
    const rejectedCount = parsed.rejected.length + verdict.rejected.length;
    if (rejectedCount > 0) parts.push(`${rejectedCount} 条被拒绝`);
    return parts.join('，');
  }

  /* ---------------------------------------------------------------------- */
  /*  Position reconciliation                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Reconcile local position records with the exchange.
   *
   * Positions can disappear without us ever receiving a user-data event — the
   * exchange-side stop or target fires, or the position is liquidated. If that
   * is not detected the bot believes it holds something it does not, and every
   * subsequent decision is built on a false premise.
   */
  /**
   * **结清待成交的限价入场单。**
   *
   * ## 它是「挂单」与「成交」之间唯一的连接
   *
   * `submitLimitEntry` 挂出一张限价单、留一行 `status='pending'` 就结束了 ——
   * 那时**没有任何仓位**。这个方法是另一半：拿那一行的 `entry_order_id` 去问
   * 交易所，按答案分三种处理。
   *
   * ## ⚠️ 为什么它必须排在 `reconcilePositions` **之前**
   *
   * 两者都会看到"交易所上多了一个仓位"，但**知道的东西不一样**：
   *
   *   · 这里知道**那张单是我们自己挂的**（`entry_order_id`）、以及当初打算用的
   *     止损止盈（存在那一行 pending 上）；
   *   · `reconcilePositions` 只能看到"多了一个仓位"，说不出它是怎么来的 ——
   *     它会把仓位收养进来（那是它的兜底职责），但**保护单要靠猜**。
   *
   * 先跑这里，仓位就带着它的止损止盈转正；后跑的话，`reconcilePositions`
   * 已经收养过它了，而这次转正会找不到 `pending` 行 —— 结果是那个仓位
   * **没有任何保护单，也没人知道它本该有一个**。那就是 §2.6 说的最糟状态。
   *
   * ## 三种答案
   *
   * | 交易所说 | 处理 |
   * | --- | --- |
   * | 成交了（`executedQty > 0`）| 转正 + **同一段代码里立刻挂保护单** |
   * | 撤单 / 过期 / 拒绝 | 关掉那一行 —— **它从未成为过持仓** |
   * | 还挂着 / 读不到 | 什么都不做，下一轮再问 |
   */
  private async settlePendingEntries(): Promise<void> {
    const traderId = this.deps.trader.id;
    const rows = positionStore.pending(traderId);
    if (rows.length === 0) return;

    for (const row of rows) {
      const orderId = row.entry_order_id;
      if (!orderId) {
        /*
         * 没有单号的 pending 行是坏数据（迁移之前的行、或者写入时出了岔子）。
         * **不能留着** —— 它会永远挂在 pending 里被反复查询。
         */
        positionStore.close(row.id);
        this.emit('warn', `${row.symbol} 的待成交记录没有交易所单号，已作废该记录。`);
        continue;
      }

      let order: Awaited<ReturnType<BinanceBroker['getOrder']>>;
      try {
        order = await this.deps.broker.getOrder(row.symbol, orderId);
      } catch (error) {
        log.warn(`[${this.deps.trader.name}] 查询 ${row.symbol} 的挂单失败：${(error as Error).message}`);
        continue;
      }
      /* 读不到 = **不知道**，不是"没成交"。下一轮再问。 */
      if (!order) continue;

      const executed = Number(order.executedQty) || 0;
      const isGone = TERMINAL_GONE_STATUSES.has(order.status);

      if (executed > 0) {
        await this.promotePendingEntry(row, executed, Number(order.avgPrice) || row.entry_price);
      } else if (isGone) {
        positionStore.close(row.id);
        this.emit(
          'info',
          `${row.symbol} 的限价单已${order.status === 'EXPIRED' ? '过期' : '撤销'}（未成交），该入场作废。`,
        );
      }
      /* 其余情况（`NEW` / `PARTIALLY_FILLED` 但还没成交）继续等。 */
    }
  }

  /**
  /**
   * 撤掉某个标的上、**指定类别**的全部存活保护单，返回撤掉的张数。
   *
   * ⚠️ **为什么撤"全部同类"而不是"DB 里记的那一张"、以及它为什么必须存在**，
   * 见 `replaceProtection` 顶部的说明。一句话：`positionStore` 只记得最后一次
   * 的 `stop_order_id`，上移过 N 次就留下 N-1 张**不在 DB 里、却在交易所侧
   * 仍然有效**的孤儿单。
   *
   * ⚠️ **`kinds` 是必需的，不能"全撤"。** 调用方可能只重挂止损（例如
   * `adjust_protection`），那时撤掉止盈就等于**把它永久删掉**——
   * 实测被测试当场抓住过（见 `replaceProtection` 里的说明）。
   *
   * ## 两个端点都要查
   *
   * 止损/止盈挂在币安的 **Algo** 端点（`/fapi/v1/algoOrder`），而历史上也出现过
   * 落在普通端点上的保护单（见 `STOP_TYPES` 那一段的说明）。只查一个端点会漏。
   *
   * ## 这里的失败一律吞掉
   *
   * `broker.cancelOrder` 把"已经成交/已撤销"（`-2011`）当成成功返回 `true` ——
   * 这对它是正确的语义，所以调用方拿到 `false` 通常意味着真正的网络问题。
   * **但那不该阻断接下来挂新单**：旧单多半已经不在，挂新单才是把一个无保护
   * 仓位救回来的动作。
   */
  private async cancelAllProtection(
    symbol: string,
    kinds: { stop: boolean; target: boolean },
  ): Promise<number> {
    const wanted = (kind: string): boolean =>
      (kinds.stop && kind.includes('STOP')) || (kinds.target && kind.includes('TAKE_PROFIT'));
    let cancelled = 0;
    try {
      const [regular, algo] = await Promise.all([
        this.deps.broker.getOpenOrders(symbol),
        this.deps.broker.getOpenAlgoOrders(symbol),
      ]);

      /* Algo 端点：用 `orderType` 判类型、用 `algoId` 撤单。 */
      for (const order of algo) {
        const kind = String((order as { orderType?: string }).orderType ?? '');
        if (!wanted(kind)) continue;
        const id = String((order as { algoId?: string | number }).algoId ?? '');
        if (id === '') continue;
        if (await this.deps.broker.cancelOrder(symbol, id, 'algo').catch(() => false)) {
          cancelled += 1;
        }
      }

      /* 普通端点：用 `type` 判类型、用 `orderId` 撤单。 */
      for (const order of regular) {
        const kind = String((order as { type?: string }).type ?? '');
        if (!wanted(kind)) continue;
        const id = String((order as { orderId?: string | number }).orderId ?? '');
        if (id === '') continue;
        if (await this.deps.broker.cancelOrder(symbol, id, 'order').catch(() => false)) {
          cancelled += 1;
        }
      }
    } catch {
      /* 查不到就当作"没有旧单"—— 挂新单仍然是当前该做的事。 */
    }
    if (cancelled > 1) {
      this.emitOnChange(
        `protection-dupes:${symbol}`,
        'warn',
        `${symbol} 上原本有 ${cancelled} 张同类保护单同时存活，已一并撤掉后重挂 —— ` +
          '重复会让"止损上移"实际不生效（更差的那张可能先被触发）。',
      );
    }
    return cancelled;
  }

  /**
   * 某张订单的**成交手续费合计**（按结算资产计价，支出为正）。
   *
   * 币安的 `GET /fapi/v1/order` 不返回佣金，只有成交明细（`userTrades`）里有，
   * 所以限价单成交后要回填 `orders.fee` 就只能从这里取。
   *
   * 匹配用 `orderIdIn()` —— 它宽容处理**历史行被 `Number()` 改写过后三位**的问题
   * （见该函数的说明）。取不到返回 0：宁可这一项缺一点，也不要让调用方抛出去
   * （它在"挂保护单"的主路径上，抛出去会留下一个没有止损的仓位）。
   */
  private async feeForOrder(symbol: string, orderId: string): Promise<number> {
    try {
      const fills = await this.deps.broker.getUserTrades(symbol, 50);
      const wanted = new Set([orderId]);
      return fills
        .filter((fill) => orderIdIn(String(fill.orderId), wanted))
        .reduce((sum, fill) => sum + (Number(fill.commission) || 0), 0);
    } catch {
      return 0;
    }
  }

  /**
   * 把一行待成交转成真正的持仓，**并在同一段代码里挂上保护单**。
   *
   * 这两个动作必须连着做：中间任何 `await` 抛出去，都会留下一个**没有止损的
   * 杠杆仓位**。所以保护单挂失败时走的是"立刻平仓"那条路（§2.6），
   * 而不是"下一轮再试"。
   */
  private async promotePendingEntry(
    row: PositionRow,
    executedQty: number,
    avgPrice: number,
  ): Promise<void> {
    const traderId = this.deps.trader.id;
    const symbol = row.symbol;
    const isLong = row.side === 'long';
    const exitSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';

    /*
     * 先转正、再挂保护单 —— 顺序与 `executeOpen` 一致：保护单需要持仓存在
     * （`closePosition` 的条件单在没有仓位时会被拒）。
     *
     * 用**交易所报的**成交量与成交价覆盖挂单时的意向值：部分成交在限价单上
     * 很常见，而账本只能记实际发生的。
     */
    const promoted = positionStore.promote(traderId, symbol, {
      quantity: executedQty,
      entryPrice: avgPrice,
      marginUsed: (executedQty * avgPrice) / Math.max(row.leverage, 1),
    });
    tradeEvents.record(traderId, symbol, 'entry');

    /*
     * ⚠️ **那张入场单也要在同一刻结清。**
     *
     * 用户看着「当前委托」问：「这一笔开仓买入，是否已经成交完了？如果是成交完了，
     * 为什么委托里面还显示有这个？」—— 答案是成交完了（持仓就是证据），而
     * **本地那张订单行从头到尾停在 `NEW`**：建仓、挂保护单都做了，唯独没人回写它。
     * 界面上于是同时出现"持仓 12.7 @ 1.5600"和"开仓 买入 限价 已挂单"，
     * 两句话互相矛盾，而真的那一句是持仓。
     *
     * 下面 `placeProtection()` 会为两张保护单各写一行，入场单这一行就写在这里 ——
     * **知道事实的地方就是该写它的地方。** 兜底那条路（`settleStaleOrders()`）也补了，
     * 但它本来被"这个标的还持仓"整段排除掉，指望不上。
     */
    const entryRow = row.entry_order_id
      ? orderStore.findByExchangeOrderId(traderId, String(row.entry_order_id))
      : null;
    if (entryRow) {
      /*
       * ⚠️ **成交手续费必须一起回填**（2026-10-03 实测的缺口）。
       *
       * 这里原来只写 `status` / `filledQty` / `avgPrice`，**不写 `fee`** ——
       * 于是限价单成交后 `orders.fee` 永远是 0，界面上的手续费是空的，而
       * 更要紧的是**总账校验取不到这一项**：
       *
       * `openEntryCosts()` 正是按"仍持仓那几笔的入场单号"去 `orders.fee` 求和的，
       * 它用来把"未平仓的持有成本"加到平台侧。取到 0 的后果是总账校验**永久**
       * 报一条差额 —— 实测 `ledger_check:10` 的 `gap` 恒为 **0.060055**
       * （`openCosts: 0`，而三个持仓的真实开仓费合计正是 0.06）。而这条告警
       * 是唯一能自动发现"账本真的错了"的地方，**每一声假响都在训练操作员忽略它**。
       *
       * 币安的 `GET /fapi/v1/order` **不返回佣金**，所以只能从成交明细取
       * （`commission` 按结算资产计价）。取不到就保持 0 —— 对账的下一轮会
       * 通过 income 流水修正账目，这里只影响那一项口径补充。
       */
      const entryFee = await this.feeForOrder(symbol, String(row.entry_order_id));
      orderStore.update(entryRow.id, {
        status: 'FILLED',
        filledQty: executedQty,
        avgPrice,
        ...(entryFee > 0 ? { fee: entryFee } : {}),
      });
    } else {
      /*
       * 找不到就**说一声**，不静默：这意味着 `orders` 里没有这张单的中间态记录，
       * 界面会一直把它显示成"已挂单"。
       */
      log.warn(
        `[${this.deps.trader.name}] ${symbol} 的入场单 ${row.entry_order_id} 已成交，` +
          '但本地找不到对应的订单行，界面会继续把它显示为挂单。',
      );
    }

    const refresh = positionStore.getOpenBySymbol(traderId, symbol);
    if (!refresh) return;

    if (promoted.mergedIntoExisting) {
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **收养抢先时，必须用 pending 行里的 Jev 价位补挂止盈**
       *      （2026-10-19 实盘抓到：CTUSDT 丢了止盈，成了单边裸仓）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故时间线（#14，CTUSDT）
       *
       * ```
       *   11:40:13  挂限价单 214 @ 0.351296（pending 行存了 stop=0.362579 take=0.325577）
       *   11:40:14  成交
       *   11:40:17  对账**先**收养 → 创建 open 行 → 挂兜底止损 0.360083（2.5%）
       *   11:40:19  这里（promotePendingEntry）发现已有 open 行 → 直接 return
       *   ⇒ 结果：持仓 stop=0.348495（兜底值×移动止损） take=0.0（**没有止盈**）
       * ```
       * **Jev 算好的 3.21% 止损 / 2:1 止盈全部作废，仓位变成"只有止损、没有目标"。**
       *
       * ## 为什么原来要 return
       *
       * 收养路径已经挂了一张兜底止损，再挂一张会吃 `-4130`
       *（同一仓位不允许两张条件单）→ `stopOrderId` 为 null → 按 §2.6 平仓。
       * 那个顾虑是**对的**，所以不能盲目重挂。
       *
       * ## 修法：把 Jev 的价位【写回本地并替换】已有的兜底保护
       *
       * ```
       *   ① 把 pending 行的 stop_loss / take_profit 写进 open 行（账本正确）
       *   ② 用 replaceProtection() 原子替换交易所上的保护单
       *      —— 它内部先撤旧的再挂新的，不会撞 -4130
       *   ③ 只在 pending 行**确实有** take_profit 时才做（手工开的仓没有，
       *      那种仍然交给 ensureStopsOnOpenPositions 兜底）
       * ```
       *
       * ⚠️ **`replaceProtection` 失败不抛** —— 那时仓位仍有收养挂的兜底止损，
       *   属于"有保护但不理想"，比"为了改止盈而把仓位平掉"好。
       */
      const jevStop = row.stop_loss;
      const jevTarget = row.take_profit;
      if (jevStop !== null && jevTarget !== null) {
        /*
         * ⚠️ **只写账本，不在这里直接挂单。**
         *
         * §2.1 规定「没有任何代码可以绕过 `risk/engine.ts` 直接下单」，
         * 而 `replaceProtection` 的允许调用者有明确白名单
         *（`riskOnlyPath.test.ts` 里逐行校验）。本方法不在其中。
         *
         * ⇒ 把 Jev 的价位写进持仓行，**交给 `ensureStopsOnOpenPositions()`**：
         * ```
         *   它每轮对账都读交易所的挂单列表，缺止盈才补；
         *   而它读的正是这一行的 stop_loss / take_profit
         *   ⇒ 写对账本 = 下一轮会自动把保护单纠正成 Jev 的价位
         * ```
         * 代价是**最多晚一轮（15 分钟）**才纠正 —— 那可以接受：
         * 仓位此刻仍有收养时挂的兜底止损，不是裸奔。
         */
        positionStore.setProtection(traderId, symbol, jevStop, jevTarget);
        this.emit(
          'info',
          `${symbol} 的限价单成交时先被对账收养了 —— 已把 Jev 的价位写进账本` +
            `（止损 ${jevStop.toFixed(6)}、止盈 ${jevTarget.toFixed(6)}），` +
            '下一轮对账会据此替换兜底保护单。',
        );
        return;
      }
      /*
       * 没有 Jev 价位（真是操作员手工开的仓）—— 原来的判断仍然成立：
       * 交给 `ensureStopsOnOpenPositions()`，不在这里猜。
       */
      this.emit(
        'warn',
        `${symbol} 的限价单成交时，本地已经有一行持仓记录（对账收养过）—— ` +
          '成交数据已合并到那一行（不再新增），保护单交给对账检查。',
      );
      return;
    }

    /*
     * ⚠️ **必须把单号写回持仓 —— 丢了它，保本守卫就会把仓位平掉。**
     *
     * ## 这是一个实测发生过的、代价很大的一次漏记
     *
     * 原来这里只是 `await this.placeProtection({...})`，**返回值被丢掉了**，
     * 也没调 `positionStore.setProtection()`。于是 `positions.stop_order_id`
     * 停在 `null`，而保本守卫的逻辑是「**先撤旧止损、再挂新**」：
     *
     * ```ts
     * const oldStopId = local.stop_order_id ? Number(local.stop_order_id) : null;
     * if (oldStopId && …) { …撤旧… }          // ← null 就整段跳过
     * const newStopId = await this.placeProtection({ triggerPrice: 成本价 });
     * if (!newStopId) { /* §2.6：立刻平仓 *\/ }
     * ```
     *
     * `stop_order_id` 是 `null` → **它跳过了撤旧**，直接去挂保本止损（成本价），
     * 而计划止损还挂在交易所上 → `-4130`「该仓位已有止损单」→ `newStopId` 为 null
     * → **按 §2.6 立刻平仓**。
     *
     * 实测那一轮（`#91` UNIUSDT）：限价单成交 → 挂上计划止损 `8.86` → 保本守卫
     * 想把它移到成本价 `8.98` → `-4130` → **市价平仓**。而那一笔本来是盈利的
     * （挂单价 8.98、成交价 9.073）。
     *
     * **同一个文件里已经为这个形态写过很多次注释了：一个写了一半的记账，
     * 会在别处被读成"什么都没有"。**
     */
    const stopOrderId = await this.placeProtection({
      symbol,
      side: exitSide,
      type: 'STOP_MARKET',
      triggerPrice: row.stop_loss ?? 0,
      purpose: 'stop_loss',
      traderId,
      quantity: executedQty,
    }).catch(() => null);

    /*
     * 止盈也要挂 —— `row.take_profit` 一直存在，而这一段原来**只用止损**，
     * 于是限价入场的止盈计划从来没有生效过（模型给了、存了、然后没用）。
     */
    const tpOrderId =
      row.take_profit !== null && row.take_profit > 0
        ? await this.placeProtection({
            symbol,
            side: exitSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: row.take_profit,
            purpose: 'take_profit',
            traderId,
            quantity: executedQty,
          }).catch(() => null)
        : null;

    /* 单号写回 —— 不写的话，下一轮的保本守卫/加仓/减仓都会以为"没有保护单"。 */
    positionStore.setProtection(
      traderId,
      symbol,
      row.stop_loss ?? null,
      row.take_profit ?? null,
      stopOrderId,
      tpOrderId,
    );

    if (!stopOrderId) {
      /*
       * 挂不上止损 → §2.6：**不留没有保护的杠杆仓位**，立刻平掉。
       *
       * 与 `executeOpen` 同一条纪律 —— 那一笔钱已经进了市场，而没有任何东西
       * 在兜底。宁可立刻退出。
       */
      this.emit(
        'error',
        `限价单成交后未能为 ${symbol} 挂上止损（计划 ${row.stop_loss}）—— 为避免留下无保护的敞口，立即平掉该仓位。`,
      );
      await this.flattenAndBook(
        symbol,
        executedQty,
        isLong ? 'long' : 'short',
        traderId,
        avgPrice,
      );
      return;
    }

    this.emit(
      'info',
      `限价单成交：${symbol} ${isLong ? '多头' : '空头'} ${executedQty} @ ${avgPrice}（挂在 ${row.entry_price}）—— 已按计划挂上保护单` +
        (tpOrderId ? '（含止盈）' : ''),
    );
  }

  /**
   * **把等太久的限价入场单撤掉。**
   *
   * ## 为什么是一条机械规则，而不是留给模型判断
   *
   * 模型现在能撤单了，但那要求它**每轮都记得回头看**。而它每轮要处理 20 个候选、
   * 几个持仓、一堆约束 —— "我半小时前挂了张单"很容易被挤出去。
   *
   * 与 `applyBreakevenGuard` / `applyDrawdownGuard` 同一个理由：
   * **保护一个已经做出的判断，恰恰是模型可靠地判断错的那件事。**
   * 而"等太久了就撤"没有任何需要判断的成分。
   *
   * ## 与模型主动撤单的分工
   *
   * 这一条是**兜底**，不是替代：模型看到理由不成立了，可以立刻撤（`cancel_pending`）；
   * 而它没想到的时候，这条时间规则保证那张单不会一直占着持仓名额。
   *
   * 撤掉的理由**要说实话**：不是"它已经没机会了"（那要模型判断），
   * 而是"等得超过了配置的时限"—— 一个纯粹的时间事实。
   */
  private async expireStalePendingEntries(): Promise<number> {
    const traderId = this.deps.trader.id;
    const configBaseMinutes = this.activeConfig.riskControl.pendingEntryTimeoutMinutes;
    /*
     * ⚠️ `0` = 关闭这条兜底规则（本项目同类字段的既有约定）——
     * **整条规则关闭**，而不是"只对没指定耐心的单生效"。关闭就该是关闭。
     */
    if (configBaseMinutes <= 0) return 0;

    const rows = positionStore.pending(traderId);
    if (rows.length === 0) return 0;

    /*
     * ⚠️ **时限要跟着"挂价距离"走，不能是一个固定值。**
     *
     * 实测（2026-10-01）：DOGEUSDT 挂 0.095241、现价 0.095860 → 距离 **0.646%**，
     * 而 15m ATR ≈ **0.212%**。按随机游走走到那个位置预期需要 **139 分钟**，
     * 而固定时限是 **45 分钟** —— 那张单在数学上**必然**等不到就被撤，
     * 模型下一轮再挂同一价位：**78 撤 / 44 成交，最近一次成交在 20 小时前**。
     *
     * 「挂多远」是模型的判断（结构位回踩是合理的交易方式）；系统该做的是
     * **给那个判断足够的时间去验证**。见 `pendingTimeout.ts`。
     *
     * 行情读不到时退回配置值 —— 那只是"用回原来的行为"，不影响任何安全性。
     */
    const caps = await this.deps.marketData
      .buildSnapshots(
        rows.map((r) => r.symbol),
        this.activeConfig.indicators,
        /* 来源标记只影响提示词渲染，这里用不上。 */
        new Map(),
      )
      .catch(() => null);

    let expired = 0;
    for (const row of rows) {
      const waitedMinutes = (Date.now() - Date.parse(row.opened_at)) / 60_000;

      const snap = caps?.find((s) => s.symbol === row.symbol) ?? null;
      const mark = snap && Number.isFinite(snap.price) && snap.price > 0 ? snap.price : null;
      /*
       * ⚠️ **不能写死 `'14'`**（外部 issue #179）：`atrPeriods` 默认 `[14]`
       * 但**界面可改、AI 可调**。写死的话配置不含 14 时这里取不到值 →
       * `atr` 为 `null` → 下面的 `limitMinutes` 退回 `rowBaseMinutes` →
       * **"自适应时限"静默退化成固定值**（那是能力降级，不只是少显示一行字）。
       *
       * 改成从配置里挑第一个实际存在的周期。
       */
      const atrSeries = pickAtrSeries(
        snap?.primary?.atr,
        this.activeConfig.indicators.atrPeriods,
      ).values;
      const atr =
        atrSeries && atrSeries.length > 0
          ? [...atrSeries].reverse().find((v): v is number => typeof v === 'number' && Number.isFinite(v)) ??
            null
          : null;
      /*
       * ⚠️ **基础值取"配置值"与"模型为这一张指定的耐心"的较大者。**
       *
       * 模型说"我愿意等 120 分钟"时，不该被配置里的 15 分钟接管 ——
       * 那正是它一直在经历的「错失机会」：判断是它做的，耐心却由系统定。
       * 取 `max` 而不是直接用它的值：**它不能把耐心调到比系统配置更低**
       *（那等于绕开这条兜底规则）。
       */
      const rowBaseMinutes = Math.max(configBaseMinutes, row.wait_minutes ?? 0);
      /*
       * ⚠️ **ATR 的口径必须与 K 线周期一致**（外部 issue #165）。
       *
       * `snap.primary` 是**主周期**指标，而 `primaryTimeframe` **默认 `'5m'`**
       *（`shared/strategy.ts:86`）且可配置。原来这里把 ATR 取出来之后，
       * `pendingTimeoutMinutes` 内部用**写死的 15 分钟**换算 ——
       * 5m ATR 约为 15m ATR 的 `1/√3`，于是算出的时限**系统性偏大**。
       *
       * 这是**真实撤单时限**（不是提示词里的一句话），所以偏差直接改变
       * 挂单等待多久才被撤。同口径的修正在 `strategy/prompt.ts` 那处。
       */
      const primaryTimeframe = snap?.primary?.timeframe;
      const barMinutes = primaryTimeframe ? timeframeBarMinutes(primaryTimeframe) : BAR_MINUTES;
      const limitMinutes =
        mark !== null && atr !== null
          ? pendingTimeoutMinutes({
              baseMinutes: rowBaseMinutes,
              distancePercent: (Math.abs(row.entry_price - mark) / mark) * 100,
              atrPercent: (atr / mark) * 100,
              barMinutes,
            })
          : rowBaseMinutes;

      if (!(waitedMinutes >= limitMinutes)) continue;

      /*
       * ⚠️ **撤之前先问清楚：这张单真的还没成交吗？**
       *
       * `cancelOrder` 返回 `true` 有两种完全不同的含义：
       *
       *   · 撤掉了；
       *   · **它本来就不存在** —— 币安 `-2011 Unknown order`，代码把它也当成功。
       *     而"不存在"最常见的原因恰恰是**它已经成交了**。
       *
       * 于是一次"超时撤单"会把一张**已经成交**的入场单关掉：`positions` 行被 close，
       * 而交易所上那笔仓位还在。实测 2026-09-27 ETHUSDT 就是这样：
       * 限价单 @2698 在 22:20 被判「未成交，已自动撤掉」，22:24 才对账发现
       * 「**未被记录的持仓**」把它收养回来 —— 而那张**订单行已经被写成 CANCELED**，
       * 它实际是 FILLED。收养救回了仓位，但订单记录里留下一个假状态
       * （用户看到的"订单记录不对"就是这个）。
       *
       * 所以撤之前先读一次交易所的权威状态。**读不到就不撤** —— 这一轮撤不掉
       * 只是晚 45 分钟释放一个入场名额，而误关一张已成交的单要等对账去捡。
       */
      if (row.entry_order_id) {
        const live = await this.deps.broker
          .getOrder(row.symbol, row.entry_order_id)
          .catch(() => null);
        if (live === null) {
          log.warn(
            `[${this.deps.trader.name}] ${row.symbol} 的挂单超时，但读不到它的状态 —— 本轮不撤，等下一轮确认。`,
          );
          continue;
        }
        if (Number(live.executedQty ?? 0) > 0) {
          this.emit(
            'info',
            `${row.symbol} 的限价挂单虽然等满了 ${Math.round(waitedMinutes)} 分钟，但它**其实已经成交**` +
              `（成交量 ${live.executedQty}）—— 不撤单、不关本地记录，交给对账把它转成持仓。`,
          );
          continue;
        }
      }

      try {
        if (row.entry_order_id) {
          /*
           * ⚠️ **必须看返回值。**
           *
           * `cancelOrder` 失败时 `return false` 而**不抛**，所以只有 `try/catch`
           * 接不住它 —— 下面那句「撤不掉就留着」就成了死代码，而
           * `positionStore.close(row.id)` 会照常执行：**本地记录被销毁，
           * 而交易所那张单还挂着**。它随后成交 = 一个既没有本地行、
           * 也没有保护单的裸仓（§2.6 的最糟状态之一）。
           */
          const cancelled = await this.deps.broker.cancelOrder(
            row.symbol,
            row.entry_order_id,
            'order',
          );
          if (!cancelled) {
            log.warn(
              `[${this.deps.trader.name}] ${row.symbol} 的挂单超时但交易所拒绝撤销 —— 保留本地记录，等下一轮重试。`,
            );
            continue;
          }
        }
      } catch (error) {
        /*
         * 撤不掉就**留着**，不改本地状态 —— 与模型的撤单同一处理。
         * 特别地：如果它其实已经成交了，`settlePendingEntries` 会把它转正；
         * 而这里若抢先关掉记录，那笔真实持仓就没人管了。
         */
        log.warn(
          `[${this.deps.trader.name}] ${row.symbol} 的挂单超时但未能撤掉：${(error as Error).message}`,
        );
        continue;
      }

      positionStore.close(row.id);
      expired += 1;

      /*
       * ⚠️ **撤单成功之后，那张入场单在本地必须立刻变成"已撤销"。**
       *
       * 这里原来只关掉 `positions` 的待成交行，而 `orders` 里那张 `entry` 行
       * 仍然停在 `NEW` —— 于是「当前委托」里一直显示一张**交易所侧已经不存在的**
       * 挂单。实测（2026-09-26 04:02）：LTCUSDT 的限价开仓单等满 55 分钟被自动撤掉，
       * 交易所侧逐笔确认没有它，而界面上它仍写着「已挂单」。
       *
       * `settleStaleOrders()` 会在**下一轮对账**把它兜底结清，但那最多是一个周期
       * （45 分钟）之后；而这里**就在撤单发生的这一刻知道事实** ——
       * 按项目自己的原则（`orders.findByExchangeOrderId()` 的注释写过同一件事：
       * "让'成交了'这件事在发生的地方写回订单行，而不是指望以后有人来收拾"），
       * 知道事实的地方就该写它。
       */
      if (row.entry_order_id) {
        const entryOrder = orderStore.findByExchangeOrderId(traderId, String(row.entry_order_id));
        if (entryOrder && !TERMINAL_ORDER_STATUSES.includes(entryOrder.status)) {
          orderStore.update(entryOrder.id, { status: 'CANCELED' });
        }
      }

      /*
       * ⚠️ **落进审计日志，不只走实时事件流。**
       *
       * 这条原来只有 `emit` —— 页面一刷新，操作员就再也查不到"那个挂单去哪了"。
       * 用户 2026-10-08 就是这么发现的：「倒数第二轮有挂单开多，最新一轮没有提示撤单，
       * 但挂单消失了？」。实时流是"现在发生了什么"，审计日志是"历史里能查到什么"，
       * 两者不能互相替代（同一个结论在本文件里已经写过一次，见"模型主动取数"那条）。
       */
      const cancelDetail =
        `${row.symbol} 的限价挂单已等满 ${Math.round(waitedMinutes)} 分钟（上限 ${limitMinutes}）` +
        '仍未成交，已自动撤掉并释放该入场名额。';
      decisionStore.appendExecutionLog(traderId, {
        action: 'cancel_pending',
        symbol: row.symbol,
        status: 'ok',
        detail: cancelDetail,
      });
      this.emit('info', cancelDetail);
    }

    return expired;
  }

  private async reconcilePositions(exchangePositions: ExchangePosition[]): Promise<void> {
    const traderId = this.deps.trader.id;
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **模拟盘不能用交易所的持仓列表当真相**（2026-10-15 线上实测抓到）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 症状：团队模式的仓位**活不过一个周期**
     *
     * 实测 `#11`（`dry_run=1`，团队模式）37 笔平仓的持有时间：
     * ```
     *   最短 0.0 分 · p50 3.8 分 · p90 6.2 分 · 最长 7.3 分
     *   持有 > 15 分钟（超过一个周期）的：【0 笔】
     *
     *   对照 #10（实盘）：p50 109 分 · 94% 超过 15 分钟 · 最长 9556 分
     * ```
     * 也就是说：**它开仓，然后在同一个周期里被自己对账平掉，再开仓，如此空转。**
     *
     * ## 机制（三个事实凑成的）
     *
     * ```
     *   ① 模拟盘的成交是本地模拟的（`simulateStandard`）—— 从不真的下单
     *   ② 而 `getPositions()` 【没有 dryRun 守卫】→ 真去查交易所
     *      → 那个账户上从来没有它的仓位 → 返回空
     *   ③ 这里于是看到"本地有、交易所没有" → `bookVanishedPosition()`
     *      → 拿 `lastFillFor()`（可能是【同账户其他机器人】的成交价）当出场价
     *      → `detectCloseReason()` 猜一个原因
     *      → `positionStore.close()` 把仓位抹掉
     * ```
     *
     * ## 实测的次生伤害（同一份数据）
     *
     * ```
     *   · 保护单从未成交：stop_loss / take_profit 的 FILLED = 0（31 张 CANCELED）
     *   · 31/32 笔的出场价【离所有保护单都 >0.5%】（最远 5.74%）
     *     ⇒ close_reason 是"离谁近猜谁"，而那个"最近的"不是触发它的单
     *   · 标 take_profit 却亏钱 5 笔（止盈单在有利方向，逻辑上不可能）
     *   · 标 stop_loss 却赚钱 10 笔（这个在移动止损下是合法的，不算错）
     * ```
     * ⇒ 那些 `stop_loss` / `take_profit` 标签在模拟盘上**是噪声**，
     *   而它们会经 `agent_memory` 变成模型的"教训"。
     *
     * ## 修法：模拟盘走自己的结算
     *
     * **模拟盘里，交易所不是真相来源** —— 本地持仓 + 标记价才是。
     * 所以这里不再比对交易所列表，改为**对着标记价结算保护单**：
     * ```
     *   标记价碰到止损 → 以【止损价】平仓，原因 stop_loss
     *   标记价碰到止盈 → 以【止盈价】平仓，原因 take_profit
     *   都没碰到       → 继续持有（并更新回撤守卫用的峰值）
     * ```
     * 这让模拟盘**真的在模拟**：出场价是触发价（而不是别处的价），
     * 原因是从触发事实推出来的（而不是猜的）。
     *
     * ⚠️ **实盘一行都不动** —— 那里交易所就是唯一真相来源，
     * 而 `#10 赚大钱` 正在用真实资金跑（用户硬约束）。
     */
    if (this.isDryRun) {
      await this.settleDryRunPositions();
      return;
    }

    const exchangeBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
    const localOpen = positionStore.open(traderId);

    for (const local of localOpen) {
      const live = exchangeBySymbol.get(local.symbol);
      if (live) {
        // Still open: ratchet the peak profit used by the drawdown guard.
        positionStore.updatePeak(traderId, local.symbol, live.unrealizedPnlPercent);
        continue;
      }

      await this.bookVanishedPosition(local);
    }

    // Positions opened outside the bot (a manual trade) are adopted rather than
    // ignored: the model should manage what is actually there.
    for (const live of exchangePositions) {
      if (localOpen.some((p) => p.symbol === live.symbol)) continue;
      this.emit(
        'warn',
        `发现一个未被记录的 ${live.symbol} ${live.side === 'long' ? '多头' : '空头'} 持仓，已收养它以便模型可以管理。`,
      );
      positionStore.insert({
        traderId,
        symbol: live.symbol,
        side: live.side,
        quantity: live.quantity,
        entryPrice: live.entryPrice,
        leverage: live.leverage,
        liquidationPrice: live.liquidationPrice,
        marginUsed: live.marginUsed,
        stopLoss: null,
        takeProfit: null,
        stopOrderId: null,
        tpOrderId: null,
        openReasoning: '收养：该仓位是在机器人之外开立的。',
      });

      /*
       * ⚠️ **收养之后立刻补挂保护单 —— 不要留一个裸的杠杆敞口。**
       *
       * 收养的意义是"让模型可以管理它"，而一个没有交易所侧保护的杠杆仓位
       * **是最糟糕的状态**（§2.6）：VPS 重启、网络中断、进程卡住，那个仓位
       * 就没有任何东西在兜底。原来收养只写一行记录、把 `stop_loss` 留成 null，
       * 保护单要等到**下一次加仓或减仓**才可能被补上 —— 而在那之前敞口是裸的，
       * 在那之后还有"缺记录被误判成挂单失败"的另一个坑（已单独修）。
       *
       * 用**兜底比例**而不是问模型：收养发生在对账里，此刻没有模型上下文，
       * 而"先有个保护、再由模型按失效位调整"明显好于"等着"。
       *
       * ## 挂不上时**不**擅自平仓
       *
       * §2.6 的"挂不上就立刻市价平仓"是针对**本机器人自己开的仓** ——
       * 那种情况下平掉是回到已知状态。而这里是**操作员手动开的一个仓位**：
       * 替他决定平掉，比留一个无保护的仓位更越界。所以报错，让他自己处置。
       */
      const fallbackPercent = this.activeConfig.riskControl.fallbackStopLossPercent;
      const fallbackDistance = live.entryPrice * (fallbackPercent / 100);
      const adoptedStop =
        live.side === 'long'
          ? live.entryPrice - fallbackDistance
          : live.entryPrice + fallbackDistance;

      const protection = await this.replaceProtection({
        symbol: live.symbol,
        side: live.side,
        quantity: live.quantity,
        stop: adoptedStop,
        target: null,
        traderId,
      });

      if (protection.stopPlaced) {
        this.emit(
          'info',
          `已为收养的 ${live.symbol} 挂上兜底止损 ${adoptedStop.toFixed(6)}（按 ${fallbackPercent}%）—— 这是系统挑的价位，建议让模型按真实失效位调整一次。`,
        );
      } else {
        this.emit(
          'error',
          `收养的 ${live.symbol} 仓位**没能挂上止损**（${protection.failures.join('；') || '原因未知'}）—— ` +
            '它现在没有交易所侧保护。这是你手动开的仓，系统不会替你平掉，请手动处理。',
        );
      }
    }

    /*
     * 最后再统一检查一遍"持仓还在、但交易所侧没有止损"。
     *
     * 放在收养之后：收养路径刚刚挂过保护单，这一遍不会重复挂。
     * 它同时覆盖了另外两种情况 —— 保护单**事后**被撤掉/过期，
     * 以及下面这种实测事故（见方法的注释）。
     */
    await this.ensureStopsOnOpenPositions(exchangePositions);
  }

  /**
   * **这个机器人当前的持仓 —— 按模式选真相来源。**
   *
   * ## 为什么必须有这一层（2026-10-15 线上实测抓到）
   *
   * `BinanceBroker.getPositions()` **没有 dryRun 守卫** —— 它直接查交易所。
   * 而模拟盘的成交是本地模拟的、**从不真的下单**，所以那个账户上
   * **从来没有它的仓位** → 恒返回空数组。
   *
   * 于是每一个读它的地方都在模拟盘上静默失效：
   * ```
   *   · reconcilePositions   → 把每个本地持仓判成"已消失"并平掉
   *                            （实测持有时间 p50 仅 3.8 分钟，0/37 超过一个周期）
   *   · applyDrawdownGuard   → 空列表 → 回撤守卫【从不触发】
   *   · applyBreakevenGuard  → 空列表 → 保本/移动止损【从不触发】
   *   · recordEquity         → 浮盈恒 0 → 权益曲线是平的
   * ```
   * 而这些都是**静默**的：没有报错、没有告警，界面上看起来一切正常。
   *
   * ## 修法：模拟盘用本地状态合成
   *
   * 模拟盘里"交易所有什么"这个问题的正确答案就是**本地持仓** ——
   * 因为那些仓位本来就是本地模拟出来的。所以这里按本地 `positions` 行
   * 加上**真实标记价**（行情是真实事实，不是模拟的）合成 `ExchangePosition[]`。
   *
   * ⚠️ 这样修的好处是**一处生效、处处生效**：上面四个调用点都改调它，
   * 而不是各写一个 `if (isDryRun)` 分支（那正是"只做一半"的温床 ——
   * 本项目为此吃过四次亏）。
   *
   * ⚠️ **实盘完全不变**：直接转发 `getPositions()`。
   */
  private async effectivePositions(symbol?: string): Promise<ExchangePosition[]> {
    if (!this.isDryRun) return this.deps.broker.getPositions(symbol);

    const open = positionStore
      .open(this.deps.trader.id)
      .filter((p) => symbol === undefined || p.symbol === normalizeSymbol(symbol));
    if (open.length === 0) return [];

    const out: ExchangePosition[] = [];
    for (const local of open) {
      let mark = 0;
      try {
        mark = await this.deps.broker.getMarkPrice(local.symbol);
      } catch {
        /* 读不到标记价：下面用入场价兜底（浮盈按 0），并让调用方看到这个仓位仍然存在。 */
      }
      const price = mark > 0 ? mark : local.entry_price;
      const isLong = local.side === 'long';
      const pnl = (isLong ? price - local.entry_price : local.entry_price - price) * local.quantity;
      const margin =
        local.margin_used > 0
          ? local.margin_used
          : (local.entry_price * local.quantity) / Math.max(1, local.leverage);

      out.push({
        symbol: local.symbol,
        side: local.side as PositionSide,
        quantity: local.quantity,
        entryPrice: local.entry_price,
        markPrice: price,
        leverage: local.leverage,
        liquidationPrice: local.liquidation_price ?? null,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: margin > 0 ? (pnl / margin) * 100 : 0,
        marginUsed: margin,
        notional: price * local.quantity,
        marginType: 'cross',
      });
    }
    return out;
  }

  /**
   * **模拟盘的持仓结算** —— 对着标记价判保护单有没有触发。
   *
   * 见 `reconcilePositions` 顶部那段事故说明：模拟盘**不能**拿交易所的持仓列表
   * 当真相（那里从来没有它的仓位），否则每个仓位都会在同一轮被"发现已消失"
   * 然后平掉 —— 实测持有时间 p50 只有 3.8 分钟。
   *
   * ## 判据
   *
   * ```
   *   做多：标记价 ≤ 止损 → 触发止损（以【止损价】成交）
   *         标记价 ≥ 止盈 → 触发止盈（以【止盈价】成交）
   *   做空：反过来
   * ```
   *
   * ⚠️ **成交价用触发价，不用标记价**：真实交易所的条件单触发后是以触发价
   * （`STOP_MARKET` 是市价、但触发那一刻的价就是触发价附近）成交的。
   * 用标记价会让"止损距离"看起来比实际更小，污染后续的归因。
   *
   * ⚠️ **两个都碰到时按"先碰到哪个"**：一次对账只看一个快照，无法知道先后。
   * 那种情况在 1 个周期（15 分钟）内同时穿过止损与止盈，说明波动极大；
   * 按**止损优先**处理（保守方向 —— 少赚好过多亏）。
   *
   * ⚠️ 标记价读不到时**跳过这个标的**，不猜。读不到 ≠ 没触发，
   * 而据一个猜出来的价平仓会永久污染账本（§2.3）。
   */
  private async settleDryRunPositions(): Promise<void> {
    const traderId = this.deps.trader.id;
    const open = positionStore.open(traderId);
    if (open.length === 0) return;

    /* 本轮读到的标记价，顺手喂给模拟盘钱包（见 `paperMarkPrices`）。 */
    const marks: Array<{ symbol: string; markPrice: number }> = [];

    for (const local of open) {
      let mark = 0;
      try {
        mark = await this.deps.broker.getMarkPrice(local.symbol);
      } catch (error) {
        this.emit(
          'warn',
          `模拟盘读不到 ${local.symbol} 的标记价（${(error as Error).message}），本轮不结算它。`,
        );
        continue;
      }
      if (!(mark > 0)) continue;
      marks.push({ symbol: local.symbol, markPrice: mark });

      const isLong = local.side === 'long';
      const stop = local.stop_loss;
      const target = local.take_profit;

      /*
       * 触发判据。`<=` / `>=` 而不是 `<` / `>`：真实交易所的条件单在**等于**
       * 触发价时就会触发，用严格不等会让恰好触到的那一笔永远不平。
       */
      const hitStop = stop !== null && stop > 0 && (isLong ? mark <= stop : mark >= stop);
      const hitTarget =
        target !== null && target > 0 && (isLong ? mark >= target : mark <= target);

      if (!hitStop && !hitTarget) {
        /*
         * 都没触发 → 继续持有。仍然要**更新回撤守卫用的峰值** ——
         * 那是"浮盈曾经到过多少"的记录，只有每轮更新才准。
         */
        positionStore.updatePeak(traderId, local.symbol, this.dryRunUnrealizedPercent(local, mark));
        continue;
      }

      /* 止损优先（保守方向）。见方法注释里"两个都碰到"那段。 */
      const reason: CloseReason = hitStop ? 'stop_loss' : 'take_profit';
      const exitPrice = hitStop ? (stop as number) : (target as number);

      this.emit(
        'info',
        `[模拟盘] ${local.symbol} ${isLong ? '多头' : '空头'} 的` +
          `${hitStop ? '止损' : '止盈'} ${exitPrice} 已被标记价 ${mark} 触发，按触发价结算。`,
      );

      /*
       * ⚠️ 走 `bookClosedPosition()` 而不是自己写 `trades` —— 那是**唯一**的
       * 平仓记账路径（§2.3），它负责减仓扣减、手续费归属、`positions.close()`。
       * 自己再写一遍会立刻产生"两处各记一次"的分歧。
       *
       * 手续费：模拟盘没有真实成交记录，按**名义价值 × 往返费率**估 ——
       * 复用 `fallbackRoundTripFeeRate`（策略里已有的那个回退费率，
       * 默认 0.001 = 0.1%，见 `strategy.ts`）。
       *
       * ⚠️ **不能用 0**：那会让模拟盘看起来比现实更容易赚 ——
       * 而模拟盘的价值恰恰是"尽量像真的"。实测模拟盘的净额本来就是负的，
       * 记 0 会把一个真实存在的成本藏起来。
       */
      const notional = exitPrice * local.quantity;
      const exitFee = notional * this.activeConfig.riskControl.fallbackRoundTripFeeRate;

      await this.bookClosedPosition(local, reason, exitPrice, exitFee);
    }

    /* 整轮读完后统一记一次，供模拟盘钱包算浮盈（见 `paperMarkPrices`）。 */
    this.rememberMarkPrices(marks);
  }

  /**
   * **最近一次读到的标记价快照**（symbol → markPrice）。
   *
   * 用途只有一个：让 `TraderManager` 能在**同步**上下文里给模拟盘钱包算浮盈
   *（`paperAccountStateOf` 是 `getAccountState()` 的实现，而那个签名是同步友好的）。
   *
   * 为什么不在这里现拉一次行情：`getAccountState()` 每个周期都会被调用，
   * 而行情本来就已经在周期里拉过了 —— 再拉一次等于把一个纯读数变成一次网络请求，
   * 且会在"行情接口抖动"时让账户读数跟着失败。缓存住的这一份足够算浮盈。
   *
   * 没读过时是空 Map：调用方按"浮盈 0"处理，**不编造价格**。
   */
  private markPriceSnapshot = new Map<string, number>();

  /** 最近一次的标记价快照（只读，供模拟盘钱包折算浮盈）。 */
  paperMarkPrices(): ReadonlyMap<string, number> {
    return this.markPriceSnapshot;
  }

  /**
   * 记下本轮读到的标记价，供 `paperMarkPrices()` 使用。
   *
   * 只保留**当前有持仓的**标的：全市场 500 多个 symbol 的 Map 会一直占着内存，
   * 而模拟盘钱包只关心自己拿着的那几个。
   */
  private rememberMarkPrices(rows: ReadonlyArray<{ symbol: string; markPrice: number }>): void {
    const next = new Map<string, number>();
    for (const row of rows) {
      if (Number.isFinite(row.markPrice) && row.markPrice > 0) next.set(row.symbol, row.markPrice);
    }
    if (next.size > 0) this.markPriceSnapshot = next;
  }

  /**
   * 模拟盘某个持仓在给定标记价下的**浮盈百分比**（保证金口径）。
   *
   * 与真实交易所的 `unrealizedPnlPercent` 同一口径：盈亏 ÷ 保证金。
   * 保证金用 `entry × qty ÷ leverage` —— 与 `marginOf()` 一致。
   */
  private dryRunUnrealizedPercent(local: PositionRow, mark: number): number {
    const isLong = local.side === 'long';
    const pnl = (isLong ? mark - local.entry_price : local.entry_price - mark) * local.quantity;
    const margin =
      local.margin_used > 0
        ? local.margin_used
        : (local.entry_price * local.quantity) / Math.max(1, local.leverage);
    return margin > 0 ? (pnl / margin) * 100 : 0;
  }

  /**
   * ⚠️ **持仓还在、交易所侧却没有任何止损 —— 这件事必须有周期性检查。**
   *
   * ## 这条检查为什么存在（2026-09-26 实测事故）
   *
   * SOLUSDT 持仓 0.16 张、浮盈 +5%，交易所侧**一张保护单都不在**：逐张查
   * `algoStatus` 全部是 `CANCELED`、`actualOrderId` 为空（= 从未触发，是被撤掉的），
   * 而它就这样裸着跑了 **1 小时 25 分钟**，系统一句告警都没有。
   *
   * 系统原来的保护只覆盖"**挂的那一刻**失败"（`executeOpen` / `executeAdjust` /
   * 收养路径里的 §2.6 分支）。而"挂上去之后因为任何原因消失"没有任何人管 ——
   * 而 §2.6 存在的意义恰恰是**不让一个没有保护的杠杆仓位变得看不见**。
   * 这次不是"变得看不见"，而是**它本来就没有任何东西在看**。
   *
   * ## 行为：自动重挂一次（方案 A），**不**自动平仓
   *
   * 发现缺失就按**本地记录的保护位**重挂（`restoreProtection`，它会一并回写单号），
   * 失败只告警、绝不市价平仓 —— 把一笔可能正在盈利的仓位在浮盈时强平，
   * 正是 ADAUSDT 那次净 −0.0166 的形态（用户的原话是"这不是白玩吗"）。
   *
   * ## 三条不肯定的地方都不动手
   *
   *   · **挂单列表读失败** → 跳过。读不到 ≠ 没有；据它重挂会挂出第二张止损。
   *   · **止盈方向不对** → 只挂止损（止盈缺了不影响安全）。
   *   · **止损落在标记价的错误一侧** → 告警而不挂：`STOP_MARKET` 挂上去会
   *     **立即触发**，那等于一次没有经过任何决策的市价平仓。
   *
   * ## 幂等与代价
   *
   * 每轮对账跑一次；有止损就什么都不做。每个持仓标的每轮多读两次挂单
   * （weight 1 + 1）；挂上之后的下一轮 `hasStop` 为真，稳态零额外调用。
   */
  private async ensureStopsOnOpenPositions(exchangePositions: ExchangePosition[]): Promise<void> {
    const traderId = this.deps.trader.id;
    const liveBySymbol = new Map(exchangePositions.map((position) => [position.symbol, position]));
    /** 什么算"这个仓位有止损"。注意 `TRAILING_STOP_MARKET` 也是止损。 */
    const STOP_TYPES = new Set(['STOP', 'STOP_MARKET', 'TRAILING_STOP_MARKET']);
    /**
     * 什么算"这个仓位有止盈"。
     *
     * ## 为什么必须单独判（2026-10-19 实盘抓到）
     *
     * 这个方法原来只有一行判据：
     * ```ts
     * if (orderTypes.some((type) => STOP_TYPES.has(type))) continue;
     * ```
     * **只要有任何止损就整段跳过** —— 于是"有止损但没止盈"的仓位
     * （CTUSDT 实测就是这样）永远不会被补上目标位。
     *
     * 用户问得很准：「系统会不会有兜底策略？」——
     * 答案是**原来只有止损兜底，止盈完全没有**。
     */
    const TARGET_TYPES = new Set(['TAKE_PROFIT', 'TAKE_PROFIT_MARKET']);

    for (const local of positionStore.open(traderId)) {
      const live = liveBySymbol.get(local.symbol);
      // 仓位已经不在交易所 —— 那是 `reconcilePositions()` 上面那一遍的事。
      if (!live) continue;

      let orderTypes: string[];
      try {
        const [regular, algo] = await Promise.all([
          this.deps.broker.getOpenOrders(local.symbol),
          this.deps.broker.getOpenAlgoOrders(local.symbol),
        ]);
        orderTypes = [...regular, ...algo].map((order) => {
          /*
           * ⚠️ **字段名有两个，必须都看。**
           *
           * 普通委托（`BinanceOrderResponse`）用 `type`；而 Algo 条件单
           * （`BinanceAlgoOrderResponse`）用 **`orderType`**。
           *
           * 只看 `type` 会让**每一张 Algo 止损都被读成空字符串** → 每轮都判定
           * "这个仓位没有止损" → 每个对账点重复挂一次止损（并被交易所 `-4130` 拒），
           * 同时把本地 `stop_order_id` 越写越乱。
           *
           * 这个坑是在测试里抓到的：`algoAfter` 从 4 → 6 → 8 一路涨，
           * 而代码还认为自己只是在"补挂一张缺失的止损"。
           */
          const type =
            (order as { orderType?: unknown }).orderType ?? (order as { type?: unknown }).type;
          return String(type ?? '');
        });
      } catch (error) {
        log.warn(
          `[${this.deps.trader.name}] ${local.symbol} 的挂单列表读取失败，本轮不检查保护单：${(error as Error).message}`,
        );
        continue;
      }

      const hasStop = orderTypes.some((type) => STOP_TYPES.has(type));
      const hasTarget = orderTypes.some((type) => TARGET_TYPES.has(type));

      const isLong = local.side === 'long';
      const mark = live.markPrice > 0 ? live.markPrice : live.entryPrice;

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **止损与止盈分开判**（2026-10-19 用户要求，修"只有止损没止盈"）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 原来为什么不对
       *
       * ```
       *   if (有任何止损) continue;   ⇒ 有止损没止盈的仓位永远不补目标
       * ```
       * 实盘 CTUSDT 就是这样：有止损、无止盈、浮盈跑到 +28% 仍无目标位。
       *
       * ## 现在的四种情况
       *
       * ```
       *   ① 有止损 + 有止盈  → continue（健康，什么都不做）
       *   ② 有止损 + 无止盈  → 只补止盈（用下面的 deriveTarget 规则）
       *   ③ 无止损 + 有止盈  → 补止损（原有逻辑），止盈保留
       *   ④ 都没有           → 两者都补（原有逻辑 + 新规则）
       * ```
       *
       * ⚠️ **补止盈不总是对的** —— 见 `deriveTarget()` 的说明：
       * 已经浮盈超过保本点的仓位**不该**补一个固定目标（那会把
       * 本来能跑的单锁死在半路）。判断在那个函数里。
       */
      if (hasStop && hasTarget) continue;

      /* 本地记录的保护位优先（那是模型/系统当初认定的失效位）。 */
      const recordedOk =
        local.stop_loss !== null &&
        local.stop_loss > 0 &&
        (isLong ? local.stop_loss < mark : local.stop_loss > mark);

      let stop: number;
      if (recordedOk) {
        stop = local.stop_loss as number;
      } else {
        const percent = this.activeConfig.riskControl.fallbackStopLossPercent;
        stop = isLong
          ? live.entryPrice * (1 - percent / 100)
          : live.entryPrice * (1 + percent / 100);
        if (!(isLong ? stop < mark : stop > mark)) {
          this.emit(
            'error',
            `${local.symbol} 的持仓在交易所侧没有任何止损，而按兜底比例（${percent}%）算出的止损 ` +
              `${stop.toFixed(6)} 已落在当前标记价 ${mark} 的**错误一侧** —— 挂上去会立即触发、等于未经决策的市价平仓，` +
              '因此不挂。请人工确认这个仓位。',
          );
          continue;
        }
      }
      /*
       * ══════════════════════════════════════════════════════════════════
       *  **补止盈的两条规则**（2026-10-19 用户要求）
       * ══════════════════════════════════════════════════════════════════
       *
       * 用户原话：
       * > 「系统会不会有兜底策略（如果有兜底策略 要设置多少合理，
       * >  不能太保守导致小亏导致手续费亏损得磨损，和错失大涨机会）」
       *
       * 三个约束：① 不能太保守 ② 不能磨损手续费 ③ 不错失大涨。
       *
       * 规则：
       * ```
       *   A. 本地有 take_profit 且方向正确 → 用它（Jev 算的，最优先）
       *   B. 没有可用 take_profit →
       *        浮盈 < 保本触发点 → 按「止损距离 × 盈亏比」补
       *        浮盈 ≥ 保本触发点 → 不补，交给移动止损
       * ```
       *
       * 为什么用「止损距离 × 盈亏比」而不是固定百分比：
       * ```
       *   固定 7.5% + 止损 8.2% ⇒ 盈亏比 0.91:1  ← 必亏
       *   固定 7.5% + 止损 1.2% ⇒ 盈亏比 6.25:1
       * ```
       * 同一个固定值在波动不同的标的上含义相反。
       */
      const rr = Math.max(0.5, jevNumber('min_rr'));
      /* 往返成本约 0.1%（单边 0.05% × 2），乘 3 倍安全边际 = 0.3%。 */
      const minTargetPercent = 0.3;
      /* 浮盈百分比 —— 决定该不该补固定目标（用标记价，不是成本价）。 */
      const unrealizedPercent = isLong
        ? ((mark - local.entry_price) / local.entry_price) * 100
        : ((local.entry_price - mark) / local.entry_price) * 100;
      const breakevenTrigger = Math.max(
        1,
        this.deps.trader.mode === 'jev'
          ? jevNumber('breakeven_trigger_percent')
          : this.activeConfig.riskControl.breakevenTriggerPercent,
      );
      /** 本地记录的目标位（方向必须还在现价之外）。 */
      const recordedTargetOk =
        local.take_profit !== null &&
        local.take_profit > 0 &&
        (isLong ? local.take_profit > mark : local.take_profit < mark);

      let target: number | null = recordedTargetOk ? (local.take_profit as number) : null;

      if (target === null && !hasTarget) {
        /*
         * 浮盈已超保本点就不补：那种仓位正在奔跑，补固定目标等于设天花板。
         * 移动止损会跟着上移 —— 既保护利润又不封顶，那才是"不错失大涨"。
         */
        if (unrealizedPercent < breakevenTrigger) {
          const stopDistancePercent = (Math.abs(stop - local.entry_price) / local.entry_price) * 100;
          const targetDistancePercent = Math.max(stopDistancePercent * rr, minTargetPercent);
          const candidate = isLong
            ? local.entry_price * (1 + targetDistancePercent / 100)
            : local.entry_price * (1 - targetDistancePercent / 100);
          if (isLong ? candidate > mark : candidate < mark) {
            target = candidate;
            this.emit(
              'info',
              `${local.symbol} 缺止盈，已按「止损 ${stopDistancePercent.toFixed(2)}% × 盈亏比 ${rr.toFixed(1)}」` +
                `补目标 ${candidate.toFixed(6)}（距离 ${targetDistancePercent.toFixed(2)}%，已确保覆盖往返成本）`,
            );
          } else {
            this.emit(
              'info',
              `${local.symbol} 缺止盈，但算出的目标落在现价错误一侧 —— 不补，交给移动止损。`,
            );
          }
        } else {
          this.emit(
            'info',
            `${local.symbol} 缺止盈，但浮盈 ${unrealizedPercent.toFixed(2)}% 已超保本点 ${breakevenTrigger}% —— ` +
              '不补固定目标（避免设天花板），交给移动止损跟随。',
          );
        }
      }

      const protection = await this.replaceProtection({
        symbol: local.symbol,
        side: isLong ? 'long' : 'short',
        quantity: local.quantity,
        stop,
        target,
        traderId,
      });

      if (protection.stopPlaced) {
        this.emit(
          'warn',
          `⚠️ ${local.symbol} 的持仓在交易所侧**没有止损**，已自动重挂 ${stop}` +
            `（${recordedOk ? '用本地记录的保护位' : '用兜底比例'}${protection.targetPlaced ? '，止盈一并恢复' : ''}）` +
            '—— 它此前为什么消失值得查（撤单失败/被替换/交易所侧过期）。',
        );
      } else {
        this.emit(
          'error',
          `${local.symbol} 的持仓没有任何交易所侧止损，且**重挂失败**` +
            `（${protection.failures.join('；') || '原因未知'}）—— 该仓位目前无保护，下一轮会再试。`,
        );
      }
    }
  }

  /**
   * Book a local position the exchange no longer holds, and close the row.
   *
   * There are two ways to learn a position vanished — a cycle comparing the
   * exchange's position list, and the ledger pass at the head of every cycle —
   * and both must produce the **same** record. This is that single path, so
   * neither one can close a row without booking the round-trip it represents.
   *
   * The exit is recovered from the exchange's fill record rather than assumed:
   * the reason detection needs it too, because when the exchange cannot tell us
   * which order fired, the exit price relative to the two levels is what
   * disambiguates a stop from a target.
   */
  private async bookVanishedPosition(local: PositionRow): Promise<void> {
    const fill = await this.lastFillFor(local.symbol);
    const exitPrice =
      fill.price > 0 ? fill.price : await this.deps.broker.getMarkPrice(local.symbol).catch(() => 0);

    const reason = await this.detectCloseReason(
      local.symbol,
      local.stop_order_id,
      local.tp_order_id,
      exitPrice,
      local.entry_price,
      local.stop_loss,
      local.take_profit,
    );
    await this.bookClosedPosition(local, reason, exitPrice, fill.fee);
  }

  /**
   * Determine why a position vanished.
   *
   * The subtlety that this used to get wrong: when a `closePosition` stop or
   * target fires, Binance also removes the *surviving* one, so neither id is in
   * `openAlgoOrders` any more. Checking "is the stop gone?" therefore always
   * answered yes and every take-profit was booked as a stop loss.
   *
   * The authoritative signal is each algo order's own final status — the one
   * that fired is `FINISHED`/`TRIGGERED`, the other is `CANCELED`. When that
   * query is unavailable (dry run, network), fall back to comparing the exit
   * price against the levels we recorded, which is unambiguous in practice
   * because they sit on opposite sides of the entry.
   */
  private async detectCloseReason(
    symbol: string,
    stopOrderId: string | null,
    tpOrderId: string | null,
    exitPrice: number,
    entryPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): Promise<CloseReason> {
    try {
      const [stopOrder, tpOrder] = await Promise.all([
        stopOrderId ? this.deps.broker.getAlgoOrder(Number(stopOrderId)) : Promise.resolve(null),
        tpOrderId ? this.deps.broker.getAlgoOrder(Number(tpOrderId)) : Promise.resolve(null),
      ]);

      const fired = (status: string | undefined): boolean =>
        status === 'FINISHED' || status === 'TRIGGERED';
      const dead = (status: string | undefined): boolean =>
        status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED';

      /*
       * ⚠️ **`'not-found'` 不能当成任何一种终态**（2026-10-14）。
       *
       * `getAlgoOrder` 现在会返回 `'not-found'`（交易所明确说这张单不存在）。
       * 在这里它意味着"那张单已经结束了，但**分不清是触发还是撤销**" ——
       * 而 `fired` / `dead` 都会把它读成 `false`（因为它不是 `undefined` 里的任何一个
       * 状态字符串），于是**自然落空**、继续走下面"用价位推断"的判据。
       *
       * 那正是这里想要的行为：**不拿一个分不清的答案去猜平仓原因**。
       * 所以不需要额外的分支 —— 但必须**显式写下来**，否则下一个人会以为
       * `'not-found'` 被漏处理了，然后给它加一个错误的映射。
       */
      /*
       * ⚠️ **先把状态抽出来再判**（`getAlgoOrder` 现在可能返回 `'not-found'`）。
       * 直接读 `stopOrder?.algoStatus` 会在类型层面失败 —— 那是好事：
       * 它逼着我们把"读失败 / 不存在 / 有状态"三种情况分开处理。
       */
      const statusOf = (o: typeof stopOrder): string | undefined =>
        o === null || o === 'not-found' ? undefined : o.algoStatus;

      if (fired(statusOf(stopOrder))) return 'stop_loss';
      if (fired(statusOf(tpOrder))) return 'take_profit';

      // Both cancelled: the position was closed some other way, so the levels
      // themselves are the tiebreaker.
      if (dead(statusOf(stopOrder)) && dead(statusOf(tpOrder))) {
        const byPrice = this.reasonFromPrice(exitPrice, stopLoss, takeProfit);
        if (byPrice) return byPrice;
      }

      // Liquidation and ADL fills carry a recognisable client order id.
      const fills = await this.deps.broker.getUserTrades(symbol, 20);
      const latest = fills[fills.length - 1];
      if (latest) {
        const clientId = String((latest as { clientOrderId?: string }).clientOrderId ?? '');
        if (/autoclose|adl/i.test(clientId)) return 'liquidated';
      }

      const byPrice = this.reasonFromPrice(exitPrice, stopLoss, takeProfit);
      if (byPrice) return byPrice;

      return 'external';
    } catch {
      return 'external';
    }
  }

  /**
   * Infer the trigger from where the position actually exited.
   *
   * Only used when the exchange will not tell us: each level is on the opposite
   * side of the entry, so whichever one the exit price is sitting on is the one
   * that fired.
   */
  private reasonFromPrice(
    exitPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): CloseReason | null {
    if (!(exitPrice > 0)) return null;
    const toStop = stopLoss !== null ? Math.abs(exitPrice - stopLoss) : Number.POSITIVE_INFINITY;
    const toTarget =
      takeProfit !== null ? Math.abs(exitPrice - takeProfit) : Number.POSITIVE_INFINITY;
    if (toStop === Number.POSITIVE_INFINITY && toTarget === Number.POSITIVE_INFINITY) return null;
    return toStop <= toTarget ? 'stop_loss' : 'take_profit';
  }

  /**
   * The most recent fill for a symbol, used to recover the true exit price and
   * commission. A guessed exit price would corrupt the trade history permanently.
   */
  private async lastFillFor(symbol: string): Promise<{ price: number; fee: number }> {
    try {
      const fills = await this.deps.broker.getUserTrades(symbol, 20);
      const latest = fills[fills.length - 1];
      if (latest) {
        return { price: Number(latest.price) || 0, fee: Number(latest.commission) || 0 };
      }
    } catch {
      /* caller falls back to the mark price */
    }
    return { price: 0, fee: 0 };
  }

  /**
   * 这一张开仓单**实际付掉的手续费**（按订单号把多笔成交的佣金加起来）。
   *
   * ## 为什么开仓也要查一次
   *
   * 币安的下单响应里**不含佣金**，要另外查成交明细。平仓路径早就这么做了
   * （`lastFillFor`），而开仓路径从来没查过 —— 于是 `orders.fee` 对每一张开仓单
   * 都是 `0`，带来两个后果：
   *
   *  1. **订单列表的「手续费」列对开仓单永远是 0** —— 界面与事实不符；
   *  2. **总账校验无法把"未平仓的持有成本"加到平台侧**（它要读这个字段），
   *     于是那个差额被报成"账本可能有漏记或重复记账"，而且每轮报一次。
   *
   * 按**交易所订单号**（`orderId`）筛而不是"取最后一笔"：市价单可能拆成多笔成交
   * （`lastFillFor` 只取最后一笔，对平仓够用，因为那里同时要的是最新价）。
   * 佣金是**支出**，币安报成负数，这里取绝对值 —— 与 `orders.fee` 的语义
   * （"付了多少"的正数）一致。
   *
   * ## ⚠️ 不能按 `clientOrderId` 筛 —— 那个字段在响应里根本不存在
   *
   * 这里原来按 `f.clientOrderId` 过滤，而 `BinanceUserTrade`（`types.ts`）
   * **没有这个字段**（`/fapi/v1/userTrades` 的真实响应字段表里也没有它）。
   * 于是 `mine.length` 恒为 0、函数**恒返回 0**：
   *
   *   · `orders.fee` 对每一张开仓单都是 0 → 订单列表的「手续费」列永远空着；
   *   · 总账校验读不到"未平仓的持有成本"，那条差额告警每轮都报；
   *   · 而且 `detectCloseReason` 里同一个 `clientOrderId` 过滤也恒不命中
   *     （爆仓会被记成普通止损）。
   *
   * 换成 `f.orderId`（真实存在，且同一订单的多笔成交共用它）之后，
   * "这笔开仓到底付了多少佣金"才第一次真的取得回来。
   */
  private async entryFeeFor(symbol: string, orderId: string): Promise<number> {
    try {
      const fills = await this.deps.broker.getUserTrades(symbol, 20);
      const mine = fills.filter((f) => String(f.orderId) === String(orderId));
      if (mine.length === 0) return 0;
      return Math.abs(mine.reduce((sum, f) => sum + (Number(f.commission) || 0), 0));
    } catch {
      /* 拿不到就按 0：宁可这一列暂时空着，也不要让开仓整个失败。 */
      return 0;
    }
  }

  /** Persist a trade and mark the local position closed. */
  private async bookClosedPosition(
    local: PositionRow,
    reason: CloseReason,
    exitPriceInput: number,
    exitFeeInput: number,
    /** Exchange fill time, when known. Funding is attributed to the real window. */
    closedAtInput?: string,
  ): Promise<{ netPnl: number; grossPnl: number; exitPrice: number; quantity: number }> {
    const traderId = this.deps.trader.id;

    /*
     * Prefer the exchange's own accounting for this round-trip.
     *
     * Its `realizedPnl` is authoritative, and reconstructing the round-trip from
     * the fills is the only way to see **both** legs' commission — the live path
     * previously recorded just the exit leg, understating costs by about half.
     * Falls back to the local arithmetic when the fills are unavailable.
     */
    const authoritative = await this.findRoundTrip(local).catch(() => null);
    const closedAt = authoritative?.closedAt || closedAtInput || new Date().toISOString();

    let exitPrice = authoritative?.exitPrice || exitPriceInput;
    if (!(exitPrice > 0)) {
      exitPrice = await this.deps.broker.getMarkPrice(local.symbol).catch(() => 0);
    }
    if (!(exitPrice > 0)) {
      this.emit('warn', `无法确定 ${local.symbol} 的出场价，改用入场价记账`);
      exitPrice = local.entry_price;
    }

    const isLong = local.side === 'long';
    /*
     * ⚠️ **减过仓的仓位，要把已经记过的那部分减掉。**
     *
     * 「减仓」会当场记一笔（那部分已经实现）。而 `findRoundTrip()` 重建的是
     * **整段往返** —— 它的 grossPnl / entryFee / exitFee 覆盖全部入场与出场。
     * 直接记下去的话，同一笔利润会被记两次。
     *
     * **重复记账比漏记更糟**：漏记让账面比账户差，而重复记账让账面比账户好 ——
     * 后者正是 §2.5 明令禁止的方向（它会让一个亏损账户看起来是赚的）。
     *
     * 已记的部分存在 `positions.realized_partial_pnl`（迁移 M8）。
     * 没有减过仓时它是 0，行为与以前完全一致。
     *
     * ## ⚠️ 2026-10-03：扣的必须是**毛盈亏**，而且手续费也要按比例扣
     *
     * 这里原来是 `grossRaw - partialPnl`，而 `partialPnl` 是**净**盈亏
     * （`grossPnl - exitFee`，见 `positionStore.resize` 的调用点）——
     * **拿毛减净**，等于把已记那部分的平仓手续费**多扣了一次**：
     *
     * ```text
     * 整段往返: 毛 G、开仓费 EF、平仓费 XF
     * 部分平仓: 毛 g、平仓费 xf（已单独记过一行，净 g − xf）
     * 正确:     grossPnl = G − g,  exitFee = XF − xf
     * 原来:     grossPnl = G − (g − xf) = (G − g) + xf   ← 毛被高估 xf
     * ```
     *
     * 同时 `entryFee`/`exitFee` 也一直是**整段**的值，于是那部分手续费
     * 在账上出现两次（部分平仓那行一次、最终平仓这行一次）。
     *
     * 所以这里用**数量比例**把已记那部分的手续费也扣掉 —— `booked_partial_qty`
     * 是同一笔部分平仓记下的数量，两条腿的费率本就一致，按它分摊足够准，
     * 而且不需要新增列去存"那一笔的费"。
     */
    const partialBooked = positionStore.partialBooked(traderId, local.symbol);
    const partialGross = partialBooked.gross;
    const partialQty = partialBooked.qty;

    const grossRaw =
      authoritative?.grossPnl ??
      (isLong ? exitPrice - local.entry_price : local.entry_price - exitPrice) * local.quantity;

    /*
     * 只在**有权威值时**减：那种情况下权威值覆盖整段往返。
     *
     * 而回退公式用的是 `local.quantity` —— 那个数量在减仓之后已经变小了，
     * 所以它本来只覆盖剩余部分，再减一次就会少记。
     *
     * ⚠️ 扣的是**毛**（`partialGross`），不是净 —— 详见上面那段 2026-10-03 的说明。
     */
    const grossPnl = authoritative && partialGross !== 0 ? grossRaw - partialGross : grossRaw;

    // When the fills are unavailable we know only the exit leg's commission, and
    // recording that as zero would be worse than recording half of it — the
    // reconciliation pass corrects it to the true total shortly afterwards.
    /*
     * ⚠️ **已记那部分的手续费要按数量比例扣掉**，否则它在账上出现两次
     * （部分平仓那行一次、这一行一次）。两条腿的费率一致，按数量分摊足够准。
     *
     * ## 🔴 分母曾经是 `local.quantity`，于是手续费被**整个乘掉**
     *
     * 这两个操作数是**互不相交的两块**，不是"部分 / 整体"：
     *
     *   · `partialQty`（`booked_partial_qty`）—— **已减仓并记过账**的数量，单调累加
     *   · `local.quantity`               —— 减仓之后**剩余还开着**的数量
     *
     * 原始总量是 `partialQty + local.quantity`。拿前者的除以后者，减掉一半时
     * `168 / 168 = 1.0` → `Math.min(…, 1)` 夹到 1 → `entryFee` 与 `exitFee`
     * **双双归零**。实测：只要减仓量 ≥ 剩余量（减掉一半或更多），
     * 最终平仓那一行的手续费恒为 0。
     *
     * 而少记手续费的方向正是 §2.5 明令禁止的那一侧 —— **账面净额比交易所好看**，
     * 一个实际亏损的账户能看起来是赚的。同时 `ledger_check` 的 gap 长期不为 0，
     * 会逐渐训练操作员忽略那条唯一能自动发现账本错误的告警。
     *
     * ## 只在有权威值时分摊
     *
     *   · `authoritative` 存在时，`entryFee` / `exitFeeRaw` 覆盖**整段往返**
     *     （见 `findRoundTrip()` 的说明），所以必须按数量比例把已记那部分扣掉；
     *   · `authoritative == null`（走回退）时，`exitFeeInput` 是**剩余腿自己那一笔**
     *     的成交手续费，它本来就不含已减仓的部分 —— 再乘 `(1 - share)` 会
     *     **新引入少记**（把唯一已知的那笔费用也削掉）。
     *
     * `entryFeeRaw` 在回退路径上恒为 0（开仓费在开仓那一刻已作为持仓成本付掉），
     * 所以它乘不乘都一样；这里仍统一写成乘以 share，是为了让"只有权威值才分摊"
     * 这条规则在两条腿上长得一样，不必让读者去推 `?? 0` 的取值。
     */
    const partialShare =
      authoritative && partialQty > 0 && local.quantity > 0
        ? Math.min(partialQty / (partialQty + local.quantity), 1)
        : 0;
    const entryFeeRaw = authoritative?.entryFee ?? 0;
    const exitFeeRaw = authoritative?.exitFee ?? exitFeeInput;
    const entryFee = entryFeeRaw * (1 - partialShare);
    /*
     * 回退路径（`authoritative == null`）**原样**采用 `exitFeeInput`：
     * 那是剩余腿自己那一笔的费用，不参与分摊。
     */
    const exitFee = authoritative ? exitFeeRaw * (1 - partialShare) : exitFeeInput;

    /*
     * Funding is read here, at the moment of closing, and not only during the
     * reconciliation pass.
     *
     * Funding settles every 8 hours and appears in **no** fill, so it can only
     * come from `/fapi/v1/income`. It used to be attributed on the reconcile
     * path alone — but that path only touches a row it can match, and a close
     * booked live with figures the reconcile could not match kept
     * `funding_fee = 0` forever. A position held across a settlement then showed
     * a net PnL that was better than the account's, which is exactly the
     * divergence §2.5 forbids.
     */
    const fundingFee = await this.fundingFor(local.symbol, local.opened_at, closedAt);

    /*
     * 上锁前先问一次：这一回合是不是已经记过账了？
     *
     * 对账（`reconcileTradeHistory`）在周期开头跑，`reconcilePositions` 在周期末尾跑，
     * 两者都可能看到同一个已经消失的仓位。`positionStore.close()` 只能保证**本进程内**
     * 不会重复记账，而这里要保证的是"同一个真实回合在 `trades` 里只有一行"——
     * 所以判定必须在写账之前，用的身份与 `trades.insert()` 里的完全一致
     * （`trades.findDuplicate()` 是同一个实现，不存在两套判据）。
     */
    const alreadyBooked = tradeStore.findDuplicate({
      traderId,
      symbol: local.symbol,
      quantity: authoritative?.quantity ?? local.quantity,
      entryPrice: local.entry_price,
      /* 出场价——两条记账路径之间唯一同源的字段，见 `findDuplicate()` 的说明。 */
      exitPrice,
      /* 开仓时刻 —— 主判据（两条路径的平仓时刻不同源，差过 11 分钟）。 */
      openedAt: local.opened_at,
      closedAt,
      entryOrderId: authoritative?.entryOrderId ?? null,
      /*
       * **确定性键。** 同一笔平仓在交易所只有一个 `orderId`，所以"两条路径拿到
       * 同一个单号"就等于"这是同一个回合" —— 不依赖任何容差窗口。
       *
       * 上面那些启发式判据都有边界：实测漏网的一对（ZECUSDT `#107`/`#120`）
       * 共用同一个 `exit_order_id`，却因为平仓时刻差 6 秒（超出 2 秒窗口）
       * 被判成两个回合，账上多记一笔 —— 而那一笔让归属权益比钱包高出 0.015。
       */
      exitOrderId: authoritative?.exitOrderId ?? null,
    });
    if (alreadyBooked !== null) {
      if (authoritative) {
        /*
         * 运行期拿到了成交记录的权威口径，就把它写到已有那一行上 —— 这正是
         * §2.5 的"重复执行只修正"：`net_pnl` 仍然只在
         * `trades.insert()` / `applyExchangeFigures()` 里算过一次。
         *
         * 为什么必须修正而不是"找到就什么都不做"：运行期与对账对同一回合取到的
         * 数量口径本来就可能不同（本地持仓量 vs 交易所实际成交量）。如果只认"已存在"
         * 而把交易所的数字丢掉，账本里留下的就是那个较粗的口径 —— 与账户对不上，
         * 而 §2.5 要求账目必须能与交易所对得上。
         */
        /*
         * ⚠️ **重建错位时，手续费也要走交易所流水 —— 只保住数量是不够的。**
         *
         * 重建的窗口起点落在持仓中间时，整条序列错位，它算出的 fee 是按**错位后的数量**
         * 计的（实测 HYPEUSDT：重建 0.000970 vs 交易所 0.010204）。只保留本地数量的话，
         * 净额照样偏大、账目 gap 依旧（0.0596）。
         *
         * 只在"数量明显不可信"时才多取一次流水 —— 正常情况不多花这次请求。
         */
        let entryFee = authoritative.entryFee;
        let exitFee = authoritative.exitFee;
        const localQuantity = tradeStore.quantityOf(alreadyBooked);
        if (
          localQuantity !== undefined &&
          !shouldTrustReconciledQuantity(localQuantity, authoritative.quantity)
        ) {
          const fees = await this.commissionsFor(
            local.symbol,
            authoritative.openedAt,
            authoritative.closedAt,
          );
          if (fees) {
            entryFee = fees.entryFee;
            exitFee = fees.exitFee;
            log.warn(
              `[${this.deps.trader.name}] ${local.symbol} 的重建成交量（${authoritative.quantity}）与本地（${localQuantity}）差得太远 —— ` +
                `本回合手续费改用交易所流水（${(entryFee + exitFee).toFixed(6)}，重建算的是 ${(authoritative.entryFee + authoritative.exitFee).toFixed(6)}）。`,
            );
          }
        }

        tradeStore.applyExchangeFigures({
          id: alreadyBooked,
          grossPnl: authoritative.grossPnl,
          entryFee,
          exitFee,
          fundingFee,
          entryPrice: authoritative.entryPrice,
          exitPrice: authoritative.exitPrice,
          quantity: authoritative.quantity,
          leverage: local.leverage,
          entryOrderId: authoritative.entryOrderId || null,
          exitOrderId: authoritative.exitOrderId || null,
        });
      }
      positionStore.close(local.id);
      tradeEvents.record(traderId, local.symbol, 'exit');
      const existing = tradeStore.list(traderId, 200).find((t) => t.id === alreadyBooked);
      this.emit(
        'info',
        `${local.symbol} 的平仓此前已入账（第 #${alreadyBooked} 笔），本次不再重复记录；净 ${(existing?.netPnl ?? 0).toFixed(4)} USDT。`,
      );
      return {
        netPnl: existing?.netPnl ?? 0,
        grossPnl: existing?.pnl ?? grossPnl,
        exitPrice: existing?.exitPrice ?? exitPrice,
        quantity: existing?.quantity ?? local.quantity,
      };
    }

    const booked = tradeStore.insert({
      traderId,
      symbol: local.symbol,
      side: isLong ? 'long' : 'short',
      quantity: authoritative?.quantity ?? local.quantity,
      entryPrice: local.entry_price,
      exitPrice,
      leverage: local.leverage,
      grossPnl,
      entryFee,
      exitFee,
      fundingFee,
      closeReason: reason,
      openedAt: local.opened_at,
      closedAt,
      source: 'bot',
      entryOrderId: authoritative?.entryOrderId ?? null,
      exitOrderId: authoritative?.exitOrderId ?? null,
      /*
       * **把开仓时记下的情报归因搬到成交上**（归因链最后一环，2026-10-12）。
       *
       * `local` 就是那行**仓位记录** —— 开仓时（`positions.insert`）
       * 已把 `decision.intelKeys` 存在它的 `intel_keys` 上。
       * 平仓时**直接搬过来**，不需要回查决策记录
       *（那需要靠 symbol + 时间猜，正是我拒绝过的"猜测式归因"）。
       *
       * ⚠️ 仓位行缺这个字段（老数据、收养的仓位）时 `?? []` ——
       * 语义是"**纯技术面成交**"，与 225 笔历史成交一致。
       *
       * ⚠️ 对账路径（`reconcileTradeHistory`）从交易所历史重建时**拿不到**它 ——
       * 那时为空是**正确的**：那条路径本来就没有决策上下文。
       */
      intelKeys: parseIntelKeysOf(local.intel_keys),
      // 这是一笔真实平仓：先查重，别把同一回合记两次（§2.5 的幂等）。
      idempotent: true,
    });
    const tradeId = booked.id;

    positionStore.close(local.id);
    tradeEvents.record(traderId, local.symbol, 'exit');

    const record = tradeStore.list(traderId, 200).find((t) => t.id === tradeId);
    if (record) eventBus.publish({ type: 'trade', traderId, trade: record });

    /*
     * Log the **net** figure: it is what actually moved the balance, and the
     * gross number was what made the console disagree with the account.
     */
    /* ⚠️ 用 
etPnlOf —— 见它的注释（资金费的符号）。 */
    const net = record?.netPnl ?? netPnlOf({ grossPnl, fee: entryFee + exitFee, fundingFee });
    const sign = net >= 0 ? '+' : '';
    const costNote =
      entryFee + exitFee > 0 ? `，含手续费 ${(entryFee + exitFee).toFixed(4)}` : '';
    const fundingNote = fundingFee !== 0 ? `，含资金费 ${fundingFee.toFixed(4)}` : '';
    if (!booked.created) {
      /*
       * 这一回合已经记过账了（对账先补录、运行期后到），`insert()` 把那一行还了回来。
       * 不新增行，也**不再播报一次"已平仓"** —— 否则操作员会以为账户上真的平了两次。
       * 保留的仍是运行期发现的平仓原因（`stop_loss` / `take_profit` 比 `reconciled`
       * 信息多），所以这里只把重复这件事说清楚。
       */
      this.emit(
        'info',
        `${local.symbol} 的平仓此前已入账（第 #${tradeId} 笔），本次不再重复记录；净 ${sign}${net.toFixed(4)} USDT。`,
      );
    } else {
      this.emit(
        'info',
        `已平仓 ${local.symbol} ${local.side === 'long' ? '多头' : '空头'} @ ${exitPrice} → 净 ${sign}${net.toFixed(4)} USDT（毛 ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)}${costNote}${fundingNote}，${closeReasonLabel(reason, net)}）`,
      );
    }

    /*
     * --- AI 托管：平仓之后请复盘员写因果结论，并结算参数实验 ------------
     *
     * ⚠️ **只挂在 `booked.created === true` 上**，也就是"这确实是一笔新入账的平仓"。
     *
     * 挂在重复入账上会有两个后果：`agent_memory.trade_id` 有 UNIQUE，
     * 重复写会被幂等跳过（无害）；但**结算**会被多触发一次 ——
     * 而结算依据是"这次调整之后有几笔结果"，重复触发会让它把同一笔数两遍，
     * 于是策略师看到一个比真实更"有依据"的历史。
     *
     * 放在这里而不是三个 `bookClosedPosition` 调用点上：那样漏掉任何一个
     * 都会让一部分平仓永远得不到复盘 —— 而漏掉是静默的。
     */
    if (booked.created && this.deps.agent) {
      const agent = this.deps.agent;
      // 两个调用都不阻塞平仓路径：复盘要调模型，可能几秒到几十秒。
      agent.reviewTrade({
        tradeId,
        symbol: local.symbol,
        closeReason: reason,
        netPnl: net,
        grossPnl,
        fee: entryFee + exitFee,
        /*
         * 这几项是复盘员**真正需要**的事实，此前没被传出去 ——
         * 于是它的结论只能停在「数据不足」（实测 #1 号记忆就是如此）。
         *
         * `peakPnlPercent` 最关键：没有它，复盘员分不清
         * 「正常波动的保护性离场」与「止盈过晚导致利润回吐」，
         * 而这两者的改法完全相反。
         */
        peakPnlPercent: local.peak_pnl_percent,
        leverage: local.leverage,
        holdMinutes: Math.max(0, (Date.now() - new Date(local.opened_at).getTime()) / 60_000),
        entryPrice: local.entry_price,
        exitPrice,
        openedAt: local.opened_at,
        /*
         * **开仓时计划的保护位** —— 复盘员要靠它区分"止损设错/挂错"与
         * "方向就错"，而以前它拿不到，只能在同标的历史记忆里找一个数，
         * 于是 `#104` 把上一笔（`#275`）的 0.544 当成了本笔的止损。
         * 详见 `ReviewTradeFacts.stopLoss` 的说明。
         *
         * ⚠️ 取**开仓时**的值，而不是当前的：`local` 是平仓那一刻的持仓行，
         * 而移动止损会改写 `stop_loss`（`#280` 就是被改写过的例子）——
         * 但复盘要回答的是"这一笔的保护位是怎么被触发的"，用平仓时的值才是对的
         * （它就是**实际挂在交易所上的那个价**）。开仓原值另有用途，
         * 由 `entry.adjustments` 那条"风控当时记下的调整"覆盖。
         */
        stopLoss: local.stop_loss,
        takeProfit: local.take_profit,
      });
      agent.settleOnly();
    }

    return {
      netPnl: net,
      grossPnl,
      exitPrice,
      quantity: authoritative?.quantity ?? local.quantity,
    };
  }

  /**
   * Funding paid or received on one symbol over a round-trip's own lifetime.
   *
   * Returns 0 — never a guess — when the income ledger cannot be read, and says
   * so in the log. Recording 0 is the honest answer (§2.5: 不要假装算过); the
   * reconcile pass re-reads the ledger later and overwrites the row with the
   * real figure if this read failed.
   */
  private async fundingFor(symbol: string, openedAt: string, closedAt: string): Promise<number> {
    try {
      /*
       * The ledger is read from `openedAt`, not from the trader's creation time:
       * a close is a one-off event, and asking for days of history to attribute
       * eight hours of funding would spend weight on every exit for no gain.
       */
      const events = await this.deps.broker.getIncome({
        startTime: new Date(openedAt).getTime(),
        endTime: new Date(closedAt).getTime() + 60_000,
      });
      return fundingInWindow(events, symbol, openedAt, closedAt);
    } catch (error) {
      log.warn(
        `[${this.deps.trader.name}] ${symbol} 的资金费读取失败，本次记 0，待对账时补齐：${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * 一个回合的**开仓侧与平仓侧手续费** —— 直接从交易所流水取。
   *
   * ## 为什么需要它（与 `fundingFor()` 同一个理由，但这次是被数量错位带出来的）
   *
   * `reconstructRoundTrips()` 的窗口起点落在持仓中间时整条成交序列会错位，
   * 而它算出来的**手续费是按错位后的数量计的**。实测（2026-09-29，HYPEUSDT）：
   *
   * ```text
   * 重建 0.000970   vs   交易所流水 0.010204      （同一个回合，差 10 倍）
   * ```
   *
   * 只"保留本地数量"是**不够的** —— fee 还是错的，净额照样偏大、账目 gap 依旧是 0.0596。
   * 所以当重建的数量明显不可信时，手续费也走这条**完全不受重建影响**的来源。
   *
   * 读不到时返回 `null`（**退回重建值，而不是记 0** —— 记 0 会让净额更偏）。
   */
  private async commissionsFor(
    symbol: string,
    openedAt: string,
    closedAt: string,
  ): Promise<{ entryFee: number; exitFee: number } | null> {
    try {
      const events = await this.deps.broker.getIncome({
        startTime: new Date(openedAt).getTime(),
        endTime: new Date(closedAt).getTime() + 60_000,
      });
      return commissionsInWindow(events, symbol, openedAt, closedAt);
    } catch (error) {
      log.warn(
        `[${this.deps.trader.name}] ${symbol} 的手续费读取失败，本次沿用重建值：${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Find this position's completed round-trip in the exchange's fill history.
   *
   * Matched on the **entry order id** (with symbol + quantity + entry price) —
   * see `roundTripKey` — rather than on time, because the local record's
   * `opened_at` is when the runtime decided and the exchange's is when the order
   * filled.
   *
   * ## ⚠️ 但那个 key **不是唯一的** —— 同标的的两个回合可能撞在一起
   *
   * 实测事故（用户的原话：「机器人未运行时平仓是什么意思？首先我没有关闭过机器人」）：
   *
   *     上一笔 #111  HYPEUSDT 0.21 @ 97.2 → 97.575   opened 01:09  closed 05:21
   *     这一笔 #110  HYPEUSDT 0.21 @ 97.2 → 96.451   opened 05:53  closed 07:54
   *
   * **同样的标的、同样的数量、同样的入场价** —— `roundTripQueryKey` 完全一致，
   * 而 `find(...)` 取到的是时间更早的那个（`#111`）。于是：
   *
   *   · `closedAt` 被替换成 `#111` 的平仓时刻、`exitPrice` 变成 `97.575`；
   *   · 再拿这组**错的**参数去 `findDuplicate()`，`|closedAt − #111.closed_at| = 0`
   *     必然命中 `#111`，于是运行期记账直接跳过（「此前已入账（第 #111 笔）」）；
   *   · 这笔真实成交最后只能由兜底路径补录，**平仓原因被写成 `reconciled`**
   *     —— 界面上就成了「机器人未运行时平仓」，而机器人从头到尾没停过，
   *     WS 把成交推来了、那张止损单在库里是 `FILLED`、本地持仓行也带着
   *     `stop_order_id`：**原因本来完全查得到。**
   *
   * ## 修法：key 仍然只做**筛选**，时间只做**排序**
   *
   * 注释原来给的理由（本地 `opened_at` 是决策时刻、交易所的是成交时刻，两者不同源）
   * 说的是**不能拿时间做等式**，而不是"时间没有用"。所以这里：
   *
   *   · 时间**不参与**过滤（不同源的问题原样保留，行为不会因此变紧）；
   *   · 只在**已通过 key 筛选**的候选里，取开仓时刻最接近 `local.opened_at` 的那个。
   *
   * 两个候选的时间差都落在"不同源误差"之内时，选哪个都对 —— 那说明它们本就同源。
   * 而像上面那种差 4.7 小时的情形，这一步就是决定性的。
   */
  private async findRoundTrip(local: PositionRow): Promise<ReconstructedTrade | null> {
    const fills = await this.deps.broker.getUserTrades(local.symbol, 50);
    const completed = reconstructRoundTrips(fills);

    /*
     * The entry order id is the exact discriminator when it is known, and the
     * local position row does not carry one — so this lookup matches on the
     * descriptive part (symbol + quantity + entry price). That is a **lookup for
     * figures**, not a key for overwriting another row: the strict key is written
     * onto the trade row, and it is the trade row that reconciliation matches on.
     */
    const wanted = roundTripQueryKey({
      symbol: local.symbol,
      quantity: local.quantity,
      entryPrice: local.entry_price,
    });
    const matches = completed.filter(
      (t) =>
        roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }) ===
        wanted,
    );
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!;

    const target = new Date(local.opened_at).getTime();
    const distance = (t: ReconstructedTrade): number => Math.abs(new Date(t.openedAt).getTime() - target);
    return matches.reduce((best, t) => (distance(t) < distance(best) ? t : best));
  }

  /* ---------------------------------------------------------------------- */
  /*  Ledger reconciliation                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuild the trade ledger from the exchange's fill history.
   *
   * This is the fix for the failure that made the console disagree with the
   * account. Live bookkeeping can only observe a close while it is running, so a
   * position whose exchange-side stop or target fires during downtime — or
   * between cycles, right before the trader is stopped — is never recorded. On
   * the live test account that lost a **+0.6563** round-trip entirely and left
   * the console reporting a loss on a profitable account.
   *
   * Reconstruction is idempotent: a round-trip already on the books is *corrected*
   * from the exchange's figures rather than duplicated, which also repairs the
   * historical fees that were captured on the exit leg only.
   *
   * Runs at start and at the head of every cycle, so the ledger converges on the
   * exchange's regardless of what the runtime managed to witness.
   *
   * `full` chooses the **time window**, and the distinction is about cost, not
   * correctness. Every pass asks one `/fapi/v1/userTrades` question per symbol in
   * scope (up to 500 fills each), and re-reads local history through
   * `trades.ledger()` / `trades.tradedSymbols()` — so a pass whose window is
   * "everything this trader ever did" gets more expensive every week it runs,
   * while answering a question whose answer can only have changed for symbols
   * that traded recently.
   *
   *  · `full: true`  — window from the trader's creation. Used by the
   *    operator-triggered `/reconcile`, and once every
   *    `FULL_RECONCILE_EVERY_PASSES` passes. This is the pass that recovers a
   *    close the process slept through.
   *  · `full: false` — window of `RECONCILE_WINDOW_MS`. Used by the routine
   *    cycle. Anything it skips is still inside the *next* deep pass's window, so
   *    nothing becomes permanently invisible.
   *
   * The deep pass deliberately still runs: skipping it entirely would leave a
   * symbol that traded once and then went quiet unrecoverable forever, which is
   * exactly the bug this whole method exists for.
   */
  async reconcileTradeHistory(
    full = true,
  ): Promise<{
    recovered: number;
    /** **真的**按交易所口径覆盖了已有行的笔数（不是"尝试过"的笔数）。 */
    corrected: number;
    /**
     * 尝试修正的总笔数（撞上已有行的次数）。
     *
     * ⚠️ 与 `corrected` 分开：`applyExchangeFigures` 在"重建腿边界不可信"时会**整笔
     * 拒绝**，那种情况计入 `correctedKept`。三者满足
     * `correctedAttempted === corrected + correctedKept`。
     */
    correctedAttempted: number;
    /** 因"腿边界存疑、保留本地口径"而**没能覆盖**的笔数（判不出来的那些）。 */
    correctedKept: number;
    funding: number;
    /** 不属于本平台任何机器人的成交笔数（外部活动）。 */
    foreignRounds: number;
    /** 这些外部成交的净额，用来解释「账户为什么在缩水」。 */
    foreignNet: number;
  }> {
    const traderId = this.deps.trader.id;
    const deep = full || this.reconcilePasses % FULL_RECONCILE_EVERY_PASSES === 0;
    this.reconcilePasses += 1;

    const createdSince = new Date(this.deps.trader.createdAt).getTime() - 60_000;
    /*
     * The window floor. A deep pass keeps the original "since this trader
     * existed" bound; a routine pass narrows it. `Math.max` with the creation
     * time keeps a *young* trader's window small as well — a trader created an
     * hour ago must not ask the exchange for a month of income history it cannot
     * have.
     */
    const since = deep
      ? createdSince
      : Math.max(createdSince, Date.now() - RECONCILE_WINDOW_MS);
    const sinceIso = new Date(since).toISOString();

    /*
     * The income ledger does double duty here: it supplies funding fees (which no
     * fill mentions) and it names **every symbol the account has touched**, which
     * is how a symbol the platform has no record of at all gets discovered.
     */
    let incomeEvents: Awaited<ReturnType<BinanceBroker['getIncome']>> = [];
    /*
     * ⚠️ **"读失败"与"读到空"是两件事，而它们在这里被混成了一件。**
     *
     * 下面那个 `catch` 原来只写 `log.debug`，然后 `incomeEvents` 停在 `[]` ——
     * 于是**总账校验**拿一个空数组算出 `exchangeNet = 0`，再把差额报成
     * "平台的账本可能有漏记或重复记账"。
     *
     * 实测那个账户上报出「平台记录 0.3246、交易所流水 **0.0000**，差 0.3246」——
     * 0.3246 恰好是它的全部净盈亏，而流水是 0，**说明流水根本没读到**。
     * 而同一次运行的落库值 `gap` 只有 0.0057（正常）：**读成功就正常、读失败就报账目错误。**
     *
     * 那正是这段代码下面自己警告过的：「一个永久误报的校验比没有校验更糟 ——
     * 它会训练操作员忽略这条告警，而这是唯一能自动发现『账本错了』的地方」。
     */
    let incomeReadFailed = false;
    try {
      incomeEvents = await this.deps.broker.getIncome({ startTime: since });
    } catch (error) {
      incomeReadFailed = true;
      log.debug(`[${this.deps.trader.name}] 收入流水读取失败，本次对账跳过资金费与总账校验：${(error as Error).message}`);
    }

    /*
     * Symbols in scope for this pass.
     *
     * Open positions are always included regardless of the window — a position
     * this trader is actually holding must have its fills checked even when its
     * local trade row is older than the window. Only the traded-symbol list is
     * windowed, and only on a routine pass.
     */
    /*
     * 扫描范围 —— **必须是账户级，不是本机器人级**。
     *
     * ## 为什么
     *
     * 这一趟循环做两件事，而它们的范围本来就不同：
     *
     *   1. **恢复本机器人的成交**（下面 `tradeStore.insert`，由 `ownOrders` 闸门把关）；
     *   2. **清点外部活动** —— "不属于本平台任何机器人"的成交，那是个**账户级**概念，
     *      落在哪个符号上与本机器人自己交易过什么毫无关系。
     *
     * 原来两件事共用一份"本机器人"的符号表（`tradedSymbols(traderId)` /
     * `positions.open(traderId)`）。结果一个只交易过少数币种的机器人**看不到账户在
     * 别的币种上的外部活动**：那部分盈亏记不进 `foreignNet`，却实实在在躺在交易所
     * `income` 流水里 —— 于是总账校验报出**账本并没有错**的假差额。
     *
     * ⚠️ 实测：共用同一账户的五个机器人里，三个报 195 笔外部活动、差额 −0.20，
     * 两个报 222/223 笔、差额 ±0.006。**差的就是扫描范围。**
     *
     * 多扫几个符号的代价是几次 `getUserTrades`，而漏扫的代价是一个永久误报的
     * 账本校验 —— 那会训练操作员忽略这条唯一能自动发现"账本错了"的告警。
     *
     * 窗口仍然保留：例行对账只看窗口内交易过的符号，只有深扫才不限。
     */
    const symbols = new Set<string>([
      ...tradeStore.allTradedSymbols(deep ? undefined : sinceIso),
      ...positionStore.allOpenSymbols(),
      ...incomeEvents.map((e) => e.symbol).filter((s): s is string => Boolean(s)),
    ]);

    /*
     * Two indexes over the same rows.
     *
     * `byKey` is the strict key (symbol + qty + entry price + entry order id) and
     * is what prevents one round-trip's exchange figures from being written onto
     * another row: two entries of the same size at the same price are only the
     * same trade if they are the same order.
     *
     * `byDescription` holds rows that carry **no** entry order id — booked before
     * the id was known, or from an adopted position. Those can only be matched on
     * their description, and keeping them in a separate index that is consulted
     * only after the strict lookup fails means the ambiguous match can never
     * shadow an exact one.
     */
    // Bounded the same way: a routine pass only needs the rows it can still match.
    const ledger = tradeStore.ledger(traderId, deep ? undefined : sinceIso);
    const byKey = new Map(
      ledger.map((t) => [
        roundTripKey({
          symbol: t.symbol,
          quantity: t.quantity,
          entryPrice: t.entryPrice,
          entryOrderId: t.entryOrderId,
        }),
        t.id,
      ]),
    );
    const byDescription = new Map(
      ledger
        .filter((t) => !t.entryOrderId)
        .map((t) => [
          roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }),
          t.id,
        ]),
    );

    /*
     * Which exchange orders this trader actually placed.
     *
     * Two traders can share one exchange account, and then the fill history is
     * identical for both — reconciliation would have each of them claim every
     * round-trip, double-counting the account's PnL across the books. Only the
     * local order history can say who traded what, so adoption is gated on it.
     *
     * The live symptom was exactly this: two traders on one credential, and a
     * boot pass that booked the same four trades onto both.
     */
    const ownOrders = orderStore.exchangeOrderIds(traderId);
    /*
     * **全局**订单号 —— 用来把「别的机器人」和「外部活动」分开。
     *
     * 两者都"不属于本机器人"，但处置完全相反：前者是多机器人共用账户的
     * 正常情况，静默跳过是对的；后者意味着**账户上有本平台之外的交易**，
     * 那会直接吃掉余额，而账面上看不出来。
     */
    const allOrders = orderStore.allExchangeOrderIds();
    /** 不属于本平台**任何**机器人的成交。函数末尾汇总上报。 */
    const foreign: Array<{ symbol: string; net: number; at: string }> = [];

    let recovered = 0;
    let corrected = 0;
    /**
     * 本轮**尝试**修正的笔数，与其中**被判"边界存疑、保留本地"**的笔数。
     *
     * ## 为什么必须分开数（2026-10-17，用户报「每次都是修正 50 笔」）
     *
     * `corrected` 原来数的是"调用过 `applyExchangeFigures` 几次"，而那个函数**有权
     * 整笔拒绝**（重建出的"腿"边界不可信时不覆盖数量、金额与价位）。于是线上每轮
     * 都报"修正 50 笔"，实际一行都没变 —— 一个恒定的假数字，把"每一轮都在重复
     * 尝试同一批判不出来的回合"这件真事藏了整整一轮迭代。
     *
     * 现在三个数各有意义：
     *   · `correctedAttempted` —— 撞上已有行的次数（**尝试**）；
     *   · `corrected`          —— 真的按交易所口径覆盖了的（**生效**）；
     *   · `keptForBoundary`    —— 因边界存疑整行保留本地的（**判不出来**）。
     *
     * ⚠️ 第三个数是**结论的一部分**，不是噪音：`attempted == keptForBoundary` 意味着
     * 这一轮的修正全军覆没，而日志必须让操作员一眼看见这一点（见函数末尾那条日志）。
     */
    let correctedAttempted = 0;
    let keptForBoundary = 0;
    let fundingTotal = 0;
    /*
     * 诊断计数器 —— 定位"外部净额"与交易所流水那 0.2 差额到底丢在哪一步。
     *
     * 光看汇总值只能知道"差 0.2"，而它可能是：时间窗把某些回合挡在外面、
     * 还是归属闸门把它们判给了别的机器人、还是没有 `entryOrderId` 的成交。
     * 三种原因的修法完全不同，所以把它们分开数。
     */
    const skipDiag = { beforeWindow: 0, otherTrader: 0, foreign: 0, foreignNoId: 0, reversed: 0 };
    /**
     * 反向回合**已经按交易所口径记进账本**的净额合计（2026-10-03 起不再丢弃）。
     *
     * 它只用于日志与诊断 —— 记进账本之后，这笔钱自然进了 `platformSelf`，
     * 不需要在 `platformNet` 里再补一次（那会重复计）。
     */
    let reversedBookedNet = 0;
    /*
     * 本机器人下单时的**意图**（交易所单号 → 用途）—— 用来辨认重建出的回合有没有
     * 把开/平方向搞反。详见 `orders.purposeByExchangeOrderId()` 与下面那段校验。
     */
    const purposeById = orderStore.purposeByExchangeOrderId(traderId);

    /*
     * ⚠️ **本轮对账里"已经被认领过"的成交 id**（2026-10-15 账目差 12.61 的修复）。
     *
     * 为什么需要它：一笔**穿过零的翻转成交**同时属于两个腿（旧腿的平、新腿的开），
     * 所以它会出现在两个 `ReconstructedTrade.fillIds` 里。若两个腿各按自己的
     * `fillIds` 去 `income` 里认领，同一笔 `REALIZED_PNL` 会被计两次 ——
     * 那正是我们要修的那个"账本虚增"形状。
     *
     * 实测对照（三个成交、两个腿）：正确答案是 `10 + 4 = 14`；
     * 不去重会得到 `10 + 10 + 4 = 24`。
     *
     * 范围是**一次对账**：下一轮重新从空集合开始，所以重复执行对账仍然幂等
     *（`platformSelf` 是重算的，不是累加的）。
     */
    const claimedFillIds = new Set<string>();

    for (const symbol of symbols) {
      if (!this.deps.registry.get(symbol)) continue;
      let fills;
      try {
        fills = await this.deps.broker.getUserTrades(symbol, 500);
      } catch {
        continue; // a symbol we cannot read must not abort the whole pass
      }

      for (const trip of reconstructRoundTrips(fills)) {
        /*
         * ⚠️ **先校验方向 —— 反了的回合一个数都不许记。**
         *
         * `reconstructRoundTrips()` 用的是**净头寸法**：按持仓数量的变化判断哪一笔
         * 是开仓、哪一笔是平仓。它拿的是 `getUserTrades(symbol, 500)`（最近 500 笔），
         * 而**"窗口起点时的持仓"这个信息根本不存在** —— 一旦窗口起点落在一个持仓的
         * 中间，第一笔（其实是平仓）会被当成开仓，**整个 leg 的 open/close 就此反向**，
         * 把不同回合的单号配到一起。
         *
         * 实测（2026-09-29，6 笔 `reconciled`）：所谓 `entry_order_id` 在 `orders`
         * 里记的用途是 `exit`、所谓 `exit_order_id` 记的是 `entry`，两者甚至相隔 2 天；
         * 6 笔净额合计 `-0.125559`，**正好等于账目校验的全部缺口**。
         * 也就是说：**账本没错，是重建凭空造出了这些反向回合**（还顺带让
         * `findDuplicate()` 的单号去重判据失效）。
         *
         * 判据用**运行期记下的下单意图**（`orders.purpose`）—— 那是我们当时真正
         * 想做的事，比重建的推测可信。找不到（外部活动/别的机器人）就照原路走。
         */
        const entryPurpose = trip.entryOrderId ? purposeById.get(trip.entryOrderId) : undefined;
        const exitPurpose = trip.exitOrderId ? purposeById.get(trip.exitOrderId) : undefined;
        if (entryPurpose === 'exit' || exitPurpose === 'entry') {
          skipDiag.reversed += 1;
          /*
           * ══════════════════════════════════════════════════════════════════════
           *  ⚠️ **两个单号要按"用途证据"逐个纠正，而不是无条件对调**（2026-10-17）
           * ══════════════════════════════════════════════════════════════════════
           *
           * ## 为什么必须纠正（ACC-07 的剩余危害）
           *
           * 这个分支的定义是"开/平判反了"，所以 `trip.entryOrderId` 其实是**平仓**单、
           * `trip.exitOrderId` 其实是**开仓**单。而 `trades.insert(..., idempotent: true)`
           * 会走 `findDuplicate()`，它的**确定性判据只看 `exit_order_id`**
           *（`repositories.ts:2782-2790`，不看 `entry_order_id`）。
           *
           * 于是：
           *   · 首次记这个反向回合 → 查不到 → 正常插入（没问题）；
           *   · **同一段成交被再次重建** → 拿"所谓的 exitOrderId"（实际是开仓单号）
           *     去查 `trades.exit_order_id` → **查不到**（账本里那个号在 `entry_order_id`）
           *     → **重复插入**。
           *
           * ## 为什么不是"无条件对调"
           *
           * 无条件 `entryOrderId: trip.exitOrderId, exitOrderId: trip.entryOrderId`
           * 在**两个用途都查得到**时是对的（那是铁证：两个单号恰好互换）。
           * 但实测的四例里有**两例只有一半能查到**：
           *
           * ```text
           *   WLDUSDT  入场 23687788340 用途【未知】  出场 23919030401 用途 entry
           *   HYPEUSDT 入场 14270293462 用途【未知】  出场 14295439869 用途 entry
           * ```
           *
           * 这时 `trip.entryOrderId`（那个"未知"的号）**未必**是平仓单 —— 它可能属于
           * 别的机器人、或者被 `Number()` 改写过精度（见 `orderIdIn()` 的注释）。
           * 无条件对调会把一个**来源不明的单号**写进 `exit_order_id`（判重身份），
           * 那就是"用一个猜测去替换一个已知错误"。
           *
           * ## 所以：每个单号**只有拿到正面证据时才改写**
           *
           *   · `exitPurpose === 'entry'` ⇒ 重建的"出场单"确实是开仓单 ⇒ 它才是 `entry_order_id`；
           *   · `entryPurpose === 'exit'` ⇒ 重建的"入场单"确实是平仓单 ⇒ 它才是 `exit_order_id`；
           *   · 用途未知的那一半**保持原样** —— 不引入新的错误（宁可少一条判据，
           *     也不要写一个假身份进去）。
           *
           * ## `exitOrderIds`（复数）为什么不能原样传
           *
           * 它是"这个腿的全部**出场**单号"，而方向反了 ⇒ 它装的是**开仓**单号。
           * 拿它去查 `exit_order_id IN (...)` 只会落空（那些号在 `entry_order_id` 里），
           * 白跑一条 SQL 且给出"没有重复"的假信心。
           * 所以：只有当我们**确知**了真正的平仓单（`entryPurpose === 'exit'`）时，
           * 才把它作为单元素数组传进去；否则传空数组（= 这条判据本轮不参与）。
           */
          const correctedEntryOrderId =
            exitPurpose === 'entry' ? trip.exitOrderId : trip.entryOrderId;
          const correctedExitOrderId =
            entryPurpose === 'exit' ? trip.entryOrderId : trip.exitOrderId;
          /*
           * ⚠️ 只有"真正的平仓单"才进 `exitOrderIds`。`entryPurpose === 'exit'` 时
           * `trip.entryOrderId` 就是它；否则没有可靠来源，传空（不参与判重）。
           */
          const correctedExitOrderIds: string[] =
            entryPurpose === 'exit' && trip.entryOrderId ? [trip.entryOrderId] : [];
          const notice =
            `[${this.deps.trader.name}] 重建出的 ${symbol} 回合方向是反的（所谓入场单 ${trip.entryOrderId} ` +
            `实际用途 ${entryPurpose ?? '未知'}、所谓出场单 ${trip.exitOrderId} 实际用途 ${exitPurpose ?? '未知'}）` +
            '—— 开/平方向、数量与价位都不可信，但**净额仍按交易所口径记账**（见下）。' +
            '这通常说明成交历史的窗口起点落在持仓中间，净头寸法把开/平判反了。';
          /*
           * ⚠️ **只告警一次。** 这个回合的成因（窗口起点落在持仓中间）在我们能读到的
           * 历史里是固定的，所以**每一轮都会重建出同一个反向回合** —— 每轮刷 WARN
           * 会让日志像在持续出错，把真正的新问题淹掉。
           */
          const noticeKey = `${trip.entryOrderId}->${trip.exitOrderId}`;
          if (this.reversedTripNotices.has(noticeKey)) {
            log.debug(notice);
          } else {
            this.reversedTripNotices.add(noticeKey);
            log.warn(notice);
          }

          /*
           * ── 2026-10-03：**不再整笔丢弃，而且金额改走 income 流水** ─────────────
           *
           * 用户在主账户上跑实盘，问「盈亏计算是否正确」。查到 `#9` 的账目与交易所
           * 流水差 **-0.436177**，而差额全部来自这里：方向反了的回合被 `continue`
           * 丢掉 ⇒ `platformSelf` 少了那部分已实现盈亏 ⇒ 页面上的「交易盈亏」偏低、
           * 总账校验每轮报一条「账目与交易所对不上」。
           *
           * ⚠️ **但 `trip.grossPnl` 不能用** —— 这一点是测试当场纠正过来的：
           * 交易所把 `realizedPnl` 记在**平仓那一笔成交**上，而方向一反，那笔就被
           * 当成了开仓、它的 `realizedPnl` 于是走开腿分支被丢掉（实测构造出来的
           * `grossPnl = 0`，而真实是 1.5）。**方向错的不只是元数据，金额也会错配。**
           *
           * 所以金额取**交易所流水**（`incomeEvents` 里的 `REALIZED_PNL`），
           * 按该标的、该回合的生命周期窗口聚合 —— 那是**完全不受重建影响**的权威口径，
           * 与上面 `!trustQuantity` 那条分支把手续费改走 `commissionsInWindow()` 同一个理由。
           */
          {
            /*
             * ⚠️⚠️ **金额按【成交 id】归属，不按"标的 + 时间窗口"**（2026-10-15 修）
             *
             * ## 事故：实盘账本比交易所高 12.61 USDT（而本金只有 100）
             *
             * 实测 `#10`：
             * ```
             *   platformNet  +5.657252      ← 账本
             *   exchangeNet  -6.956285      ← 交易所流水
             *   gap          12.613538
             *
             *   逐项：reconciled_reversed 38 笔 · 净 +13.0577   ← 与 gap 量级吻合
             *   platformSelf − reversedNet = -7.4004（与交易所只差 0.44，差两个数量级）
             * ```
             *
             * ## 根因：窗口聚合把【别人的回合】算进了自己
             *
             * 原来这里是 `realizedInWindow(events, symbol, openedAt, closedAt)` ——
             * 按**标的 + 时间窗口**。而这些回合的窗口**平均 23.1 小时、最大 159.3 小时**
             *（其他平仓类只有 2–3 小时），因为方向判错时 `openedAt` 取自一笔
             * "其实是平仓"的成交，窗口就此跨到别的回合里。实测：
             * ```
             *   ADAUSDT #344 reconciled_reversed  10-06T15:53 → 10-10T17:07（97 小时）
             *   被它包住的真实回合：#250 stop_loss · #281/#283 manual_partial
             *                       · #288 drawdown_guard（共 12 个回合落在别的窗口内部，
             *                       净额合计 +4.5997）
             *   ⇒ 那些盈亏各自已经记过账，却又被这个窗口聚合了一遍
             * ```
             *
             * ## 修法：`income.tradeId` 就是成交的 `id`
             *
             * 实测确认（`NEARUSDT`）：19 条 `REALIZED_PNL` 与 33 笔成交里
             * **19/19 的 `tradeId` 能在成交里找到**。所以"这笔盈亏属于哪个回合"
             * 有精确答案 —— 与手续费那侧早就采用的"按单号而不是按标的"同源
             *（见本文件讲 `openEntryCosts` 的那段）。
             *
             * ⚠️⚠️ **但归属必须用 `fillIds`，不能用 `closeFillIds`**（实测纠正）
             *
             * 这个分支的定义就是「**开/平判反了**」，所以"哪一笔是平腿"这个判断
             * **本身就是错的**。用 `closeFillIds` 会一个数都匹配不到：
             * ```
             *   夹具实测：交易所把 1.5 记在成交 #1 上（那是真实的平仓），
             *   而重建把它误判成【开腿】→ 它在 openFillIds 里
             *   ⇒ 拿 closeFillIds=['2'] 去匹配 → 0（而正确答案是 1.5）
             * ```
             * 所以退回"这个腿的全部成交"，并用 `claimedFillIds` 去重 ——
             * 一个穿过零的翻转成交同时属于两个腿，不去重会重复入账。
             */
            const realizedForTrip =
              trip.fillIds.length > 0
                ? realizedInFills(incomeEvents, trip.fillIds, claimedFillIds)
                : /* 兜底：老版本重建出的回合没有 fillIds（回放/跨版本）→ 退回窗口口径。 */
                  realizedInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
            const fundingForTrip = fundingInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
            const feesForTrip =
              commissionsInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
            /*
             * 窗口里一条 `REALIZED_PNL` 都没有 ⇒ 这一个"回合"在交易所流水里没有任何
             * 已实现盈亏 —— 那它大概率是重建把两笔平仓拼出来的假回合（金额为 0），
             * 记它只会往账本里塞一行噪声。**宁可不记。**
             */
            if (realizedForTrip === 0 && feesForTrip.entryFee + feesForTrip.exitFee === 0) {
              log.debug(
                `[${this.deps.trader.name}] ${symbol} 的反向回合在 income 里没有任何流水 —— 不记账。`,
              );
              continue;
            }
            const netForTrip = netPnlOf({
              grossPnl: realizedForTrip,
              fee: feesForTrip.entryFee + feesForTrip.exitFee,
              fundingFee: fundingForTrip,
            });
            try {
              tradeStore.insert({
                traderId,
                symbol,
                side: trip.side,
                quantity: trip.quantity,
                entryPrice: trip.entryPrice,
                exitPrice: trip.exitPrice,
                leverage: this.leverageFor(symbol),
                /* 金额来自交易所流水，**不是**重建的推测。 */
                grossPnl: realizedForTrip,
                entryFee: feesForTrip.entryFee,
                exitFee: feesForTrip.exitFee,
                fundingFee: fundingForTrip,
                /* 独立原因码：方向字段不可信，金额来自流水。 */
                closeReason: 'reconciled_reversed',
                openedAt: trip.openedAt,
                closedAt: trip.closedAt,
                source: 'reconciled',
                /*
                 * ⚠️ **用纠正过的单号**（见上面那段"逐个纠正"的说明）——
                 * 直接传 `trip.*` 会让 `findDuplicate()` 的确定性判据（只看
                 * `exit_order_id`）永远查不到，于是同一段成交被再次重建时重复插入。
                 */
                entryOrderId: correctedEntryOrderId || null,
                exitOrderId: correctedExitOrderId || null,
                exitOrderIds: correctedExitOrderIds,
                idempotent: true,
              });
              reversedBookedNet += netForTrip;
              this.emit(
                'info',
                `${symbol} 的一个回合开/平方向不可信（成交历史窗口起点落在持仓中间），` +
                  `已按【交易所流水】记账：净 ${netForTrip >= 0 ? '+' : ''}${netForTrip.toFixed(4)} USDT。` +
                  '该行的方向与数量字段请勿用于胜率统计。',
              );
            } catch (error) {
              log.warn(
                `[${this.deps.trader.name}] ${symbol} 的反向回合记账失败（不影响本周期交易）：` +
                  `${(error as Error).message}`,
              );
            }
          }
          continue;
        }
        if (new Date(trip.closedAt).getTime() < since) {
          skipDiag.beforeWindow += 1;
          continue;
        }
        const funding = fundingInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
        fundingTotal += funding;
        const key = roundTripKey(trip);
        /*
         * Exact match first. Only when no row owns this entry order do we fall
         * back to the description-only index, and only for rows that have no
         * entry order id of their own — so an ambiguous row can never be
         * overwritten by, or overwrite, an identified one.
         */
        const existingId =
          byKey.get(key) ??
          byDescription.get(
            roundTripQueryKey({
              symbol: trip.symbol,
              quantity: trip.quantity,
              entryPrice: trip.entryPrice,
            }),
          );

        if (existingId !== undefined) {
          /*
           * ⚠️ **重建错位时，手续费也必须走 income 的权威值 —— 不能只挡住数量。**
           *
           * 实测（2026-09-29，HYPEUSDT）：重建的窗口起点落在持仓中间时，整条序列错位，
           * 它算出来的 `fee` **是按错位后的数量计的**（重建 0.000970 vs 交易所 0.010204）。
           * 只保留本地数量是不够的 —— fee 还是错的，净额照样偏大，gap 依然在（0.0596）。
           *
           * 所以数量不可信时，`entryFee/exitFee` 改从 income 流水取（它的 COMMISSION 是
           * 结算资产计价、且**完全不受重建影响**）。数量本身由 `applyExchangeFigures()`
           * 内部再挡一次（双保险）。
           */
          const localQuantity = tradeStore.quantityOf(existingId);
          const trustQuantity =
            localQuantity === undefined || shouldTrustReconciledQuantity(localQuantity, trip.quantity);
          const fees = trustQuantity
            ? { entryFee: trip.entryFee, exitFee: trip.exitFee }
            : commissionsInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
          if (!trustQuantity) {
            log.warn(
              `[${this.deps.trader.name}] ${symbol} 的重建成交量（${trip.quantity}）与本地（${localQuantity}）差得太远 —— ` +
                `本回合的手续费改用交易所流水（${(fees.entryFee + fees.exitFee).toFixed(6)}，` +
                `重建算的是 ${(trip.entryFee + trip.exitFee).toFixed(6)}）。`,
            );
          }

          /*
           * ⚠️ **「修正」的计数必须是"真的改了"，不是"试过了"。**
           *
           * 线上实测（用户报「每次都是修正 50 笔」）：这一行原来无条件 `corrected += 1`，
           * 而 `applyExchangeFigures` 在 `keepLocalQuantity` 为真时**整行都不覆盖**（内部
           * 早退）—— 于是日志每次都说"修正了 50 笔"，而账本一个字都没变。
           * 计数虚报比不计更糟：操作员以为对账在正常工作，就没动机去追
           * 「为什么每一轮都要修正同样那 50 笔」（那 50 笔的"腿边界"每次都不可信）。
           *
           * 所以分成两个数：`corrected` = 真正生效的，`keptForBoundary` = 被判"边界存疑、
           * 保留本地"的。后者不是失败，而是**必须上报的第三种结果** ——
           * 操作员要知道"有多少笔是判不出来的"。
           */
          correctedAttempted += 1;
          const figureWrite = tradeStore.applyExchangeFigures({
            id: existingId,
            grossPnl: trip.grossPnl,
            entryFee: fees.entryFee,
            exitFee: fees.exitFee,
            fundingFee: funding,
            entryPrice: trip.entryPrice,
            exitPrice: trip.exitPrice,
            quantity: trip.quantity,
            leverage: this.leverageFor(symbol),
            entryOrderId: trip.entryOrderId || null,
            exitOrderId: trip.exitOrderId || null,
          });
          if (figureWrite.applied) corrected += 1;
          else keptForBoundary += 1;
          /*
           * The row now owns this entry order, so it moves out of the
           * description-only index — otherwise a later identical-looking
           * round-trip could still match it by description.
           */
          byKey.set(key, existingId);
          byDescription.delete(
            roundTripQueryKey({
              symbol: trip.symbol,
              quantity: trip.quantity,
              entryPrice: trip.entryPrice,
            }),
          );
          continue;
        }

        /*
         * Only adopt a round-trip this trader placed.
         *
         * `entryOrderId` comes from the exchange's fill, so an exact match in the
         * local order history proves ownership. A round-trip with no matching
         * order belongs to another trader on the same credential, or to a manual
         * trade — either way it is not ours to claim, and booking it would
         * double-count the account's PnL across the books.
         *
         * No fallback: a trade we cannot prove we opened is skipped. Missing a
         * recovery is a smaller error than inventing one, because a phantom trade
         * corrupts the ledger permanently while a skip corrects itself the moment
         * the order row exists.
         */
        /*
         * 这段"归属闸门"（`ownOrders`）必须先说清楚它管什么、不管什么：
         * 它回答的是"这一回合是不是**本机器人**开的"，用来防止同一个交易所账户下的
         * 多个机器人各自把账户的全部盈亏记到自己账上。
         *
         * 它**不**回答"这一回合是不是已经记过账了"。运行期从本地持仓行记的那一行
         * 完全属于这台机器人，闸门照样放行 —— 于是同一回合被记两次（实盘上
         * SYNUSDT 99/169、LSKUSDT 35 三组，凭空多出 +0.4954）。幂等由
         * `trades.insert()` 内部的身份判定负责（见 `trades.findDuplicate()`），
         * 而不是由这道闸门负责；两者的职责不要混。
         */
        /*
         * ⚠️ **历史行的单号可能被 `Number()` 改写过后三位 —— 用 `orderIdIn` 宽容一次。**
         *
         * 币安新版单号 19 位，而 2026-09-28 之前的解析用 `Number()` → 写进 `orders`
         * 的是被精度改写过的值（实测 `8389766285736312000` vs 真实 `8389766285736311569`）。
         * 严格的字符串相等会让那些回合**永远**被判成「外部活动」→ 账目告警每轮误报。
         * 详见 `orderIdIn()` 的注释。
         */
        const entryId = trip.entryOrderId ?? '';
        if (!orderIdIn(entryId, ownOrders)) {
          /*
           * ⚠️ **这里原来是一句 debug 日志 —— 而 debug 级日志不会被显示。**
           *
           * 于是"账户上有别人的交易"这件事从来没有在界面上出现过：
           * 操作员看到机器人赚了 0.32、账户少了 1.56，无法解释；
           * **AI 也看到同样的矛盾，而它连"账户上有外部交易"都不知道。**
           *
           * 现在按归属分两类，只有真正的外部活动才收集上报：
           * 属于别的机器人的是正常情况（共用账户），不该刷告警。
           */
          if (!orderIdIn(entryId, allOrders)) {
            /*
             * ⚠️ **`net` 必须把资金费算进来 —— 它原来漏了，而那是 0.2 USDT 的假差额。**
             *
             * 外部活动的净额原来写的是 `grossPnl - entryFee - exitFee`，少了
             * `funding`。而另一侧（`exchangeNet`）是对交易所 `income` 流水求和，
             * `FUNDING_FEE` **在里面**。于是总账校验拿两个不同口径去比：
             *
             *     gap = platformNet - exchangeNet = -（外部活动的资金费）
             *
             * 实测三个共用账户的机器人报出 **-0.2026 / -0.1962**，而同一账户上
             * 两个没有外部活动的机器人只有 ±0.006（浮点级）。差额全部来自这一个缺项，
             * 却被报成「平台的账本可能有漏记或重复记账」—— 又是一次**账本明明是对的、
             * 报警说它错了**。
             *
             * `funding` 在上面已经算好（`fundingInWindow`），这里只是把它减掉 ——
             * 与 `trades.insert()` 的 `净 = 毛 − 费 − 资金费` 完全同一个口径。
             */
            if (trip.entryOrderId) skipDiag.foreign += 1;
            else skipDiag.foreignNoId += 1;
            foreign.push({
              symbol,
              net: netPnlOf({ grossPnl: trip.grossPnl, fee: trip.entryFee + trip.exitFee, fundingFee: funding }),
              at: trip.closedAt,
            });
          } else {
            skipDiag.otherTrader += 1;
          }
          log.debug(
            `[${this.deps.trader.name}] 跳过非本机器人开立的成交：${symbol} ${trip.quantity} @ ${trip.entryPrice}（入口订单 ${trip.entryOrderId || '未知'}）`,
          );
          continue;
        }

        const booked = tradeStore.insert({
          traderId,
          symbol: trip.symbol,
          side: trip.side,
          quantity: trip.quantity,
          entryPrice: trip.entryPrice,
          exitPrice: trip.exitPrice,
          leverage: this.leverageFor(symbol),
          grossPnl: trip.grossPnl,
          entryFee: trip.entryFee,
          exitFee: trip.exitFee,
          fundingFee: funding,
          closeReason: 'reconciled',
          openedAt: trip.openedAt,
          closedAt: trip.closedAt,
          source: 'reconciled',
          entryOrderId: trip.entryOrderId || null,
          exitOrderId: trip.exitOrderId || null,
          /*
           * ⚠️ **这个腿的全部出场单号 —— 判重靠它，不是靠上面那个"最后一个"。**
           *
           * 实测（2026-10-03，`#10` 的 MANAUSDT）：交易所是
           * `BUY 336 → SELL 168 → SELL 168`，**运行期按每次平仓各记了一笔**
           * （`#191` 168 + `#192` 168），而对账把整段看成一个 **336 的腿**。
           * 只看 `trip.exitOrderId`（= 最后一笔的单号）查不到 `#191`
           * （它记的是**第一笔**的单号），于是又插了一行 `#193` —— pnl 恰好
           * 等于前两笔之和，账目凭空多出 **1.5153 USDT**。
           *
           * 传全部单号之后，"任意一个已记账"就能命中，对账回到它该有的语义：
           * **只修正、不重复插入**。
           */
          exitOrderIds: trip.exitOrderIds,
          // 这是从交易所成交重建出的真实回合：同一回合已经记过就只修正，不再插一行。
          idempotent: true,
        });
        /*
         * 无论本次是"新插入"还是"命中已有行"，这条成交都已经被账本认领了，所以
         * 两个索引都要更新 —— 否则同一遍里第二笔长相相同的成交会绕过刚刚建立的
         * 认知（`byKey.set` 原来只在新插入时做，是因为那时没有第二种结果）。
         */
        byKey.set(key, booked.id);

        if (!booked.created) {
          /*
           * 这一回合运行期已经记过账了：`insert()` 认出并返回了那一行。
           * 这里**不算补录、也不播报补录** —— 账本一行没多，"补录了 N 笔"的日志
           * 会让操作员以为发生过漏记，而漏记才是需要警惕的信号。
           *
           * 但要把交易所的权威口径写到那一行上（§2.5 的"只修正"）：运行期是从本地
           * 持仓行记的，数量与手续费口径都比成交记录粗；不修正，账本就停在一个
           * 与账户对不上的数字上。
           */
          const figureWrite = tradeStore.applyExchangeFigures({
            id: booked.id,
            grossPnl: trip.grossPnl,
            entryFee: trip.entryFee,
            exitFee: trip.exitFee,
            fundingFee: funding,
            entryPrice: trip.entryPrice,
            exitPrice: trip.exitPrice,
            quantity: trip.quantity,
            leverage: this.leverageFor(symbol),
            entryOrderId: trip.entryOrderId || null,
            exitOrderId: trip.exitOrderId || null,
          });
          /*
           * ⚠️ 与上面那条 `applyExchangeFigures` 同一个口径（见 `correctedAttempted` 的说明）：
           * **只有真的覆盖了才算"生效"**。这一条的日志原来固定说"只修正不重复插入"，
           * 而在"边界存疑"时它其实一个字都没改 —— 一句话把两种完全不同的结果说成了一种。
           */
          correctedAttempted += 1;
          if (figureWrite.applied) corrected += 1;
          else keptForBoundary += 1;
          log.debug(
            `[${this.deps.trader.name}] 对账发现 ${symbol} 的这一回合已在账上（第 #${booked.id} 笔）：` +
              (figureWrite.applied
                ? '已按交易所口径修正，不重复插入。'
                : `重建出的腿边界不可信（重建 ${trip.quantity} vs 本地 ${figureWrite.keptLocalQuantity}）—— 本轮未覆盖它，继续保留本地口径。`),
          );
          continue;
        }

        recovered += 1;

        const net = netPnlOf({ grossPnl: trip.grossPnl, fee: trip.fee, fundingFee: funding });
        this.emit(
          'warn',
          `对账补录了一笔未被记录的成交：${trip.symbol} ${trip.side === 'long' ? '多头' : '空头'} ` +
            `${trip.quantity} @ ${trip.entryPrice} → ${trip.exitPrice}，净 ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT。` +
            '（平仓发生在机器人未运行时，已从交易所成交记录恢复）',
        );
      }
    }

    /*
     * Settle local position rows the exchange no longer holds.
     *
     * `reconcilePositions` does this during a cycle, but it needs the position to
     * still be open locally *and* a cycle to run. Doing it here as well means a
     * trader that was stopped mid-position does not come back believing it still
     * holds something.
     *
     * **It must book the round-trip, not merely close the row.** This loop used
     * to call `positionStore.close()` directly and book nothing: the local row
     * disappeared while the exchange still held a finished entry+exit round-trip,
     * so the trade never reached `trades` — a position closed by an exchange-side
     * stop during downtime was dropped from the ledger entirely, and the
     * platform's PnL read better than the account's (§2.3). Worse, this pass runs
     * at the *head* of every cycle, before `reconcilePositions`, so it could
     * swallow a close that the later pass would have booked correctly.
     *
     * Booking it here is idempotent with `reconcilePositions`: closing the row
     * takes it out of `positionStore.open()`, so the later pass cannot book the
     * same round-trip twice.
     */
    /*
     * ⚠️ **读不到持仓 ≠ 交易所上没有仓位。**
     *
     * 这一行原来是 `getPositions().catch(() => [])`，于是**一次网络抖动 / 一次 5xx**
     * 就足以让 `liveSymbols` 变成空集，下面的循环随即把**每一个**本地持仓判成
     * "已在交易所消失" → `bookVanishedPosition()` 给它们各写一行 `trades`
     * （出场价取最近一笔成交、原因多半落到 `stop_loss`），再 `positionStore.close()`
     * 把真实持仓从本地账本抹掉。
     *
     * 两个后果都很重，而且方向相反：
     *   · **凭空记账**会永久污染账本，还会让后续对账的幂等判定（`findDuplicate`）
     *     命中那行假记录 —— `docs/AGENTS.md` §2.3 专门写过「漏记会在下一轮自己修好，
     *     而凭空记一笔会永久污染账本」；
     *   · **本地持仓被抹掉**，而交易所上的敞口还在 —— 机器人下一轮按"空仓"决策，
     *     那正是 §2.6 说的最糟状态。
     *
     * 所以拉不到就**整段跳过**：少记一轮没有代价（下一轮会补上），凭空记一笔没有救。
     *
     * ⚠️ **模拟盘整段跳过**（2026-10-15）—— 见 `reconcilePositions` 顶部那段：
     * 交易所的持仓列表在模拟盘上**不是真相来源**（那里从来没有它的仓位）。
     * 拿它当判据会把每一个本地持仓都判成"已消失"。
     * 模拟盘的持仓结算由 `settleDryRunPositions()` 负责（对着标记价判保护单）。
     */
    let livePositions: Awaited<ReturnType<typeof this.deps.broker.getPositions>> | null = null;
    if (!this.isDryRun) {
      try {
        livePositions = await this.deps.broker.getPositions();
      } catch (error) {
        this.emit(
          'warn',
          `读不到交易所持仓（${(error as Error).message}）—— 本轮跳过"持仓消失"的核对，` +
            '避免把网络故障当成已平仓而凭空记账。',
        );
      }
    }

    if (livePositions !== null) {
      const liveSymbols = new Set(livePositions.map((p) => p.symbol));
      for (const local of positionStore.open(traderId)) {
        if (!liveSymbols.has(local.symbol)) {
          await this.bookVanishedPosition(local);
        }
      }
    }

    /*
     * Refresh the display snapshot — 但**只给在跑的机器人**刷新。
     *
     * 这一段原来存在的理由：`computeTraderStats` 读最近一条快照，而一个已停止的
     * 机器人不再写快照，于是它的显示权益冻在最后一次周期那一刻。实盘上那次是
     * 显示 9.6213 而真实余额 10.2586 —— 利润是在机器人停下**之后**到的账。所以
     * 「对账时顺手写一条」在当时是对的。
     *
     * 但它同时是一个 bug 的一半：这一遍也会在一个**已停止**的机器人上跑（控制台的
     * 「对账」按钮、以及启动前的这一遍），而它当时写进去的是 `account.equity` ——
     * **共享钱包**的余额。同账户下每个机器人的快照因此都被刷成同一个数：一个从未
     * 成交的机器人显示别人的收益率，而一个已停止的机器人的数字会随着邻居继续交易
     * 而变动。**停止的机器人，历史必须停止移动。**
     *
     * 所以：只有循环是活的（`this.running`）或者这一遍本身就在一个进行中的周期里
     * （`this.cycleInFlight`）时才写。停止状态下点「对账」不再改动任何机器人快照；
     * 而"账刚对上就要显示新数字"这件事没有丢 —— `computeTraderStats` 在读取时按
     * 归属口径从 `trades` 现算权益，这一遍刚补录的成交立刻就会出现在控制台上，
     * 根本不需要一条新快照。
     */
    if (this.running || this.cycleInFlight) {
      try {
        const account = await this.deps.broker.getAccountState();
        const livePositions = await this.deps.broker.getPositions().catch(() => []);
        /*
         * ⚠️ **走 `recordEquity()`，不要直接 `equityStore.insert()`。**
         *
         * 这里原来是直接插入的，于是它绕过了"完全重复的快照不记"那条判定 ——
         * 而它**每一轮深对账都会跑**（`FULL_RECONCILE_EVERY_PASSES = 24`，
         * 外加启动前与控制台按钮），所以它正是那些"连续 64 条一模一样的
         * 21.9669"的主要来源之一。
         *
         * 统一走同一个方法还有第二个好处：它会发 `eventBus` 的 `equity` 事件，
         * 而这条路径原来不发 —— 同一个动作在两个入口下行为不同，是下一类 bug 的温床。
         */
        await this.recordEquity(account, livePositions);
      } catch (error) {
        log.debug(`[${this.deps.trader.name}] 对账后写入权益快照失败：${(error as Error).message}`);
      }
    }

    /*
     * ⚠️ **这条日志必须能区分三种结果，而不是只报一个笼统的"修正 N 笔"。**
     *
     * 线上实测的形状（用户报「每次都是修正 50 笔」）：`corrected` 原本数的是"试过几次"，
     * 而其中**每一笔都被内部拒掉**（重建腿边界不可信 ⇒ 整行保留本地）—— 于是操作员
     * 看到的是一个恒定的假数字，而真相是"这 50 笔每一轮都判不出来"。
     *
     * 所以：尝试 / 生效 / 判不出来，三个数都要在日志里。第三个数不是失败，而是
     * **需要人来判断的边界**（要么重建窗口不够，要么本地那一行才是对的）——
     * 只要它非零，下一轮还会撞上同一批，这条日志就该让人一眼看出"账本没有被修正"。
     */
    if (recovered > 0 || corrected > 0 || keptForBoundary > 0) {
      log.info(
        `[${this.deps.trader.name}] 对账完成：补录 ${recovered} 笔，` +
          `尝试修正 ${correctedAttempted} 笔（生效 ${corrected} 笔 · 因边界存疑保留本地 ${keptForBoundary} 笔），` +
          `资金费合计 ${fundingTotal.toFixed(6)} USDT`,
      );
    }
    if (keptForBoundary > 0 && corrected === 0) {
      /*
       * 全军覆没才升级成 warn：这一轮**号称在修正、实际一笔都没改**。
       * 只报 info 会让它混在正常的"修正 N 笔"里看不出异常（那正是这次要修的病灶）。
       */
      log.warn(
        `[${this.deps.trader.name}] 本轮对账尝试修正 ${correctedAttempted} 笔，` +
          `但**一笔都没真的生效** —— 全部因"重建腿边界存疑"保留本地口径。` +
          '这通常意味着成交历史的窗口起点落在持仓中间（重建把开/平判反、整条序列错位），' +
          '或是这些行本来就是对的而重建是错的。请对照交易所成交明细核查，不要当它已经修好了。',
      );
    }

    /*
     * 交易所已经不再挂着的本地委托行，也要在这一遍里结清。
     *
     * 位置放在"消失的持仓已经记账"之后：一张触发成交的止损，先要有人把那一回合记进
     * `trades`，再谈它自己的状态；而"这个标的是否还持仓"正是那一段刚更新过的东西。
     * 详见 `settleStaleOrders()`。
     */
    await this.settleStaleOrders().catch((error) => {
      // 记账失败不能影响这一遍对账的结论（它已经写完了），更不能把异常抛给周期。
      log.warn(
        `[${this.deps.trader.name}] 结清本地委托记录失败（不影响本周期交易）：${(error as Error).message}`,
      );
    });

    /*
     * ── 外部交易活动 ──────────────────────────────────────────────────
     *
     * 到这一步 foreign 里装的是**不属于本平台任何机器人**的成交。
     * 它们不是"别人的机器人"（那种是共用账户的正常情况），而是这个账户上
     * 有本平台之外的东西在交易 —— **它产生的盈亏直接从余额里进出，而账面看不见**。
     *
     * 这正是「机器人显示一直在挣钱、账户却在缩水」的成因，也是 AI 无法
     * 解释的那个矛盾。所以必须上报，不能只写 debug。
     */
    const foreignNet = Number(foreign.reduce((sum, r) => sum + r.net, 0).toFixed(6));
    const foreignSymbols = [...new Set(foreign.map((r) => r.symbol))];
    /*
     * 持久化：这一页要在**机器人停止之后**仍然能显示它 —— 而停止之后
     * 就不会再跑对账了，只放在内存里等于关掉页面就没了。
     */
    settings.set(
      `foreign_activity:${traderId}`,
      JSON.stringify({
        rounds: foreign.length,
        net: foreignNet,
        symbols: foreignSymbols.slice(0, 20),
        firstAt: foreign[0]?.at ?? null,
        lastAt: foreign[foreign.length - 1]?.at ?? null,
        detectedAt: new Date().toISOString(),
      }),
    );

    /*
     * ── 总账校验 ──────────────────────────────────────────────────────
     *
     * 到这里 `incomeEvents`（交易所权威流水）与 `foreign`（外部活动）都在手上，
     * 正好可以做一次**总账级**的对账 —— 它回答「平台整体记的账，与交易所实际
     * 发生的，能不能对上」。
     *
     * 这是唯一能**自动**发现「机器人显示在挣钱、账户却在缩水」这类故障的地方：
     * 账本自己不会说自己错了，只有拿它和权威流水比才知道。
     */
    const exchangeNet = incomeEvents.reduce((sum, e) => {
      /*
       * 只算交易口径。`TRANSFER`（入金/出金）不是盈亏 ——
       * 把它算进来会让「刚充过钱」看起来像「赚了钱」。
       * 未知的 incomeType 也一并跳过：宁可不计入，也不要凭猜归类。
       */
      if (
        e.incomeType !== 'REALIZED_PNL' &&
        e.incomeType !== 'COMMISSION' &&
        e.incomeType !== 'FUNDING_FEE'
      ) {
        return sum;
      }
      return sum + (Number(e.income) || 0);
    }, 0);
    
    /* 平台侧：所有机器人的已实现净额 + 外部活动净额。 */
    /*
     * ⚠️ **平台侧必须与交易所侧用同一个时间窗。**
     *
     * `incomeEvents` 是 `since` 之后的（币安的收入接口必须给窗口），
     * 所以这里也要用 `netSince(sinceIso)` 而不是"全部历史" ——
     * 否则差额里会混进窗口之外的历史交易，**那会永久误报**。
     *
     * 实测：用全部历史时这个账户报出 −0.86 的假差额，
     * 而真实差值是 0.0057（窗口边界的浮点误差）。
     * **一个永久误报的校验比没有校验更糟** —— 它会训练操作员忽略这条告警，
     * 而这是唯一能自动发现"账本错了"的地方。
     */
    /*
     * 分两项存下来，**不只是为了好看**。
     *
     * 原来这里只有 `platformNet` 一个汇总值。于是当差额出现时，能看到的只有
     * "差 0.2" —— 而它可能是本机器人的成交记错了、也可能是外部活动那侧漏了，
     * 两种原因的修法完全不同，光看汇总值无从判断。
     *
     * 实测的代价：我按"外部活动漏算资金费"改了一版，部署、对账、`checkedAt`
     * 是新的、`gap` 一模一样 —— **因为没有任何一项能告诉我改动到底作用在哪一侧**，
     * 只能再从头推一遍。把分项存下来，这个问题下次当场就答完了。
     */
    /*
     * 纯模拟盘（没有交易所账户）**没有交易所侧可对** —— `netSinceForAccount`
     * 按账户聚合，而没有账户就没有这个维度。这类机器人跳过整段总账校验：
     * 它的账全部来自本地台账，不存在"与交易所流水对不上"这回事。
     *
     * ⚠️ 模拟盘但**绑定了**账户的机器人仍然会走到下面 —— 那时账户是存在的，
     * 只是交易所流水里没有它的单（那些单从来没发出去），所以校验结果会如实地
     * 报出差额。这是对的：它如实描述了"模拟单不在交易所流水里"这个事实。
     */
    const accountId = this.deps.trader.exchangeAccountId;
    if (accountId === null) {
      /* 没有账户 = 没有交易所流水可对；外部活动那几项也一并记 0。 */
      return {
        recovered: 0,
        corrected: 0,
        correctedAttempted: 0,
        correctedKept: 0,
        funding: 0,
        foreignRounds: foreign.length,
        foreignNet: foreignNet,
      };
    }
    const platformSelf = tradeStore.netSinceForAccount(accountId, sinceIso);
    /*
     * ⚠️ **未平仓的持有成本必须加在平台侧，否则这个校验会永久误报。**
     *
     * 交易所流水从**开仓那一刻**就有 `COMMISSION`、持仓期间还有 `FUNDING_FEE`；
     * 而 `trades` **只在平仓时**记一笔。只要有持仓，「平台净额」就天然比
     * 「交易所流水」少一个"还拿在手上的那些仓位的持有成本"。
     *
     * 实测：两条告警的差额 `0.0119` / `0.0202` 正好是当时那两个仓位的入场手续费
     * （ETH `0.0118539` + HYPE `0.00837404` = `0.0202`）—— **一个纯粹的口径差
     * 被报成了"账本可能有漏记或重复记账"**。
     *
     * 两侧必须同口径，否则这个校验的每一次响都是假的，而它本该是唯一能自动发现
     * "账本真的错了"的地方（实测它确实抓到过那次 0.17 的重复记账）。
     */
    /**
     * 未平仓仓位的持有成本，**两个符号不同，必须分开返回**。
     *
     * ## ⚠️ 2026-10-03：这里原来把两者相加成一个 `openCosts`，然后在
     * `platformNet` 里用 `+ openCosts` —— **符号对了一半，于是平台侧被高估
     * 两倍的手续费**。
     *
     * 实测现场（`#10`，两个持仓）：
     *
     * ```text
     * 交易所：毛 -0.6479 · 费 0.307327（含未平仓开仓费 0.054795）
     *       ⇒ 已平仓部分费用 = 0.252532，而本地账本的 fee 正是 0.252532
     * 本地已平仓净额 platformSelf = -0.900432
     * 正确：-0.900432 − 0.054795 = -0.955227 = 交易所净额 ✅
     * 实际：-0.900432 + 0.054795 = -0.845637 ⇒ gap 0.109590 = 2 × 0.054795 ❌
     * ```
     *
     * **手续费是支出、正数** ⇒ 要从平台净额里**减**；
     * **资金费在币安 `income` 里本身就是负数**（`FUNDING_FEE -0.013888`）⇒ 用**加**。
     * 混在一个数里用一个符号，必错一个。
     */
    const openHoldings = ((): { entryFees: number; funding: number } => {
      try {
        /*
         * 传**入场订单号**而不是标的：同一标的反复开平时，按标的过滤会把
         * 历史回合的入场费再加一遍（那些回合已经在 `platformSelf` 里了）。
         * 详见 `openEntryCosts` 的注释。
         */
        const entryOrderIds = positionStore
          .open(traderId)
          .map((p) => p.entry_order_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        /*
         * 未平仓仓位的**资金费**（`orders` 表没有资金费列，只能从流水取）。
         * 持仓跨过资金费结算点时平台侧会偏小 —— 代码注释原来把它记成
         * "已知且方向固定的残差，不要再靠猜口径去补"，而它**不用猜**：
         * 资金费就在 `income` 流水里，按标的 + 开仓之后聚合即可。
         */
        const funding = positionStore
          .open(traderId)
          .reduce((sum, p) => sum + fundingSince(incomeEvents, p.symbol, p.opened_at), 0);
        return { entryFees: orderStore.openEntryCosts(traderId, entryOrderIds), funding };
      } catch {
        /* 读不到就按 0：宁可这一轮差一点，也不要让对账整个失败。 */
        return { entryFees: 0, funding: 0 };
      }
    })();
    const openEntryFees = openHoldings.entryFees;
    const openFunding = openHoldings.funding;
    const openCosts = openEntryFees + openFunding;
    /*
     * 手续费**减**、资金费**加**（它本身就是负数）—— 见 `openHoldings` 的说明。
     */
    const platformNet = platformSelf + foreignNet - openEntryFees + openFunding;
    const ledgerGap = Number((platformNet - exchangeNet).toFixed(6));

    /*
     * 权益 —— 容差要随账户规模缩放（见 `ledgerGapTolerance`）。读不到就退回 0，
     * 那时只用绝对容差，而不是让对账本身失败。
     */
    const equityForTolerance = ((): number => {
      try {
        const [latest] = equityStore.list(traderId, 1);
        return typeof latest?.equity === 'number' && Number.isFinite(latest.equity) ? latest.equity : 0;
      } catch {
        return 0;
      }
    })();
    
    /*
     * ⚠️ **容差必须随账户规模缩放 —— 固定 1 美分在两个方向上都是错的。**
     *
     * ## 实测（2026-10-02 03:00）
     *
     * 权益 21.92 的账户报出差额 **0.0101** —— 只比原来那个固定值 0.01 多
     * **0.0001 美元**，却挂起一条 ERROR 级"账目与交易所对不上"。
     * 而它对应的真实相对偏差是 **0.046%**，远在噪声范围里
     * （开仓那一刻的持有成本口径差异就足够产生它）。
     *
     * ## 为什么固定阈值在两端都会失效
     *
     *   · **小账户**：1 美分是 0.046%（$21.92）—— 日常口径噪声就能触发，
     *     于是这条告警变成背景噪声，**真的漏记出现时没人再看它**；
     *   · **大账户**：1 美分是 0.0001%（$10,000）—— 一笔漏记可能远大于它，
     *     但"大于 1 美分"这条线根本拦不住，**该报的没报**。
     *
     * 所以取"绝对 1 美分"与"权益的 0.1%"里**较大**的那个：
     * 小账户按相对值放宽（消除噪声），大账户按相对值收紧（抓住真漏记）。
     *
     * 原来的注释说"任何一笔真实的漏记/错记都大于 0.01"—— 那句话在**这个账户规模**上
     * 曾经成立，但它把"账户有 22 美元"这个前提写死进了阈值。
     */
    const LEDGER_GAP_TOLERANCE = ledgerGapTolerance(equityForTolerance);
    settings.set(
      `ledger_check:${traderId}`,
      JSON.stringify({
        platformNet: Number(platformNet.toFixed(6)),
        exchangeNet: Number(exchangeNet.toFixed(6)),
        gap: ledgerGap,
        /*
         * 两个分项。差额出现时，"本机器人的成交"与"外部活动"哪一侧出的问题，
         * 看这两个数就知道 —— 而它们的修法完全不同。
         */
        platformSelf: Number(platformSelf.toFixed(6)),
        foreignNet: Number(foreignNet.toFixed(6)),
        foreignRounds: foreign.length,
        /* 未平仓的持有成本（加在平台侧的那个数）—— 它长期是差额的主要来源。 */
        openCosts: Number(openCosts.toFixed(6)),
        /*
         * ⚠️ **两个分量要分开存**（2026-10-03）。
         *
         * `openCosts` 是"未平仓入场手续费 + 资金费"相加后的一个数，而**两项的符号
         * 不同**（手续费正、资金费负）—— 只存汇总值时，`gap` 一旦不为 0，
         * 看的人分不清是"这一项没算进去"还是"符号用错"（两者差一个因子 2）。
         * 实测就是栽在这里：`+ openCosts` 让平台侧高估了两倍手续费，
         * 而落库的 `openCosts: 0.054795` 看起来完全正常。
         */
        openEntryFees: Number(openEntryFees.toFixed(6)),
        openFunding: Number(openFunding.toFixed(6)),
        skipDiag,
        /*
         * 反向回合**已记账**的净额合计（2026-10-03 起）。
         *
         * 这些钱已经落在 `platformSelf` 里，所以**不再**加到 `platformNet` 上
         * （加了就是重复计）。它单独存下来只为回答一个问题：
         * 「这一轮账本里有多少来自"方向不可信、金额可信"的行」——
         * 那个数大，说明成交历史窗口覆盖不足，值得去查，而不是账目坏了。
         */
        reversedBookedNet: Number(reversedBookedNet.toFixed(6)),
        // 让落库的数据自己说清这一轮算不算数（读失败时 exchangeNet 是 0，不是"真的 0"）。
        incomeReadFailed,
        checkedAt: new Date().toISOString(),
      }),
    );
    
    /*
     * ⚠️ **读不到流水就不要下"账本错了"这个结论。**
     *
     * `incomeEvents` 为空的两种情况含义完全不同：**账户上真的没有流水**，
     * 与**这一次没读到**。只有前者支持"账目对不上"的判断；后者什么也说明不了 ——
     * 拿 0 去比只会得到一个假差额，而这条告警的价值恰恰在于它稀有一响。
     */
    if (!incomeReadFailed && Math.abs(ledgerGap) > LEDGER_GAP_TOLERANCE) {
      /*
       * ⚠️ **这条告警比外部活动那条更严重。**
       *
       * 外部活动只是"账户上有别人的交易"，而账本本身是对的。
       * 这里是**账本本身与交易所对不上** —— 意味着平台记录的盈亏不可信，
       * 而 AI 正是照着它做决策的。
       *
       * ## 为什么第四个参数是固定的 `'ledger-gap'`
       *
       * 句子里带着四个会变的数字，而 `emitOnChange` 的"状态没变就不再记"是拿
       * **整条文本**比的 —— 于是差额每变一次就重记一条。实测：从 17:17 到 18:32
       * **上百条一模一样的 error**，而它们说的都是同一件事。
       *
       * 传一个稳定键之后：**状态真的解除时由 `clearStateNotice()` 清掉**，
       * 下次再出现才重新记。这既保住了"稀有一响"的分量，也不丢信息 ——
       * 差额的精确数值在 `ledger_check:` 里一直存着。
       */
      this.emitOnChange(
        "ledger-gap",
        "error",
        `账目与交易所对不上：平台记录 ${platformNet.toFixed(4)} USDT、` +
          `交易所流水 ${exchangeNet.toFixed(4)} USDT，差 ${ledgerGap.toFixed(4)}。` +
          `（平台侧已含未平仓的持有成本 ${openCosts.toFixed(4)}。）` +
          /*
           * ⚠️ **把两项写进告警本身，而不是只留在 `ledger_check` 里。**
           *
           * 那段注释记着一次真实的返工：「我按'外部活动漏算资金费'改了一版，部署、
           * 对账、`checkedAt` 是新的、`gap` 一模一样 —— **因为没有任何一项能告诉我
           * 改动到底作用在哪一侧**，只能再从头推一遍。」
           *
           * 那句话说的正是这条告警：它只报一个汇总差额，于是读它的人（人也好、AI 也好）
           * **无从判断该查哪一侧** —— 而两侧的修法完全不同：
           *
           *   · **本机器人那一项**偏高/偏低 → 账本真的漏记或重复记账（严重）；
           *   · **外部活动那一项**对不上 → 那是由交易所成交历史**重建**出来的估算，
           *     口径与运行期记账天然不同（多数情况出在这里）。
           *
           * 实测那台机器人：本机器人侧 `1.30048` 与 `trades` 净额合计**一字不差**，
           * 而外部活动估出 `-0.2134`、实际约 `-0.0298` —— 差额全在估算那一侧。
           * 把这两项打在告警里，"哪一侧"这个问题当场就答完了。
           */
          `【本机器人成交 ${platformSelf.toFixed(4)}` +
          (Math.abs(foreignNet) > 1e-9
            ? ` · 账户上不属于本机器人的成交（重建估算）${foreignNet.toFixed(4)}`
            : '') +
          `】` +
          `先看括号里后一项 —— 它由交易所成交历史重建，口径与运行期记账不同，` +
          `偏差通常出在那里；如果**本机器人那一项**与交易所的差也在容差之外，` +
          `才是账本本身漏记或重复。`,
        'ledger-gap',
      );
    } else {
      this.clearStateNotice("ledger-gap");
    }
        if (foreign.length > 0) {
      /*
       * 符号列表**排过序**再用 —— 见下面 `emitOnChange` 的说明：
       * 状态键里任何会自己变化的东西都会让"状态没变就不再记"失效。
       */
      const list = [...foreignSymbols].sort().slice(0, 6).join("、");
      const more = foreignSymbols.length > 6 ? " 等" : "";
      /*
       * 按**状态变化**记，不是每轮都记：这是一个会持续成立的状态
       * （外部程序一直在跑），每轮刷一条会把日志淹掉。
       *
       * ⚠️ **但这条规则原来并没有生效**，因为"变化"是按**整条文本**比的
       * （见 `emitOnChange`），而这段文本里带着浮点净额 —— 外部活动一直在发生时
       * 它每轮都在变，于是每一轮都算"变了"。
       *
       * 实测：2000 行日志里同一条警告出现了 **232 次**（五个机器人各报几十次）。
       * 到第 200 次，操作员就再也看不见它了 —— **而那正是真出事时该被看见的那条**。
       *
       * 现在只把**离散量**（笔数 + 排序后的标的）放进文本。净额与完整标的列表
       * 仍然写在 `foreign_activity` 台账里，控制台的「交易所账户」那一行与
       * AI 的提示词读的是那一处 —— 需要精确数字的地方不缺它。
       *
       * 文案也去掉了「请立刻检查账户安全」：控制台那边已经因为"那块警示
       * **假设了恶意**"把它降级成了安静说明（见 `TraderPage.tsx` 里的注释）。
       * 同一个事实在两个地方用两种语气，只会让人不知道该信哪个。
       */
      this.emitOnChange(
        "foreign-activity",
        "warn",
        `账户上发现 ${foreign.length} 笔不属于本平台的成交（涉及 ${list}${more}）。` +
          "这些盈亏直接从交易所余额进出、不计入本机器人的绩效。" +
          "标的与净额见控制台的「交易所账户」那一行。",
      );
    } else {
      /* 外部活动消失（或本来就没有）时清掉状态，否则会永远挂着一个旧告警。 */
      this.clearStateNotice("foreign-activity");
    }
    
    return {
      recovered,
      corrected,
      correctedAttempted,
      correctedKept: keptForBoundary,
      funding: fundingTotal,
      foreignRounds: foreign.length,
      foreignNet,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Stale order records                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 把交易所已经不挂着的本地委托行结清（§2.2 只要求不删行，从不要求状态停在 `NEW`）。
   *
   * ## 这个缺陷是什么
   *
   * `orders.status` 是**下单那一刻**交易所给的返回值，此后没有任何代码更新过它
   * （`orders.update()` 在本次修复之前没有任何调用点）。于是有三条路径会让它停在非终态：
   *
   *  1. **条件单触发成交** —— 平仓发生在交易所，本地行还是 `NEW`；
   *  2. **平仓前 `cancelAllOrders()` 撤单**（§2.7）—— 撤掉了，但没写回本地行；
   *  3. **交易所自己撤单** —— `closePosition=true` 的止损触发后，止盈那张"兄弟单"
   *     会被交易所一并撤掉，它不会通知任何人。
   *
   * 实盘上量到的后果：本地 24 行 `NEW` 全部属于已经平掉的仓位，而交易所的
   * `/fapi/v1/openOrders` 是 **0** —— 控制台的「当前委托」因此列出十几行并不存在的委托，
   * 其中每一行按 §2.7 看起来都像是会朝反方向开出新仓的存活单。**它其实全是假警报**，
   * 但一个不能相信的界面与真的出事一样糟：操作员无法分辨这一次到底是哪一种。
   *
   * ## 它只改账
   *
   * 这里既不补撤单、也不重挂保护单，唯一的依据是**交易所自己**说这张单还在不在
   * （挂单列表 + 条件单的最终状态）。撤单与下单的时机、位置一个都没有变 ——
   * 若某条路径真的漏撤了，那是另一件更严重的事，要单独报出来，而不是靠更新一行状态
   * 把它掩盖掉。
   *
   * @param onlySymbol 只结清这一个标的（平仓之后立刻调用，好让控制台马上正确）；
   *   不传时扫这个机器人全部待结清的行。对账轮次走的就是不传的那条。
   * @returns 实际改写的行数。
   */
  private async settleStaleOrders(onlySymbol?: string): Promise<number> {
    const traderId = this.deps.trader.id;

    /*
     * 只把"够老"的行当候选：`createdBefore` 就是宽限窗口的下界，
     * 窗口取多长、为什么需要，见 `ORDER_SETTLE_GRACE_MS`。
     */
    const cutoff = new Date(Date.now() - ORDER_SETTLE_GRACE_MS).toISOString();
    const candidates = orderStore
      .unsettled(traderId, cutoff)
      .filter((row) => onlySymbol === undefined || row.symbol === onlySymbol);
    if (candidates.length === 0) return 0;

    /*
     * ⚠️ **只保护"当前正在生效的那张保护单"，不再按标的整体跳过。**
     *
     * 原来这里的判据是"这个标的还持仓 → 它的保护单一行都不碰"。理由是：
     * 还持仓时保护单不在交易所，可能不是"显示脏了"而是"保护单真的没了"——
     * 那是一件更严重、也完全不同的故障（§2.6），不该混进这次记账修复里。
     *
     * **这个理由对"当前生效的那张保护单"成立，对被替换掉的旧保护单不成立。**
     * 而追踪止损每上移一次就换一张：实测同一个 SOLUSDT 仓位在界面上挂着
     * **4 条止损**（118.10 / 119.607 / 119.627 / 120.942），而交易所侧一张都没有 ——
     * 旧的那三张早被撤掉，只是**永远没人结清**。用户据此问"这是不是 BUG"，
     * 而它确实是。
     *
     * 现在的判据来自本地持仓行：`positions.stop_order_id` / `tp_order_id` 指向的
     * 才是"现在生效的那一张"。它缺失 → 由 `ensureStopsOnOpenPositions()` 去重挂
     * 并告警（那才是 §2.6 要的处置）；其余历史保护单行照常走交易所核对 → 结清。
     */
    const activeProtectionIds = new Set<string>();
    for (const position of positionStore.open(traderId)) {
      if (position.stop_order_id) activeProtectionIds.add(String(position.stop_order_id));
      if (position.tp_order_id) activeProtectionIds.add(String(position.tp_order_id));
    }

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **模拟盘：本地账就是唯一真相**（2026-10-14 线上实测抓到的死锁）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：模拟盘 `#11` 的 44 条委托永远停在「已挂单」
     *
     * 用户截图：下面「当前委托 17」列着一堆"已挂单（待对账）"，
     * 而上面「保证金占用 / 持仓」都是 0 —— **两边对不上**。
     *
     * ## 死锁的形状（三个事实凑成的）
     *
     * ```
     *   ① 模拟盘（dry_run=1）的委托【从未真的发到交易所】
     *   ② 但 getOpenOrders / getOpenAlgoOrders 【没有 dryRun 守卫】→ 真去查交易所
     *      → 交易所返回 0 条（当然没有）
     *   ③ 而 getAlgoOrder 【有】dryRun 守卫：`if (this.dryRun) return null`
     *      → finalStatusOf 拿到 null → "这一轮不下结论" → 静默跳过
     *   ⇒ settleStaleOrders 永远返回 0，那些行永远停在 NEW
     * ```
     * ⚠️ **两个方法对 dryRun 的处理不一致**正是这个死锁的成因 ——
     * 一个去查交易所，另一个拒绝查。而**在模拟盘里，交易所本来就不该是真相来源**。
     *
     * ## 修法：模拟盘直接结清（依据是本地持仓行，不是交易所）
     *
     * ```
     *   模拟盘：本地 positions 表说这个标的还有没有仓位 —— 那就是全部真相
     *           没有持仓了 → 它的保护单行就该是终态
     *   实盘  ：照旧问交易所（那是唯一的真相来源）
     * ```
     *
     * ⚠️ **判据仍然用 `activeProtectionIds`**（上面刚算出来的）——
     * 也就是"当前生效的保护单不碰"。所以即使模拟盘里还持有仓位，
     * 它那张**正在生效**的保护单也不会被误写成终态。
     *
     * ⚠️ 写 `CANCELED` 而不是 `FILLED`：模拟盘里那张单**从未成交**
     *（它根本没到交易所），说"已撤销"是准确的说法。写 `FILLED` 会编造一次成交。
     */
    if (this.isDryRun) {
      let settled = 0;
      const summary: string[] = [];
      for (const row of candidates) {
        /* 当前生效的保护单不碰（与实盘那条路径同一个判据）。 */
        if (activeProtectionIds.has(String(row.exchangeOrderId ?? ''))) continue;
        orderStore.update(row.id, { status: 'CANCELED' });
        settled += 1;
        summary.push(`${row.symbol} ${orderPurposeLabel(row.purpose)}`);
      }
      if (settled > 0) {
        this.emit(
          'info',
          `模拟盘结清了 ${settled} 张本地委托（${summary.slice(0, 8).join('、')}` +
            `${summary.length > 8 ? ' 等' : ''}）：模拟盘的单从未发到交易所，` +
            '仓位平掉后它们的本地行应当收尾 —— 否则界面会一直显示"已挂单"。',
        );
      }
      return settled;
    }

    const symbols = [
      ...new Set(
        candidates
          .filter((row) => !activeProtectionIds.has(String(row.exchangeOrderId ?? '')))
          .map((row) => row.symbol),
      ),
    ];
    if (symbols.length === 0) return 0;

    /*
     * 权威答案在交易所。
     *
     * 两个端点都要读：条件单在 Algo 端点（`/fapi/v1/algoOpenOrders`），普通单在
     * `/fapi/v1/openOrders`，两边互不覆盖（`broker.cancelAllOrders()` 的注释写过同一件事）。
     * 少读一个，都会把一张**真的还挂着**的保护单当成已经不在 —— 那就是在自己造 §2.6 的事故。
     *
     * 按标的读（带 symbol 是 weight 1，不带是 40），而且只为"有待结清行的标的"读：
     * 结清之后这些标的下一次就没有候选行了，稳态下这一整段不产生任何请求。
     */
    const liveBySymbol = new Map<string, Set<string>>();
    for (const symbol of symbols) {
      try {
        const [regular, algo] = await Promise.all([
          this.deps.broker.getOpenOrders(symbol),
          this.deps.broker.getOpenAlgoOrders(symbol),
        ]);
        const live = new Set<string>();
        for (const order of regular) live.add(String(order.orderId));
        for (const order of algo) live.add(String(order.algoId));
        liveBySymbol.set(symbol, live);
      } catch (error) {
        /*
         * 读不到就**什么都不做**：这一轮无法断定它已经不在交易所，而"以为它不在"
         * 会把一张还在挂着的保护单写成终态。下一轮会重新读。
         */
        log.warn(
          `[${this.deps.trader.name}] ${symbol} 的挂单列表读取失败，本轮不结清该标的的委托记录：${(error as Error).message}`,
        );
      }
    }

    let settled = 0;
    const summary: string[] = [];
    for (const row of candidates) {
      /*
       * 只跳过**当前正在生效**的那张保护单：它不在交易所挂单列表里说明保护真的丢了，
       * 那由 `ensureStopsOnOpenPositions()` 负责重挂并告警（§2.6），
       * **不能在这里被静默写成终态** —— 那会把"仓位裸着"伪装成"历史脏行"。
       */
      if (activeProtectionIds.has(String(row.exchangeOrderId ?? ''))) continue;

      const live = liveBySymbol.get(row.symbol);
      // 三种情况都不是"可以结清"：这个标的一轮没读到、这行没有交易所单号、
      // 或者它**正躺在挂单列表里**（那它当然还活着）。
      if (!live || !row.exchangeOrderId || live.has(row.exchangeOrderId)) continue;

      const outcome = await this.finalStatusOf(row);
      if (!outcome) continue;

      orderStore.update(row.id, outcome);
      settled += 1;
      summary.push(`${row.symbol} ${orderPurposeLabel(row.purpose)}`);
    }

    if (settled > 0) {
      this.emit(
        'info',
        `对账结清了 ${settled} 张交易所已不再挂着的委托（${summary.slice(0, 8).join('、')}` +
          `${summary.length > 8 ? ' 等' : ''}）：这些行此前停在挂单状态，实际早已成交或撤销；交易所侧没有任何改动。`,
      );
    }
    return settled;
  }

  /**
   * 一张已经**不在交易所挂单列表里**的委托，最终是怎么结束的。
   *
   * 判据只有两种，都来自交易所，没有一处靠推断凑数：
   *
   *  1. **条件单** —— `/fapi/v1/algoOrder` 能查到它自己的 `algoStatus`：
   *     `FINISHED`/`TRIGGERED` 是触发成交，`CANCELED` 是被撤，`EXPIRED` 是过期。
   *     这是唯一能把"止损真的触发了"和"平仓时被我们撤掉了"分开的东西，
   *     `detectCloseReason()` 依赖的也正是同一个查询。
   *     查不到（网络故障、dry run）时返回 `null` = **什么都不写** —— 此时把一张可能已经
   *     成交的止损写成"已撤销"，会和 `trades.close_reason` 里的 `stop_loss` 直接矛盾，
   *     比多留一轮脏行糟得多。
   *  2. **普通委托**（开仓 / 平仓的市价单）—— 交易所没有按单号回读的封装，就用手上
   *     真实拿到过的数字判：下单时确认的成交量若已覆盖整张单，就是 `FILLED`；
   *     否则它是带着剩余数量离场的，在币安自己的语义里那就是 `CANCELED`
   *     （部分成交 + 撤销剩余）。
   *
   * @returns 要写进那一行的字段；`null` 表示"这一轮不下结论"。
   */
  private async finalStatusOf(
    row: OrderRecord,
  ): Promise<{ status: string; filledQty?: number; avgPrice?: number; rawResponse?: unknown } | null> {
    const exchangeOrderId = row.exchangeOrderId;
    if (!exchangeOrderId) return null;

    if (CONDITIONAL_ORDER_TYPES.has(row.type)) {
      const algo = await this.deps.broker.getAlgoOrder(Number(exchangeOrderId));
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️ **交易所说"这张单不存在"是一个可判定的答案**（2026-10-14 修的死锁）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 死锁：查不到 → 不下结论 → 永远查不到
       *
       * 原来这里只有 `if (!algo) return null`，而 `null` 的含义是
       * "这一轮不下结论"。那个取舍本身对（读不到时不该改账），但它有个死锁：
       * ```
       *   交易所真的查不到这张单（-2013 Order does not exist）
       *   → getAlgoOrder 永远返回 null → 这里永远 return null
       *   → 那些行【永远】停在 NEW
       * ```
       * 线上实测（`#11`）：**42 条**本地 `NEW` 条件单，逐个查都回
       * `{"code":-2013,"msg":"Order does not exist."}` —— 而界面一直显示"已挂单"。
       *
       * ## 修法：把"不存在"翻译成一个明确的终态
       *
       * 交易所说它不存在，意思是**它已经结束了**（成交过、或被撤掉后过了保留期）。
       * 而我们**无法**再分辨是哪一种 —— 所以写 `CANCELED`（币安语义里"带着剩余
       * 数量离场"就是它），并且**不写成交数字**（`filledQty` / `avgPrice` 留空）。
       *
       * ⚠️ **安全边界不变**：
       * ```
       *   'not-found'（交易所明确说不存在）→ 写 CANCELED
       *   null（网络 / 鉴权 / 限流）      → 仍然 return null，什么都不写
       * ```
       * 这两件事被混成一件正是这个 bug 的成因。
       *
       * ⚠️ 为什么敢写 `CANCELED` 而不是别的：这一行的仓位**早已平掉**
       *（`settleStaleOrders` 只在"交易所挂单列表里没有它"时才走到这里），
       * 所以它不可能还是"活着的保护单"。而写终态让界面不再骗人 ——
       * 那正是 §2.2 的目的（"不删行，但状态不能停在 NEW"）。
       */
      if (algo === 'not-found') {
        return { status: 'CANCELED' };
      }
      if (!algo) return null;
      const status = ALGO_FINAL_ORDER_STATUS[algo.algoStatus];
      // `NEW` 会走到这里：它说"还挂着"，而挂单列表刚说"不在" —— 两次读之间的竞态，
      // 真相是哪一个都可能是。留给下一轮，不拿这个矛盾去改账。
      if (!status) return null;

      const filledQty = Number(algo.actualQty ?? 0) || 0;
      const avgPrice = Number(algo.actualPrice ?? 0) || 0;
      return {
        status,
        // 只有交易所确实报了成交数字才写：`0` 会把已有的数字抹掉。
        ...(filledQty > 0 ? { filledQty } : {}),
        ...(avgPrice > 0 ? { avgPrice } : {}),
        // 交易所对这张单的最后一次答复（§2.2：raw_response 留的是交易所的话）。
        rawResponse: algo,
      };
    }

    /*
     * ⚠️ **限价单必须问交易所，不能靠"下单时拿到过的数字"判。**
     *
     * 下面那条 `fullyExecuted` 的判据只有一个输入：`row.filledQty`。而一张限价单
     * **挂出去的时候成交量就是 0** —— 它是之后某个时刻才成交的，本地那一行如果没被
     * 别的路径回写，`filledQty` 会一直是 0，于是这里把一张**已经成交**的单判成
     * `CANCELED`。实测：持仓 `12.7 @ 1.5600` 明明在，它的入场单却会被判成"已撤销"。
     *
     * 交易所对普通单有单号回读（`GET /fapi/v1/order`），所以这里去问它 ——
     * 与 `settlePendingEntries()` 问的是同一个接口、同一个答案。
     */
    if (row.type === 'LIMIT') {
      const limit = await this.deps.broker.getOrder(row.symbol, exchangeOrderId).catch(() => null);
      // 读不到 = 不知道，这一轮不下结论。
      if (!limit) return null;

      const executed = Number(limit.executedQty) || 0;
      const avgPrice = Number(limit.avgPrice) || 0;
      if (executed <= 0) {
        // 成交量为 0 且已不在挂单列表里 —— 被撤或过期，交易所自己说了是哪一个。
        return {
          status: limit.status === 'EXPIRED' ? 'EXPIRED' : 'CANCELED',
          rawResponse: limit,
        };
      }
      return {
        status: executed >= row.quantity * (1 - 1e-9) ? 'FILLED' : 'CANCELED',
        filledQty: executed,
        ...(avgPrice > 0 ? { avgPrice } : {}),
        rawResponse: limit,
      };
    }

    /*
     * 相对容差而不是"浮点相等"：`quantity` 与 `filledQty` 分别是**请求数量**与交易所
     * 回报的**成交数量**，两者都过了字符串 → 数字这一趟，一个先取整、一个由交易所
     * 自己格式化，逐位相等不是它们之间的契约（同一取舍见 `repositories.ts` 里
     * 判定"同一个回合"用的 `DUPLICATE_QUANTITY_TOLERANCE`）。
     */
    const fullyExecuted = row.quantity > 0 && row.filledQty >= row.quantity * (1 - 1e-9);
    return fullyExecuted ? { status: 'FILLED' } : { status: 'CANCELED' };
  }

  /**
   * Leverage to record on a reconciled trade.
   *
   * The exchange's fill history carries prices and sizes but not the leverage
   * that was set, and leverage only affects the *percentage* return — never the
   * absolute PnL, which comes from the exchange. Preferring the live position's
   * leverage keeps the percentage honest for anything still open; otherwise the
   * strategy's configured default is the best available answer.
   */
  private leverageFor(symbol: string): number {
    const open = positionStore.open(this.deps.trader.id).find((p) => p.symbol === symbol);
    if (open && open.leverage > 0) return open.leverage;

    /*
     * ⚠️ **2026-10-05 修复：这一级原来缺失，百分比因此虚高约 40 倍。**
     *
     * 原来只有两级 —— "开着的仓位 → 配置上限"。而**"仓位已经平掉"正是对账的常态**
     * （对账补录的就是**已经结束**的回合），所以绝大多数重建出来的成交都拿到
     * `altcoinMaxLeverage` 去当杠杆。用户看到的就是那些百分比：
     *
     * ```text
     * #217 SUIUSDT  net +0.44  显示 +156.05%   真实（3x）应为 +4.05%
     * #215 QNTUSDT  net -1.19  显示 -278.75%   真实（3x）应为 -6.39%
     * #214 SANDUSDT net -1.70  显示 -428.62%   真实（2x）应为 -6.86%
     * ```
     *
     * **而这个错误被当天的另一处改动放大了**：`altcoinMaxLeverage` 从 5 改成 125
     * （用户要求"智能托管不设边界"）→ 虚高倍数从约 2 倍变成约 40 倍，
     * 他这才在界面上看出荒谬。
     *
     * `positions` 保留着**已平的行、且带着当时的真实杠杆** —— 那就是答案。
     * 顺序因此是"开着的 → 最近一行（含已平）→ 配置上限"，
     * 最后一级只在"这个标的从来没有过仓位"时才走到（真正的兜底）。
     */
    const last = positionStore.lastBySymbol(this.deps.trader.id, symbol);
    if (last && last.leverage > 0) return last.leverage;

    const risk = this.activeConfig.riskControl;
    return isMajorSymbol(symbol) ? risk.btcEthMaxLeverage : risk.altcoinMaxLeverage;
  }

  /**
   * 给每个候选标上「**当前账户规模下能不能真的开出仓**」。
   *
   * ## 为什么需要它（实测：每轮都在给模型看一个它开不了的标的）
   *
   * BTCUSDT 的交易所最小名义是 **$50**，而账户约 22 USDT 时模型按风险算出的名义只有 **$20** ——
   * 实测 `#1462` 就是被这句拒掉的：「仓位名义价值 $20.00 低于最低要求 $50.00」。
   *
   * 而 `coins.ts` 把 BTCUSDT **无条件**放进候选池（它提供「大盘背景」），于是它每轮都排在
   * **第一位**、拿到约 10KB 的完整多周期序列 —— 那些数据模型永远用不上，
   * 却占着提示词预算，还让它以为"BTC 是一个可以做的候选"。
   *
   * 判据是"**上限够不够得着下限**"：本账户对该标的的名义上限（`ratio × 权益`）
   * 必须 ≥ 交易所的最小名义。够不着就标 `ok: false`，渲染层据此只给摘要 + 写明原因。
   *
   * 注意这**不是**在替模型设限（风控照旧独立裁决）：它只是把"一个已经确定的物理事实"
   * 提前告诉模型，省掉一轮必然被拒的提案和那 10KB 的行情。
   */
  private annotateTradability(snaps: MarketSnapshot[], equity: number): void {
    const rc = this.activeConfig.riskControl;
    for (const snap of snaps) {
      let minNotional = 0;
      try {
        minNotional = this.deps.registry.minNotional(snap.symbol);
      } catch {
        /* 查不到下限（标的刚下架等）→ 不标，按可交易处理，交给风控照常裁决。 */
        continue;
      }
      const ratio = snap.isMajor ? rc.btcEthMaxPositionValueRatio : rc.altcoinMaxPositionValueRatio;
      const cap = ratio * equity;
      if (minNotional > 0 && cap > 0 && minNotional > cap) {
        snap.tradability = {
          ok: false,
          minNotional,
          reason:
            `交易所最小名义 $${minNotional}，而权益 $${equity.toFixed(2)} × ${ratio} = ` +
            `$${cap.toFixed(2)} 是你这个账户规模的上限 —— 够不着`,
        };
      } else {
        /*
         * 可做 —— 但**把最小名义一起带上**。实测 `#1462`：模型对 BTCUSDT 提了 $20，
         * 而交易所下限是 $50 → 被拒。BTC 对这个账户其实能做（上限 ≈ $110），
         * 它只是不知道"起步就要 $50"。这句话属于**事实**，无条件写给它是正确的。
         */
        snap.tradability = { ok: true, minNotional: minNotional > 0 ? minNotional : undefined };
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Drawdown guard                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Close positions that have given back too much of their peak profit.
   *
   * Runs before the model is consulted and does not ask permission: protecting
   * realised profit is exactly the judgement models reliably get wrong.
   */
  private async applyDrawdownGuard(): Promise<number> {
    const traderId = this.deps.trader.id;
    /*
     * ⚠️ 走 `effectivePositions()` —— 直接读 `broker.getPositions()` 在模拟盘上
     * **恒返回空**，于是回撤守卫会**从不触发**（静默失效）。见那个方法的说明。
     */
    const exchangePositions = await this.effectivePositions();
    const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
    let closed = 0;

    for (const local of positionStore.open(traderId)) {
      const live = liveBySymbol.get(local.symbol);
      if (!live) continue;

      // Use the exchange's own unrealised PnL for the decision, but the stored
      // peak (which we ratchet ourselves) for the reference point.
      const view: PositionView = {
        ...this.toPositionView(local, new Map()),
        markPrice: live.markPrice,
        unrealizedPnl: live.unrealizedPnl,
        unrealizedPnlPercent: live.unrealizedPnlPercent,
      };

      const verdict = shouldCloseForDrawdown(view, this.activeConfig);
      if (!verdict.close) continue;

      this.emit('info', verdict.reason);
      try {
        await this.executeClose(
          {
            symbol: local.symbol,
            action: local.side === 'long' ? 'close_long' : 'close_short',
            leverage: local.leverage,
            positionSizeUsd: 0,
            stopLoss: null,
            takeProfit: null,
            confidence: 100,
            riskUsd: 0,
            reasoning: verdict.reason,
reducePercent: null,
reduceQuantity: null,
            /* 回撤守卫是机械动作，没有"标的评分"可言 —— 如实留空。 */
            setupScore: null,
            setupScoreBasis: '',
            adjustments: [],
          },
          'drawdown_guard',
        );
        closed += 1;
      } catch (error) {
        this.emit(
          'error',
          `回撤守卫平仓 ${local.symbol} 失败：${(error as Error).message}`,
        );
      }
    }

    return closed;
  }
  /* ---------------------------------------------------------------------- */
  /*  Breakeven guard                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * 浮盈够多时把止损移到开仓价。
   *
   * ## 与回撤守卫的分工
   *
   * `applyDrawdownGuard()` 是**平仓**：浮盈回吐太多就落袋 —— 它给利润设了上限。
   * 这里**不平仓**，只把止损移到成本价，**让赢的单继续跑**。
   *
   * 两者互补。而这一条治的是实测到的那个病：
   * **平均持仓 4.6 分钟、手续费占毛盈亏 38%，一笔已经赚到钱的单又变回亏损单。**
   *
   * ## ⚠️ 顺序：**先撤旧、再挂新**（这一段原来是反的，见下）
   *
   * 实测得出的结论，而不是推理出来的：
   *
   * | 顺序 | 结果 |
   * | --- | --- |
   * | **先撤旧、再挂新** | 中间有一个短暂的无保护窗口 —— 但这是**唯一可行**的顺序 |
   * | 先挂新、再撤旧 | **必吃 `-4130`**（币安不允许同一仓位存在两张条件单） |
   *
   * 原来这里写的是"先挂新、再撤旧"，理由是"挂新失败时旧止损还在"。那个推理
   * **漏了交易所的约束**：两张不能并存。实测后果是订单记录里连刷四条 `-4130`、
   * **保本止损从未生效过**（`20:00:25 / 20:12:25 / 20:15:25 / 20:16:25`）。
   *
   * 所以挂新失败时**必须按 §2.6 处理** —— 立刻市价平仓并记账，
   * 而不是留一个没有止损的杠杆敞口等下一轮。
   *
   * ## 为什么不用 `cancelAllOrders`
   *
   * 它同时撤**普通单和条件单**，会把**止盈单一起撤掉** —— 而本函数只重挂止损，
   * 那个止盈就永久没了。**精选要撤的那一张**，而不是推倒重来。
   * 用 `cancelOrder(symbol, id, 'algo')` —— `kind` 必须传 `'algo'`，理由见调用处的注释。
   */
  /**
   * **把一个止损价往当前价方向收紧**（P2 · 2026-10-19）。
   *
   * ## 用途
   *
   * 给 Jev 提供"更紧的候选档"。它不自己算数（Jev 弱于算术），
   * 而是从算好的三档里选 —— 与开仓档位同一个设计。
   *
   * ## 口径
   *
   * ```
   *   多头：新止损 = 当前价 - (当前价 - 原止损) × factor   ← 更靠近当前价
   *   空头：新止损 = 当前价 + (原止损 - 当前价) × factor
   * ```
   * `factor < 1` ⇒ 止损离当前价更近 ⇒ **更紧**（风险更小）。
   *
   * ⚠️ **`factor` 必须 < 1**。`≥ 1` 会算出一个更远（更宽松）的止损，
   * 而放宽止损等于增加风险 —— 那不是本函数该做的事。
   */
  private tightenStop(
    side: 'long' | 'short',
    markPrice: number,
    stop: number,
    factor: number,
  ): number {
    /* 防御：`factor >= 1` 会让止损变宽，直接钳到 0.99（仍比原来紧一点点）。 */
    const f = factor >= 1 ? 0.99 : Math.max(0.01, factor);
    if (side === 'long') {
      return markPrice - (markPrice - stop) * f;
    }
    return markPrice + (stop - markPrice) * f;
  }

  /**
   * **判断新止损是否【比旧止损更紧】**（P2 的最后一道闸 · 2026-10-19）。
   *
   * ## 为什么需要它（不能信任上游）
   *
   * 上游有两个来源：机械规则与 Jev。**两者都可能算出更宽松的值** ——
   * 机械规则理论上不会（`breakeven.ts` 有保证），但 Jev 的答案完全不可控
   *（它是个概率模型，可能选错档、也可能在某个边界上给出奇怪的值）。
   *
   * ⇒ 在真正下单之前**再判一次**：
   * ```
   *   多头：新止损 > 旧止损（更靠近上方当前价）⇒ 更紧
   *   空头：新止损 < 旧止损（更靠近下方当前价）⇒ 更紧
   * ```
   * 旧止损为 `null`（仓位没有止损？）时**一律拒绝移动** ——
   * 那种情况应该走"补挂保护单"那条路径，不是这里。
   */
  private isStopTighter(
    side: 'long' | 'short',
    oldStop: number | null,
    newStop: number,
    _markPrice: number,
  ): boolean {
    if (oldStop === null || !Number.isFinite(oldStop)) return false;
    if (!Number.isFinite(newStop) || newStop <= 0) return false;
    return side === 'long' ? newStop > oldStop : newStop < oldStop;
  }

  private async applyBreakevenGuard(): Promise<number> {
    const traderId = this.deps.trader.id;
    const threshold = this.activeConfig.riskControl.breakevenTriggerPercent;

    // 阈值为 0 表示关闭这条规则 —— 连行情都不必拉。
    if (!(threshold > 0)) return 0;

    /*
     * ⚠️ **JEV 模式的「允许移动止损」关掉时整段跳过**（2026-10-19 补）。
     *
     * 用户关这个开关的意思是「**不要让止损自己动**」——
     * 而不是"不要问 Jev，但仍然按机械规则动"。
     *
     * ⇒ 在入口就返回，连行情都不拉（省一次交易所请求）。
     *   ⚠️ 其它模式**逐字节不变**（`mode !== 'jev'` 时这个条件恒假）。
     */
    if (this.deps.trader.mode === 'jev' && !jevBool('allow_trailing')) return 0;

    /* ⚠️ 同 `applyDrawdownGuard`：模拟盘上直接读会恒空 → 保本止损从不触发。 */
    const exchangePositions = await this.effectivePositions();
    const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
    let moved = 0;

    for (const local of positionStore.open(traderId)) {
      const live = liveBySymbol.get(local.symbol);
      if (!live) continue;

      /*
       * 用 `toPositionView` 而不是直接读 `local.side`。
       *
       * `positionStore.open()` 返回的是**原始数据库行**（`side` 是 `string`），
       * 而视图把它收窄成 `PositionSide`。既有代码（`applyDrawdownGuard`）
       * 走的也是这条路 —— 直接读会拿到一个宽类型，硬转则会把
       * "数据库里出现了意料之外的 side 值"这件事静默吞掉。
       */
      const view: PositionView = {
        ...this.toPositionView(local, new Map()),
        markPrice: live.markPrice,
        unrealizedPnl: live.unrealizedPnl,
        unrealizedPnlPercent: live.unrealizedPnlPercent,
      };

      const verdict = shouldMoveStopToBreakeven({
        side: view.side,
        entryPrice: view.entryPrice,
        currentStop: view.stopLoss,
        markPrice: view.markPrice,
        unrealizedPnlPercent: view.unrealizedPnlPercent,
        triggerPercent: threshold,
        /*
         * 追踪距离。`0` = 退回旧的纯保本行为（止损停在开仓价）。
         *
         * ⚠️ 它必须与 `breakevenTriggerPercent` 一起读 —— 只配后者不配前者，
         * 就是那条被实测证明会回吐 27% 浮盈的旧行为。
         */
        trailPercent: this.activeConfig.riskControl.trailingStopPercent,
      });

      if (!verdict.move || verdict.newStop === null) continue;

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **JEV 模式：让 Jev 决定"要不要收紧、收到哪一档"**（P2 · 2026-10-19）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 为什么在机械规则之上再加一层
       *
       * 机械规则（浮盈到阈值就收紧、跟到回退 trailPercent）是**无条件执行**的。
       * 用户希望这个判断也由 Jev 做（「一切由 JEV 自主」），代价是每个持仓
       * 每轮多一次调用（约 300ms + token）。
       *
       * ## ⚠️ 三层硬约束（缺一条都不能上线）
       *
       * ```
       * ① 只有 mode === 'jev' 才问 —— 其余三种模式的执行路径逐字节不变
       * ② Jev 只能【收紧】，不能放宽 —— 放宽止损 = 增加风险，必须由人决定
       * ③ 新止损必须在【盈利方向】上 —— 绝不接受把止损移回不利一侧
       * ```
       *
       * ②③ 在这里**由代码强制**，不是靠 Jev 的自觉：
       * `shouldMoveStopToBreakeven()` 已经保证"只往有利方向移"，
       * 而下面再比一次（新止损必须比旧止损更靠近当前价）。
       *
       * ## 失败时怎么办
       *
       * Jev 调不通 → **退回机械规则**（`verdict` 照常执行）。
       * 理由：机械规则本身就是安全的，不该因为一个"锦上添花"的判断失败
       * 而放弃收紧止损的机会。
       */
      let effectiveStop = verdict.newStop;
      /*
       * ⚠️ **Jev 的移动止损判断走 `deps.model`** —— 它就是
       * `createJevDecisionModel()` 造出来的那个 `DecisionModel`
       *（见 `manager.ts` 的 `buildJevModeModel`）。
       *
       * **不给 `AutoTrader` 加新字段**：那会让"决策模型"有两个来源，
       * 而"哪个才是权威"这种问题一旦出现就会在某个分支里写错。
       * 用可选方法探测（`typeof === 'function'`）保证：
       * ```
       *   其它模式的 model 没有这个方法 ⇒ 整段跳过 ⇒ 行为逐字节不变
       * ```
       */
      const jevTrailing = this.deps.model as {
        suggestTrailingStop?: (input: {
          symbol: string;
          side: 'long' | 'short';
          entryPrice: number;
          markPrice: number;
          currentStop: number | null;
          unrealizedPnlPercent: number;
          candidates: { A: number; B: number; C: number };
        }) => Promise<number | 'keep' | null>;
      };
      /*
       * ⚠️ **「允许移动止损」关掉时，Jev 不参与判断**（2026-10-19 补）。
       *
       * 只关掉"问 Jev"是不够的 —— 用户关这个开关的意思是
       * **「不要让止损自己动」**，所以整段（含机械规则）都不该执行。
       *
       * 那个判断在函数入口（见 `applyBreakevenGuard` 开头）——
       * 这里再判一次是防御：将来若有人改了入口，这里仍然不会误动。
       */
      const jevTrailingAllowed =
        this.deps.trader.mode !== 'jev' || jevBool('allow_trailing');
      if (
        this.deps.trader.mode === 'jev' &&
        jevTrailingAllowed &&
        typeof jevTrailing.suggestTrailingStop === 'function'
      ) {
        try {
          const asked = await jevTrailing.suggestTrailingStop({
            symbol: view.symbol,
            side: view.side,
            entryPrice: view.entryPrice,
            markPrice: view.markPrice,
            currentStop: view.stopLoss,
            unrealizedPnlPercent: view.unrealizedPnlPercent,
            /* 三档候选：机械值 / 更紧 / 最紧。都由既有算式算出，Jev 只选。 */
            candidates: {
              A: verdict.newStop,
              B: this.tightenStop(view.side, view.markPrice, verdict.newStop, 0.5),
              C: this.tightenStop(view.side, view.markPrice, verdict.newStop, 0.25),
            },
          });
          if (asked === 'keep') {
            this.emitOnChange(
              `jev-keep-stop:${local.id}`,
              'info',
              `${local.symbol} Jev 判断保持原止损不动（机械规则本可收紧到 ${verdict.newStop}）。`,
            );
            continue;
          }
          if (asked !== null) effectiveStop = asked;
        } catch (err) {
          /* 失败退回机械规则 —— 见上面"失败时怎么办"。 */
          log.warn(
            `[JEV 模式] ${local.symbol} 的移动止损判断失败，退回机械规则：${(err as Error).message}`,
          );
        }
      }

      /*
       * ⚠️ **最后一道闸：只接受"比旧止损更靠近当前价"的值**（约束 ③）。
       *
       * 这一步不信任任何上游（包括 Jev）—— 放宽止损等于增加风险，
       * 而那段逻辑绝不能靠"上游会算对"来保证。
       */
      if (!this.isStopTighter(view.side, view.stopLoss ?? null, effectiveStop, view.markPrice)) {
        this.emitOnChange(
          `stop-not-tighter:${local.id}`,
          'warn',
          `${local.symbol} 算出的新止损 ${effectiveStop} 并不比原止损更紧，本轮不移动（防止放宽风险）。`,
        );
        continue;
      }

      /*
       * ⚠️ **先撤旧止损，再挂新的 —— 顺序与我最初的实现相反。**
       *
       * ## 我最初写反了，而实盘证明它完全不工作
       *
       * 原本是"先挂新、再撤旧"，理由是"新挂失败时旧止损还在，仓位不会失去保护"。
       * **那个推理漏了一个前提：交易所允不允许两张条件单并存。**
       *
       * 实测（订单记录里连刷四条）：
       *
       *     20:00:25  ZECUSDT 止损 已拒绝  Binance -4130
       *     20:12:25  ZECUSDT 止损 已拒绝  Binance -4130
       *     20:15:25  ZECUSDT 止损 已拒绝  Binance -4130
       *     20:16:25  ZECUSDT 止损 已拒绝  Binance -4130
       *
       * `-4130` = 该仓位已有止损/止盈单，不能再挂一张。**所以新止损每一次都被拒绝，
       * 保本止损从未生效过，而它每一轮都重试、把订单记录刷满拒绝。**
       *
       * ## 现在的顺序，以及它带来的代价
       *
       * 撤旧 → 挂新。中间有一个**短暂的无保护窗口**，这无法避免：
       * 交易所不允许两张并存，"先撤"是唯一路径。
       *
       * 所以挂新失败时**必须按 §2.6 处理** —— 立刻市价平仓并记账，
       * 而不是留一个没有止损的杠杆敞口等下一轮。
       */
      /*
       * ⚠️ **单号保持字符串**（不去 `Number()`）——19 位单号超过 JS 安全整数，
       * 转换后末几位就变了，撤单会打到一个不存在的单号上（详见 `preserveBigIds()`）。
       */
      const oldStopId = local.stop_order_id ? String(local.stop_order_id) : null;
      /*
       * ⚠️ **撤"该标的全部止损"，而不是"DB 里记的那一张"（2026-10-02 实测）。**
       *
       * 下面那段撤单逻辑原来只打 `oldStopId`。而 `positionStore` 只保存**最后一次**
       * 的 `stop_order_id` —— 上移过 N 次止损就留下 N-1 张**不在 DB 里、却在交易所侧
       * 仍然有效**的孤儿单。只撤 DB 里那张，撤完再挂一张，孤儿单就此累积。
       *
       * 实测形态（HYPEUSDT）：持仓上同时有两张 STOP_MARKET（`#788` 上移时挂的、
       * `#790` 缺失检测挂的），历史上 LTCUSDT 同挂过 4 张。**旧的那张价位更差、
       * 会先被触发** —— 于是"止损上移"这件事在有孤儿单时根本没有生效。
       *
       * 所以这里改用 `cancelAllProtection(symbol, { stop: true, target: false })`：
       * **只撤止损、不碰止盈**（止盈本函数不重挂，撤掉就永久没了 —— 见下面那段注释）。
       */
      const oldStopCount = await this.cancelAllProtection(local.symbol, {
        stop: true,
        target: false,
      });
      if (oldStopCount === 0 && oldStopId && oldStopId.length > 0) {
        /*
         * 交易所侧查不到任何止损（可能是查询失败、也可能它真的已经不在）——
         * 回退到"按 DB 里的单号撤一次"，与改动前的行为一致。
         */
        const cancelled = await this.deps.broker
          .cancelOrder(local.symbol, oldStopId, 'algo')
          .catch(() => false);
        if (!cancelled) {
          /*
           * 撤不掉就**不要挂新的**：那必然吃 `-4130`，只会多一条无用的拒绝记录，
           * 而旧止损仍然有效 —— 当前状态是安全的，下一轮再试。
           */
          this.emitOnChange(
            `breakeven-cancel-fail:${local.id}`,
            'warn',
            `${local.symbol} 的旧止损 #${oldStopId} 未能撤掉，本轮不移动止损（原有的仍然有效）。`,
          );
          continue;
        }
      }

      const newStopId = await this.placeProtection({
        symbol: local.symbol,
        side: local.side === 'long' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        triggerPrice: effectiveStop,
        purpose: 'stop_loss',
        traderId,
        quantity: local.quantity,
      }).catch(() => null);

      if (!newStopId) {
        /*
         * 撤旧成功、挂新失败 —— **此刻仓位没有止损**。按 §2.6：
         * 一个没有保护的杠杆仓位是最糟糕的状态，宁可立刻退出。
         */
        this.emit(
          'error',
          `为 ${local.symbol} 移动止损时，旧止损已撤但新止损（开仓价 ${effectiveStop}）没挂上。` +
            '为避免留下无保护的敞口，立即平掉该仓位。',
        );
        const exitSide: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';
        const flatten = await this.emergencyFlatten(
          local.symbol,
          local.quantity,
          exitSide,
          traderId,
        ).catch(() => null);
        const still = positionStore.getOpenBySymbol(traderId, local.symbol);
        /*
         * ⚠️ **只有交易所确认成交了才记账**（`flatten === null` 表示"没确认"）。
         * 未确认就 `bookClosedPosition` = 账本说已平、交易所上仓位还在。
         * 漏记会在下一轮对账里补上，凭空记一笔不会自己消失（§2.3）。
         */
        if (still && flatten) {
          await this.bookClosedPosition(
            still,
            'protection_unavailable',
            flatten.avgPrice,
            flatten.fee,
            new Date().toISOString(),
          );
        } else if (still) {
          this.emit(
            'warn',
            `${local.symbol} 的紧急平仓未获确认，本轮不记账（本地持仓保留），交给下一轮对账处理。`,
          );
        }
        moved += 1;
        continue;
      }

      /*
       * 本地记录必须与交易所一致：把 `stop_loss` 也更新成刚挂上去的保本价。
       *
       * 只更新单号是不够的 —— 下一轮的 `shouldMoveStopToBreakeven()` 会拿
       * `local.stop_loss` 判断"是否仍在亏损侧"，读到旧值的话它会以为还需要移，
       * 于是**每一轮都重复挂一张新止损**，把交易所堆满同向的条件单。
       */
      positionStore.setProtection(
        traderId,
        local.symbol,
        effectiveStop,
        local.take_profit,
        String(newStopId),
        local.tp_order_id,
      );
      this.clearStateNotice(`breakeven-fail:${local.id}`);
      this.emit('info', verdict.reason);
      moved += 1;
    }

    return moved;
  }


  /* ---------------------------------------------------------------------- */
  /*  Execution                                                              */
  /* ---------------------------------------------------------------------- */

  /** Market-close an entire position, then cancel its leftover protection. */
  private async executeClose(decision: Decision, reason: CloseReason): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const symbol = normalizeSymbol(decision.symbol);
    const local = positionStore.getOpenBySymbol(traderId, symbol);
    if (!local) {
      return {
        action: decision.action,
        symbol,
        status: 'skipped',
        detail: '本地没有该持仓的记录，无法平仓。',
      };
    }

    const clientOrderId = makeClientId('exit', symbol);
    const side: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';

    // Cancel the resting stop/target FIRST. A `closePosition` algo order survives
    // a manual close and would fire into a flat book, opening a new position in
    // the opposite direction.
    //
    // ⚠️ 撤单失败**不阻断平仓**：撤不掉的挂单是麻烦，而平不掉的亏损仓位是危险。
    // 两害相权先平 —— 这里显式吞掉异常（`cancelAllOrders` 的契约是"撤不掉就抛"，
    // 所以必须接住，否则一个网络抖动会让平仓指令根本发不出去）。
    await this.deps.broker.cancelAllOrders(symbol).catch((error) => {
      this.emit(
        'warn',
        `${symbol} 平仓前撤单失败（${(error as Error).message}），仍然继续平仓。`,
      );
    });

    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity: local.quantity,
        reduceOnly: true,
        clientOrderId,
      });

      const filled = await this.deps.broker.waitForFill(placed);
      const filledQty = filled.executedQty;

      /*
       * An unconfirmed exit must never be booked as a completed round-trip.
       *
       * `waitForFill` gives up after its timeout and returns whatever the last
       * poll saw — which can be a partial fill or a still-working order. The code
       * here used to fall back to `local.quantity`, so a timeout was booked as a
       * **full** close: the remainder stayed open at the exchange, the next
       * `reconcilePositions` found the position still there, and the same
       * round-trip was booked a second time. The ledger then showed a trade that
       * never happened while the account still carried the position.
       *
       * So: book only what the exchange confirms, and when it confirms nothing,
       * leave the position open and let the next cycle reconcile the truth. The
       * position row is deliberately *not* closed here — the reconciliation pass
       * is the path that knows how to handle a remainder.
       */
      if (!(filledQty > 0)) {
        this.recordOrder({
          traderId,
          exchangeOrderId: filled.id,
          clientOrderId,
          symbol,
          side,
          type: 'MARKET',
          purpose: 'exit',
          quantity: local.quantity,
          price: null,
          triggerPrice: null,
          status: filled.status,
          avgPrice: filled.avgPrice || null,
          filledQty: 0,
          raw: filled.raw,
        });
        this.emit(
          'warn',
          `${symbol} 的平仓单在 ${filled.status} 状态下没有确认成交，本次不记账；仓位仍按本地记录保留，下一轮对账会以交易所的实际持仓为准。`,
        );
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: `平仓单未确认成交（状态 ${filled.status}），未记账，等待对账。`,
          orderId: filled.id,
        };
      }

      const exitPrice = filled.avgPrice || (await this.deps.broker.getMarkPrice(symbol));

      // Best-effort commission capture. Fee accounting is a reporting concern,
      // so a failure here must never abort a close that has already executed.
      let fee = 0;
      try {
        const fills = await this.deps.broker.getUserTrades(symbol, 10);
        fee = fills
          .filter((fill) => String(fill.orderId) === filled.id)
          .reduce((sum, fill) => sum + (Number(fill.commission) || 0), 0);
      } catch {
        /* leave the fee at zero rather than fail the close */
      }

      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity: local.quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: exitPrice,
        filledQty,
        fee,
        raw: filled.raw,
      });

      if (filledQty < local.quantity) {
        this.emit(
          'warn',
          `${symbol} 只成交了 ${filledQty}/${local.quantity}，本地记录已保留，剩余敞口由下一轮对账与后续平仓处理。`,
        );
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: `平仓单只成交 ${filledQty}/${local.quantity}，未按全平记账，等待对账。`,
          orderId: filled.id,
        };
      }

      /*
       * Book through the same path as every other close, so fees, funding and
       * the trades row are produced identically no matter what closed the
       * position.
       */
      const booked = await this.bookClosedPosition(
        local,
        reason,
        exitPrice,
        fee,
        new Date().toISOString(),
      );

      /*
       * 平仓前撤掉的那些保护单（§2.7）在交易所已经没了，本地行却还写着 `NEW`。
       * 顺手结清它们，操作员就不必等到下一轮对账才在「当前委托」里看到正确的状态。
       *
       * 只碰账：撤单仍然只发生在上面那一次 `cancelAllOrders()`，时机与参数都没变。
       * 这一步失败只记日志，绝不影响这一笔已经成交的平仓。
       */
      await this.settleStaleOrders(symbol).catch((error) => {
        log.warn(
          `[${this.deps.trader.name}] ${symbol} 平仓后结清本地委托记录失败：${(error as Error).message}`,
        );
      });

      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `已按 ${exitPrice} 平掉${local.side === 'long' ? '多头' : '空头'} ${filledQty}，净盈亏 ${booked.netPnl >= 0 ? '+' : ''}${booked.netPnl.toFixed(4)} USDT。`,
        orderId: filled.id,
        notionalUsd: filledQty * exitPrice,
      };
    } catch (error) {
      this.recordOrder({
        traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity: local.quantity,
        price: null,
        triggerPrice: null,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * **限价入场**：挂单，这一轮不建仓。
   *
   * ## 它为什么和市价开仓是两条路
   *
   * 市价那条：下单 → 等成交 → 建仓 → 挂保护单，四步连着做完，一轮之内仓位就成立了。
   *
   * 限价这条：**下单之后就结束了**。单挂在交易所上等价格过来，可能几分钟、
   * 也可能几小时 —— 而这一轮**不建仓**，只在 `positions` 里留一行
   * `status='pending'`（`open()` 看不到它，风控与权益也不把它算作持仓）。
   *
   * ## 为什么 `stopLoss` / `takeProfit` 现在就存下来
   *
   * 挂单时**挂不了保护单**（还没有仓位，`closePosition` 的条件单会被拒）。
   * 但成交那一刻必须立刻挂上 —— 所以决策里的止损止盈要先存在那一行 pending 上，
   * 等 `settlePendingEntries` 转正时直接拿来用。**不给的话，成交之后就是裸仓。**
   *
   * ## 返回 `submitted`（不是 `filled`）
   *
   * 状态名要说实话：这一轮**没有成交**，只有一个挂出去的委托。执行摘要里
   * 它必须和"已开仓"分开显示 —— 否则界面又会变成"显示有持仓而实际没有"。
   */
  private async submitLimitEntry(
    decision: Decision,
    snapshot: MarketSnapshot | undefined,
    ctx: {
      traderId: number;
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      price: number;
      clientOrderId: string;
    },
  ): Promise<ExecutionLogEntry> {
    const { traderId, symbol, side, quantity, price, clientOrderId } = ctx;
    const limitPrice = decision.limitPrice ?? 0;

    /*
     * 本地先做一次方向检查：买单的限价**高于**市价会立刻成交（那就不是"挂单等"），
     * 卖单反之。这不是交易所会拒的错，而是**意图与做法不一致** —— 与其让它
     * 悄悄变成市价单，不如说清楚。
     */
    const wouldFillImmediately = side === 'BUY' ? limitPrice >= price : limitPrice <= price;
    if (wouldFillImmediately) {
      this.emit(
        'warn',
        `${symbol} 的限价 ${limitPrice} 相对于市价 ${price} 会立即成交（${side === 'BUY' ? '买价高于市价' : '卖价低于市价'}）—— 这已经不是"挂单等成交"了。已按市价开仓处理。`,
      );
      return this.executeOpen({ ...decision, entryType: 'market', limitPrice: null }, snapshot);
    }

    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'LIMIT',
        quantity,
        price: limitPrice,
        timeInForce: 'GTC',
        clientOrderId,
      });

      /*
       * ⚠️ **不能在这里"当成市价开仓再来一次"**（外部 issue #137）。
       *
       * 原来这一段是 `return this.executeOpen({ ...decision, entryType: 'market', ... })`，
       * 它有两个后果，而且**都是那个 bug 的成因**：
       *
       * 1. **那张已经成交的 LIMIT 单永远没有账** —— `recordOrder` 与
       *    `positionStore.insert` 都在那个 `return` **之后**，永不执行；
       *    `settlePendingEntries` 也救不了：pending 行从未写入，这条成交在本地不存在；
       * 2. **又多下一张市价单** —— `executeOpen` 里 `makeClientId('entry', symbol)`
       *    带 `Math.random()` 后缀，所以币安**不会**当成重复单挡掉。
       *
       *     账户上：两份仓位（成交的 LIMIT + 新下的 MARKET）
       *     本地账：只有后面那张市价单的那一份
       *
       * 复现条件：上面 `wouldFillImmediately` 那条是对的（它根本没下 LIMIT 单），
       * 但**行情在"取到现价"与"发出 LIMIT"之间跳一下**就会绕过它。
       * 低价山寨/meme 的 tick 极密，瞬间穿价很常见。
       *
       * 所以顺序改成：**先记账 → 再按"它已经成交了"收尾**（见下面 pending 插入之后）。
       */

      /*
       * 保证金在这里算一次，两个消费者用它：这一行订单（订单记录里那一列）与
       * 下面那行 `pending` 持仓。两处各写一遍算式就是同一个金额有了两份公式
       * —— 而它们会分叉，分叉之后"这一单占多少本金"会随看它的地方而变。
       *
       * 用**委托价 × 委托数量**：单还没成交，交易所那一刻锁的就是这个意向名义价值；
       * 成交之后 `settlePendingEntries()` 会用真实成交价与成交量重算持仓那一份
       * （订单行保留下单那一刻的意向值 —— 它说的是"这张单当初打算占多少"）。
       */
      const margin = marginOf(limitPrice, quantity, decision.leverage);

      /* 记进订单表（`NEW`，`limitPrice` 落进 `price` 而不是 `avgPrice`）。 */
      this.recordOrder({
        traderId,
        exchangeOrderId: placed.id,
        clientOrderId,
        symbol,
        side,
        type: 'LIMIT',
        purpose: 'entry',
        quantity,
        price: limitPrice,
        triggerPrice: null,
        status: 'NEW',
        avgPrice: 0,
        filledQty: 0,
        fee: 0,
        marginUsed: margin,
      });

      /*
       * 插一行 `pending`：它**不是持仓**，只是"有一张挂出去的单要盯着"。
       * `stopLoss` / `takeProfit` 存在这一行上，成交时直接拿来挂保护单。
       *
       * ⚠️ **接住它的返回值（新行的 id）**：下面"立即成交"那条路要拿这一行去
       * `promotePendingEntry`（转正 + 结清订单行 + 挂保护单）——
       * 那是 issue #137 的修复点。
       *
       * `insert` 返回的是**自增 id** 而不是整行，所以这里用 `entry_order_id`
       * 把刚插进去的那一行取回来（不能靠 `pending()[0]`：同一轮可能有多笔限价单，
       * 顺序不保证）。
       */
      const insertedId = positionStore.insert({
        traderId,
        symbol,
        side: decision.action === 'open_long' ? 'long' : 'short',
        quantity,
        entryPrice: limitPrice,
        leverage: decision.leverage,
        liquidationPrice: null,
        marginUsed: margin,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        stopOrderId: null,
        tpOrderId: null,
        openReasoning: decision.reasoning,
        /*
         * **情报归因**（见 `db/schema.ts` M17）—— 归因链的中间一环。
         *
         * ⚠️ 这里存的是**裁决官标注并经 `filterKnownIntelKeys` 校验过**的键
         *（编造的已被剔除）。`undefined` 时仓库层写 `[]` = 纯技术面。
         */
        ...(decision.intelKeys !== undefined ? { intelKeys: decision.intelKeys } : {}),
        status: 'pending',
        entryOrderId: placed.id,
        /* 模型为这一张指定的耐心（没给就是 null = 用配置值）。 */
        waitMinutes: decision.waitMinutes ?? null,
      });

      /*
       * ⚠️ **挂单也可能立刻成交**（价格刚好穿过去）—— 但那**不是**"当成开仓再来一次"。
       *
       * 那张单**已经成交了**，要做的只是**把刚插进去的 pending 行转正**：
       * `promotePendingEntry` 会一并做完三件事 —— 转正持仓、结清那张订单行、
       * **在同一段代码里立刻挂上保护单**（那个窗口是整条路径里唯一有风险的地方）。
       *
       * ⚠️ **绝不能再下一次单**：`executeOpen` 会生成新的 `clientOrderId`
       *（带随机后缀、币安不会去重）→ 账户上两份仓位、账本只记一份（issue #137）。
       *
       * 走到这里的前提是"上面已经把 `recordOrder` 与 pending 行都写好了" ——
       * 那正是这次修复调整顺序的原因（原来它们在那个 `return` 之后，永不执行）。
       */
      if (placed.terminal && placed.executedQty > 0) {
        const actualPrice = placed.avgPrice > 0 ? placed.avgPrice : limitPrice;
        /*
         * 把刚插进去那一行取回来（`insert` 只回 id）—— 按 `id` 匹配，
         * 不用 `pending()[0]`：同一轮可能有多笔限价单。
         */
        const pendingRow = positionStore.pending(traderId).find((p) => p.id === insertedId);
        if (!pendingRow) {
          /*
           * 理论上不可达（刚插进去）。真发生时**不能静默**：那张单已经成交、
           * 而本地找不到它 —— 这正是"账本与账户不符"的起点，必须让对账去处理。
           */
          this.emit(
            'error',
            `${symbol} 的限价单已立即成交，但本地找不到刚写入的待成交行（id=${insertedId}）—— 已交给对账处理，请人工核对交易所持仓与账本。`,
          );
        } else {
          this.emit(
            'info',
            `${symbol} 的限价单已立即成交（${placed.executedQty} @ ${actualPrice}），直接转正并挂保护单。`,
          );
          await this.promotePendingEntry(pendingRow, placed.executedQty, actualPrice);
        }
        return {
          action: decision.action,
          symbol,
          status: pendingRow ? 'ok' : 'failed',
          detail: pendingRow
            ? `限价单 ${limitPrice} 已立即成交（${placed.executedQty} @ ${actualPrice}）。`
            : `限价单已成交，但本地待成交行丢失（id=${insertedId}），已交给对账。`,
        };
      }

      this.emit(
        'info',
        `已挂限价单 ${symbol} ${decision.action === 'open_long' ? '做多' : '做空'} ${quantity} @ ${limitPrice}（现价 ${price}，${decision.leverage}x）—— 成交后会自动挂上止损 ${decision.stopLoss ?? '无'} 与止盈 ${decision.takeProfit ?? '无'}。`,
      );

      return {
        action: decision.action,
        symbol,
        status: 'submitted',
        detail: `已挂限价单 @ ${limitPrice}（现价 ${price}），等待成交；成交后自动挂保护单。`,
      };
    } catch (error) {
      return {
        action: decision.action,
        symbol,
        status: 'failed',
        detail: `限价挂单失败（${(error as Error).message}）。`,
      };
    }
  }

  /**
   * **撤掉一张还没成交的限价入场单。**
   *
   * ## 为什么它需要一个显式分支
   *
   * 执行层是链式分派（`isClose` → `isAdjust` → `add` → `reduce` → **否则当成开仓**）。
   * 不加这个分支的话，`cancel_pending` 会**被真的当成一笔开仓去执行** ——
   * 那比"静默什么都不做"更糟。`decision.ts` 里已经为同一个坑写过三次注释。
   *
   * ## ⚠️ 撤单失败时**先问清楚它是"没了"还是"成了"**
   *
   * 交易所回"这张单不存在"有两种可能，而它们的结果完全相反：
   *
   *   · 它**被撤销/过期了** → 从未成为持仓，关掉本地记录就对了；
   *   · 它**刚刚成交了** → 那是一笔真实持仓，**关掉本地记录等于把一个仓位丢了**
   *     （钱花了、仓位在，而账本上没有它）。
   *
   * 所以撤单失败时**不猜**：去查一次那张单的真实状态，成交了就交给
   * `settlePendingEntries` 走转正那条路（它下一轮会跑），**本地记录保持不动**。
   */
  private async executeCancelPending(decision: Decision): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const symbol = normalizeSymbol(decision.symbol);

    const row = positionStore.pending(traderId).find((p) => p.symbol === symbol);
    if (!row) {
      return {
        action: decision.action,
        symbol,
        status: 'skipped',
        detail: `${symbol} 没有等待成交的挂单（可能已经成交或被撤销）。`,
      };
    }

    const orderId = row.entry_order_id;
    if (!orderId) {
      /* 坏数据：没有单号的待成交行撤不了什么，直接作废（与对账同一处理）。 */
      positionStore.close(row.id);
      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `${symbol} 的待成交记录没有交易所单号，已作废。`,
      };
    }

    /*
     * ⚠️ **两种失败形态都要接住：抛异常，以及"静默返回 false"。**
     *
     * `broker.cancelOrder()` 的契约是 `Promise<boolean>`，**失败时 `return false`
     * 而不抛**（只有 `-2011` 例外，它表示"单子已经不在交易所了"= 成功）。
     * 这里原来只写了 `try/catch` —— 于是撤单真的被拒时 `catch` 不触发，
     * 代码继续走到下面的 `positionStore.close(row.id)`：**本地记录被销毁，
     * 而交易所那张单还挂着**。它随后成交 = 一个既没有本地行、也没有保护单的裸仓。
     *
     * 这与 `expireStalePendingEntries()`（挂单超时撤）和 `applyBreakevenGuard()`
     * （保本移损）里那两处是**同一个形状** —— 适配层用"返回值"表达失败、
     * 调用层用"异常"表达失败，编译器抓不到，所以三处都要显式判断。
     */
    let cancelFailure: string | null = null;
    try {
      const cancelled = await this.deps.broker.cancelOrder(symbol, orderId, 'order');
      if (!cancelled) cancelFailure = '交易所拒绝了撤单请求（返回 false，未抛错）';
    } catch (error) {
      cancelFailure = (error as Error).message;
    }

    if (cancelFailure !== null) {
      /*
       * 撤不掉 —— **先查清楚那张单现在是什么状态**，而不是想当然。
       * 查不到（null）也不动：交给下一轮的对账，它每轮都会问一次。
       */
      const order = await this.deps.broker.getOrder(symbol, orderId).catch(() => null);
      const executed = Number(order?.executedQty ?? 0) || 0;
      if (executed > 0) {
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail:
            `撤单时发现 ${symbol} 那张单**已经成交了**（${executed}）—— 撤不了，` +
            '它是一笔真实持仓，已留给对账去转正并挂保护单。',
        };
      }
      return {
        action: decision.action,
        symbol,
        status: 'failed',
        detail: `撤销 ${symbol} 的挂单失败（${cancelFailure}）；本地记录保留，下一轮继续尝试。`,
      };
    }

    /*
     * 撤成功（或交易所说它本来就不存在）→ 关掉本地记录。
     *
     * 这里可以放心关：上面那个 `catch` 已经处理了"其实已经成交"的情况，
     * 而走到这里意味着交易所接受了撤单请求。
     */
    positionStore.close(row.id);
    this.emit('info', `已撤掉 ${symbol} 的限价挂单（挂在 ${row.entry_price}，未成交），释放该入场名额。`);

    return {
      action: decision.action,
      symbol,
      status: 'ok',
      detail: `已撤掉 ${symbol} 的限价挂单（挂单价 ${row.entry_price}）—— 该入场作废，名额已释放。`,
    };
  }

  /**
   * **撤掉这个机器人**全部**还没成交的限价入场单** —— 供「全部平仓」使用。
   *
   * ## 为什么需要它（2026-10-02 用户报告）
   *
   * 用户的原话：「全部平仓功能似乎不作用于委托挂单」。
   *
   * 核实后确认成立，而且是**两层都漏**：
   *
   *   · `manager.closeAllPositions()` 只遍历 `positions.open()` —— 那是
   *     `status = 'open'` 的**已成交持仓**，`pending`（挂单）根本不在里面；
   *   · 它调用的 `closeManually()` 第一句是 `getOpenBySymbol()`，
   *     没有持仓就 `return null` —— **撤单那一行永远执行不到**。
   *
   * 于是"一个只有挂单、没有持仓的机器人"点全部平仓 = **什么都不发生**。
   * 那正是"平仓"这个按钮最需要工作的场景之一：挂单成交就会变成持仓，
   * 而操作员按它就是想把这个敞口收回来。
   *
   * ## 语义与 `executeCancelPending` 保持一致
   *
   * 撤单失败时**不猜**：查一次那张单的真实状态。已经成交的**不关本地记录** ——
   * 它是一笔真实持仓，关掉等于把仓位从账本上抹掉（钱花了、仓位在）。
   * 那种情况留给对账的 `settlePendingEntries` 走转正那条路。
   *
   * 返回实际撤掉的张数，供调用方如实汇报。
   */
  async cancelAllPendingEntries(): Promise<number> {
    const traderId = this.deps.trader.id;
    let cancelled = 0;

    for (const row of positionStore.pending(traderId)) {
      const symbol = row.symbol;
      try {
        /*
         * 有单号就精确撤；没有单号（坏数据）直接作废本地行 ——
         * 与 `executeCancelPending` 同一处理。
         */
        if (!row.entry_order_id) {
          positionStore.close(row.id);
          continue;
        }
        let cancelFailure: string | null = null;
        try {
          const ok = await this.deps.broker.cancelOrder(symbol, row.entry_order_id, 'order');
          if (!ok) cancelFailure = '交易所拒绝了撤单请求（返回 false）';
        } catch (error) {
          cancelFailure = (error as Error).message;
        }

        if (cancelFailure !== null) {
          /*
           * 撤不掉 —— 查清楚它现在是"没了"还是"成了"。
           * **已成交的不关本地记录**：那会丢掉一个真实仓位。
           */
          const order = await this.deps.broker.getOrder(symbol, row.entry_order_id).catch(() => null);
          const executed = Number(order?.executedQty ?? 0) || 0;
          if (executed > 0) {
            this.emit(
              'warn',
              `全部平仓时发现 ${symbol} 的挂单**已经成交**（${executed}）—— ` +
                '它现在是真实持仓，已留给对账转正并挂保护单（本次不平它）。',
            );
            continue;
          }
          this.emit('warn', `全部平仓时撤销 ${symbol} 的挂单失败（${cancelFailure}）—— 它仍然挂在交易所。`);
          continue;
        }

        positionStore.close(row.id);
        cancelled += 1;
      } catch (error) {
        this.emit('warn', `全部平仓时撤销 ${symbol} 的挂单出错：${(error as Error).message}`);
      }
    }

    if (cancelled > 0) {
      this.emit('info', `全部平仓：已撤掉 ${cancelled} 张还没成交的限价挂单。`);
    }
    return cancelled;
  }

  /**
   * **执行回执：把"刚才真的发生了什么"交回给模型，让它再决定一次。**
   *
   * ## 它补的是哪一环
   *
   * 在此之前这个循环是：
   *
   *     模型决策 → 风控 → 执行 → 记账 → 下一轮（45 分钟后）
   *
   * 也就是说**模型看不见自己动手之后发生了什么**。而有两件事只有执行完才知道：
   *
   *   · **成交价**。止损是按**决策时那个价**算出来的，而实际成交价可能差
   *     0.5% —— 止损距离跟着变，而那笔的风险画像就不一样了。真实交易员是
   *     成交之后按**实际入场价**去定保护位的。
   *   · **拒绝**。风控把它压了多少、交易所为什么拒 —— 那些现在只进执行日志，
   *     模型要等下一轮才（可能）看到。
   *
   * ## ⚠️ 为什么只允许"调保护位"与"撤单"
   *
   * 这是**刻意的限制**，它让这一轮的成本与风险都可控：
   *
   *   · 那正是**最需要回执的场景**（成交价出来了 → 按真实价定止损）；
   *   · 而这两个动作**只降低风险或持平**，不会让敞口在一轮之内反复膨胀；
   *   · 放它开新仓的话，一轮可能开出好几笔 —— 而每追问一次都是一次完整的
   *     模型调用（实测单次输入 10 万+ token），成本与敞口会一起失控。
   *
   * ## 只在"真的执行了动作"时才追问
   *
   * 大多数轮次模型什么都不做（`wait` / `hold`）。那种情况下没有回执可言 ——
   * 追问一次就是白花一次完整调用的钱，而结论只会是"我什么都没做"。
   *
   * **只追问一轮**，不递归：回执本身再产生"要不要再回执"的疑问时，
   * 答案是"不"。一轮足够拿到成交价并调整保护位。
   */
  private async followUpAfterExecution(input: {
    systemPrompt: string;
    stablePrompt: string;
    volatilePrompt: string;
    /** 这一轮已经产生的执行结果（含风控拒绝）。 */
    log: ExecutionLogEntry[];
    /** 本周期用过的行情快照，用来给回执里的价位提供上下文。 */
    progress: CycleProgress;
    /**
     * 本轮的行情快照（按 symbol）。
     *
     * ⚠️ **回执里的 `adjust_protection` 要过风控引擎**（外部 issue #117），
     * 而引擎的棘轮校验需要 `positions`（当前止损）与 `snapshots`（现价）——
     * 所以它必须传进来，而不是在这个方法里重新拉一遍（那会多一轮网络请求，
     * 也可能与刚才执行时用的价格不一致）。
     */
    snapshots: Map<string, MarketSnapshot>;
    /**
     * 本轮的**权威**账户读数（交易所侧）。
     *
     * ⚠️ 回执里的 `adjust_protection` 要过风控引擎（外部 issue #117），
     * 而引擎的判据需要账户（保证金占用、可用余额）。用它而不是在这里重拉 ——
     * 重拉会多一次网络请求，也可能与刚才执行时用的读数不一致。
     */
    account: { equity: number; availableBalance: number; marginUsed: number };
  }): Promise<ExecutionLogEntry[]> {
    const traderId = this.deps.trader.id;

    /*
     * 挑出"模型需要立刻知道结果"的那些 —— 见下面 `filter` 里的逐条说明。
     */
    const happened = input.log.filter((entry) => {
      /* 真的改变了什么状态的三种。 */
      if (entry.status === 'ok' || entry.status === 'submitted' || entry.status === 'failed') {
        return true;
      }
      /*
       * ⚠️ **风控拒绝也要进回执 —— 这一点我原来想错了。**
       *
       * 第一版只挑了上面三种，理由是"`rejected` 没有产生新状态"。**而那个理由
       * 是错的**：模型提了一个被拒的开仓，它**要等到下一轮（45 分钟后）才可能
       * 知道** —— 甚至永远不知道（如果它下一轮换了别的想法）。而"我这个提案
       * 为什么没通过"恰恰是回执该回答的问题：它是模型**能立刻修正**的东西
       * （"名义太小"→ 提大一点；"盈亏比不够"→ 换价位）。
       *
       * 实测触发这条的场景：`#120` 有一条 `rejected open_long BNBUSDT`，
       * 而它在原来的筛选下**完全不会进回执** —— 那一轮等于白提。
       */
      if (entry.status === 'rejected') return true;
      /*
       * 而"下去再来"的那种跳过**不进**：节流与冷却到下一轮自然会解除，
       * 模型知道了也做不了什么 —— 塞进回执只是花 token 换噪声。
       */
      return false;
    });
    if (happened.length === 0) return [];

    const summary = happened
      .map((entry) => {
        const head =
          entry.status === 'ok'
            ? '✅ 已执行'
            : entry.status === 'submitted'
              ? '⧗ 已挂单（未成交）'
              : entry.status === 'rejected'
                ? '⊘ 被风控拒绝（**没有执行**）'
                : '⚠️ 执行失败';
        return `${head} ${entry.action} ${entry.symbol}\n   ${entry.detail}`;
      })
      .join('\n');

    /* 当前持仓与挂单的**最新**状态 —— 回执里的价位要能对上真实情况。 */
    const positions = positionStore
      .open(traderId)
      .map(
        (p) =>
          `${p.symbol} ${p.side === 'long' ? '多头' : '空头'} 数量 ${p.quantity} 入场 ${p.entry_price}` +
          ` 止损 ${p.stop_loss ?? '无'} 止盈 ${p.take_profit ?? '无'}`,
      )
      .join('\n');
    const pending = positionStore
      .pending(traderId)
      .map((p) => `${p.symbol} 挂单 ${p.entry_price}（未成交）`)
      .join('\n');

    const feedback = [
      '# 你刚才的动作结果如下',
      '',
      summary,
      '',
      '## 现在的真实状态',
      positions ? `持仓：\n${positions}` : '持仓：无',
      pending ? `挂单：\n${pending}` : '',
      '',
      '## 你现在可以做什么',
      '',
      '**只能用这两个动作**（它们不增加敞口，所以这一轮不再走那批开仓上限）：',
      '',
      '- `adjust_protection` —— **按上面的真实成交价**重新考虑止损止盈。',
      '  决策时的价位与成交价可能不同，止损距离跟着变；**这是你唯一一次在成交后',
      '  修正它的机会**，而它必须仍满足盈亏比与手续费门槛。',
      '  ⚠️ **止损只能向有利方向移动**：多头只能往上、空头只能往下。',
      '  反向移动是**主动扩大风险**（把已经锁到的浮盈交出去），风控会直接拒绝 ——',
      '  所以不要把止损往回挪，那一次调用会被记成 `rejected` 并原样回给你看。',
      '- `cancel_pending` —— 撤掉上面的挂单（如果你认为它不该再等了）。',
      '',
      '**改不了的就别写**：不要开新仓、不要加仓、不要减仓平仓 —— 那些下一轮再说。',
      '如果你认为**不需要调整**，返回空数组 `[]` 即可（那是一个完全正常的答案）。',
      '',
      '输出格式与之前**完全一样**（`<reasoning>` + `<decision>`）。',
    ]
      .filter((part) => part !== '')
      .join('\n');

    let text: string;
    let usage: { promptTokens: number | null; completionTokens: number | null };
    try {
      /*
       * 与主调用同一个消息形状（system + 稳定段 + 变动段 + 回执），
       * **前缀完全一致** —— 那让这一轮的输入能命中缓存，成本是未命中价的 1/50。
       */
      const response = this.deps.model.chat
        ? await this.deps.model.chat([
            { role: 'system', content: input.systemPrompt },
            ...(input.stablePrompt.length > 0
              ? [{ role: 'user' as const, content: input.stablePrompt }]
              : []),
            { role: 'user', content: input.volatilePrompt },
            { role: 'assistant', content: '（已给出决策。）' },
            { role: 'user', content: feedback },
          ])
        : await this.deps.model.complete(input.systemPrompt, `${input.volatilePrompt}\n\n${feedback}`);
      text = response.text;
      usage = response.usage;
    } catch (error) {
      /*
       * 追问失败**不影响已经完成的事** —— 单已经下了、仓位已经建了、记账已经做了。
       * 这一轮只是少了"事后微调保护位"的机会，下一轮的机械保护仍然在兜底。
       */
      log.warn(`[${this.deps.trader.name}] 执行回执追问失败（不影响已完成的下单）：${(error as Error).message}`);
      return [];
    }

    /* token 用量必须累计 —— 否则"这一轮花了多少"会少算一整次调用。 */
    input.progress.promptTokens = (input.progress.promptTokens ?? 0) + (usage.promptTokens ?? 0);
    input.progress.completionTokens =
      (input.progress.completionTokens ?? 0) + (usage.completionTokens ?? 0);

    /*
     * ⚠️ **追问就记 —— 不管模型有没有真的调整。**
     *
     * 我第一版只在"模型确实调了什么"时才 emit，于是：
     *
     *   · **回执发生了、而模型回了空数组**（那是一个完全正常的答案）；
     *   · **回执压根没发生**（比如某个筛选条件把它排除了）
     *
     * ——**这两种情况在日志里长得一模一样**。而实测我正是靠日志判断"回执有没有
     * 上线"，于是那一条 0 条的日志让我怀疑了两轮。
     *
     * 那正是这个项目反复在修的那类问题：**一个观察不到的机制，等于无法验证的机制。**
     */
    this.emit(
      'info',
      `执行回执已追问（${happened.length} 条结果交回给模型）：${happened
        .map((h) => `${h.status}:${h.action} ${h.symbol}`)
        .join('、')}`,
    );

    /*
     * ⚠️ **回执路径同样需要「有决策块」这道闸门 —— 主路径有，这里原来漏了。**
     *
     * `parseDecisionResponse` 找不到 `<decision>` 时会**逐步放宽**（先试围栏代码块、
     * 再试第一个平衡的 JSON）。而这一次的回复里**带着系统提示词自己的范例**：
     * 模型在 `<reasoning>` 里回显、引用、或改写示例 JSON 是常态（提示词里就有
     * 三份完整的 `adjust_protection` / `cancel_pending` 范例）。
     *
     * 于是一段被截断的回复（回执输出很容易撞上长度上限）会让**推理文字里的
     * 范例 JSON 变成真实指令**：`adjust_protection` 会去移保护位、`cancel_pending`
     * 会真的撤单。白名单挡得住开仓，挡不住这两个 —— 而它们都会动真实挂单。
     *
     * 主路径（`analyze()`）早就用 `hasDecisionBlock()` 挡住了同一件事，
     * 这里补上同一道判据：**没有决策块 = 这一轮没有任何指令**。
     */
    if (!hasDecisionBlock(text)) {
      this.emit(
        'info',
        '执行回执的回复里没有决策块 —— 本轮不执行任何调整（避免把推理里回显的范例 JSON 当成指令）。',
      );
      return [];
    }

    const parsed = parseDecisionResponse(text, {
      candidateSymbols: new Set(positionStore.open(traderId).map((p) => p.symbol)),
      openPositions: new Map(positionStore.open(traderId).map((p) => [p.symbol, p.side as 'long' | 'short'])),
      allowUnlistedCloses: true,
      pendingSymbols: new Set(positionStore.pending(traderId).map((p) => p.symbol)),
    });

    /*
     * ⚠️ **只执行白名单里的两个动作。**
     *
     * 模型可能仍然写了开仓（提示词说了不要，但它不一定照做）。**静默丢弃它**
     * 而不是报错：这一轮的定位就是"事后微调"，而一条超出范围的决策
     * 没有产生任何后果 —— 记成 failed 反而会污染决策流。
     */
    const followed: ExecutionLogEntry[] = [];

    /*
     * ⚠️ **回执里的 `adjust_protection` 必须先过风控引擎**（外部 issue #117）。
     *
     * ## 这里原来跳过风控
     *
     * 主决策路径是 `this.risk.review(gatedDecisions, …)` → 只执行 `verdict.approved`。
     * 而回执这一轮直接 `await this.executeAdjust(decision)` —— **从未经过风控**。
     *
     * ## 为什么这条特别要紧
     *
     * `RiskEngine.reviewAdjust()` 对 `adjust_protection` 有两条**别的层都没有**的校验 ——
     * 棘轮（ratchet）：
     *
     * ```
     *   多头止损只能往上移（往下 = 主动扩大风险）
     *   空头止损只能往下移
     * ```
     *
     * 它保护的是**已经锁到的浮盈**。允许反向移动意味着模型一句话就能把
     * 靠 `applyBreakevenGuard` / 移动止损攒下来的保护**放松掉**。
     *
     * 而回执这一轮恰恰是"模型刚看完成交回报、情绪与上下文最浓"的时刻
     *（见本方法的头部注释），也是**唯一能改动止损止盈的两条路之一** ——
     * 它绕过了唯一一道方向校验。
     *
     * 且 `executeAdjust()` 内部**不记账 `adjustments`**，所以事后审计里
     * 看不出"风控曾经钳制过它" —— 违反 README 的「每一次钳制都留下记录」。
     *
     * ## 为什么只审查 adjust（而不审 cancel）
     *
     * `cancel_pending` **只降低风险**（撤掉一张挂着的入场单 = 释放一个已承诺的敞口），
     * 风控里也是"总是通过"（见 `review()` 里 `isCancelPendingAction` 那条）。
     * 所以它不必过引擎 —— 但**前提是这个判断在提示词里是准的**，见下面那处修正。
     */
    const adjustDecisions = parsed.decisions.filter((d) => isAdjustAction(d.action));
    const adjustVerdict =
      adjustDecisions.length > 0
        ? this.risk.review(adjustDecisions, {
            config: this.activeConfig,
            account: {
              equity: input.account.equity,
              availableBalance: input.account.availableBalance,
              marginUsed: input.account.marginUsed,
              /* 回执这一轮不开仓，持仓数只用于引擎内部的通用判据。 */
              positionCount: positionStore.open(traderId).length,
            },
            positions: new Map(
              positionStore.open(traderId).map((p) => [p.symbol, this.toPositionView(p, input.snapshots)]),
            ),
            snapshots: input.snapshots,
            minNotionalOf: (symbol) => this.deps.registry.minNotional(symbol),
            quantityFor: (symbol, notionalUsd, price) =>
              this.deps.registry.notionalToQuantity(symbol, notionalUsd, price),
            quantityUpFor: (symbol, quantity) => this.deps.registry.roundQuantityUp(symbol, quantity),
            entriesThisCycle: 0,
            entriesLastHour: 0,
            /* 回执不涉及"入场"这一类判据，费率给 null 走引擎的兜底。 */
            roundTripFeeRate: null,
          })
        : { approved: [], rejected: [] };

    /* 被风控拒掉的调整要留痕 —— 模型下一轮能看见，操作员也能看见。 */
    for (const rejection of adjustVerdict.rejected) {
      followed.push({
        action: rejection.decision.action,
        symbol: rejection.decision.symbol,
        status: 'rejected',
        detail: rejection.reason,
      } as ExecutionLogEntry);
    }

    /*
     * ⚠️ **只执行风控放行的那一份** —— 与主路径同一个形状（`verdict.approved`），
     * 而不是原始 `parsed.decisions`。
     */
    for (const decision of adjustVerdict.approved) {
      if (isAdjustAction(decision.action)) {
        followed.push(await this.executeAdjust(decision));
      }
    }

    for (const decision of parsed.decisions) {
      if (isAdjustAction(decision.action)) continue;
      if (isCancelPendingAction(decision.action)) {
        followed.push(await this.executeCancelPending(decision));
      } else if (
        isSkipAction(decision.action) ||
        decision.action === 'hold' ||
        decision.action === 'wait'
      ) {
        /*
         * ⚠️ **"什么都没做"不该被报成"越界"。**
         *
         * 这一轮只允许调保护位与撤单，别的动作都会被下面那条日志记成
         * "不在允许范围内，已忽略"。而 `skip` / `hold` / `wait` **本来就没有动作** ——
         * 报它们越界，等于把"我看了一圈、没有需要调的"说成一次违规。
         *
         * 提示词现在要求模型对**每一个候选标的**都留一条（不做的用 `skip`，
         * 带 `setup_score`），所以这一轮正常就会有十几条 —— 全报出来的话，
         * 日志里真正该被看见的那一两条会被淹掉。
         */
      } else {
        this.emit(
          'info',
          `执行回执那一轮里模型提出了 ${decision.action} ${decision.symbol} —— 该动作不在这一轮允许的范围内（只能调保护位或撤单），已忽略。`,
        );
      }
    }

    if (followed.length > 0) {
      this.emit(
        'info',
        `执行回执：模型在成交后主动调整了 ${followed.filter((f) => f.status === 'ok').length} 处（只能调保护位或撤单）。`,
      );
    }

    return followed;
  }

  /** Market-enter, then immediately place exchange-side protection. */
  private async executeOpen(
    decision: Decision,
    snapshot: MarketSnapshot | undefined,
  ): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const symbol = normalizeSymbol(decision.symbol);
    const isLong = decision.action === 'open_long';

    if (!snapshot) {
      return {
        action: decision.action,
        symbol,
        status: 'skipped',
        detail: '该标的没有可用的行情快照。',
      };
    }

    /* --- Leverage -------------------------------------------------------- */
    const leverageResult = await this.deps.broker.setLeverage(symbol, decision.leverage);
    if (leverageResult.note) this.emit('warn', leverageResult.note);

    /*
     * --- Margin mode -----------------------------------------------------
     *
     * ⚠️ **在下第一单之前设保证金模式 —— 而这一步以前完全缺失。**
     *
     * 币安官方明文「All contracts and positions are defaulted to the Cross Margin
     * mode」：**不管它，账户就是全仓**。而全仓意味着**任何一笔判断错到底都可能
     * 把其他仓位的钱一起带走** —— 爆仓清空整个钱包，而不是亏掉那一笔。
     *
     * 硬约束是它**只能在零持仓、零挂单时改**（`-4047`/`-4048`）—— 所以只能在这里
     * 设，而且只对新标的生效。已经存在的仓位保持原样：**为了改模式去平掉一个正在
     * 跑的仓，比全仓本身更危险**（§2.6：一个没有保护的杠杆敞口是最糟的状态）。
     *
     * `marginSet` 是进程内的"这个标的已经设过"缓存。跨进程重启会重新设一次 ——
     * 那正是我们要的：交易所侧可能被别的东西改回去。
     */
    /*
     * ⚠️ **模式来源：模型给了就用模型的，没给才用策略配置**（2026-10-18 新增）。
     *
     * 用户的原话：「② 不能写死，用什么模式 AI 决定」。
     * 在此之前这里只有 `activeConfig.riskControl.marginMode` 一个来源，
     * 于是线上 #11 的 335 张单**全部逐仓** —— 不是因为每笔都该逐仓，
     * 而是因为模型根本没有这个旋钮。
     *
     * ## 为什么"不写时回落配置"是安全的
     *
     * `decision.marginMode` 是 `optional`，解析器对认不出的值也归一成 `undefined`
     * ⇒ **模型不写 / 写错 = 行为与改动前逐字一致**。这条保证很重要：
     * 团队模式在持续盈利，任何一次发版都不该悄悄改变它的风险特征。
     */
    const wantedMode = decision.marginMode ?? this.activeConfig.riskControl.marginMode;
    if (this.marginSet.get(symbol) !== wantedMode) {
      const ok = await this.deps.broker.setMarginType(
        symbol,
        wantedMode === 'isolated' ? 'ISOLATED' : 'CROSSED',
      );
      if (ok) {
        this.marginSet.set(symbol, wantedMode);
      } else {
        /*
         * 设不上不算开仓失败：**它只影响"这笔最多亏多少"，不影响这笔该不该做**。
         * 失败通常有明确原因（该标的已有持仓或挂单），下一轮会再试。
         */
        this.emit(
          'warn',
          `${symbol} 的保证金模式未能设为${wantedMode === 'isolated' ? '逐仓' : '全仓'}（该标的可能已有持仓或挂单）—— 本次开仓继续，但这一仓的损失上限按当前模式计算。`,
        );
      }
    }

    /* --- Size ------------------------------------------------------------ */
    const price = await this.deps.broker.getMarkPrice(symbol).catch(() => snapshot.price);
    if (!(price > 0)) {
      return { action: decision.action, symbol, status: 'skipped', detail: '没有可用价格。' };
    }

    /*
     * ⚠️ **向下取整掉到最低名义之下时，上取一档 —— 不要把这笔丢掉。**
     *
     * 实测三次真实失败（2026-09-24 ~ 09-26），交易所原文：
     *
     *     LTCUSDT 的名义价值不足：0.275 × 72.55 = 19.9513 USDT，
     *     低于交易所下限 20 USDT。（数量 0.275 按步长取整为 0.275 之后才不足
     *     —— 调整仓位时要把这一步算进去。）
     *
     * 成因是**两次向下取整**：风控引擎按挂单价放行时给的名义是 $20.02，
     * 而这里又按挂单价 `floor(20.02 / 72.55)` → **0.275 → $19.95**，
     * 恰好掉回门槛之下。引擎第 12 步早就为这种"差一档"做了进位
     * （见 `reviewOpen` 里那段长注释），**下单这一层漏了**。
     *
     * 进位只加一个步长（这里约 $0.07），而且**只在确实能越过门槛时才加** ——
     * 越不过就照原样交给交易所拒绝，不掩盖真实的"这个标的在当前规模下做不了"。
     */
    /*
     * ⚠️ **优先用风控引擎算好的数量（`decision.quantity`），不要在这里重算。**
     *
     * 这个系统里数量曾经由**两条路径各算一次**：引擎第 12 步算一遍（用它校验最低名义、
     * 并把结果写进 `adjustments`），下单这里再拿 `positionSizeUsd` 除以价格算一遍。
     * 两处口径一旦不同就分叉 —— 实测（2026-09-24 ~ 09-26，三次真实失败）：
     * 引擎按市价放行、这里按挂单价向下取整，`0.275 × 72.55 = 19.9513 < 20`，
     * 整笔被交易所拒绝，**白丢一次机会**。
     *
     * 所以引擎现在把 `quantity` 一起交出来，这里直接用。**回退路径保留**：
     * 字段缺失时（回放数据、别的调用方）仍按原来的算法算，并保留"差一档就进位"的兜底。
     */
    let quantity: number;
    if (decision.quantity && decision.quantity > 0) {
      quantity = decision.quantity;
    } else {
      quantity = this.deps.registry.notionalToQuantity(symbol, decision.positionSizeUsd, price);
    }
    const minNotional = this.deps.registry.minNotional(symbol);
    if (minNotional > 0 && quantity > 0 && quantity * price < minNotional) {
      const bumped = this.deps.registry.roundQuantityUp(symbol, quantity);
      if (bumped > quantity && bumped * price >= minNotional) {
        this.emit(
          'info',
          `${symbol} 的数量按挂单价 ${price} 向下取整后只有 $${(quantity * price).toFixed(4)}` +
            `（低于交易所下限 $${minNotional}）—— 已上取一档到 ${bumped}（$${(bumped * price).toFixed(4)}）。`,
        );
        quantity = bumped;
      }
    }
    if (quantity <= 0) {
      return {
        action: decision.action,
        symbol,
        status: 'rejected',
        detail: `名义价值 ${decision.positionSizeUsd.toFixed(2)} 在价格 ${price} 下取整后为 0 张。`,
      };
    }

    const clientOrderId = makeClientId('entry', symbol);
    const side: 'BUY' | 'SELL' = isLong ? 'BUY' : 'SELL';

    /*
     * ⚠️ **限价入场走另一条路。**
     *
     * 市价那条路的核心是"下单 → 等成交 → 建仓"，三步连着做完；而限价入场
     * **下单之后就结束了** —— 单挂在交易所上等价格过来，这一轮**不建仓**。
     *
     * 它会在 `positions` 里留下一行 `status='pending'`（不是持仓，`open()` 看不到），
     * 由 `settlePendingEntries` 在后续周期里问交易所"成交了吗"，成交那一刻才
     * 转正并**立刻补挂保护单**。
     *
     * 这是整个限价入场机制里唯一有风险的地方：**从成交到挂上保护单之间有一个窗口**。
     * 所以转正与挂保护单必须在同一段代码里连着做（见 `settlePendingEntries`）。
     */
    if (decision.entryType === 'limit' && (decision.limitPrice ?? 0) > 0) {
      return this.submitLimitEntry(decision, snapshot, {
        traderId,
        symbol,
        side,
        quantity,
        price,
        clientOrderId,
      });
    }

    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **开仓【之前】确认止损还没失效**（2026-10-15 线上实测抓到）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：同一形状的浪费重复了 4 次
     *
     * 线上 `#11` 的日志（2026-10-14）：
     * ```
     *   QUSDT     止损 0.048537  vs 标记价 0.04901806  → 错误一侧 → 立即平仓
     *   TRUTHUSDT 止损 0.022545  vs 标记价 0.02180561  → 错误一侧 → 立即平仓
     *   BTWUSDT   止损 2.55126   vs 标记价 2.55684229  → 错误一侧 → 立即平仓
     *   WALUSDT   止损 0.051833  vs 标记价 0.05188987  → 错误一侧 → 立即平仓
     * ```
     * 四笔全是 **`净 +0.0000`** —— 也就是说：**付了一次往返手续费，什么都没得到**。
     *
     * ## 根因：价格在"决策 → 执行"之间穿越了止损位
     *
     * ```
     *   模型基于材料里的 current_price 算止损（那时是对的）
     *   → 决策 → 风控 → 执行 之间隔了几十秒到几分钟
     *   → 价格漂移 1.3–2.0%，而止损距离只 1.0%
     *   → 实际成交时，止损已经落在标记价的【另一侧】
     * ```
     *
     * ## 为什么现在的处置（开了再平）是次优的
     *
     * 现有逻辑（本文件下面那段）在**开仓之后**发现止损无效 → 立即市价平掉。
     * 那在那个时刻是**唯一诚实的选择**（不能留一个没有保护的杠杆仓位），
     * 但它有一个本可避免的代价：**白付一次往返手续费**。
     *
     * 而"止损已失效"这件事在**开仓之前就已经成立** —— 那时检查，
     * 结果是**这一单根本不该开**（论点已经死了）。
     *
     * ## 为什么这不违反 §4.2（不许放宽风控）
     *
     * ```
     *   ✗ 放宽：把止损挪到另一侧，好让这一单能挂上   ← 仍然禁止
     *   ✓ 收紧：发现论点已死，这一单【不开】         ← 本次做的
     * ```
     * **它只减少风险，从不增加。** 而且它减少的是"一次注定白花的往返手续费"。
     *
     * ## 只在"已经失效"时拦住，不做别的判断
     *
     * ⚠️ **不因为"价格偏离了"就拦**（那会变成"用一个我没被授权的滑点阈值
     * 去否决风控的裁决"）。判据只有一条，且它就是执行层后面用的那一条：
     * ```
     *   isValidTrigger(止损, 'STOP_MARKET', 平仓方向, 当前标记价) === false
     * ```
     * 也就是说：**同一个判据从"开了再平"提前到"根本不开"** ——
     * 判定逻辑一字不改，只改了发现它的时机。
     *
     * ⚠️ 读不到标记价时**放行**（`markNow <= 0` → 不拦）——
     * 与 `exchangeMaxLeverageOf` 读不到时退回旧行为同源：
     * **读不到某个事实，不该让功能停下来。**
     */
    if (decision.stopLoss && decision.stopLoss > 0) {
      const markBefore = await this.deps.broker.getMarkPrice(symbol).catch(() => 0);
      const exitSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      if (
        markBefore > 0 &&
        !this.deps.registry.isValidTrigger(decision.stopLoss, 'STOP_MARKET', exitSide, markBefore)
      ) {
        const detail =
          `开仓前止损已失效：触发价 ${decision.stopLoss} 位于当前标记价 ${markBefore} 的错误一侧` +
          '（挂上去会立即触发），说明这笔的入场论点在执行前已被市场否定，**本次不开仓**。' +
          '（这样比"开了再立刻平掉"少付一次往返手续费。）';
        this.emit('warn', `${symbol} ${detail}`);
        this.recordOrder({
          traderId,
          exchangeOrderId: null,
          clientOrderId,
          symbol,
          side,
          type: 'MARKET',
          purpose: 'entry',
          quantity,
          price: null,
          triggerPrice: null,
          status: 'REJECTED',
          avgPrice: null,
          filledQty: 0,
          error: detail,
        });
        return { action: decision.action, symbol, status: 'rejected', detail };
      }
    }

    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
        clientOrderId,
      });

      const filled = await this.deps.broker.waitForFill(placed);

      /*
       * ⚠️ **不能拿「请求的数量」冒充「成交的数量」。**
       *
       * 这里原来是 `filled.executedQty || quantity`：只要交易所没报成交
       * （超时、或那一刻 `executedQty` 还是 0），它就**回退成请求数量** ——
       * 于是一次**没有确认**的成交被记成了完全成交，而 `status` 字段留下交易所
       * 那一刻的 `NEW`。界面上一半读 `status`（"已挂单"）、一半读 `filled_qty`
       * （"已成交 0.009"），**两个互相矛盾的字段并存**。
       *
       * 平仓路径早就有这条纪律（`if (!(filledQty > 0))` 就不记账、留给对账），
       * 而开仓路径漏了 —— 同一条规则在一半代码里缺席，是这类 bug 最常见的形状。
       *
       * 现在的做法：**交易所说什么就是什么**。它报了 0 就按 0 记，并把这一笔
       * 标成失败交给对账；绝不用本地的意图去填补交易所的事实。
       */
      const filledQty = filled.executedQty;
      const entryPrice = filled.avgPrice || price;

      if (!(filledQty > 0)) {
        this.recordOrder({
          traderId,
          exchangeOrderId: filled.id,
          clientOrderId,
          symbol,
          side,
          type: 'MARKET',
          purpose: 'entry',
          quantity,
          price: null,
          triggerPrice: null,
          status: filled.status,
          avgPrice: null,
          filledQty: 0,
          raw: filled.raw,
        });
        this.emit(
          'warn',
          `${symbol} 的开仓单在 ${filled.status} 状态下没有确认成交，本次不建仓；下一轮对账会以交易所的实际持仓为准。`,
        );
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: `开仓单未确认成交（状态 ${filled.status}），未建仓，等待对账。`,
          orderId: filled.id,
        };
      }

      /*
       * ⚠️ **开仓手续费要自己查一次** —— 下单响应里没有它，而订单列表要显示、
       * 总账校验也要用它。见 `entryFeeFor` 的说明。
       */
      const entryFee = await this.entryFeeFor(symbol, filled.id);

      /*
       * 保证金在这一个地方算，两个消费者用它：这一行订单（订单记录里那一列）与
       * 下面 `openPosition.marginUsed`。两边各写一遍就是同一个金额有了两份公式。
       *
       * 用**成交价 × 成交数量**（不是请求里的意向数量）：账本只记交易所确认的事实，
       * 而 `filledQty > 0` 上面刚刚把没有确认成交的情形挡掉了。
       */
      const notional = filledQty * entryPrice;
      const margin = marginOf(entryPrice, filledQty, decision.leverage);

      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'entry',
        quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: entryPrice,
        filledQty,
        fee: entryFee,
        marginUsed: margin,
        raw: filled.raw,
      });

      /*
       * Record the position **before** protection is attempted.
       *
       * If the stop cannot be established, the position is immediately flattened,
       * and that flatten is a real account event that must be booked in `trades`
       * (§2.3). The booking path needs a local row to close, and — more
       * importantly — an unprotected position that exists at the exchange must
       * never be invisible to the local books: that is exactly the state in which
       * a stop-out would go unrecorded and the console would claim a PnL the
       * account does not have. Nothing here trades without the stop: the only
       * difference is that the row exists one step earlier.
       */
      const openPosition = {
        traderId,
        symbol,
        side: (isLong ? 'long' : 'short') as 'long' | 'short',
        quantity: filledQty,
        entryPrice,
        leverage: decision.leverage,
        liquidationPrice: null,
        marginUsed: margin,
        stopLoss: null as number | null,
        takeProfit: null as number | null,
        stopOrderId: null as string | null,
        tpOrderId: null as string | null,
        openReasoning: decision.reasoning,
        /*
         * **情报归因**（见 `db/schema.ts` M17）—— 归因链的中间一环。
         *
         * 与限价那条路径同一个字段、同一个来源（裁决官标注 + 已校验）。
         * **两条开仓路径都要写它** —— 否则市价开仓的成交会永远没有归因，
         * 而 `signalHealth` 会以为"这个消息面信号从没被用过"。
         */
        ...(decision.intelKeys !== undefined ? { intelKeys: decision.intelKeys } : {}),
        /*
         * ⚠️ **入场单号必须落在这里**（2026-10-03 实测抓到）。
         *
         * 这一行原来没有 `entryOrderId`，于是市价开的仓位在 `positions` 里
         * `entry_order_id` 是 NULL。而总账校验的"未平仓持有成本"恰恰是**按它**
         * 去 `orders.fee` 求和的（`openEntryCosts(traderId, entryOrderIds)`）——
         * 取不到 ⇒ 那一项恒为 0 ⇒ 「账目与交易所对不上」每轮报一次**假差额**。
         *
         * 实测现场：`#286`（ZECUSDT 市价空）`entry_order_id = NULL`，而它对应的
         * 订单 `#1010` 明明记着 `fee = 0.0393888` —— 而 `ledger_check` 的
         * `openEntryFees = 0`、`gap = 0.039389`，**与那笔手续费一字不差**。
         *
         * （限价单那条路径（`promotePendingEntry`）本来就有单号，所以这个洞只在
         * 市价开仓上；两处都写才是对的。）
         */
        entryOrderId: filled.id,
      };
      positionStore.insert(openPosition);

      /* --- Exchange-side protection ------------------------------------- */
      // Order matters: the stop goes on first and is verified. If protection
      // cannot be placed the position is closed immediately rather than left
      // naked — an unprotected leveraged position is the worst state to be in.
      const exitSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';

      /*
       * ⚠️ **挂这一批保护单之前，先撤掉该标的已有的条件单。**
       *
       * 币安不允许同一仓位存在两张条件单，而**最容易踩的形态是"上一张单已经过期了"**
       * —— 过期的 Algo 单在交易所那边仍然占着名额。实测三次完全相同的序列：
       * 开仓挂上保护单 → 交易所报 `EXPIRED` → 模型想移动保护位 → 重挂撞 `-4130`
       * → 判成"保护单缺失" → **把仓位提前平掉**（三次都恰好盈利，纯属运气）。
       *
       * 撤单必须在**这一批之前**、而不是在 `placeProtection` 内部：那一次调用
       * 要连着挂止损和止盈，在内部撤会把刚挂好的止损一起撤掉（实测报过
       * 「没有可触发的止损单」）。
       */
      await this.deps.broker.cancelAllOrders(symbol).catch((error) => {
        this.emit('warn', `${symbol} 挂保护单前撤旧单失败（不影响后续尝试）：${(error as Error).message}`);
      });

      let stopOrderId: string | null = null;
      let tpOrderId: string | null = null;
      let stopFailureDetail = '止损挂单失败，已立即平掉该仓位。';

      if (decision.stopLoss && decision.stopLoss > 0) {
        /*
         * A stop that sits on the *wrong* side of the current market is not a
         * stopped-out trade, it is a trade whose thesis died: the mark price
         * already crossed the level the risk engine approved. Binance rejects
         * such an order with `-2021 Order would immediately trigger`, and a
         * stop that triggers the instant it is placed protects nothing at all —
         * it is a market exit with extra steps.
         *
         * This is what the price drift between the risk engine's snapshot and
         * execution produces. `roundTriggerPrice` must not paper over it by
         * nudging the trigger to the other side of the market: that would silently
         * place a stop at a *different* level than the one the risk engine sized
         * the trade around, i.e. it would widen the stop to make the order
         * placeable. §4.2 forbids exactly that.
         *
         * So the answer is the honest one: the entry's thesis is already
         * invalidated, flatten it now. That is a loss either way — the price has
         * already moved through the stop — and paying one market exit is strictly
         * better than holding an unprotected leveraged position while pretending
         * a stop exists.
         */
        const markNow = await this.deps.broker.getMarkPrice(symbol).catch(() => 0);
        if (
          markNow > 0 &&
          !this.deps.registry.isValidTrigger(decision.stopLoss, 'STOP_MARKET', exitSide, markNow)
        ) {
          stopFailureDetail =
            `止损触发价 ${decision.stopLoss} 已位于当前标记价 ${markNow} 的错误一侧（挂上去会立即触发、等于没有保护），` +
            '入场逻辑已失效，已立即平掉该仓位。';
          this.emit('error', `${symbol} ${stopFailureDetail}`);
          this.recordOrder({
            traderId,
            exchangeOrderId: null,
            clientOrderId: makeClientId('stop_loss', symbol),
            symbol,
            side: exitSide,
            type: 'STOP_MARKET',
            purpose: 'stop_loss',
            quantity: filledQty,
            price: null,
            triggerPrice: decision.stopLoss,
            status: 'REJECTED',
            avgPrice: null,
            filledQty: 0,
            error: stopFailureDetail,
          });
        } else {
          stopOrderId = await this.placeProtection({
            symbol,
            side: exitSide,
            type: 'STOP_MARKET',
            triggerPrice: decision.stopLoss,
            purpose: 'stop_loss',
            traderId,
            quantity: filledQty,
          });
        }
      }

      if (!stopOrderId && this.activeConfig.riskControl.requireStopLoss) {
        this.emit(
          'error',
          `无法为 ${symbol} 挂上止损。为避免留下无保护的杠杆敞口，立即平掉该仓位。`,
        );
        /*
         * Every close must be booked, including this one.
         *
         * This path used to return straight after the flatten, so the exchange
         * held a complete entry+exit round-trip that the `trades` table never
         * saw: `reconcilePositions` could not recover it (the local position row
         * did not exist) and `reconstructRoundTrips` reports nothing for an
         * already-closed round-trip it was never told about. The platform's PnL
         * then read *better* than the account's — the exact divergence §2.3
         * exists to prevent.
         */
        const flatten = await this.emergencyFlatten(symbol, filledQty, exitSide, traderId);
        const localPosition = positionStore.getOpenBySymbol(traderId, symbol);
        if (localPosition && flatten) {
          await this.bookClosedPosition(
            localPosition,
            'protection_unavailable',
            flatten.avgPrice,
            flatten.fee,
            new Date().toISOString(),
          );
        } else if (localPosition) {
          /*
           * 平仓未获确认 —— **不记账**（见 `emergencyFlatten` 里的说明）。
           * 上一轮的账本是"漏记会在下一轮自己修好"，凭空记一笔不会。
           */
          this.emit(
            'warn',
            `${symbol} 的紧急平仓未获确认，本轮不记账（本地持仓保留），交给下一轮对账处理。`,
          );
        } else {
          // Cannot happen while the insert above succeeded, but a missing row
          // must be reported rather than silently swallowing the account event.
          this.emit(
            'error',
            `${symbol} 已紧急平仓，但本地找不到对应的持仓记录，这一笔无法入账。`,
          );
        }
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: stopFailureDetail,
        };
      }

      if (decision.takeProfit && decision.takeProfit > 0) {
        tpOrderId = await this.placeProtection({
          symbol,
          side: exitSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: decision.takeProfit,
          purpose: 'take_profit',
          traderId,
          quantity: filledQty,
        });
      }

      positionStore.setProtection(
        traderId,
        symbol,
        decision.stopLoss && decision.stopLoss > 0 ? decision.stopLoss : null,
        decision.takeProfit && decision.takeProfit > 0 ? decision.takeProfit : null,
        stopOrderId,
        tpOrderId,
      );

      tradeEvents.record(traderId, symbol, 'entry');

      this.emit(
        'info',
        `已开仓 ${symbol} ${isLong ? '多头' : '空头'} ${filledQty} @ ${entryPrice}（${decision.leverage}x，$${notional.toFixed(2)}）止损 ${decision.stopLoss ?? '无'} 止盈 ${decision.takeProfit ?? '无'}`,
      );

      const adjustments =
        decision.adjustments.length > 0 ? ` 运行时调整：${decision.adjustments.join(' ')}` : '';

      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `已开仓${isLong ? '多头' : '空头'} ${filledQty} @ ${entryPrice}。${adjustments}`,
        orderId: filled.id,
        notionalUsd: notional,
        ...(decision.adjustments.length > 0 ? { adjustments: decision.adjustments } : {}),
      };
    } catch (error) {
      this.recordOrder({
        traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'entry',
        quantity,
        price: null,
        triggerPrice: null,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Place a `closePosition=true` stop or target on the Algo Order API.
   *
   * `closePosition` is preferred over a sized `reduceOnly` order because it
   * always covers the full position however the size drifts, and cannot be left
   * behind as a partial residual. Binance forbids combining it with `quantity`,
   * which the broker strips automatically.
   */
  /**
   * 挂一张保护单（止损或止盈）。
   *
   * ## ⚠️ 调用方必须在**挂这一批之前**先撤掉该标的的旧条件单
   *
   * 币安不允许同一仓位存在两张条件单 —— 撞上就是 `-4130`（原文：「该仓位已有
   * 止损或止盈单，不能重复挂」）。而**最容易踩的形态是"上一张单已经过期了"**：
   * 实测三次完全相同的序列：
   *
   * ```
   * 06:22:17  stop_loss    EXPIRED   单号 3000002207017212   ← 交易所报"已过期"
   *    ...    （2 小时 52 分后，模型决定移动保护位）
   * 09:14:37  stop_loss    REJECTED  -4130「已有止损单」      ← 挂不上
   * 09:14:38  exit         FILLED                            ← 判"保护单缺失"→ 立即平仓
   * ```
   *
   * 也就是说：**过期的 Algo 单在交易所那边仍然占着那个名额**，而本地看它
   * `EXPIRED` 就以为可以挂新的了。于是连续三次"移动保护位"都变成**把仓位提前
   * 平掉**（三次都恰好是盈利的，纯属运气）。
   *
   * **但不能在这个函数里撤** —— 它被调用 8 次，而其中 4 次是"止损 + 止盈"
   * 成对出现的：在挂止盈时撤一次，会把**刚刚挂好的止损**一起撤掉。实测这么写过
   * 一次，测试立刻报「没有可触发的止损单」。撤单属于**批次**，不属于单张。
   *
   * `replaceProtection` 那条路径（保本止损）一直是"先撤旧、再挂新"，
   * 开仓路径与另外两处漏了 —— 撤单加在它们的**第一张之前**。
   */
  private async placeProtection(input: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    purpose: 'stop_loss' | 'take_profit';
    traderId: number;
    quantity: number;
    /**
     * 挂失败时把**原因**交回调用方。
     *
     * ⚠️ 这个方法**自己吞掉异常**（它要记一行 `REJECTED` 的订单、并让"止盈失败不
     * 影响止损"成立），所以调用方的 `.catch()` **永远收不到** ——
     * 实测 2026-09-27 ETHUSDT：交易所明确回了
     * `-4509 Time in Force (TIF) GTE can only be used with open positions`，
     * 而界面上写的是「**没有挂单尝试**」（`failed` 数组是空的）。
     * 一句把"可诊断"变成"不可诊断"的话。
     */
    onFailure?: (reason: string) => void;
  }): Promise<string | null> {
    /*
     * ⚠️ **挂之前先撤掉同类的旧单 —— 不变量放在最底层，调用点就不可能漏。**
     *
     * ## 为什么搬到这里（2026-10-02 用户报告 + 实测）
     *
     * 用户看到「当前委托」里有 **3 组重复的止盈/止损**（ETHUSDT 上
     * 3 张 STOP_MARKET + 3 张 TAKE_PROFIT_MARKET，分别来自
     * 23:32:42 / 23:32:57 / 23:36:07）。
     *
     * 根因是**"先撤旧的"这个不变量散落在各调用点**：本文件里
     * `placeProtection` 有 6 处调用，而"先撤"只写在其中一两处。
     * 我下午修 `replaceProtection` 时补了它，却没覆盖开仓路径与另外几处 ——
     * 于是重复照旧累积。**把不变量写在最底层是唯一不会漏的位置。**
     *
     * ## 为什么按 `purpose` 只撤同类（否则会踩下面那个坑）
     *
     * 这段注释的上文记着一个实测教训：**在这个函数里无差别撤单会毁掉刚挂好的单** ——
     * "止损 + 止盈"是成对出现的，挂止盈时撤一次会把刚挂的止损一起撤掉
     * （测试当场报过「没有可触发的止损单」）。
     *
     * 解法不是"不在这里撤"，而是**按 purpose 精确撤**：
     *
     *   · 挂 `stop_loss`   → 只撤旧的 `stop_loss`（不碰止盈）
     *   · 挂 `take_profit` → 只撤旧的 `take_profit`（不碰止损）
     *
     * 两者互不干扰，成对挂单时各自替换自己那一张。
     *
     * ## 代价
     *
     * 每次挂单前多两次只读查询（`getOpenOrders` + `getOpenAlgoOrders`），
     * 以及若干撤单请求。**相对"账户上挂着一堆重复止损"这个后果，那是值得的** ——
     * 重复止损里价位更差的那张会先触发，于是"上移止损"根本没有生效。
     */
    const isStop = input.purpose === 'stop_loss';
    await this.cancelAllProtection(input.symbol, { stop: isStop, target: !isStop });

    const clientOrderId = makeClientId(input.purpose, input.symbol);
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        triggerPrice: input.triggerPrice,
        closePosition: true,
        workingType: 'MARK_PRICE',
        /*
         * ⚠️ 由策略配置决定 —— **默认关掉**（`priceProtectOnStop: false`）。
         *
         * 原来这里写死 `true`。官方语义是"双价差超过阈值时**本次触发受保护**"，
         * 也就是**极端行情里止损不会触发**。对保证金账户那个取舍是反的：
         * 影线打掉止损只是少赚一次，**止损不生效可能亏掉保证金**。
         * 见 `StrategyConfigSchema.priceProtectOnStop` 的完整说明。
         */
        priceProtect: this.activeConfig.riskControl.priceProtectOnStop,
        clientOrderId,
      });

      this.recordOrder({
        traderId: input.traderId,
        exchangeOrderId: placed.id,
        clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: null,
        triggerPrice: input.triggerPrice,
        status: placed.status,
        avgPrice: null,
        filledQty: 0,
        raw: placed.raw,
      });

      return placed.id;
    } catch (error) {
      const reason = (error as Error).message;
      this.emit(
        'error',
        `为 ${input.symbol} 挂 ${input.purpose === 'stop_loss' ? '止损' : '止盈'}（触发价 ${input.triggerPrice}）失败：${reason}`,
      );
      /* 把原因交回调用方 —— 界面要显示它，而不是"没有挂单尝试"。 */
      input.onFailure?.(reason);
      this.recordOrder({
        traderId: input.traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: null,
        triggerPrice: input.triggerPrice,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Last-resort market exit used when protection could not be established.
   *
   * Returns what the exchange confirmed — or `null` when the flatten itself
   * failed, in which case the caller must still book the entry, because the
   * position may well exist at the exchange unprotected.

  /* ---------------------------------------------------------------------- */
  /*  加仓 / 减仓                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * 加仓：在一个已有持仓上再买一部分。
   *
   * ## 三个必须做对的地方
   *
   * 1. **均价要重算成加权平均** —— `(旧均价×旧数量 + 新价×新数量) / 总数量`。
   *    只改数量的话，平仓时的盈亏算错，而那个数字会成为永久的账面记录。
   * 2. **保护单要按新数量重挂。** 原来的止损单只覆盖旧数量 ——
   *    加仓之后**多出来的那部分是裸的**。这是加仓最危险的一步：
   *    敞口变大而保护没跟上。
   * 3. 顺序照 §2.7：**先撤旧单，再按新数量挂新单**（币安不允许两张条件单并存）。
   */
  private async executeAdd(decision: Decision): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const local = positionStore.getOpenBySymbol(traderId, decision.symbol);
    if (!local) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `${decision.symbol} 没有持仓，不能加仓。`,
      };
    }

    const mark = await this.deps.broker.getMarkPrice(decision.symbol).catch(() => 0);
    const price = mark > 0 ? mark : local.entry_price;
    if (!(price > 0)) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `${decision.symbol} 拿不到价格，无法加仓。`,
      };
    }

    const addQty = this.deps.registry.notionalToQuantity(
      decision.symbol,
      decision.positionSizeUsd,
      price,
    );
    if (!(addQty > 0)) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'skipped',
        detail: `拟加仓名义 $${decision.positionSizeUsd.toFixed(2)} 按步长取整后为 0，没有可下数量。`,
      };
    }

    /* ① 先撤旧保护单 —— 它们只覆盖旧数量。 */
    /*
     * ⚠️ **撤不掉就不要往下走。**
     *
     * `cancelAllOrders()` 的失败形态是**抛错**（它内部把 `-2011`「单子已经不在交易所了」
     * 当成功，其余失败一律抛）。这里原来写的是 `.catch(() => undefined)` ——
     * **把失败整个吞掉，然后照样加仓**：
     *
     *   · 旧止损单还在，而它覆盖的是**加仓前**的数量 → 加完之后多出来的那部分
     *     **没有任何保护**（§2.6 最糟的形状之一）；
     *   · 接着按新数量重挂保护单，必然吃 `-4130`（同一仓位不允许重复挂条件单）。
     *
     * `executeAdjust()` 里早就是显式判断了 —— 这与它是**同一条纪律**：
     * 适配层用"返回值 / 异常"表达失败，调用方必须**看得见**它。
     */
    try {
      await this.deps.broker.cancelAllOrders(decision.symbol);
    } catch (error) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail:
          `撤不掉现有的保护单（${(error as Error).message}）—— 已放弃本次加仓：` +
          '旧保护单只覆盖加仓前的数量，带着它加仓会让多出来的那部分没有保护。',
      };
    }

    /* ② 市价买入/卖出这一部分。 */
    const side: 'BUY' | 'SELL' = local.side === 'long' ? 'BUY' : 'SELL';
    const clientOrderId = makeClientId('add', decision.symbol);
    let filledId = '';
    let fillPrice = price;
    /*
     * ⚠️ **只用交易所报的成交量，不用我们请求的数量。**
     *
     * 这一段原来是 `filled.avgPrice` 取了、`executedQty` 没取，然后拿**请求量**
     * `addQty` 去累加本地持仓与加权均价。开仓/平仓路径早就改成"只看 `executedQty`，
     * 等于 0 就不建仓"了，**这两条（加仓/减仓）没跟上**。
     *
     * 后果在**部分成交**时出现：请求 0.02、实际成交 0.012，本地却按 0.02 记 ——
     * 持仓数量与均价一起偏离，而账目之后只会离得更远。
     */
    let filledAddQty = 0;
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol: decision.symbol,
        side,
        type: 'MARKET',
        quantity: addQty,
        clientOrderId,
      });
      const filled = await this.deps.broker.waitForFill(placed);
      filledId = filled.id;
      fillPrice = Number(filled.avgPrice) || price;
      filledAddQty = filled.executedQty;
      /*
       * 没确认成交就**不加仓** —— 与开仓路径同一条口径（`filled.executedQty` 为 0
       * 时不建仓）。旧保护单已经撤了，所以要先把它补回来（§2.6：不留裸仓）。
       */
      if (!(filledAddQty > 0)) {
        await this.restoreProtection(local, traderId, decision.symbol);
        return {
          action: decision.action,
          symbol: decision.symbol,
          status: 'failed',
          detail: `加仓单在 ${filled.status} 状态下没有确认成交，本次不加仓；下一轮对账会以交易所的实际持仓为准。`,
        };
      }
    } catch (error) {
      /*
       * 加仓失败时**旧保护单已经撤了** —— 仓位此刻是裸的。
       * 按 §2.6：立刻把它补回来，而不是留一个没有止损的敞口。
       */
      await this.restoreProtection(local, traderId, decision.symbol);
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `加仓下单失败（${(error as Error).message}），已尝试恢复原有保护。`,
      };
    }

    const newQty = local.quantity + filledAddQty;
    const newEntry = (local.entry_price * local.quantity + fillPrice * filledAddQty) / newQty;

    /*
     * ⚠️ **加仓也是一笔真实订单，必须进订单表。**
     *
     * 这一段原来什么都不记：下单、等成交、改本地持仓、写节流事件 —— 唯独没有
     * `recordOrder`。后果是**订单列表里永远看不到加仓单**，而它是一笔真实的成交、
     * 有真实的手续费，操作员在「当前委托 / 历史委托」里核对时会对不上账。
     *
     * 与开仓同一处口径：手续费要另外查成交明细（下单响应里没有）。
     */
    const addFee = await this.entryFeeFor(decision.symbol, filledId);
    /*
     * 这一笔加仓**自己**占用的保证金（与开仓同一口径：成交价 × 成交数量 ÷ 杠杆，
     * 用 `local.leverage` —— 加仓不改杠杆）。不是加完之后整个持仓的保证金：
     * 订单记录里每一行说的是**这一张单**，几张单各自的数加起来才是持仓那一行。
     */
    const addMargin = marginOf(fillPrice, filledAddQty, local.leverage);
    this.recordOrder({
      traderId,
      exchangeOrderId: filledId,
      clientOrderId,
      symbol: decision.symbol,
      side,
      type: 'MARKET',
      purpose: 'entry',
      quantity: filledAddQty,
      price: null,
      triggerPrice: null,
      status: 'FILLED',
      avgPrice: fillPrice,
      filledQty: filledAddQty,
      fee: addFee,
      marginUsed: addMargin,
    });

    /* ③ 更新本地持仓：数量与**加权均价**一起改。 */
    positionStore.resize(traderId, decision.symbol, {
      quantity: newQty,
      entryPrice: newEntry,
      marginUsed: (newQty * newEntry) / Math.max(local.leverage, 1),
    });

    /*
     * ⚠️ **加仓也要写"入场事件"。**
     *
     * 小时节流（`throttle.maxEntriesPerHour`）是从 `trade_events` 里数 `entry` 的
     * （`tradeEvents.entriesThisHour()`，见 `runCycle` 里读 `entriesLastHour` 那行）。
     * 原来只有 `executeOpen` 写它，加仓不写 —— 于是"每小时最多 N 笔"对加仓
     * **完全无效**：模型可以在一小时里加十几次仓，而计数一直是 0。
     *
     * 同一件事的另一半是 `reviewAdd` 拿不到滚动的周期计数（已另修）。两处合起来，
     * 节流对加仓才真的成立 —— 而提示词一直告诉模型「加仓与新开仓共用同一批上限」。
     *
     * 加仓就是一笔新的入场：它让敞口变大，就该占这个额度。
     */
    tradeEvents.record(traderId, decision.symbol, 'entry');

    /*
     * ④ 按新数量重挂保护 —— 用模型给的新价位（如果给了），否则沿用旧的。
     *
     * ⚠️ **"本地没有止损"必须在这里补上，不能让它变成"挂单失败"。**
     *
     * 收养进来的外部持仓，本地记录里 `stop_loss` 是 `null`（收养时不补挂 ——
     * 见 `positionStore.insert` 那段）。而一次加仓会把本地值原样传下去：
     *
     *     stop: decision.stopLoss ?? local.stop_loss      → null
     *
     * `replaceProtection` 只在 `stop > 0` 时才真的去挂单，于是 `stopPlaced`
     * 为 false —— 而调用方的判据是「加仓成功但保护挂不上」，按 §2.6
     * **把整个仓位市价平掉**。
     *
     * 结果是：一个正常持有中的仓位，**因为一条合规的加仓指令被全平**。
     * 而提示词还告诉模型「保护单会按新数量自动重挂，你不需要操心这两件事」——
     * 照做的模型根本不会在加仓里再给一次止损。
     *
     * 所以缺止损时按**与新开仓完全相同的兜底比例**补一个：`§2.6` 要的是
     * "不能有裸的杠杆敞口"，而平掉整个仓位是那条规则为"**挂单真的失败**"
     * 准备的处置 —— 两件事不该共用一条路径。
     */
    let stopForProtection = decision.stopLoss ?? local.stop_loss;
    if (stopForProtection === null || !(stopForProtection > 0)) {
      const fallbackPercent = this.activeConfig.riskControl.fallbackStopLossPercent;
      const distance = fillPrice * (fallbackPercent / 100);
      stopForProtection = local.side === 'long' ? fillPrice - distance : fillPrice + distance;
      this.emit(
        'warn',
        `${decision.symbol} 加仓时本地没有止损记录（可能是收养的仓位），已按兜底比例 ${fallbackPercent}% 补挂 ${stopForProtection.toFixed(6)} —— 请按你自己的失效位调一次。`,
      );
    }

    const protection = await this.replaceProtection({
      symbol: decision.symbol,
      side: local.side === 'long' ? 'long' : 'short',
      quantity: newQty,
      stop: stopForProtection,
      target: decision.takeProfit ?? local.take_profit,
      traderId,
    });

    if (!protection.stopPlaced) {
      /*
       * 加仓成功但保护挂不上 —— 敞口变大了却没有止损。
       * 按 §2.6 平掉**整个仓位**（不是只平掉刚加的那部分：
       * 原来那部分此刻也没有保护了）。
       */
      await this.flattenAndBook(decision.symbol, newQty, local.side === 'long' ? 'long' : 'short', traderId, fillPrice);
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `加仓后保护单挂不上（${protection.failures.join('；') || '原因未知'}），已按 §2.6 立即平掉整个仓位。`,
      };
    }

    return {
      action: decision.action,
      symbol: decision.symbol,
      status: 'ok',
      detail:
        `加仓 ${addQty} @ ${fillPrice}，均价 ${local.entry_price} → ${newEntry}，` +
        `总数量 ${newQty}，保护单已按新数量重挂。`,
    };
  }

  /**
   * 减仓：平掉一个已有持仓的一部分。
   *
   * ## 记账是这个方法里唯一复杂的地方
   *
   * 卖掉的那一部分必须**当场记账**（交易所已经实现了盈亏）。
   * 而仓位最终平掉时 `findRoundTrip()` 会把整段往返再算一遍 ——
   * 所以这里把已记的部分写进 `positions.realized_partial_pnl` /
   * `booked_partial_qty`，最终平仓时减掉（迁移 M8）。
   *
   * ## 均价不变
   *
   * 卖掉一部分不改变剩余部分当初的买入价 —— 那正是"加权平均"的含义。
   * 改它会让剩余部分的盈亏算错。
   */
  private async executeReduce(decision: Decision): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const local = positionStore.getOpenBySymbol(traderId, decision.symbol);
    if (!local) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `${decision.symbol} 没有持仓，无法减仓。`,
      };
    }

    const mark = await this.deps.broker.getMarkPrice(decision.symbol).catch(() => 0);
    const refPrice = mark > 0 ? mark : local.entry_price;

    const reduceQty = this.deps.registry.notionalToQuantity(
      decision.symbol,
      decision.positionSizeUsd,
      refPrice > 0 ? refPrice : local.entry_price,
    );
    if (!(reduceQty > 0) || reduceQty >= local.quantity) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'skipped',
        detail: `拟减数量 ${reduceQty} 不合法（持仓 ${local.quantity}）—— 要全部平掉请用 close_${local.side}。`,
      };
    }

    /* ① 先撤保护单：它们覆盖的是全部数量。 */
    /*
     * ⚠️ **撤不掉就不要往下走** —— 与加仓那一处同一条纪律（见上面的长注释）。
     *
     * 减仓这条的后果稍有不同：旧保护单覆盖的是**全部**数量，减完之后仓位变小，
     * 那张单的 `closePosition` 语义还成立（它平的是当前持仓）—— 但紧接着按
     * **剩余数量**重挂保护单会吃 `-4130`，那条路会走到 §2.6「没有有效止损 → 立刻平仓」，
     * 把一笔本来有保护的仓位平掉。所以失败时**什么都不做**最安全。
     */
    try {
      await this.deps.broker.cancelAllOrders(decision.symbol);
    } catch (error) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail:
          `撤不掉现有的保护单（${(error as Error).message}）—— 已放弃本次减仓：` +
          '带着旧保护单重挂会吃 -4130，进而被误判成"没有有效止损"而平掉整个仓位。',
      };
    }

    /* ② reduceOnly 市价平掉这一部分。 */
    const side: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';
    const clientOrderId = makeClientId('reduce', decision.symbol);
    let filledId = '';
    let exitPrice = refPrice;
    /*
     * ⚠️ **与加仓同一处口径：只看交易所报的成交量。**
     *
     * 这一段原来和加仓一样 —— `avgPrice` 取了、`executedQty` 没取，后面 6 处
     * （毛盈亏、订单记录、成交记录、剩余持仓、已实现盈亏累计）**全用请求量**。
     * 部分成交时那 6 个数字会一起偏离，而账目之后只会离得更远。
     */
    let filledReduceQty = 0;
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol: decision.symbol,
        side,
        type: 'MARKET',
        quantity: reduceQty,
        reduceOnly: true,
        clientOrderId,
      });
      const filled = await this.deps.broker.waitForFill(placed);
      filledId = filled.id;
      exitPrice = Number(filled.avgPrice) || refPrice;
      filledReduceQty = filled.executedQty;
      if (!(filledReduceQty > 0)) {
        await this.restoreProtection(local, traderId, decision.symbol);
        return {
          action: decision.action,
          symbol: decision.symbol,
          status: 'failed',
          detail: `减仓单在 ${filled.status} 状态下没有确认成交，本次不减仓；下一轮对账会以交易所的实际持仓为准。`,
        };
      }
    } catch (error) {
      await this.restoreProtection(local, traderId, decision.symbol);
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `减仓下单失败（${(error as Error).message}），已尝试恢复原有保护。`,
      };
    }

    const isLong = local.side === 'long';
    const grossPnl =
      (isLong ? exitPrice - local.entry_price : local.entry_price - exitPrice) * filledReduceQty;
    let exitFee = 0;
    try {
      const fills = await this.deps.broker.getUserTrades(decision.symbol, 10);
      exitFee = fills
        .filter((f) => String(f.orderId) === filledId)
        .reduce((sum, f) => sum + (Number(f.commission) || 0), 0);
    } catch {
      /* 拿不到手续费就记 0，对账会补 */
    }

    /*
     * ⚠️ **减仓同样是一笔真实订单，必须进订单表。**
     *
     * 与 `executeAdd` 同一个缺口：下单、算手续费、写成交表、改持仓 —— 唯独没有
     * `recordOrder`，于是「当前委托 / 历史委托」里永远看不到这一笔。
     * 操作员拿订单列表与交易所核对时会对不上。
     *
     * 用途是 `exit`（平掉一部分），所以它进「历史委托」的"平仓"这一类。
     */
    this.recordOrder({
      traderId,
      exchangeOrderId: filledId,
      clientOrderId,
      symbol: decision.symbol,
      side,
      type: 'MARKET',
      purpose: 'exit',
      quantity: filledReduceQty,
      price: null,
      triggerPrice: null,
      status: 'FILLED',
      avgPrice: exitPrice,
      filledQty: filledReduceQty,
      fee: exitFee,
    });

    /*
     * ③ 当场记这一笔部分平仓。
     *
     * 走 `tradeStore.insert` —— **那是唯一算净额的地方**（§2.3）。
     * 不自己拼一个 insert：账目只能有一个计算点。
     *
     * `idempotent: false`：这不是"一个仓位的最终成交"，
     * 它没有可与交易所对齐的整段往返身份，也不该被重建逻辑覆盖。
     */
    /*
     * ⚠️ 这是**这一笔平仓自己**的净额（毛 − 平仓费），**不含开仓费** ——
     * 开仓费在开仓那一刻就作为持仓成本付掉了，它不重复计在这一笔上。
     *
     * 所以日志里不要把它写成光秃秃的「净 X USDT」（那会让人以为已扣开仓费，
     * 和账户对上时会发现差一点点）。这里明确标成"本笔平仓净额"。
     */
    const netPnl = grossPnl - exitFee;
    tradeStore.insert({
      traderId,
      symbol: decision.symbol,
      side: local.side === 'long' ? 'long' : 'short',
      quantity: filledReduceQty,
      entryPrice: local.entry_price,
      exitPrice,
      leverage: local.leverage,
      grossPnl,
      entryFee: 0,
      exitFee,
      fundingFee: 0,
      closeReason: 'manual_partial',
      openedAt: local.opened_at,
      closedAt: new Date().toISOString(),
      source: 'bot',
      entryOrderId: null,
      exitOrderId: filledId,
      idempotent: false,
    });

    /* ④ 更新持仓：数量减、**均价不变**、已记部分累加。 */
    const remaining = local.quantity - filledReduceQty;
    positionStore.resize(traderId, decision.symbol, {
      quantity: remaining,
      entryPrice: local.entry_price,
      marginUsed: (remaining * local.entry_price) / Math.max(local.leverage, 1),
      /*
       * ⚠️ **累计的是毛盈亏，不是净。**
       *
       * 最终平仓时会用它去减交易所重建的**整段毛盈亏**（见 `bookClose` 的
       * `grossRaw - partialGross`）—— 那里扣的必须是同一口径。这里若记净额，
       * 最终的毛盈亏会凭空多出这一部分的平仓手续费（`G − (g − xf)` 而非 `G − g`），
       * 而手续费那一侧还会再算一遍，账目因此偏高。
       */
      addRealizedPartialPnl: grossPnl,
      addBookedPartialQty: filledReduceQty,
    });

    /*
     * ⑤ 按剩余数量重挂保护。
     *
     * ⚠️ 与加仓同一处陷阱：收养进来的持仓本地 `stop_loss` 是 `null`，
     * 原样传下去会让 `stopPlaced` 为 false —— 而调用方按 §2.6 把**剩余部分
     * 全部平掉**。一笔合规的减仓指令因此把仓位清空。
     *
     * 减仓让敞口变小，用"平掉剩余"来处置"本地缺一条止损记录"就更过头了：
     * 那条规则是为「保护单**真的挂不上**」准备的。缺记录时按兜底比例补一个。
     */
    let stopForProtection = decision.stopLoss ?? local.stop_loss;
    if (stopForProtection === null || !(stopForProtection > 0)) {
      const fallbackPercent = this.activeConfig.riskControl.fallbackStopLossPercent;
      const distance = exitPrice * (fallbackPercent / 100);
      stopForProtection = local.side === 'long' ? exitPrice - distance : exitPrice + distance;
      this.emit(
        'warn',
        `${decision.symbol} 减仓时本地没有止损记录（可能是收养的仓位），已按兜底比例 ${fallbackPercent}% 补挂 ${stopForProtection.toFixed(6)} —— 请按你自己的失效位调一次。`,
      );
    }

    const protection = await this.replaceProtection({
      symbol: decision.symbol,
      side: isLong ? 'long' : 'short',
      quantity: remaining,
      stop: stopForProtection,
      target: decision.takeProfit ?? local.take_profit,
      traderId,
    });

    if (!protection.stopPlaced) {
      await this.flattenAndBook(decision.symbol, remaining, local.side === 'long' ? 'long' : 'short', traderId, exitPrice);
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `减仓 ${reduceQty} 已成交，但剩余部分的保护单挂不上（${protection.failures.join('；') || '原因未知'}），已按 §2.6 平掉剩余 ${remaining}。`,
      };
    }

    return {
      action: decision.action,
      symbol: decision.symbol,
      status: 'ok',
      detail:
        `减仓 ${reduceQty} @ ${exitPrice}，本笔平仓净 ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT（不含开仓费），` +
        `剩余 ${remaining}，保护单已按剩余数量重挂。`,
    };
  }

  /**
   * 按给定数量重挂保护单（**先撤后挂由调用方完成**）。
   *
   * 返回止损有没有挂上 —— **那一个是"仓位是否受保护"的判据**。
   * 止盈挂了更好，没挂不构成"裸仓"。
   */
  private async replaceProtection(input: {
    symbol: string;
    side: 'long' | 'short';
    quantity: number;
    stop: number | null;
    target: number | null;
    traderId: number;
  }): Promise<{ stopPlaced: boolean; targetPlaced: boolean; failures: string[] }> {
    const exitSide: 'BUY' | 'SELL' = input.side === 'long' ? 'SELL' : 'BUY';
    let stopOrderId: string | null = null;
    let tpOrderId: string | null = null;
    /** 挂单失败的原因。**必须带回去** —— 见下面的说明。 */
    const failures: string[] = [];

    /*
     * ⚠️ **先把这个标的的旧保护单撤干净，再挂新的。**
     *
     * ## 这个函数叫 `replaceProtection`，但原来只做了"挂"、没有"替代"
     *
     * 实测（2026-10-02）：HYPEUSDT 持仓上**同时有两张 STOP_MARKET 存活** ——
     * `#788` 是上移止损时挂的、`#790` 是缺失检测时挂的，而 `positionStore`
     * 只记得其中一张。历史上 LTCUSDT 在同一时刻挂过 4 张。
     *
     * 因为 `placeProtection` 传的是 `closePosition: true`，多余的止损**不会**
     * 反手开仓（第一张平掉仓位后第二张无仓可平）—— 所以这不是致命风险，
     * 但有三个真实代价：
     *
     *   1. 本地账目与交易所长期不一致（日志里"对账结清了 3 张…"就是它）；
     *   2. 占用交易所的挂单额度；
     *   3. **上移止损时新旧并存** —— 旧的那张（更差的价位）可能先被触发，
     *      于是"止损上移"这件事在有重复单时是**没有生效**的。
     *
     * ## 为什么撤"全部"而不是"DB 里记的那一张"
     *
     * `positionStore` 只保存最后一次的 `stop_order_id`。上移过 N 次止损就会
     * 留下 N-1 张**不在 DB 里、却在交易所侧仍然有效**的孤儿单。只撤 DB 里
     * 那个 id 根本撤不干净 —— 那正是上面 `#788` 的来历。
     *
     * 撤单失败**不阻断**：撤不掉的通常已经成交或过期，那时挂新单是对的。
     *
     * ⚠️ **"撤旧的"现在由 `placeProtection` 自己做（按 purpose 撤同类）** ——
     * 这个不变量放在最底层，调用点就不可能漏。见那里的完整说明：
     * 用户实测到 ETHUSDT 上堆了 **3 组**重复止盈/止损，根因正是
     * "先撤"散落在 6 个调用点里、只覆盖了一两处。
     */
    if (input.stop !== null && input.stop > 0) {
      stopOrderId = await this.placeProtection({
        symbol: input.symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        triggerPrice: input.stop,
        purpose: 'stop_loss',
        traderId: input.traderId,
        quantity: input.quantity,
        /* 原因要带回去，见 `onFailure` 的说明。 */
        onFailure: (reason) => failures.push(`止损：${reason}`),
      }).catch((error) => {
        failures.push(`止损：${(error as Error).message}`);
        return null;
      });
    }
    if (input.target !== null && input.target > 0) {
      tpOrderId = await this.placeProtection({
        symbol: input.symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: input.target,
        purpose: 'take_profit',
        traderId: input.traderId,
        quantity: input.quantity,
        onFailure: (reason) => failures.push(`止盈：${reason}`),
      }).catch((error) => {
        failures.push(`止盈：${(error as Error).message}`);
        return null;
      });
    }

    positionStore.setProtection(
      input.traderId,
      input.symbol,
      input.stop,
      input.target,
      stopOrderId,
      tpOrderId,
    );

    return {
      stopPlaced: Boolean(stopOrderId),
      targetPlaced: Boolean(tpOrderId),
      failures,
    };
  }

  /** 用**本地记录里的价位**恢复保护（撤单之后下单失败时用）。 */
  private async restoreProtection(
    local: {
      symbol: string;
      side: string;
      quantity: number;
      stop_loss: number | null;
      take_profit: number | null;
    },
    traderId: number,
    symbol: string,
  ): Promise<void> {
    await this.replaceProtection({
      symbol,
      side: local.side === 'long' ? 'long' : 'short',
      quantity: local.quantity,
      stop: local.stop_loss,
      target: local.take_profit,
      traderId,
    }).catch((error) => {
      this.emit(
        'error',
        `${symbol} 恢复保护单失败（${(error as Error).message}）—— 该仓位目前可能没有止损，请检查。`,
      );
    });
  }

  /** 平掉整个仓位并记账（§2.6：不留无保护敞口）。 */
  private async flattenAndBook(
    symbol: string,
    quantity: number,
    side: 'long' | 'short',
    traderId: number,
    fallbackPrice: number,
  ): Promise<void> {
    const exitSide: 'BUY' | 'SELL' = side === 'long' ? 'SELL' : 'BUY';
    const flatten = await this.emergencyFlatten(symbol, quantity, exitSide, traderId).catch(
      () => null,
    );
    const still = positionStore.getOpenBySymbol(traderId, symbol);
    if (still && flatten) {
      await this.bookClosedPosition(
        still,
        'protection_unavailable',
        flatten.avgPrice,
        flatten.fee,
        new Date().toISOString(),
      );
    } else if (still) {
      this.emit(
        'warn',
        `${symbol} 的紧急平仓未获确认，本轮不记账（本地持仓保留），交给下一轮对账处理。`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  调整保护位                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * 执行「调整保护位」：把已有的止损/止盈换成新的。
   *
   * ## 顺序不可颠倒，理由与保本止损那次完全相同
   *
   * **先撤旧单，再挂新单。**
   *
   * 币安不允许同一仓位存在两张条件单（实测吃 `-4130`）。
   * 我最早在保本止损里写的是"先挂新、再撤旧"，理由是"挂新失败时旧止损还在" ——
   * **那个推理漏了交易所的约束**，结果新止损每次都被拒、保本从未生效过。
   * 这里必须是同一个顺序。
   *
   * ## 撤旧成功、挂新失败 = 仓位裸着 → 立刻平掉（§2.6）
   *
   * 这是这一步唯一的危险时刻。一个没有止损的杠杆敞口是最糟的状态，
   * 宁可立刻退出也不留着它等下一轮 —— 与 `applyBreakevenGuard` 同一处理。
   */
  private async executeAdjust(decision: Decision): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const local = positionStore.getOpenBySymbol(traderId, decision.symbol);

    if (!local) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `${decision.symbol} 没有持仓，无法调整保护位。`,
      };
    }

    const newStop = decision.stopLoss;
    const newTarget = decision.takeProfit;

    if (newStop === null && newTarget === null) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'skipped',
        detail: '既没给止损也没给止盈，没有可执行的变化。',
      };
    }

    /*
     * ⚠️ **撤旧单、挂新单之前，先问一句：交易所侧还有这个仓位吗？**
     *
     * 2026-09-27 23:08 ETHUSDT 实测：那张平仓单其实已经成交，只是本地这一轮
     * 还没确认（`waitForFill` 超时 → 按 §2.6 的保守口径"不记账，等对账"），
     * 紧接着模型的执行回执要求调整保护位 —— 于是系统去挂一张 `closePosition`
     * 止损，币安回：
     *
     *     -4509 Time in Force (TIF) GTE can only be used with open positions
     *
     * 那句错误本身是**对的**（没有仓位当然挂不上）；错的是我们**没先问**。
     * 系统随后判"调整后没有有效止损"→ 按 §2.6 **尝试市价平仓** → 又吃
     * `-2022 ReduceOnly Order is rejected`（无仓可减）。界面上于是出现两条
     * 互相矛盾的失败提示，而真相只有一句：**仓位早就不在了。**
     *
     * 所以先读一次交易所持仓：没有就**什么都不做**（不撤单、不挂单、不平仓），
     * 把本地记录交给对账 —— 它会按交易所的实际持仓把这一回合正确结掉。
     */
    const livePositions = await this.effectivePositions(local.symbol).catch(() => null);
    if (livePositions !== null && livePositions.length === 0) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'skipped',
        detail:
          `${decision.symbol} 在交易所侧已经没有持仓（可能刚被平掉）—— ` +
          '不需要调整保护位，也**不会**留下无保护敞口；本地记录交给对账结清。',
      };
    }

    /*
     * ① 先撤旧单 —— 这一条不能颠倒。
     *
     * 🔴 **这里曾经写的是 `.catch(() => 继续挂新单)`，那是一个会平掉盈利仓位的 BUG。**
     *
     * 撤旧失败时旧单还在，此时去挂新单**必然吃 `-4130`**（币安不允许同一仓位
     * 存在两张条件单）→ `placeProtection` 返回 null → 下面的 `hasLiveStop` 判否
     * → 按 §2.6「无保护敞口立刻平仓」把仓位平掉。
     *
     * **实测代价**（2026-09-22 22:17:13 ADAUSDT）：模型只是想调止盈
     * （`0.259 → 0.271`），日志里先是一次 `algo STOP_MARKET`（挂新单），
     * 紧接着 ERROR「调整保护位后没有有效的止损」→ 市价平掉，净 `-0.0166`；
     * 而开仓才 0.5 分钟，**原来的止损单其实还好好挂在交易所上**。
     *
     * 同一个文件里的 `applyBreakevenGuard` 早就把这条写对了 ——
     * 「**撤不掉就不要挂新的**：那必然吃 `-4130`，只会多一条无用的拒绝记录」。
     * 两处要求的是同一条顺序，这里漏了。
     *
     * **为什么"放弃调整"是对的**：旧单撤不掉 = 仓位**仍然有保护**，
     * 这是比"撤了却挂不上"好得多的状态。调整保护位只是优化，不值得拿
     * 平仓去换。失败会如实回给模型（它能看到 detail），下一轮再试即可。
     */
    try {
      await this.deps.broker.cancelAllOrders(decision.symbol);
    } catch (error) {
      const why = (error as Error).message;
      this.emit(
        'warn',
        `${decision.symbol} 调整保护位时撤旧单失败（${why}）—— 旧保护单仍在，本次调整放弃，不动仓位。`,
      );
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail:
          `撤旧保护单失败，已放弃本次调整（${why}）。` +
          '原保护单仍然有效，仓位没有被裸奔 —— 所以这里不按 §2.6 平仓，下一轮可重试。',
      };
    }

    /* ② 挂新单。止损与止盈各自独立，一个失败不影响另一个。 */
    const exitSide: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';
    let stopOrderId: string | null = null;
    let tpOrderId: string | null = null;
    const placed: string[] = [];
    const failed: string[] = [];

    if (newStop !== null) {
      stopOrderId = await this.placeProtection({
        symbol: decision.symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        triggerPrice: newStop,
        purpose: 'stop_loss',
        traderId,
        quantity: local.quantity,
        /* 失败原因必须带进 `failed` —— 否则界面只会写"没有挂单尝试"。 */
        onFailure: (reason) => failed.push(`止损：${reason}`),
      }).catch((error) => {
        failed.push(`止损：${(error as Error).message}`);
        return null;
      });
      if (stopOrderId) placed.push(`止损 ${newStop}`);
    }

    if (newTarget !== null) {
      tpOrderId = await this.placeProtection({
        symbol: decision.symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: newTarget,
        purpose: 'take_profit',
        traderId,
        quantity: local.quantity,
        onFailure: (reason) => failed.push(`止盈：${reason}`),
      }).catch((error) => {
        failed.push(`止盈：${(error as Error).message}`);
        return null;
      });
      if (tpOrderId) placed.push(`止盈 ${newTarget}`);
    }

    /*
     * ③ 关键判断：这次调整之后，仓位**还有没有止损**？
     *
     * 用交易所的实际挂单判断，不用本地记录 —— 本地记录正是我们刚刚
     * 撤掉/重挂的那一份，它此刻不可能是权威。
     *
     * 只有"请求里带止损但没挂上"或"请求里没带止损而旧的被撤了"这两种情况
     * 会让仓位失去保护，而它们都落在这个判断里。
     */
    const survivingStop = newStop ?? local.stop_loss;
    const stillProtected =
      survivingStop !== null
        ? await this.hasLiveStop(decision.symbol, survivingStop)
        : await this.hasLiveStop(decision.symbol, null);

    if (!stillProtected) {
      this.emit(
        'error',
        `${decision.symbol} 调整保护位后没有有效的止损，为避免留下无保护的敞口，立即平仓。`,
      );
      const flatten = await this.emergencyFlatten(
        decision.symbol,
        local.quantity,
        exitSide,
        traderId,
      ).catch(() => null);
      const still = positionStore.getOpenBySymbol(traderId, decision.symbol);
      if (still && flatten) {
        await this.bookClosedPosition(
          still,
          'protection_unavailable',
          flatten.avgPrice,
          flatten.fee,
          new Date().toISOString(),
        );
      } else if (still) {
        this.emit(
          'warn',
          `${decision.symbol} 的紧急平仓未获确认，本轮不记账（本地持仓保留），交给下一轮对账处理。`,
        );
      }
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `新保护单没挂上（拟设止损=${String(newStop)}、止盈=${String(newTarget)}；${failed.join('、') || '没有挂单尝试'}），已按 §2.6 立即平仓，不留无保护敞口。`,
      };
    }

    /*
     * ④ 本地记录必须与交易所一致 —— 连**单号**一起更新。
     *
     * 只改价格是不够的：下一轮的保本守卫会拿 `local.stop_loss` 判断
     * "是否仍在亏损侧"，读到旧值的话它会以为还需要移，于是**每一轮都重复挂一张新止损**。
     * 保本止损那段注释里已经记过这个坑。
     */
    positionStore.setProtection(
      traderId,
      decision.symbol,
      newStop ?? local.stop_loss,
      newTarget ?? local.take_profit,
      stopOrderId ?? (newStop === null ? local.stop_order_id : null),
      tpOrderId ?? (newTarget === null ? local.tp_order_id : null),
    );

    if (failed.length > 0) {
      return {
        action: decision.action,
        symbol: decision.symbol,
        status: 'failed',
        detail: `${failed.join('、')} 没挂上（已挂：${placed.join('、')}）。`,
      };
    }

    return {
      action: decision.action,
      symbol: decision.symbol,
      status: 'ok',
      detail: `已调整保护位：${placed.join('、')}。`,
    };
  }

  /**
   * 该标的上现在有没有活的止损单。
   *
   * 用**交易所的实际挂单**而不是本地记录判断 —— 本地记录正是我们刚刚
   * 撤掉/重挂的那一份，它此刻不可能是权威。
   *
   * `expectedStop` 给定时要求价格吻合；给 null 时只要求"存在一张止损"。
   */
  private async hasLiveStop(symbol: string, expectedStop: number | null): Promise<boolean> {
    /*
     * ⚠️ **必须查条件单接口，不是普通挂单接口。**
     *
     * 第一版写的是 `broker.getOpenOrders(symbol)` 并找 `o.stopPrice` ——
     * **两处都错**：
     *
     *   · 止损/止盈是 `closePosition` 的**条件单**，币安把它们放在
     *     `openAlgoOrders`，而不是普通挂单接口
     *   · 那个接口里的字段是 `triggerPrice`，不是 `stopPrice`
     *
     * 于是这个函数**永远返回 false** —— 调用方每次都会误判"仓位裸着"
     * 并立刻平仓。**实测是在模拟回放里发现的：17 次调整保护位全部失败，
     * 而且每次都把仓位平掉。** 没跑模拟的话，这个缺陷会在实盘上
     * 把一笔本来安全的仓位平掉。
     */
    return this.deps.broker
      .getOpenAlgoOrders(symbol)
      .then((orders) =>
        orders.some((o) => {
          /* 只认止损那一类；止盈不算"有保护"。 */
          const kind = String((o as { orderType?: string }).orderType ?? '');
          if (!kind.includes('STOP')) return false;
          const trigger = Number((o as { triggerPrice?: string | number }).triggerPrice ?? 0);
          if (!(trigger > 0)) return false;
          if (expectedStop === null) return true;
          /*
           * ⚠️ **容差不能用 1e-9。**
           *
           * 下单时 `broker` 会把触发价**按 tickSize 取整** —— 传进去的
           * 75829.784 挂上去是 75829.78。所以"精确相等"永远匹配不上，
           * 而匹配不上就会被当成"没有止损"，进而把仓位平掉。
           *
           * 实测是在模拟回放里发现的：
           *   拟设止损=75829.784、止盈=91202.564；没有挂单尝试
           * 两个挂单都成功了，但这个比较说不匹配。
           *
           * 用相对容差（万分之五）而不是绝对容差：价格是 7 万还是 0.5，
           * tickSize 造成的那点偏差相对量级是一样的。
           */
          return Math.abs(trigger - expectedStop) <= Math.max(expectedStop * 5e-5, 1e-9);
        }),
      )
      .catch(() => false);
  }

  /* ---------------------------------------------------------------------- */

  /**
   * 操作员在控制台上手工平掉一个持仓。
   *
   * ## 为什么它必须随时可用
   *
   * 这里原本**没有**这个能力：控制台上的「平仓」按钮只弹一个说明弹窗，
   * 理由是"机器人自己在管理持仓，控制台不该和它抢"。
   *
   * **那个理由把"代码整洁"放在了"操作员对自己资金的控制权"前面。**
   * 一个止不住手的操作员是被困住的 —— 无论机器人当时在做什么，
   * **人都必须能立刻退出。这是最高权限，不该被任何设计考量限制。**
   *
   * ## 顺序不可颠倒（§2.7）
   *
   * **先撤该标的的全部挂单，再市价平仓。**
   *
   * 保护单是 `closePosition=true` 的条件单，**手动平仓后它会继续存活**，
   * 然后朝反方向开出一个新仓 —— 操作员以为自己平掉了，实际开了一个反向仓。
   * 这个坑在 `executeClose` 的注释里记着，这里必须重复一遍。
   *
   * ## 记账（§2.3）
   *
   * 平完必须走 `bookClosedPosition` —— 那是唯一算净额的地方。
   * 少记这一笔会让平台账面比账户好看，而那正是 §2.5 存在的理由。
   *
   * @returns 成交均价与手续费；没有本地持仓时返回 null
   */
  async closeManually(symbol: string): Promise<{ avgPrice: number; fee: number } | null> {
    const traderId = this.deps.trader.id;
    const local = positionStore.getOpenBySymbol(traderId, symbol);
    if (!local) return null;

    // ① 先撤单 —— 这一条不能颠倒，见上面的说明。
    await this.deps.broker.cancelAllOrders(symbol).catch((error) => {
      /*
       * 撤单失败**不阻断平仓**：一个撤不掉的保护单是麻烦，
       * 而一个平不掉的亏损仓位是危险。**两害相权，先平。**
       */
      this.emit(
        'warn',
        `${symbol} 手工平仓前撤单失败（${(error as Error).message}），仍然继续平仓。`,
      );
    });

    // ② 市价平仓。
    const exitSide: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';
    const flatten = await this.emergencyFlatten(symbol, local.quantity, exitSide, traderId);
    if (!flatten) {
      throw new Error(`${symbol} 手工平仓失败：交易所没有接受平仓单。`);
    }

    // ③ 记账 —— 唯一算净额的地方。
    const still = positionStore.getOpenBySymbol(traderId, symbol);
    if (still) {
      await this.bookClosedPosition(
        still,
        'manual',
        flatten.avgPrice,
        flatten.fee,
        new Date().toISOString(),
      );
    }

    this.emit('info', `操作员手工平仓 ${symbol} @ ${flatten.avgPrice}。`);
    return flatten;
  }

  private async emergencyFlatten(
    symbol: string,
    quantity: number,
    side: 'BUY' | 'SELL',
    traderId: number,
  ): Promise<{ avgPrice: number; fee: number } | null> {
    const clientOrderId = makeClientId('flatten', symbol);
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
        reduceOnly: true,
        clientOrderId,
      });
      const filled = await this.deps.broker.waitForFill(placed);

      /*
       * ⚠️ **"没成交"和"平掉了"是两句相反的话，这里必须挡住。**
       *
       * `waitForFill` 超时（默认 10s）后会返回**它最后一次轮询看到的东西** ——
       * 可能是一张仍然挂着的单、也可能是 `executedQty = 0`。原来的代码不看这个
       * 数字，照样返回 `{avgPrice, fee}`，而**5 处调用点都拿它当"已经平掉"的
       * 凭据**去 `bookClosedPosition()`：写一行 `trades` + `positionStore.close()`。
       *
       * 结果是 §2.6 那个最糟状态的镜像：**交易所上仓位还在、保护单已经被撤掉、
       * 而本地账本说已经平了** —— 机器人下一轮按"空仓"决策，敞口无人管。
       *
       * 对照：同文件 `executeClose` 有一整段注释写着「未确认的平仓绝不能记成
       * 完成的回合」，并在 `filledQty <= 0` 时拒记。**同一条纪律原来只在平仓
       * 路径实现了，而这里（保护单挂不上时的紧急退出）漏了。**
       *
       * 返回 `null` 让调用方**不记账**：漏记会在下一轮 `reconcilePositions` /
       * 对账里自己修好，而凭空记一笔会永久污染账本（§2.3）。
       */
      if (!(Number(filled.executedQty) > 0)) {
        this.emit(
          'error',
          `${symbol} 的紧急平仓没有被交易所确认成交（status=${filled.status}、executedQty=${filled.executedQty}）` +
            '—— 仓位可能仍然是开的，这一笔不记账，留给下一轮对账处理。需要人工确认交易所侧状态。',
        );
        return null;
      }

      /*
       * Commission is captured here too. This exit is a pure cost — the entry
       * and the exit both paid a fee — and reporting a net PnL that omits it
       * would make the platform's books read better than the account's (§2.5).
       */
      let fee = 0;
      try {
        const fills = await this.deps.broker.getUserTrades(symbol, 10);
        fee = fills
          .filter((fill) => String(fill.orderId) === filled.id)
          .reduce((sum, fill) => sum + (Number(fill.commission) || 0), 0);
      } catch {
        /* leave the fee at zero rather than fail the flatten */
      }

      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: filled.avgPrice,
        filledQty: filled.executedQty,
        fee,
        raw: filled.raw,
      });
      /*
       * 撤掉刚才那张仓位的残余挂单。**这一步失败不能翻转"已经平掉"这个结论** ——
       * 平仓单已经成交、账也已经记好了，只是还有一张挂单没撤干净。
       * （`cancelAllOrders` 的契约是"撤不掉就抛"，所以这里必须显式接住，
       * 否则异常会跑到外层 `catch`，让调用方以为平仓失败而拒绝记账。）
       */
      await this.deps.broker.cancelAllOrders(symbol).catch((error) => {
        this.emit(
          'warn',
          `${symbol} 已市价平掉，但残余挂单未能撤净（${(error as Error).message}）—— 需要留意交易所侧。`,
        );
      });
      this.emit('warn', `因保护单挂单失败，已市价平掉 ${symbol}。`);
      return { avgPrice: filled.avgPrice, fee };
    } catch (error) {
      this.emit(
        'error',
        `${symbol} 紧急平仓失败：${(error as Error).message}。需要人工介入。`,
      );
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private isInCooldown(symbol: string): boolean {
    const minutes = this.activeConfig.throttle.reentryCooldownMinutes;
    if (minutes <= 0) return false;
    const lastExit = tradeEvents.lastFor(this.deps.trader.id, symbol, 'exit');
    if (!lastExit) return false;
    return Date.now() - new Date(lastExit).getTime() < minutes * 60_000;
  }

  /**
   * 组装提示词里的「记忆」区块（提案 §2 的三块）。
   *
   * ## 为什么全部在 SQL 里做（§4 的 O(1)）
   *
   * 三块内容分别来自：一个**固定时间窗口**的聚合、**固定 5 笔**逐笔明细、以及计数与
   * 时间差。进提示词的只有这些结果，所以提示词大小与 `trades` 里有多少行无关 ——
   * 这是"跑满一年后单轮 token 数与第一天相同"这条承诺的实现方式。把成交行拉进
   * JavaScript 再自己 reduce 也能算出同样的数，但每轮的记忆开销会随历史长度线性上升，
   * 而 `node:sqlite` 是同步的：那笔开销直接压在交易循环所在的事件循环上。
   *
   * ## 为什么"当时的理由"必须和结果一起给模型
   *
   * 它看不到自己刚在 4 分钟前平掉了一笔、今天已经开了 7 笔、连续用同一个理由在同一个
   * 标的上反复进出。把理由与结果并排放，是它唯一能形成"我某个判断模式不奏效"的机制：
   * 只看结果它不知道自己错在哪，只看理由它不知道那个理由已经失败过。
   */
  private buildPromptMemory(
    traderId: number,
    config: StrategyConfig,
    entriesThisHour: number,
    /** 这一轮的候选标的 —— 用来取"我在这些标的上以前是怎么亏的"。 */
    symbols: readonly string[],
  ): PromptMemory {
    const since = new Date(Date.now() - PROMPT_PERFORMANCE_WINDOW_HOURS * 3_600_000).toISOString();
    const performance = tradeStore.performanceSince(traderId, since);
    const lastExitAt = tradeEvents.lastExit(traderId);
    const lastExitMs = lastExitAt ? Date.parse(lastExitAt) : Number.NaN;

    return {
      performance: {
        windowHours: PROMPT_PERFORMANCE_WINDOW_HOURS,
        totalTrades: performance.totalTrades,
        wins: performance.wins,
        losses: performance.losses,
        grossPnl: performance.grossPnl,
        totalFees: performance.totalFees,
        totalFunding: performance.totalFunding,
        netPnl: performance.netPnl,
        avgWin: performance.avgWin,
        avgLoss: performance.avgLoss,
        /*
         * 没有亏损单时这个比值算不出来 —— 用 null 表示"算不出来"，而不是 0 或无穷：
         * 0 会被渲染成"实际盈亏比 0.00"，读起来像是"每一笔都亏"，与事实相反。
         */
        realizedPayoffRatio:
          performance.avgLoss > 0 ? performance.avgWin / performance.avgLoss : null,
        roundTripFeeRate: performance.roundTripFeeRate,
        /*
         * ⚠️ **连续空转了多少轮。**
         *
         * 上面那些字段在"没有成交"时全是 0，而模型需要区分"刚开始跑"与
         * "已经连着二十几轮把候选全部否掉"。后者是系统性问题，处置方式
         * （改门槛 / 改标的池 / 承认账户规模不该交易）与"再等等"完全不同。
         */
        idleCycles: this.countIdleCycles(traderId),
        /*
         * ⚠️ **按平仓原因摊开 —— "钱是在哪一类里漏掉的"。**
         *
         * 用户 2026-10-02：「AI 是瞎子、傻子，**看不清订单**」。
         * 聚合后的绩效看不出答案；摊开之后（实测 63 笔）是：
         * 赚钱那类平均走 3.6%，而它主动平仓那类平均只走 0.4%（往返成本 0.07–0.1%）。
         *
         * 上限 200 笔是**固定常数**，所以这一步是 O(1)（§4）。
         */
        byCloseReason: closeReasonBreakdown(tradeStore.recent(traderId, 200)),
      },
      recentCloses: tradeStore.recentWithReason(traderId, PROMPT_RECENT_CLOSE_COUNT),
      throttle: {
        entriesThisHour,
        maxEntriesPerHour: config.throttle.maxEntriesPerHour,
        // 时间戳读不出来时按"从未平过仓"处理（null）：宁可少说一句，也不要报一个假的剩余时间。
        minutesSinceLastExit: Number.isFinite(lastExitMs)
          ? Math.max(0, (Date.now() - lastExitMs) / 60_000)
          : null,
        reentryCooldownMinutes: config.throttle.reentryCooldownMinutes,
      },
      /*
       * 最近被风控拒绝的提议。
       *
       * **这一块是实测逼出来的**：模型提「名义 $6.00」→ 取整后 $5.00 → 拒绝，
       * 而下一轮它只看到绩效与节流、**完全不知道被拒过**，于是原样再提一次。
       * 操作员看到的是「为什么同一个错误反复出现」——
       * **不是模型不智能，是这一侧没把它自己的失败告诉它。**
       *
       * 取自 `decision_records` 的执行记录（`status === 'rejected'`），
       * 固定取最近 3 条（与最近平仓同样的 O(1) 纪律，见 §4）。
       */
      recentRejections: this.buildPromptRejections(traderId),
      lessons: this.buildPromptLessons(traderId),
    };
  }

  /**
   * AI 自己复盘出来的教训，按候选标的取。
   *
   * ## 为什么这一条是"越跑越厉害"的关键
   *
   * `agent_memory` 是复盘员每笔平仓之后写下的结论（"止损过紧""费用吃掉利润"
   * 之类）。它写进了库，**但在这次改动之前没有任何决策路径读它** ——
   * 交易决策提示词里从来没有出现过教训，于是 AI 每一轮都在从零开始：
   * 它看不见自己上一笔为什么亏，也看不见复盘员对那笔怎么说。
   *
   * 一条教训要影响交易，原来只能**绕道**：复盘员的结论 → 策略师（如果它恰好
   * 调用了 `get_lessons`）→ 变成一次参数改动 → 才间接影响下一笔。
   * 中间任何一跳断掉，教训就沉在库里了。
   *
   * ## 取多少
   *
   * 每个标的最近 2 条，总数封顶 8 条 —— 与 `recentCloses` / `recentRejections`
   * 同样的 **O(1) 纪律**（§4）：区块大小不随交易历史增长。超过就丢后面的，
   * 因为**最近的教训最可能还与当前行情相关**。
   *
   * 按候选顺序取（候选已按评分排过），于是最值得看的标的的教训优先保留。
   */
  private buildPromptLessons(traderId: number): PromptLesson[] {
    /*
     * ⚠️ **【2026-10-02 修复】原来按"候选池顺序"遍历，把最新教训挤掉了。**
     *
     * 旧实现：
     *
     *     for (const symbol of symbols) {                     // 候选池顺序（按成交额降序）
     *       for (const m of agentMemory.forSymbol(traderId, symbol, 2)) {  // 每标的 2 条
     *         out.push(...);
     *         if (out.length >= 8) return out;                // 满 8 条就停
     *       }
     *     }
     *
     * 三个条件叠在一起，后果是：**只有候选池排名前 4 左右的标的**的教训能进提示词。
     * 而候选池按 24h 成交额降序 —— HYPEUSDT 常排第 14 位左右，于是它的教训
     * **永远进不了**。而区块标题写的是"最新在前"，名不副实。
     *
     * 实测证据（两轮相隔 40 分钟）：
     *
     *     #90（agent_memory）15:22 写下 HYPE 的回吐教训，里面有
     *         "同类单应在浮盈约 0.5% 价格时部分止盈" 与
     *         "保本/移动止损只解决不亏，不解决留利"
     *     #1851（决策轮）16:02 的提示词里【完全找不到它】，
     *         教训列表第一条是更早的 SUIUSDT 教训
     *
     * 也就是说：**复盘员认真总结出一条能改变行为的结论，而它没有到达决策现场。**
     * 而那句话（"不解决留利"）恰好是当时账户最需要的一条。
     *
     * 现在按**时间**取最近 N 条 —— 与标题一致，让每一次复盘都真的被看见。
     * 代价是"候选池里某个老标的的旧教训"可能被挤出去；但旧教训针对的是当时的行情，
     * 而"最新的教训"正是它刚学到的。
     */
    return selectPromptLessons(agentMemory.recent(traderId, PROMPT_LESSON_LIMIT));
  }

  /**
   * 最近被拒的提议，给提示词用。
   *
   * 只取 `rejected`（被风控挡下），**不含 `failed`**（执行出错）——
   * 后者是系统问题，让模型去"调整提议"是误导。
   */
  private buildPromptRejections(traderId: number): PromptRejection[] {
    try {
      const recent = decisionStore.list(traderId, 20);
      const out: PromptRejection[] = [];
      for (const rec of recent) {
        for (const entry of rec.executionLog) {
          if (entry.status !== 'rejected') continue;
          // 从记录里找回当时提议的名义价值：执行记录只带理由，
          // 而"我提了多少"是模型调整时最需要的对照。
          const decision = rec.decisions.find((d) => d.symbol === entry.symbol);
          out.push({
            symbol: entry.symbol,
            positionSizeUsd: decision?.positionSizeUsd ?? 0,
            reason: entry.detail,
          });
          if (out.length >= 3) return out;
        }
      }
      return out;
    } catch {
      /*
       * 读不到就当作"没有被拒记录" —— 少一块记忆好过整个周期失败。
       * **但这是有损的**：模型会因此重复它上一次的错误，所以只吞读取异常，
       * 不吞逻辑异常。
       */
      return [];
    }
  }

  /**
   * 连续多少轮没有做出**任何**决策。
   *
   * 从最近的决策记录往前数，遇到第一条有决策的就停。它回答的是
   * "我是不是已经空转很久了" —— 而那个问题在绩效区块里原来没有答案：
   * `totalTrades === 0` 只会说"最近 N 小时没有已平仓的交易"，
   * 那既可能是刚跑两轮，也可能是连着二十几轮把候选全部否掉。
   *
   * ⚠️ 扫的是固定 50 条（O(1) 的窗口，与其它记忆块同一纪律）：这个数字只需要
   * 分辨"几轮"与"几十轮"，不需要跨月精确 —— 而扫全表会让每轮都读一遍历史。
   *
   * 读不到时返回 0（而不是抛）：一块统计缺失不该让整个周期失败。
   * **但那是偏乐观的默认** —— 读失败时它会显示成"没有空转"，所以只吞读取异常。
   */
  private countIdleCycles(traderId: number): number {
    try {
      const recent = decisionStore.list(traderId, 50);
      let idle = 0;
      for (const rec of recent) {
        if (rec.decisions.length > 0) break;
        idle += 1;
      }
      return idle;
    } catch {
      return 0;
    }
  }

  private buildPromptPositions(
    localPositions: PositionRow[],
    snapshots: Map<string, MarketSnapshot>,
  ): PromptPosition[] {    return localPositions.map((p) => ({
      position: this.toPositionView(p, snapshots),
      snapshot: snapshots.get(p.symbol) ?? null,
      holdingMinutes: (Date.now() - new Date(p.opened_at).getTime()) / 60_000,
    }));
  }

  private toPositionView(row: PositionRow, snapshots: Map<string, MarketSnapshot>): PositionView {
    const snapshot = snapshots.get(row.symbol);
    /*
     * ⚠️ **这个回落是"账面上的假事实"，不要让它发生。**
     *
     * 取不到快照时拿开仓价当市价，算出来的未实现盈亏恒等于 0 —— 一笔正在亏的
     * 持仓会以"浮盈 +0.00"的样子进到提示词里，而模型据此会认为没什么可管的。
     *
     * 这条路径应当是**不可达**的：候选评分门槛已经把持仓标的排除在外
     * （见上面 gate 那段），而持仓标的本身是由 `mustInclude: held` 强制进候选池的。
     * 剩下唯一的可能是"这个标的的行情确实取不到"—— 那种情况下
     * `ownUnrealizedPnlOf()`（归属权益那条路径）会另外报一条"读不到标记价"的告警，
     * 提示词里的这一处仍然不代表真相。
     *
     * 保留回落是为了不改 `PositionView.markPrice: number` 的类型契约（改动会波及
     * 前端与持仓页）；但**如果这条路径真的开始出现，该做的是让持仓标的必然带快照，
     * 而不是在这里补一个更好看的默认值。**
     */
    const markPrice = snapshot?.price ?? row.entry_price;
    const isLong = row.side === 'long';
    const unrealizedPnl =
      (isLong ? markPrice - row.entry_price : row.entry_price - markPrice) * row.quantity;

    return {
      id: row.id,
      traderId: row.trader_id,
      symbol: row.symbol,
      side: isLong ? 'long' : 'short',
      quantity: row.quantity,
      entryPrice: row.entry_price,
      markPrice,
      leverage: row.leverage,
      liquidationPrice: row.liquidation_price,
      unrealizedPnl,
      unrealizedPnlPercent: row.margin_used > 0 ? (unrealizedPnl / row.margin_used) * 100 : 0,
      peakPnlPercent: row.peak_pnl_percent,
      marginUsed: row.margin_used,
      notional: row.quantity * markPrice,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      openedAt: row.opened_at,
      openReasoning: row.open_reasoning,
    };
  }

  private recordOrder(input: {
    traderId: number;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: string;
    purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'adjustment';
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    status: string;
    avgPrice: number | null;
    filledQty: number;
    /** Commission reported by the exchange, when known. */
    fee?: number;
    error?: string | null;
    raw?: unknown;
    /**
     * 这张单**对应占用的保证金**（USDT 本金），订单记录里那一列。
     *
     * 只有**开仓 / 加仓**要传：那是这一笔自己的 `|价 × 量| ÷ 杠杆`，也就是即将
     * 写进 `positions.margin_used` 的同一个数（用 `marginOf()`，不要在这里另写算式）。
     * 平仓 / 止损 / 止盈**不要传** —— 那些行上没有成交价，重算只会算出第二个口径；
     * 它们由 `recordOrder` 从持仓行取权威值（见下面的说明）。
     *
     * ⚠️ **拿不到就别传，绝不传 0**：0 在界面上是"这笔没占保证金"，
     * 与"我们不知道"是两句相反的话。
     */
    marginUsed?: number;
  }): void {
    /*
     * 保证金的那一个数**只在这里定**，insert 与下面的事件用同一个值 ——
     * 否则"刷新后是 123、实时推送补进来的那一行却是空的"这种不一致会出现。
     *
     * 判断本身（谁能当保证金、开仓单为什么**不许**回落到持仓行、0 为什么等于
     * "不知道"）在 `resolveOrderMarginUsed()` 里，那是纯函数、有单元测试；
     * 这里只负责把**它需要的两样输入**取来：调用方给的值，与该标的当前持仓行的
     * `margin_used`（`positions.margin_used` 是保证金的单一事实源，不改、不重算）。
     *
     * 开仓单不查持仓：那一刻它要建的持仓还不存在，查到的只会是**别人的仓位**。
     */
    const position =
      input.purpose === 'entry'
        ? undefined
        : positionStore.getOpenBySymbol(input.traderId, input.symbol);
    const marginUsed = resolveOrderMarginUsed({
      purpose: input.purpose,
      override: input.marginUsed,
      positionMargin: position?.margin_used,
    });

    /*
     * ── 保证金模式（全仓 / 逐仓）──────────────────────────────────────────
     *
     * 取的是**本进程最近一次成功应用到该标的**的模式：`setMarginType()` 只有拿到交易所
     * 的 ok 才写进 `marginSet`（见 `executeOpen` 里那一段），所以它记的是交易所**确认过**
     * 的配置，而不是我们"想设成"的配置。
     *
     * ⚠️ **它不是从交易所重新读回来的当前值**，所以有两种如实为空的路径 ——
     * 都由界面显示 `—`，**不要在这里补一个 `?? 'cross'`**（币安的默认是全仓，但
     * "默认是"与"我们读到了"是两件事，与 `marginUsed` 那条"0 不等于不知道"同一纪律）：
     *
     *   · 这台进程从来没为该标的设成功过（仓位是进程启动前建的、或那次
     *     `setMarginType` 被 `-4048` 挡回来）→ `NULL`；
     *   · 进程设成功之后，有人在零持仓时手工把该标的改成别的模式 → 这一列记的仍然是
     *     我们那次设置的结果。真正的"当前值"由 `/positions` 实时读 `positionRisk`
     *     （`PositionView.marginType`），界面拿它**兜底**，所以这个偏差不会让界面说谎。
     *
     * `marginSet` 里存的是**配置的写法**（`'isolated' | 'crossed'`），而这一列只认
     * `'cross' | 'isolated'` —— 收口在 `normalizeMarginMode()`。
     */
    const marginType = normalizeMarginMode(this.marginSet.get(input.symbol));

    const id = orderStore.insert({
      traderId: input.traderId,
      exchangeOrderId: input.exchangeOrderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      purpose: input.purpose,
      quantity: input.quantity,
      price: input.price,
      stopPrice: input.triggerPrice,
      status: input.status,
      avgPrice: input.avgPrice,
      filledQty: input.filledQty,
      fee: input.fee ?? 0,
      marginUsed,
      marginType,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.raw !== undefined ? { rawResponse: input.raw } : {}),
    });

    /*
     * ⚠️ **手续费兜底：成交了却没带 fee 的单，异步去交易所查一次并回填。**
     *
     * ## 为什么必须有这一层（2026-10-07 实测：账本比交易所多算 0.496 USDT）
     *
     * 用户看到「起始 100.05、现在 100.84，却显示 +$1.29」——账本净额比交易所
     * 流水少了整整 0.496。逐笔追下去，**33 张已成交的平仓单 `fee = 0`**
     * （止损/止盈由**交易所**触发，系统只在事后对账里知道它成交了，那一刻没有
     * 手续费数据）。而 `trades.fee` 又没有别的来源，只好拿开仓费顶替 ——
     * 于是 11 笔呈现精确的 `fee = 2 × entry_fee`，净盈亏被多扣一份手续费。
     *
     * ## 为什么放在这里而不是各个调用点
     *
     * `recordOrder` 是**所有下单路径的唯一落库口**（开仓、平仓、止损、止盈、
     * 对账补录都走它）。在调用点各补一次，就是同一个修复复制五份 ——
     * 而本仓库已经因为"同一个算式有五份副本"吃过大亏（见 `netPnlOf` 的注释）。
     *
     * ## 为什么是异步的、而且不 await
     *
     * 它挂在一条**已经执行完的平仓**后面：手续费只是记账，取不到绝不能拖慢或
     * 影响平仓本身。查到了就 UPDATE 回填（界面与总账校验下一轮都能看到），
     * 查不到就维持 0 —— 与改动前的行为一致，只是**多了一次可能的修正**。
     */
    if (input.fee === undefined && input.exchangeOrderId && /FILLED/i.test(input.status)) {
      void this.feeForOrder(input.symbol, String(input.exchangeOrderId))
        .then((resolved) => {
          if (resolved > 0) orderStore.update(id, { fee: resolved });
        })
        .catch(() => {
          /* 查不到就保持 0：手续费不该让任何交易路径失败 */
        });
    }

    eventBus.publish({
      type: 'order',
      traderId: input.traderId,
      order: {
        id,
        traderId: input.traderId,
        exchangeOrderId: input.exchangeOrderId,        clientOrderId: input.clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: input.price,
        stopPrice: input.triggerPrice,
        status: input.status,
        avgPrice: input.avgPrice,
        filledQty: input.filledQty,
        fee: input.fee ?? 0,
        error: input.error ?? null,
        /* 与刚落库的那一行是同一个数（`null` → 事件里用 `undefined`）。 */
        ...(marginUsed === null ? {} : { marginUsed }),
        /*
         * 同上：字段缺失 = "不知道"，界面显示 `—`。
         *
         * 事件里必须带上它：`useTablePaging` 只把**新 id** 的行并进列表、不按字段合并，
         * 所以漏传会让刚推送进来的那一行在界面上是 `—`，直到 15 秒后那次轮询才补上 ——
         * 而"同一行先空后满"正是操作员最容易读成"这张单的模式和别的不一样"的样子。
         */
        ...(marginType === null ? {} : { marginType }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 组装这个机器人本次的权益快照。
   *
   * 为什么不能直接写 `account.equity`：同一个交易所账户下可以跑多个机器人 ——
   * 它们共用一份凭据、共用一个钱包，`account.equity` 对它们全都是**同一个数**。
   * 实盘上量到的后果：一个 **0 笔平仓、净盈亏 0.000000** 的机器人显示 +2.67%
   * 收益率，而另一个机器人显示完全相同的 +2.67%（两个机器人读的是同一个钱包）。
   *
   * 归属权益只由这个机器人自己的东西构成（见 `attributedEquity()`）：
   *
   *   initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈
   *
   * 浮盈用**自己的** `positions` 行（开仓价、数量、方向）按标记价算；标记价取自
   * 交易所持仓里的 `markPrice`（行情事实，对所有机器人相同，借用它不引入归属
   * 错误），**不是** `account.unrealizedPnl` —— 那个数同样是整个账户的，会把它
   * 人的浮盈算进来。读不到标记价时按 0 计并明确报警，不静默。
   *
   * 账户权益没有丢：`accountEquity` / `accountUnrealizedPnl` 两列记的就是它，
   * 风控的回撤高水位与「账户权益」展示读那两列（见 `realizedHighWaterMark`）。
   */
  private async buildEquitySnapshot(account: AccountState, exchangePositions: ExchangePosition[]): Promise<EquitySnapshot> {
    const traderId = this.deps.trader.id;
    const openPositions = positionStore.open(traderId);
    const markPrices = new Map(exchangePositions.map((p) => [p.symbol, p.markPrice]));

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️ **交易所没有的标的要回落到【行情】标记价**（2026-10-15 修）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 事故：模拟盘的浮盈恒被按 0 计入
     *
     * 上面那个 map 来自交易所的 `positionRisk` —— 而 `dry_run`（模拟盘）机器人的
     * 本地持仓**在交易所根本不存在**，于是它**恒缺标记价**。线上实测（`#11`）：
     * ```
     *   每 5 秒一条 WARN
     *   「这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：SOLUSDT」
     *   而那个 SOLUSDT 空头是模拟仓 —— 交易所侧本来就没有它。
     * ```
     * 后果：模拟盘的浮盈**永远少算那一块**，而界面上的数字看起来完全正常。
     *
     * ## 为什么回落是安全的
     *
     * 标记价是**行情事实**（对所有机器人相同），借它不引入归属错误 ——
     * 与"借用交易所 `markPrice`"是同一条理由（见上面那段注释）。
     *
     * ⚠️ 只对**交易所没有的**标的去查行情：有的话优先用交易所那个数，
     * 它是这个账户的实际结算依据。
     */
    const fromMarket = await this.deps.marketData.markPricesOf(
      openPositions.map((p) => p.symbol).filter((symbol) => !markPrices.has(symbol)),
    );

    const { unrealizedPnl, missingMarkPrice } = ownUnrealizedPnlOf(openPositions, (symbol) =>
      markPrices.get(symbol) ?? fromMarket.get(symbol),
    );
    if (missingMarkPrice.length > 0) {
      this.emit(
        'warn',
        `读不到 ${missingMarkPrice.join('、')} 的标记价，这些持仓的浮动盈亏暂按 0 计入归属权益。`,
      );
    }

    return {
      traderId,
      timestamp: new Date().toISOString(),
      // 归属权益：本机器人自己的账，不是共享钱包。
      equity: attributedEquity(
        traderStore.get(traderId)?.initialEquity ?? 0,
        tradeStore.stats(traderId).netPnl,
        unrealizedPnl,
      ),
      availableBalance: account.availableBalance,
      unrealizedPnl,
      marginUsed: account.marginUsed,
      openPositions: openPositions.length,
      accountEquity: account.equity,
      accountUnrealizedPnl: account.unrealizedPnl,
    };
  }

  /**
   * 记录一条权益快照 —— **但完全重复的不记**。
   *
   * ## 为什么（用户的原话）
   *
   * 「默认上面显示得是全部 …… 鼠标悬停在某个时间节点上，显示得信息也是全局来的
   * 数据（现在显示的数据我感觉是基于今天的，导致了**除了今天以外的鼠标悬停都看
   * 不到数据**）」
   *
   * 查下来的结论是**数据没错**：那一刻的快照确实是那个值（悬停在 24/09 07:08
   * 显示 21.97，而那条快照的 `equity` 就是 21.96687；如果它读的是"今天的值"，
   * 应该显示 22.23）。**但体验确实是坏的**，而根因在这里：
   *
   * 空仓期间权益一动不动，而系统仍然每 45 分钟记一条**逐字节相同**的快照。
   * 实测线上 635 条里最长的一段是**连续 64 条都是 21.9669**：
   *
   *     09-21T02:35 → 连续 31 条都是 20.8021
   *     09-21T22:14 → 连续 19 条都是 22.0523
   *     09-23T11:09 → 连续 64 条都是 21.9669
   *     09-24T18:39 → 连续 27 条都是 22.0601
   *
   * 于是曲线上是大片长平线，**悬停在任何一点看到的都是同一个数** ——
   * 用户的感受完全正确，只是原因不在提示框、而在这里。
   *
   * ## 规则
   *
   *   · **有变化 → 一定记**（持仓数、浮动盈亏、权益任一不同）；
   *   · **没变化 → 每 `SNAPSHOT_HEARTBEAT_MS` 记一条心跳**，其余跳过。
   *
   * 心跳是必要的：没有它，长时间空仓会在曲线上留下**断档**，那看起来像
   * "机器人没在跑"。而重复的中间态**没有信息量** —— 去掉它不丢任何东西。
   *
   * ## 比哪几项
   *
   * `openPositions` / `unrealizedPnl` / `equity` 三项。前两项是"这个机器人在干什么"，
   * 最后一项是"结果" —— 只比 `equity` 会让"开了仓但价格还没动"被误判成重复。
   *
   * ⚠️ **不比较 `availableBalance` / `accountEquity`**：那是**共享钱包**的读数，
   * 同一个账户下别的机器人交易也会让它变。用它当判据会让这个机器人在自己什么都没做
   * 的时候记下一堆"变化"，而那条曲线上讲的是**它自己的账**。
   */
  private async recordEquity(account: AccountState, exchangePositions: ExchangePosition[]): Promise<void> {
    const snapshot = await this.buildEquitySnapshot(account, exchangePositions);
    if (this.isRedundantSnapshot(snapshot)) return;
    equityStore.insert(snapshot);
    eventBus.publish({ type: 'equity', traderId: this.deps.trader.id, snapshot });
  }

  /** 与上一条快照相比，这一条有没有新信息（判据见 `recordEquity`）。 */
  private isRedundantSnapshot(next: EquitySnapshot): boolean {
    const [prev] = equityStore.list(next.traderId, 1);
    if (!prev) return false;

    const same =
      prev.openPositions === next.openPositions &&
      Math.abs(prev.unrealizedPnl - next.unrealizedPnl) < SNAPSHOT_SAME_TOLERANCE &&
      Math.abs(prev.equity - next.equity) < SNAPSHOT_SAME_TOLERANCE;
    if (!same) return false;

    const ageMs = Date.parse(next.timestamp) - Date.parse(prev.timestamp);
    return Number.isFinite(ageMs) && ageMs < SNAPSHOT_HEARTBEAT_MS;
  }
}

/* -------------------------------------------------------------------------- */
/*  Module helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Client order ids are how we correlate our records with the exchange's.
 * Binance caps them at 36 characters, and the id must be persisted *before* the
 * request so an ambiguous outcome can be reconciled instead of retried.
 *
 * ⚠️ 这里有两个坑，都是实盘上撞出来的：
 *
 * **1. 标的符号不能原样拼进去。** Binance 只接受
 * `^[.A-Z:/a-z0-9_-]{1,36}$` —— 而交易所的标的列表里有**中文名的币**。
 * 实测 `龙虾USDT` 会让下单直接失败：
 *
 *     Binance -1100: Illegal characters found in parameter 'newclientorderid'
 *
 * 而且**每个周期都会再失败一次**（策略会反复选中它），所以不能放着不管。
 *
 * **2. 唯一性后缀必须先拼。** 原来符号在 `stamp`/`random` 前面，长符号会在
 * `.slice(0, 36)` 处把它们挤掉 —— 那样两笔订单可能拿到同一个 id。
 * **撞 id 比下单失败更危险**：账目上无法区分那两笔，对账会认错回合。
 * 所以唯一性后缀放在最前面，符号只作为可读的尾注，且位置最容易被截断。
 *
 * 没人解析这个 id 去取符号（全仓库只有相等匹配），所以调整格式不会影响对账；
 * 已入库的旧 id 原样保留，只影响新订单。
 */
export function makeClientId(prefix: string, symbol: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  // 只保留币安允许的字符；全被去掉时给一个占位符，避免出现空片段。
  const safeSymbol = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 14) || 'X';
  return `${prefix}-${stamp}${random}-${safeSymbol}`.slice(0, 36);
}

/* -------------------------------------------------------------------------- */
/*  周期失败的分类与表述                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 失败发生在周期的哪一段。
 *
 * 只在**错误类型本身说明不了问题**时才用得上（`describeCycleFailure` 的最后一级）：
 * 行情层抛的是普通 `Error`，而下单路径抛的也可能是普通 `Error` —— 同一个异常类型在
 * 两个阶段意味着两件完全不同的事，只有阶段标记分得开。
 */
export type CycleFailurePhase =
  | 'bookkeeping'
  | 'market'
  | 'model'
  | 'parse'
  | 'risk'
  | 'execute';

/** 一条记录里放得下的错误原文长度。见 `clipDetail` 的说明。 */
const FAILURE_DETAIL_LIMIT = 300;

/**
 * 折叠并截断服务商 / 交易所返回的原文。
 *
 * 它们可能是一整页 HTML 错误页或者带着换行的 JSON。原样写进
 * `decision_records.error` 会：让一条记录在决策流里占满整屏、把元数据行挤出视野。
 * 300 字符够放下"insufficient balance: please top up"这类关键句。
 */
function clipDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '未提供错误详情';
  return flat.length > FAILURE_DETAIL_LIMIT ? `${flat.slice(0, FAILURE_DETAIL_LIMIT)}…` : flat;
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return clipDetail(error.message);
  return clipDetail(String(error));
}

/**
 * `llm/errors.ts` 的 `emptyCompletionError()` 没有专属的 `kind`（HTTP 200、但没有任何
 * 可用的助手文本），只能认它那句固定的英文文案 —— 那是"AI 响应无法解析"这一类的
 * 唯一信号。判错的后果只是把"空补全"说成"服务不可用"，两者的处置建议相同，所以这个
 * 妥协是可接受的；不要为了它去改 `errors.ts` 的类型（那会牵动重试策略）。
 */
function looksLikeEmptyCompletion(error: LlmError): boolean {
  return error.status === null && /no assistant text/i.test(error.message);
}

/**
 * 一次失败的周期，该对操作员说什么。
 *
 * ## 为什么返回中文散文，而不是堆栈
 *
 * 决策流是操作员唯一会去看的地方（参考产品就是这么做的），而堆栈在那里等于什么都
 * 没说：既看不出"是谁没给钱"，也看不出"要不要做点什么"。所以每一类都给一句**能照着
 * 做**的话，并把服务商 / 交易所的原文附在中间 —— 那句话往往已经写明了原因
 * （额度耗尽、模型不存在、保证金不足）。
 *
 * ## 失败类别写在**第一个全角冒号之前**
 *
 * 决策流的元数据行只放类别（`失败 · AI 服务额度不足`），完整说明留在盒子里，见
 * `packages/web/src/components/DecisionFeed.tsx` 的 `failureCategory()`。没有为此
 * 新增列：`decision_records.error` 本来就在，而这条文本的唯一读者是人。
 *
 * ## 判类只做这一次，且**不看 HTTP 状态码**
 *
 * `LlmError.kind` 是 `llm/errors.ts` 已经判好的结论，这里直接用它。那里记着一次实测
 * 事故：一个网关在 **HTTP 400** 里返回 `模型不可用：deepseek-flash`，而"400 不可重试"
 * 的通用规则让一次本可成功的请求被放弃；修复方式正是在 `kindForStatus()` 里显式列出
 * 这类可用性短语。这里若按状态码再判一次，等于把那个 bug 复制到展示层。
 */
export function describeCycleFailure(error: unknown, phase: CycleFailurePhase): string {
  if (error instanceof LlmError) {
    const detail = detailOf(error);
    switch (error.kind) {
      case 'quota_exhausted':
        return `AI 服务额度不足：${detail}。服务商已经把这条密钥判定为没有余额或没有额度，机器人在充值前每一轮决策都会失败 —— 请先在服务商后台充值或提高额度；充值后无需重启机器人，下一轮会自动恢复。`;
      case 'auth':
        return `AI 服务拒绝：${detail}。通常是 API Key 无效、已过期或被停用，请在控制台「设置 → AI 模型」里更新密钥。`;
      case 'permission':
        return `AI 服务拒绝：${detail}。这把密钥没有调用该模型的权限，请确认密钥权限或改用其他模型。`;
      case 'not_found':
        return `AI 服务拒绝：${detail}。配置的模型名在服务商侧不存在或已下线，请在控制台改用可用的模型。`;
      case 'bad_request':
        return `AI 服务拒绝：请求参数错误（${detail}）。请求被 AI 服务判定为参数异常，本轮没有产生任何决策；请检查模型名、温度与最大输出 Token 的配置，若反复出现请联系模型服务商。`;
      case 'content_filter':
        return `AI 服务拒绝：${detail}。模型侧的内容审核拦下了本次请求，一般下一轮就会恢复；若持续出现，请检查提示词与行情数据里是否有异常内容。`;
      case 'rate_limit':
      case 'overloaded':
      case 'server':
      case 'timeout': {
        /*
         * ⚠️ **必须说清"具体是哪一种不可用"。**
         *
         * 用户 2026-10-01 的原话：「还有图示的报错（系统不能自己处理重试？
         * **因为报错的时候我用 API 测试上游是可用的**）」。
         *
         * 他看到的是一句把四类原因混在一起的话，于是**无从判断该等还是该查**。
         * 而这四类指向完全不同的处置：
         *
         *   · **超时**（`request exceeded 240000ms`）—— 是**我们**的请求跑太久，
         *     该动的是提示词大小与超时配置，不是去服务商后台查；用户在那里单独测 API
         *     会发现"上游是好的"，因为那是**另一个请求路径**（请求体小得多）。
         *   · **限流**（429）—— 该退避，而不是立刻重试（那会加剧限流）。
         *   · **5xx** —— 确实是上游，等一等就恢复。
         *
         * 格式约束：第一个全角冒号之前必须仍是类别 —— `DecisionFeed.failureCategory()`
         * 靠它渲染元数据行。
         */
        const which =
          error.kind === 'rate_limit'
            ? '被限流'
            : error.kind === 'overloaded'
              ? '服务商过载'
              : error.kind === 'server'
                ? '服务商 5xx'
                : '请求超时';
        const http = typeof error.status === 'number' ? `HTTP ${error.status}` : '无 HTTP 状态';
        const advice =
          error.kind === 'timeout'
            ? '**注意：这一类的责任在我们这边** —— 请求没有在配置的时限内拿到响应，' +
              '通常意味着单次请求太大或模型推理太久，而不是上游挂了。' +
              '机器人在下一轮会重试；若反复出现，可考虑调小候选池或提高该模型的超时配置。'
            : '这是服务商侧的临时故障，机器人下一轮会自动重试，通常不需要人工处理。';
        return `AI 服务不可用：${which}（${http}）—— ${detail}。${advice}`;
      }
      case 'unknown':
        return looksLikeEmptyCompletion(error)
          ? `AI 响应无法解析：${detail}。模型返回了 HTTP 成功但没有任何可用文本（推理过程耗尽输出预算、或内容被审核掉都可能这样），本轮没有决策；机器人会在下一轮重新提问。`
          : `AI 服务不可用：${detail}。这次请求没有拿到模型的响应（网络不可达、被取消或响应异常），机器人下一轮会自动重试。`;
    }
  }

  if (error instanceof BinanceApiError) {
    const detail = detailOf(error);
    if (error.isInsufficientMargin) {
      return `交易所拒绝：保证金不足（${detail}）。这笔订单没有成交；请降低仓位比例或少开几个仓位，风控会按最新可用余额重算额度。`;
    }
    if (error.isRateLimited) {
      return `交易所限流：${detail}。请求过快或已被临时限制，机器人下一轮会自动重试。`;
    }
    if (error.isTimestampError) {
      return `交易所拒绝：请求时间戳超出接收窗口（${detail}）。服务器时钟需要与交易所同步，否则每一笔下单都会被拒。`;
    }
    if (error.isFilterError) {
      return `交易所拒绝：订单参数不符合该标的的交易规则（${detail}）。这通常是数量 / 价格的取整或最小名义价值问题，订单没有成交。`;
    }
    return `交易所拒绝：${detail}。这笔订单没有得到交易所确认；原始响应与错误码已记入订单表，可据此判断是否需要人工干预。`;
  }

  const detail = detailOf(error);

  // 模型返回的内容本身不是合法 JSON（被截断、或混进了额外说明）。它在"解析"阶段
  // 抛出，但类型是 SyntaxError，比阶段标记更精确。
  if (error instanceof SyntaxError) {
    return `AI 响应无法解析：${detail}。模型返回的内容不是合法 JSON（可能被截断或混入了说明文字），本轮没有决策；机器人会在下一轮重新提问。`;
  }

  switch (phase) {
    case 'market':
      return `行情数据不可用：${detail}。本轮取不到可用行情，因此没有向模型提问、也没有下单；通常是交易所行情接口暂时失败，机器人会在下一轮重试。`;
    case 'model':
      return `AI 服务不可用：${detail}。调用模型时出错，且这个错误不属于已知的服务商故障类型；机器人会在下一轮重试。若持续出现，请检查网络与模型配置。`;
    case 'parse':
      return `AI 响应无法解析：${detail}。模型返回的内容无法解析成决策，本轮没有决策。`;
    case 'risk':
      return `决策处理失败：${detail}。本轮在风控裁决环节抛出异常，没有下任何单；这属于程序内部故障，请结合运行日志排查（该周期的提示词与模型返回已保存在这条记录里）。`;
    case 'execute':
      return `交易所下单失败：${detail}。这笔订单没有得到交易所确认，可能并未成交；请核对交易所的持仓与挂单，机器人下一轮会重新对账。`;
    case 'bookkeeping':
      return `未知错误：${detail}。本轮在账务 / 对账环节失败，且错误不属于已知的模型、行情或交易所类别；该周期已经拿到的提示词与执行记录已尽量保存，请结合运行日志排查。`;
  }
}

/**
 * 把熔断裁决变成一句**给人看的话**：为什么被拦、以及怎么解除。
 *
 * 提取出来是因为它有**两个调用点**：跳过周期时的 `executionLog`，以及控制台的
 * `/stats` 响应。**两处必须说同一件事** —— 否则操作员会在面板上看到一种说法、
 * 在决策流里看到另一种，然后去追一个不存在的差异。
 *
 * ⚠️ **两种熔断的解除方式完全不同，不能都用"等零点"概括。**
 * `total_drawdown` 比较的是历史最高水位与当前权益，**没有"按日"这个概念**；
 * 空仓时权益不会自己变化，所以它**不会自行恢复**。这里原来对所有 `blocked`
 * 都写「熔断按单日结算，跨过零点后自动恢复」—— 一个被总回撤熔断的机器人因此
 * 连续 15 个周期都在给操作员一条**会让他安心地不去处理**的错误信息。
 */
export function describeBreaker(verdict: CircuitBreakerVerdict, config: StrategyConfig): string {
  if (!verdict.blocked) return '';
  return verdict.kind === 'total_drawdown'
    ? `${verdict.reason}注意：总回撤熔断不按日重置 —— 它要等权益回到最高水位以下 ` +
        `${config.circuitBreaker.maxTotalDrawdownPercent}% 以内才会解除，` +
        '而空仓时权益不会自己变化，所以它不会自行恢复。' +
        '要不要继续交易需要操作员决定（例如入金，或调整这一上限）。'
    : `${verdict.reason}单日亏损熔断按日结算，跨过零点后自动恢复。`;
}

/**
 * 模型的「点名清单」在 `settings` 里的键。
 *
 * 存 `settings` 而不是新表：它是**每机器人的一小段运行时状态**，
 * 与 `ledger_check` / `llm_health` 同一类，不值得为它加一张表和一个迁移。
 */
export function watchlistKey(traderId: number): string {
  return `watchlist:${traderId}`;
}

/**
 * 点名清单的存活轮数。
 *
 * 3 轮 ≈ 1.5 小时（周期 30 分钟）：够模型"盯一会儿"，又不至于把一份**临时兴趣**
 * 变成永久候选 —— 后者会让清单越积越满，最后每一轮都在看几天前的东西。
 */
const WATCHLIST_TTL_ROUNDS = 3;
/**
 * 点名清单的上限。
 *
 * 10 个 ≈ 与候选池同量级 —— 再多就会与系统选的候选抢位置，
 * 而那是**系统的职责**（`selectCandidates` 的预算裁剪会先保 `mustInclude`）。
 */
const WATCHLIST_MAX_SIZE = 10;
/**
 * 「共识标的」（出现在 ≥2 个榜里的）一次最多请几个进深潜层。
 *
 * 6 是个刻意的克制数字：深潜层一共只能放 15-20 个，共识占 6 个已经不少 ——
 * 再多就会把系统按成交额/评分选的候选挤掉，而**那些是另一条独立的信息**。
 */
const CONSENSUS_LIMIT = 6;

/**
 * 读出模型的点名清单。
 *
 * ⚠️ 解析失败时返回空数组而**不是抛错**：这是模型自己的一份便签，
 * 一个读不出来的便签不该让整个周期失败。但也不会装作"点过名"——
 * 读不出来就等于没点过，下一轮它自然会再点一次。
 */
export function readWatchlist(traderId: number): WatchlistEntry[] {
  try {
    const raw = settings.get(watchlistKey(traderId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => row as Partial<WatchlistEntry>)
      .filter((row) => typeof row.symbol === 'string' && typeof row.remaining === 'number')
      .map((row) => ({
        symbol: String(row.symbol).toUpperCase(),
        remaining: Number(row.remaining),
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      }));
  } catch (error) {
    log.warn(`点名清单读取失败（按"还没点过名"处理）：${(error as Error).message}`);
    return [];
  }
}

/** 写回点名清单。空清单也照写（那是"轮空了"，与"没点过"在语义上一样）。 */
export function writeWatchlist(traderId: number, rows: readonly WatchlistEntry[]): void {
  settings.set(watchlistKey(traderId), JSON.stringify(rows));
}

/**
 * 读最近一次对账检测到的外部交易活动。
 *
 * 解析失败时返回空对象而**不是抛错**：这是给模型看的注解，
 * 一个读不出来的注解不该让整个周期失败。但也不会静默假装"没有外部活动" ——
 * 认不出就返回空，让 prompt 那一行不渲染（见那里的 `> 0` 判断）。
 */
export function readForeignActivity(traderId: number): {
  foreignRounds?: number;
  foreignNet?: number;
  ledgerGap?: number;
} {
  const out: { foreignRounds?: number; foreignNet?: number; ledgerGap?: number } = {};
  try {
    const raw = settings.get(`foreign_activity:${traderId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { rounds?: number; net?: number };
      if (typeof parsed.rounds === "number" && parsed.rounds > 0) {
        out.foreignRounds = parsed.rounds;
        out.foreignNet = typeof parsed.net === "number" ? parsed.net : 0;
      }
    }
  } catch {
    /* 读不出来就不带这一项 —— 见下面 ledgerGap 的注释。 */
  }
  /*
   * 账本差额：**必须单独读，而且失败时不能静默当成 0。**
   *
   * 它是「平台账本与交易所对不上」的唯一信号。读不到时留 `undefined`，
   * prompt 那一行按「大于 0.01 才渲染」判断 —— 于是读不到就不渲染，
   * **而不是渲染成"差额为 0、账是对的"**。
   *
   * 两种失败的含义完全不同：一个是"我们不知道"，一个是"账没问题"。
   */
  try {
    const raw = settings.get(`ledger_check:${traderId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { gap?: number; incomeReadFailed?: boolean };
      /*
       * ⚠️ **读流水失败的那一轮整个不算数 —— 包括这里的 `gap`。**
       *
       * 上面那段注释讲的是"读不到时不要假装是 0"；这里是它的**另一面**：
       * `incomeReadFailed` 为真时，`gap` 是在 `exchangeNet` 为 0 的前提下算出来的，
       * 它等于整个 `platformNet` —— 一个**假差额**。
       *
       * 把它喂给模型，等于告诉它"账本与交易所差了 N USDT、可能有漏记"，
       * 而真实情况只是**这一次没读到流水**。上一轮修了"是否告警"却漏了这条路径，
       * 而这条路径的读者是**正在做决策的模型**。
       */
      if (!parsed.incomeReadFailed && typeof parsed.gap === 'number') out.ledgerGap = parsed.gap;
    }
  } catch {
    /* 同上：留空，不要假装是 0。 */
  }
  return out;
}

/**
 * **JEV 模式的 `<JEV_INPUT>` 块**（2026-10-19）。
 *
 * ## 这个块是什么
 *
 * 一段结构化 JSON，附在 prompt **末尾**，只被 `jevModel.ts` 读取。
 * 它承载"算候选档位需要的最小字段" —— 不是行情全集。
 *
 * ## ⚠️ 为什么不用解析散文
 *
 * `renderUserPrompt()` 的段落随策略配置变化（有些有、有些没有）。
 * 用正则从中文散文里抠"价格是多少"会在某个配置下**静默抠错** ——
 * 而错的档位会真的下单。
 *
 * ## ⚠️ 三条约束（改这里之前先读）
 *
 * ```
 * ① 只在 mode === 'jev' 时调用 —— 其余模式的 prompt 逐字节不变
 * ② 追加在末尾 —— 不破坏前缀缓存（那段 4.7 万 token 的稳定段命中率靠它）
 * ③ 字段只放最小集 —— 每多一个字段就多一份"它变了但没人更新"的风险
 * ```
 *
 * ## `heldSide` 为什么在这里算
 *
 * 本模式只做"开仓 / 跳过"，已有持仓的标的要跳过（不叠加仓位）。
 * 那个判断需要**持仓列表**，而 `jevModel` 只拿得到 prompt 文本。
 *
 * ## `maxCandidates` 为什么在这里也生效
 *
 * 候选太多会：① 每标的 400ms ⇒ 线性变慢；② token 成本线性上升。
 * 上限在这里就截断，`jevModel` 那边再截一次（双重保险，不会因为
 * 一处改动就失控）。
 */
function buildJevInputBlock(
  ctx: PromptContext,
  _budgetTokens: number,
  /**
   * **账户状态**（2026-10-19 用户要求）。
   *
   * 用户原话：
   * > 「给JEV 判断里面现在有没有实际仓位？（如果开很多仓位了JEV不知道
   * >  又一直要开仓的情况，你研究一下到底要投喂哪些数据最合理）」
   *
   * ## 为什么从参数传进来而不是从 `ctx` 读
   *
   * `PromptContext` 是**提示词层**的结构（给普通 LLM 用的散文渲染），
   * 它没有"本轮已开几仓"这种**交易循环的状态**。
   * 那些数只有 `AutoTrader` 自己知道（它管着节流计数）。
   *
   * ⇒ 加一个参数，而不是往 `PromptContext` 塞字段 ——
   *   后者会让"提示词层"依赖"交易循环的状态"，方向是反的。
   */
  account?: JevAccountState,
): string {
  const held = new Map<string, 'long' | 'short'>();
  for (const p of ctx.positions) {
    const side = p.position.side;
    if (side === 'long' || side === 'short') held.set(p.position.symbol, side);
  }

  /*
   * ⚠️ 上限 8：与 `defaultJevConfig()` 的 `coinPoolLimit(8) + oiTopLimit(4)`
   * 量级一致。再多的标的对"这一轮做不做"的判断帮助很小，而成本是线性的。
   */
  const MAX = 8;

  const items = ctx.candidates.slice(0, MAX).map((c) => {
    const primary = c.primary;
    /* 指标序列取末值 —— 与 `verifyPipeline.ts` 同一取法（键名由数据决定）。 */
    const atrKey = Object.keys(primary.atr)[0];
    const rsiKey = Object.keys(primary.rsi)[0];
    const emaKey = Object.keys(primary.ema)[0];
    const atr = atrKey !== undefined ? (last(primary.atr[atrKey] ?? []) ?? 0) : 0;
    const rsi7 = rsiKey !== undefined ? (last(primary.rsi[rsiKey] ?? []) ?? undefined) : undefined;
    const ema20 = emaKey !== undefined ? (last(primary.ema[emaKey] ?? []) ?? undefined) : undefined;

    /*
     * 近 3 根位移百分比（策略里的 D）：
     * `(收盘[-1] - 收盘[-4]) / 收盘[-4] × 100` —— 与团队模式 `windowHint`
     * 用的那个 D 是同一个口径（那里实测过它的语义：0.8%~3.5% 是可执行窗口）。
     */
    const closes = primary.closes;
    let displacementPercent: number | undefined;
    if (closes.length >= 4) {
      const a = closes[closes.length - 4];
      const b = closes[closes.length - 1];
      if (typeof a === 'number' && typeof b === 'number' && a > 0) {
        displacementPercent = ((b - a) / a) * 100;
      }
    }

    return {
      symbol: c.symbol,
      price: c.price,
      atr,
      ...(displacementPercent !== undefined ? { displacementPercent } : {}),
      ...(Number.isFinite(c.priceChangePercent24h)
        ? { change24hPercent: c.priceChangePercent24h }
        : {}),
      ...(rsi7 !== undefined && Number.isFinite(rsi7) ? { rsi7 } : {}),
      ...(ema20 !== undefined && Number.isFinite(ema20) ? { ema20 } : {}),
      ...(held.has(c.symbol) ? { heldSide: held.get(c.symbol) } : {}),
      /* 账户状态挂到每个候选上 —— `jevModel` 从 `c.account` 读。 */
      ...(account !== undefined ? { account } : {}),
      
    };
  });

  return `<JEV_INPUT>${JSON.stringify(items)}</JEV_INPUT>`;
}
