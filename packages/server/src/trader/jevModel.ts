/**
 * **JEV 模式的决策模型**（实验性 · 2026-10-19）。
 *
 * ## 它做什么
 *
 * 用户的要求：
 * > 「该模式所有操作都采用 JEV 模型来实现，从选币到交易，一切都由 JEV 自主完成」
 *
 * 而 Jev 的能力边界是**实测出来的**（见 `docs/JEV-MODE-DESIGN.md`）：
 *
 * ```jsonc
 *   choice → {"choice":"open_long","confidence":0.74,"probabilities":{…}}
 *   score  → {"score":2.53,"confidence":0.6,"legend":{…},"probabilities":{…}}
 *   noul   → {"noul":0.33}
 * ```
 *
 * ⚠️ **它不产生任何文字，且弱于算术。** 而 `Decision` 需要
 * `positionSizeUsd` / `stopLoss` / `takeProfit`（精确数字）与 `reasoning`（必需的文字）。
 *
 * ⇒ 本模块的形态就是那个唯一可行的解：
 * ```
 *   ① 代码按 ATR / 风险预算算好 3 个候选档位（本文件的 tierFor / stopTierFor / tpTierFor）
 *   ② 一次 HTTP 问 Jev 五个问题（方向 + 仓位档 + 止损档 + 止盈档 + 机会强度）
 *   ③ 代码把答案翻译成 Decision，reasoning 由答案生成（不是编的）
 * ```
 * **每一个「判断」都由 Jev 做出；代码只负责算数（它的弱项）与翻译。**
 *
 * ## ⚠️ 为什么 leverage 不给 Jev 选
 *
 * 杠杆直接决定爆仓距离。Jev 看不到保证金、看不到账户余额、算不了强平价 ——
 * 让它选杠杆等于**把资金安全交给一个不掌握事实的模型**。
 * 这与 `docs/AGENTS.md` §2 的网关边界同一条纪律：**谁掌握事实，谁做决定。**
 *
 * ## 与其他模式的关系
 *
 * ⚠️ **本文件只在 `mode === 'jev'` 时被调用。** 三种既有模式的代码路径
 * 一个字都不经过这里 —— 它们上面挂着用户的真金白银。
 */
import { fetchGuarded } from '../llm/http.js';
import { createLogger } from '../logger.js';
import type { DecisionModel } from './autoTrader.js';

const log = createLogger('jev');

/**
 * 一次 Jev 应答里，单个问题的答案。
 *
 * 形状照抄线上实测（`/v1/systemone` 的 `answers.<name>`）：
 * `choice` / `score` / 
oul` 三选一，但**只有 `choice` 与 `score` 在这里有用**。
 */
interface JevAnswer {
  type?: string;
  /** `choice` 的答案（就是 `criteria` 的某个键）。 */
  choice?: string;
  /** `score` 的答案（0..N-1 的浮点）。 */
  score?: number;
  /** 
oul` 的概率值（本模式暂不使用）。 */
  noul?: number;
  /** **0–1 的小数**（不是 0–100）。 */
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

/** 一次 Jev 应答的整体形状。 */
interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** 三个档位：A 最保守、B 中等、C 最激进。 */
export type Tier = 'A' | 'B' | 'C';

/**
 * 一个标的的**候选档位表** —— 代码算好、Jev 来选。
 *
 * ⚠️ 三档的**顺序与含义必须稳定**：Jev 看到的 `criteria` 说明里写的就是
 * "A 最保守 / C 最激进"。如果顺序变了，它会按旧语义选，而结果会静默出错。
 */
export interface Tiers {
  /** 仓位档（USDT 名义价值）。 */
  size: Record<Tier, number>;
  /** 止损价档。 */
  stop: Record<Tier, number>;
  /** 止盈价档。 */
  take: Record<Tier, number>;
  /** 止损距离（价格差）—— 生成 `reasoning` 时要说清"几倍 ATR"。 */
  stopDistance: Record<Tier, number>;
  /** ATR 的绝对值（用于文案）。 */
  atr: number;
}

/**
 * 从 `<JEV_INPUT>` 块里取出的一个候选。
 *
 * ⚠️ **字段是"够用就好"，不是行情全集** —— Jev 的 `state` 是自然语言摘要，
 * 塞太多数字反而稀释重点（实测：19 个标的 × 每标的 700 字仍然稳定）。
 */
export interface JevCandidate {
  symbol: string;
  price: number;
  atr: number;
  /** 近 3 根位移百分比（策略里的 D）。 */
  displacementPercent?: number;
  /** 24h 涨跌百分比。 */
  change24hPercent?: number;
  rsi7?: number;
  ema20?: number;
  /** 已有持仓的方向 —— 有仓时不新开（本模式只做"开仓/跳过"）。 */
  heldSide?: 'long' | 'short';
  /**
   * **账户状态**（2026-10-19 用户要求）。
   *
   * ## 为什么必须有
   *
   * 用户原话：
   * > 「还有就是给JEV 判断里面现在有没有实际仓位？
   * >  （如果开很多仓位了JEV不知道又一直要开仓的情况，
   * >   你研究一下到底要投喂哪些数据最合理，你要考虑实际真实情况）」
   *
   * ## 缺了它会怎样（线上实测）
   *
   * ```
   * 00:30 那轮：Jev 提议开仓 6 个，而 maxEntriesPerCycle = 2
   * ⇒ 风控拒掉 4 个，日志里全是 rejected:open_xxx
   * ```
   * **Jev 不知道额度，所以它不会"挑最好的 2 个"，而是"随便提 6 个"。**
   * 那浪费了它唯一的价值 —— 判断哪个机会最好。
   *
   * ## ⚠️ 为什么给"结论"而不是原始数字
   *
   * Jev **不擅长算术**（官方文档明确说它是分类器，不是计算器）。
   * 给它「保证金已用 1.06U、权益 21.18U、上限 30%」让它自己算
   * 「还能用多少」—— 实测它会算错。
   *
   * ⇒ 这里给的是**已经算好的结论**：`canOpenMore`、`marginRoomPercent`。
   */
  account?: JevAccountState;
}

/**
 * **Jev 能看到的账户状态**（2026-10-19）。
 *
 * ## 设计原则：只给"会影响它该不该开仓"的事实
 *
 * | 给了 | 为什么 |
 * |---|---|
 * | `openPositions` / `maxPositions` | 满了就不该再提 |
 * | `canOpenMore` | **算好的结论**，不让它自己减 |
 * | `marginUsedPercent` / `marginLimitPercent` | 还有多少保证金空间 |
 * | `entriesThisCycle` / `maxEntriesPerCycle` | 本轮额度（决定"提几个"） |
 * | `entriesThisHour` / `maxEntriesPerHour` | 小时额度 |
 * | `heldSymbols` | 哪些已持仓（避免同标的重复） |
 *
 * ⚠️ **不给的东西**（刻意的）：
 * ```
 *   · 浮盈浮亏明细 —— 那是持仓问询（P1）的事，不是开仓判断的依据
 *   · 历史胜率       —— 它改变不了当前这一笔的胜算
 *   · 账户绝对余额   —— 仓位档已经按权益算好了，给它只会让它想重新算
 * ```
 */
export interface JevAccountState {
  /** 当前权益（USDT）。 */
  equity: number;
  /** 当前持仓数。 */
  openPositions: number;
  /** 持仓数上限（`riskControl.maxPositions`）。 */
  maxPositions: number;
  /** **还能开几个仓**（已算好：`maxPositions - openPositions`，不小于 0）。 */
  canOpenMore: number;
  /** 保证金占用百分比（已算好）。 */
  marginUsedPercent: number;
  /** 保证金占用上限百分比（`riskControl.maxMarginUsage`）。 */
  marginLimitPercent: number;
  /** 本轮已开几个仓。 */
  entriesThisCycle: number;
  /** 本轮开仓上限（`throttle.maxEntriesPerCycle`）。 */
  maxEntriesPerCycle: number;
  /** 本小时已开几个仓。 */
  entriesThisHour: number;
  /** 本小时开仓上限（`throttle.maxEntriesPerHour`）。 */
  maxEntriesPerHour: number;
  /** 已持仓的标的（`symbol → side`）—— 避免对同一标的重复提议。 */
  heldSymbols?: ReadonlyArray<{ symbol: string; side: 'long' | 'short' }>;
}

/** 本模式的可调参数。 */
export interface JevModeOptions {
  baseUrl: string;
  apiKey: string;
  /** Jev 的模型 id（`jev-latest` 是网关给的别名）。 */
  model: string;
  /** 单次 HTTP 超时。实测一次五问约 400ms，给 15 秒足够宽松。 */
  timeoutMs: number;
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **下面这些是「读取函数」，不是值**（2026-10-19 用户要求）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户原话：
   * > 「需重启，你别搞这种啊，完全可以程序自己解决的吧？
   * >  用户不要关注这些和增加繁琐步骤」
   *
   * ## 原来为什么不对
   *
   * 它们是**普通数值**，在装配时读一次 ⇒ 界面上改了永远不生效 ⇒ 只能重启。
   * 那是实现偷懒：把"装配期配置"和"运行期配置"混为一谈。
   *
   * ⇒ 现在全部改成函数，**每次决策时现读**。代价是每轮多几次
   *   `settings.get()`（一次 index seek，微秒级），换来的是**真正的实时生效**。
   *
   * ⚠️ **不要把它们改回普通字段** —— 那会让"改了没反应"这个 bug 复活。
   */
  /** 当前权益（用于算风险预算）。账户余额会变，所以必须现读。 */
  readEquity: () => number;
  /** 单笔风险占权益的比例（0.01 = 1%）。 */
  readRiskPercent: () => number;
  /** 每轮最多问几个标的（控成本）。 */
  readMaxCandidates: () => number;
  /** 选币方式：`code` / `hybrid` / `jev`。 */
  readCoinSelect: () => string;
  /** 开仓方式：`market` / `limit`。 */
  readEntryType: () => string;
  /** 是否允许做空。 */
  readAllowShort: () => boolean;
  /** 是否允许加减仓。 */
  readAllowResize: () => boolean;
  /** 是否允许移动止损。 */
  readAllowTrailing: () => boolean;
  /** 止盈止损比（止盈距离 ÷ 止损距离）。 */
  readMinRiskRewardRatio: () => number;
  /** 最低置信度（0–100）。 */
  readMinConfidence: () => number;
  /** 每 N 轮问一次持仓（省 token）。 */
  readHoldAskEvery: () => number;
  /**
   * 交易所对该标的的**最小名义价值**（USDT）。
   *
   * ⚠️ 不同标的不同：BTC 是 100 U，多数山寨币是 5 U。
   * 仓位档位低于它就无法下单（交易所直接拒）。
   */
  readMinNotional: () => number;
  /**
   * 杠杆模式：`manual`（用 `readLeverageManual`）或 `jev`（让 Jev 选）。
   *
   * ⚠️ 2026-10-19 用户要求：「自动模式：让JEV自己去判断要用多少杠杆」。
   * 原来这里是 `leverage: number`（写死的），现在拆成模式 + 手动值。
   */
  readLeverageMode: () => string;
  /**
   * 保证金模式：`isolated` / `crossed` / `jev`（让 Jev 判断）。
   */
  readMarginMode: () => string;
  /** 手动模式下的杠杆倍数（会被 `leverageCap` 夹住）。 */
  readLeverageManual: () => number;
  /**
   * 该标的的**可用杠杆上限**（`min(策略上限, 币种级上限)`）。
   *
   * ⚠️ 每次决策现读 —— 币种级上限是交易所返回的，随标的不同。
   */
  readLeverageCap: () => number;
  /**
   * 保证金模式。
   *
   * ⚠️ 取值是 `'crossed'` 而**不是** `'cross'` —— 这是仓库既有约定
   *（`StrategyConfigSchema` 的 `marginMode: z.enum(['isolated','crossed'])`，
   * 见 `packages/shared/src/strategy.ts:317`）。写成 `'cross'` 会被
   * `Decision.marginMode` 的类型挡下来（tsc 会红，那正是它的价值）。
   */
  marginMode: 'isolated' | 'crossed';
}

/**
 * 计算三个候选档位。
 *
 * ## 为什么档位是"代码算、Jev 选"而不是"Jev 算"
 *
 * Jev **弱于算术**（实测：它能给出概率分布，但算不对精确价位）。
 * 让它算止损价，它会给一个看起来合理、实际会挂不上的数字 —— 那是**静默错误**，
 * 比没有决策更危险。
 *
 * ## 三档的口径
 *
 * ```
 *   仓位：按「单笔风险预算 ÷ 止损距离」反推，再取 0.6× / 1.0× / 1.4× 三档
 *   止损：按 ATR 的 1.0× / 1.5× / 2.0× 三档
 *   止盈：按 2:1 盈亏比算（配合每档自己的止损距离）
 * ```
 * ⇒ 三档**都是合法的**（都能通过风控），Jev 只决定"要多激进"。
 *
 * ## ⚠️ 方向从哪来（2026-10-19 修正）
 *
 * 原来用 `c.heldSide !== 'short'` 推方向 —— **那是在猜**：
 * 新建仓时 `heldSide` 是 `undefined`，于是永远推出 `dirLong = true`
 * ⇒ **只会开多仓**，空头机会全丢。
 *
 * 现在方向是**必填参数**，由 Jev 的 `direction` 答案决定
 *（`open_long` / `open_short`）。它同时决定止损在价的哪一侧。
 */
export function tiersFor(
  c: JevCandidate,
  opts: JevModeOptions,
  /**
   * 方向。**必填** —— 没有"默认多头"这回事（那正是原来的 bug）。
   */
  side: 'long' | 'short',
): Tiers {
  const dirLong = side === 'long';
  const atr = c.atr > 0 ? c.atr : c.price * 0.01;

  /* 单笔愿意亏的钱（USDT）。 */
  /*
   * ⚠️ **现读一次，本函数内复用** —— 一次决策里权益与风险比例不该变
   *（中途变了会让三档基于不同的基准算出来，那是静默的不一致）。
   */
  const equity = opts.readEquity();
  const riskUsd = Math.max(0.5, equity * opts.readRiskPercent());

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **止损距离必须有下限**（2026-10-19 实测抓到的真缺陷）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故
   *
   * 线上 `#13` 实测的决策（BTC 现价 81,094）：
   * ```
   *   止损距离 = 127.32  =  0.16% of price
   * ```
   * 而**单边手续费 + 滑点约 0.06%**（taker 0.05% + 滑点 0.01%）——
   * 一来一回就是 0.12%。**止损距离 0.16% 意味着价格稍微抖一下
   * 就打到止损，而那时连手续费都没赚回来。**
   *
   * ## 为什么 ATR 会这么小
   *
   * 不是 bug：**BTC 当时真的横盘**（实测真实 ATR(14) = 156.7 = 0.19%）。
   * ATR 是对的，错的是"直接用 ATR 当止损距离"这个做法 ——
   * **它假设波动永远大于交易成本，而横盘时那个假设不成立。**
   *
   * ## 修法
   *
   * 止损距离取 `max(ATR × 倍数, 价格 × 最小百分比)`。
   * 最小百分比定 **0.5%** —— 那是"覆盖 0.12% 成本后还剩 0.38% 缓冲"，
   * 且小于常见波动（1%~3%），不会把正常止损推得太远。
   *
   * ⚠️ **横盘时这个下限会让止损变宽**，于是仓位（按风险预算反推）会变小 ——
   * 那是正确的取舍：**横盘时要么不交易，要么用更小的仓位换更宽的止损。**
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **止损下限从 0.5% 提到 1.2%**（2026-10-19 实盘抓到）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 实盘症状（#14，07:36）
   *
   * ```
   *   SIRENUSDT 止损距离 0.6%
   *   AGTUSDT   止损距离 7.13%
   *   ZEREBROUSDT 止损距离 3.87%
   * ```
   * 那个 0.6% 就是 0.5% 下限 + ATR 略大一点的产物。
   *
   * ## 为什么 0.5% 不够
   *
   * ```
   *   单边 taker 手续费  0.05%
   *   来回手续费         0.10%
   *   滑点（市价单）     0.02–0.05%
   *   ─────────────────────────
   *   成本合计           0.12–0.15%
   * ```
   * 止损距离 0.5% 时，**扣掉成本只剩 0.35% 的实际空间** ——
   * 一根 15 分钟 K 线的正常噪音就能打掉它。
   *
   * 实测证据：`#14` 的第一笔 SIRENUSDT 就是在 0.6% 处被打掉的。
   *
   * ## 为什么定 1.2%
   *
   * ```
   *   1.2%  = 成本 0.15% + 缓冲 1.05%
   *   ⇒ 缓冲是成本的 7 倍，噪音打不掉
   *   ⇒ 而 1.2% 仍小于常见波动（2–5%），不会把止损推到"永远打不到"
   * ```
   *
   * ⚠️ **提高下限会让仓位变小**（风险预算 ÷ 更宽的止损）——
   * 那是正确的取舍：**要么用小仓位换合理的止损，要么不开**。
   */
  const MIN_STOP_PERCENT = 1.2;
  const minStopDistance = c.price * (MIN_STOP_PERCENT / 100);
  const stopDistance: Record<Tier, number> = {
    A: Math.max(atr * 1.0, minStopDistance),
    B: Math.max(atr * 1.5, minStopDistance),
    C: Math.max(atr * 2.0, minStopDistance),
  };

  const stop: Record<Tier, number> = {
    A: dirLong ? c.price - stopDistance.A : c.price + stopDistance.A,
    B: dirLong ? c.price - stopDistance.B : c.price + stopDistance.B,
    C: dirLong ? c.price - stopDistance.C : c.price + stopDistance.C,
  };

  /*
   * 止盈：按 **2:1** 盈亏比。
   * ⚠️ 用每一档**自己的**止损距离算 —— 否则 C 档（宽止损）会得到一个
   * 与它风险不匹配的过近止盈，等于让"激进"变成了"高风险低回报"。
   */
  /*
   * ⚠️ **盈亏比由用户配置决定，不再是写死的 2**（2026-10-19 用户要求）。
   *
   * 用户截图指出「盈亏比 1:1.33 低于要求的 1:1.5」而**设置里没有这一项** ——
   * 那个值来自策略配置（`minRiskRewardRatio: 1.5`），界面上改不了。
   *
   * ⇒ 现在它进了「JEV 模式」标签（`min_rr`），而且**止盈价按它算**：
   *   止盈距离 = 止损距离 × 该比值。
   *   于是盈亏比**恒等于用户设的值**，不可能再组合出 1:1.33 这种。
   */
  const rr = Math.max(0.5, opts.readMinRiskRewardRatio());
  const take: Record<Tier, number> = {
    A: dirLong ? c.price + stopDistance.A * rr : c.price - stopDistance.A * rr,
    B: dirLong ? c.price + stopDistance.B * rr : c.price - stopDistance.B * rr,
    C: dirLong ? c.price + stopDistance.C * rr : c.price - stopDistance.C * rr,
  };

  /*
   * 仓位：数量 = 风险预算 ÷ 止损距离，名义 = 数量 × 价格。
   * 再按 0.6 / 1.0 / 1.4 缩放成三档。
   *
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **必须有账户规模上限**（2026-10-19 线上实测抓到的硬 bug）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故
   *
   * `#13` 实跑时算出这些名义价值（账户只有 **21 USDT**）：
   * ```
   *   BTCUSDT  名义 244.47 U   ← 账户的 11.6 倍
   *   ETHUSDT  名义  97.60 U   ← 4.6 倍
   * ```
   * 幸好风控拒了，否则就是**用 21U 的账户下 244U 的单**。
   *
   * ## 根因
   *
   * 上面那个算式只按 ATR 反推，**完全没有上限**：
   * ```
   *   风险预算 0.21 U ÷ 止损距离(BTC 的 1.5×ATR = 1800) × 价格 108000
   *   = 0.21 / 1800 × 108000 ≈ 12.6 U 的"风险中性"仓位
   * ```
   * 但 BTC 的 ATR 相对价格很小（1.1%），所以"止损距离"小 ⇒ 反推出的名义巨大。
   * **波动小的标的会被反推出更大的仓位** —— 这正是该算式最危险的形状。
   *
   * ## 修法
   *
   * 取三个上限的最小值：
   * ```
   *   ① ATR 反推值（风险中性）
   *   ② 可用余额 × 杠杆（物理上限：买不起就是买不起）
   *   ③ 权益 × 30%（单笔占比上限：不把鸡蛋放一个篮子）
   * ```
   * ⚠️ 第 ③ 条是**新增的产品判断**，不是数学必然 —— 取 30% 是因为
   * `maxPositions: 4`，4 × 30% > 100% 意味着仍可能超配，
   * 但风控的 `maxMarginUsage` 会兜住。这个值可以调（见 `JEV_OPTIONS`）。
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **上限必须限制【保证金占用】而不是【名义价值】**
   *      （2026-10-19 实盘抓到，这是"risk_percent 30% 完全没生效"的根因）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 实盘症状（#14）
   *
   * ```
   *   配置：risk_percent = 30%   ⇒ 单笔该亏 25.59U
   *   实际：每笔亏 0.4–1.2U      ⇒ 只有设计的 4%
   *   所有仓位名义都是 15.35U（A 档 = 权益 × 30% × 0.6）
   * ```
   *
   * ## 根因：混淆了两个不同的概念
   *
   * ```
   *   ❌ 旧：名义价值 ≤ 权益 × 30%
   *          ⇒ 名义 25.59U，止损 7.11%，实际亏损只有 1.82U
   *
   *   ✅ 新：保证金占用 ≤ 权益 × 30%
   *          ⇒ 名义 = 权益×30% × 杠杆（17x 时 = 435U）
   *          ⇒ 止损 7.11% 时亏 31U ≈ 接近风险预算
   * ```
   *
   * **「风险」是亏损金额，「名义」是交易规模 —— 两者差一个止损距离。**
   * 用名义去限制风险，等于止损越宽、实际风险越小（方向正好反了）。
   *
   * ## 三道约束（全部保留，但语义修正）
   *
   * ```
   *   ① riskNeutralNotional —— 按风险预算反推（亏损 = riskUsd）
   *   ② physicalCap         —— 权益 × 杠杆上限（买得起）
   *   ③ marginCap           —— 保证金占用 ≤ 权益 × 30%（不把鸡蛋放一个篮子）
   *                           名义 = 权益×30% × 杠杆
   * ```
   * ⚠️ ③ 现在**乘上了杠杆** —— 那才是"用 30% 权益做保证金能开多大"。
   *
   * ## 为什么仍然要保留 ③
   *
   * 没有它，一个 17x 的标的会被反推出 `25.59 / 0.0278 = 920U` 名义
   *（保证金 54U = 权益的 63%）—— 单笔占用超过一半账户。
   * ③ 把保证金压在 30% 以内（= 25.59U 保证金，17x 时名义 435U）。
   *
   * ## ⚠️ 现在的实际风险会**变大**
   *
   * 之前每笔亏 0.4–1.2U，之后可能亏到 25U（30% 账户）。
   * 那是**用户配置的意图**（他明确说"激进能好测试它能力"），
   * 但这是真钱 —— 已在部署说明里告知。
   */
  const riskNeutralNotional = (riskUsd / stopDistance.B) * c.price;
  const leverageForCap = Math.max(1, Math.floor(opts.readLeverageCap()));
  /* ② 物理上限：买得起（权益 × 杠杆）。 */
  const physicalCap = equity * leverageForCap;
  /*
   * ③ 保证金占用上限：权益 × 30% 作为**保证金**，能开的名义 = 它 × 杠杆。
   * ⚠️ 这里必须用**实际杠杆**而不是上限 —— 否则 3x 的标的会被允许
   *   开 17x 才买得起的名义，保证金直接超配。
   */
  const actualLeverage = Math.max(1, Math.floor(opts.readLeverageManual()));
  const marginCap = equity * 0.3 * actualLeverage;
  const baseNotional = Math.max(
    0,
    Math.min(riskNeutralNotional, physicalCap, marginCap),
  );
  /*
   * ⚠️ **每一档都必须单独受上限约束**（2026-10-19 实测抓到）。
   *
   * 实测（账户 21U、上限 21×30% = 6.3U）：
   * ```
   *   A=3.78  B=6.30  C=8.82   ← C 档冲破了上限
   * ```
   * 因为 `baseNotional` 只把 **B 档** 截到上限，而 C 档是它的 1.4 倍。
   *
   * ⇒ 三档各自 `min(缩放值, 上限)`。这样 C 档最多等于上限，
   *   而 A/B 仍然保持"保守/中等"的相对关系。
   *
   * ⚠️ 代价：当上限生效时 C 档会等于 B 档（失去区分度）。
   *   那是**正确的取舍** —— 宁可两档相同，也不要突破风险上限。
   *   账户规模变大之后（上限不再生效）三档自然恢复区分。
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **仓位必须同时满足"上限"和"交易所最小名义"**（2026-10-19 线上抓到）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 症状
   *
   * 决策名义 **3.74 U**，交易所对 AGTUSDT/QUSDT/GTCUSDT 的
   * `MIN_NOTIONAL` 都是 **5 U** ⇒ **3.74 < 5 ⇒ 下单被拒**。
   * 日志里只写 `rejected`，看不到原因。
   *
   * ## 为什么算出 3.74
   *
   * ```
   *   21.2 U × 30%（单笔上限）= 6.36 U   ← B 档
   *   6.36 × 0.6（A 档缩放）= 3.82 U    ← 低于 5 U
   * ```
   * **小账户 + 三档缩放**必然产生"低于交易所门槛"的档位。
   *
   * ## 修法
   *
   * 三档都抬到 `max(缩放值, 交易所最小名义)`。
   * ⚠️ 但**抬升不能突破 `marginCap`** —— 否则小账户会为了"够最小名义"
   * 而超配。两者冲突时**宁可不交易**（返回 0，让风控拒绝）。
   *
   * ⚠️ 交易所最小名义用 `readMinNotional()` 现读（不同标的不同：
   * BTC 是 100 U，山寨币多为 5 U）。拿不到时退回 5 U（主流值）。
   */
  const minNotional = Math.max(1, opts.readMinNotional());
  const scale = { A: 0.6, B: 1.0, C: 1.4 } as const;
  const scaled: Record<Tier, number> = {
    A: Math.min(baseNotional * scale.A, marginCap),
    B: Math.min(baseNotional * scale.B, marginCap),
    C: Math.min(baseNotional * scale.C, marginCap),
  };
  const size: Record<Tier, number> = {
    /*
     * 抬到最小名义，但**不超过单笔上限** —— 两者冲突时给 0
     *（= 这个档位开不了仓，比"下了单被交易所拒"更早暴露）。
     */
    A: scaled.A >= minNotional ? scaled.A : marginCap >= minNotional ? Math.min(minNotional, marginCap) : 0,
    B: scaled.B >= minNotional ? scaled.B : marginCap >= minNotional ? Math.min(minNotional, marginCap) : 0,
    C: scaled.C >= minNotional ? scaled.C : marginCap >= minNotional ? Math.min(minNotional, marginCap) : 0,
  };

  return { size, stop, take, stopDistance, atr };
}

/**
 * **把 `state` 摘要拼出来** —— 这是 Jev 唯一能看到的东西。
 *
 * ## ⚠️ 为什么要同时给出【多空两套档位】（2026-10-19 修正）
 *
 * 第一版只给多头档位、并且把"做多"写死在摘要里：
 * ```
 *   我们正在评估做多（已有持仓方向决定，本次不改变方向）
 *   候选止损价档：A=…（1.0×ATR）   ← 这些数字是【多头】的止损
 * ```
 * 后果：**Jev 根本没有机会说"做空"** —— 它看到的所有数字都是多头的，
 * 而问题里也没有"做空"这个选项。于是整个模式只会开多仓。
 *
 * 现在把两套都摊开，让它**先选方向、再选档位**。
 * ⚠️ 顺序很重要：方向决定档位属于哪一侧，所以两套必须一起给出。
 */
export function buildState(
  c: JevCandidate,
  longTiers: Tiers,
  shortTiers: Tiers,
  /**
   * 可用杠杆范围（2026-10-19 用户要求）。
   *
   * ⚠️ **必须是"已经夹过"的真实范围**：`min(策略上限, 币种级上限)`。
   * 账户级限制（子账户 5x）事前读不到，只能靠 `setLeverage` 降级兜底 ——
   * 所以这里给的是一个**可能偏乐观的上界**，但**绝不会低于 1**。
   */
  leverageRange?: { min: number; max: number },
): string {
  const lines = [
    `标的 ${c.symbol}`,
    `当前价 ${c.price}`,
    `ATR14 = ${longTiers.atr.toFixed(6)}（占价 ${((longTiers.atr / c.price) * 100).toFixed(2)}%）`,
  ];
  if (c.change24hPercent !== undefined) lines.push(`24h 涨跌 ${c.change24hPercent.toFixed(2)}%`);
  if (c.displacementPercent !== undefined) {
    lines.push(`近3根位移 D = ${c.displacementPercent.toFixed(3)}%`);
  }
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **给「关系」而不是孤立数字**（2026-10-20 实盘事故）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故
   *
   * 一夜之间（下跌行情，BTC -1.54%、ETH -2.13%）：
   * ```
   *   做多 57 笔 → 净 -10.10（胜率 35%）
   *   做空  8 笔 → 净  +2.10（胜率 50%）
   *   ⇒ 它 88% 的时间在做多，而做空是赚钱的
   * ```
   *
   * ## 根因：它拿到的是一串孤立数字
   *
   * 原来 state 里写：
   * ```
   *   当前价 81458
   *   EMA20  82000
   *   RSI7 = 35
   *   24h 涨跌 -1.54%
   * ```
   * **这四个数之间的关系没有被说出来。** Jev 是分类器，不做算术 ——
   * 它无法从「81458 与 82000」推出「价格在均线下方 = 空头结构」。
   * 于是它看到的"跌了 1.54%"读成了"便宜了 → 抄底做多"，
   * 而不是"趋势向下 → 顺势做空"。
   *
   * ## 修法：把关系算好再说给它听
   *
   * ```
   *   ✗ EMA20 = 82000
   *   ✓ 价格在 EMA20 下方 0.66%（空头结构，做多为逆势）
   * ```
   * 这是**同一个事实的另一种表达**，而后者是可判断的结论。
   */
  if (c.rsi7 !== undefined) {
    /* RSI 的语义：越高越超买（追多风险大），越低越超卖（追空风险大）。 */
    const rsiNote =
      c.rsi7 >= 70 ? '（超买区，追多风险大）' : c.rsi7 <= 30 ? '（超卖区，追空风险大）' : '';
    lines.push(`RSI7 = ${c.rsi7.toFixed(1)}${rsiNote}`);
  }
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **趋势判断必须用 ATR 归一化，不能用固定百分比阈值**
   *      （2026-10-20 第二次修正：第一版用 0.1% 固定阈值是错的）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么 0.1% 这种固定阈值不可用
   *
   * 同一时刻实测各标的「价格 - EMA20」偏离：
   * ```
   *   BTCUSDT    -0.10%   （ATR 0.19%）
   *   ETHUSDT    -0.18%   （ATR 0.30%）
   *   SOLUSDT    -0.16%   （ATR 0.32%）
   *   PHAUSDT    -2.48%   （ATR 2.08%）
   *   JCTUSDT   +21.60%   （ATR 6.18%）
   * ```
   * **主流币的偏离天然就小**（价格紧贴均线，那是它们"有效"的表现），
   * 而垃圾币随便就偏离 20%。一个固定的 0.1% 阈值对前者是"刚跨过线"、
   * 对后者是"差了两个数量级" —— **两者根本不可比**。
   *
   * ## 修法：除以 ATR
   *
   * ```
   *   标准化强度 = (价格 - EMA20) / ATR
   *
   *   BTC:  -0.10% / 0.19% = -0.53  （弱）
   *   ETH:  -0.18% / 0.30% = -0.60  （弱）
   *   PHA:  -2.48% / 2.08% = -1.19  （中）
   *   JCT:  +21.6% / 6.18% = +3.49  （强）
   * ```
   * 这才是可比的量。而且它有一个直观含义：
   * **"价格偏离均线多少个 ATR"** —— `±1 ATR` 是常见的，`±3 ATR` 是极端。
   *
   * ## 三档判据
   *
   * ```
   *   |强度| < 0.5  → 中性（贴着均线，方向不明 —— 不要假装看得出趋势）
   *   0.5 ≤ 强度 < 1.5 → 温和多头/空头
   *   强度 ≥ 1.5      → 强多头/空头
   * ```
   * ⚠️ **中性档必须保守**：这个模式的底线是"宁可少做，不要假装有信号"。
   * 上一版把 -0.15% 判成"空头结构"就是过度解读 —— 那点偏离在
   * BTC 的 ATR（0.19%）里还不到 1 个 ATR。
   */
  if (c.ema20 !== undefined && c.ema20 > 0 && c.atr > 0) {
    const deviationPercent = ((c.price - c.ema20) / c.ema20) * 100;
    /* 标准化趋势强度：偏离了几个 ATR。 */
    const atrPercent = (c.atr / c.price) * 100;
    const trendStrength = atrPercent > 0 ? deviationPercent / atrPercent : 0;
    const absStrength = Math.abs(trendStrength);

    /* 文字要读得通：中性时不能拼成「中性（…）趋势」这种。 */
    const strengthText = absStrength < 0.5 ? '中性' : absStrength < 1.5 ? '温和趋势' : '强趋势';
    const directionText =
      absStrength < 0.5
        ? ''
        : deviationPercent > 0
          ? '多头结构（顺势做多；做空是逆势）'
          : '空头结构（顺势做空；做多是逆势）';

    lines.push(
      `EMA20 = ${c.ema20 < 1 ? c.ema20.toFixed(6) : c.ema20 < 100 ? c.ema20.toFixed(3) : c.ema20.toFixed(2)} —— ` +
        `价格在均线${deviationPercent >= 0 ? '上方' : '下方'} ${Math.abs(deviationPercent).toFixed(2)}%` +
        `（= ${absStrength.toFixed(2)} 倍 ATR，${strengthText}）` +
        (directionText === '' ? '，方向不明 —— 不要假设有趋势' : `：${directionText}`),
    );
  }

  /*
   * ⚠️ **盈亏比文字必须是真实配置值，不能写死 2:1**（2026-10-20 实盘抓到）。
   *
   * 实盘证据：用户把 `min_rr` 从 2 改成 2.5 后，
   * ```
   *   state 里仍写「候选止盈价档（2:1 盈亏比）」
   *   而实际止盈价是按 2.5 算的
   * ```
   * Jev 会照文字理解（"2:1"），于是它对"值不值得做"的判断与真实盈亏比脱节 ——
   * 那正是它在这段行情里一直做多的原因之一：它以为自己拿的是 2:1，
   * 而实际结构已经是 2.5:1。
   *
   * ⇒ 文案与算式必须同源（都用 `rr`）。
   */
  /*
   * 盈亏比从**档位本身**反推，而不是再读一次配置。
   *
   * 理由：`buildState` 收到的 `longTiers`/`shortTiers` 已经是算好的价，
   * 从它们反推出的 rr 就是**这一轮真正生效的**那个值 ——
   * 再读一次配置只可能引入"文案与算式不同源"的新分叉。
   * 那正是这条注释上面记着的那个 bug。
   */
  const rrForText = (() => {
    const risk = Math.abs(shortTiers.stop.B - shortTiers.take.B);
    const reward = Math.abs(shortTiers.take.B - shortTiers.stop.B);
    void risk;
    void reward;
    /*
     * 更直接：用做空 B 档的 (止盈 - 止损) / (止损 - 价格基准)。
     * 但 `buildState` 拿不到 price 之外的原始止损距离 ——
     * 所以用 A/B 两档的止盈差与止损差之比，两档用的是同一个 rr：
     *   (take.B - take.A) / (stop.B - stop.A) = rr
     */
    const stopDelta = Math.abs(shortTiers.stop.B - shortTiers.stop.A);
    const takeDelta = Math.abs(shortTiers.take.B - shortTiers.take.A);
    return stopDelta > 0 ? Math.max(0.5, takeDelta / stopDelta) : 2;
  })();
  const tierLine = (label: string, t: Tiers, verb: string): string[] => [
    `${verb}候选仓位档（名义价值，已按风险预算算好）：` +
      `A=${t.size.A.toFixed(2)}U  B=${t.size.B.toFixed(2)}U  C=${t.size.C.toFixed(2)}U`,
    `${verb}候选止损价档：` +
      `A=${t.stop.A.toFixed(6)}（1.0×ATR）  B=${t.stop.B.toFixed(6)}（1.5×ATR）  C=${t.stop.C.toFixed(6)}（2.0×ATR）`,
    `${verb}候选止盈价档（${rrForText.toFixed(1)}:1 盈亏比）：` +
      `A=${t.take.A.toFixed(6)}  B=${t.take.B.toFixed(6)}  C=${t.take.C.toFixed(6)}`,
  ];

  lines.push('', ...tierLine('做多', longTiers, '【做多】'), '', ...tierLine('做空', shortTiers, '【做空】'));

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  **账户状态**（2026-10-19 用户要求）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户原话：
   * > 「给JEV 判断里面现在有没有实际仓位？（如果开很多仓位了JEV不知道
   * >  又一直要开仓的情况，你研究一下到底要投喂哪些数据最合理）」
   *
   * ## 放在"标的"之后、"杠杆范围"之前
   *
   * 顺序的理由：先看"这个标的长什么样"（事实），再看"我还有多少余地"
   * （约束），最后是"你能选多少杠杆"（最细的约束）。
   *
   * ## ⚠️ 每条都给【结论】而不是原始数字
   *
   * Jev 不擅长算术。所以：
   * ```
   *   ✗ 「持仓 1、上限 4」      → 它要自己减
   *   ✓ 「还能开 3 个」         → 直接可用
   * ```
   * 两者都给（原始 + 结论）—— 原始数字让它理解"为什么"，
   * 结论让它**不用算**。
   */
  if (c.account !== undefined) {
    const a = c.account;
    lines.push('', '【账户状态】');
    lines.push(
      `权益 ${a.equity.toFixed(2)}U · 已用保证金 ${a.marginUsedPercent.toFixed(1)}%` +
        `（上限 ${a.marginLimitPercent}%）`,
    );
    lines.push(`当前持仓 ${a.openPositions}/${a.maxPositions} 个 · **还能开 ${a.canOpenMore} 个**`);
    lines.push(
      `本轮已开 ${a.entriesThisCycle}/${a.maxEntriesPerCycle} 个 · ` +
        `本小时已开 ${a.entriesThisHour}/${a.maxEntriesPerHour} 个`,
    );
    if (a.heldSymbols !== undefined && a.heldSymbols.length > 0) {
      const heldText = a.heldSymbols
        .map((h) => `${h.symbol}（${h.side === 'long' ? '多' : '空'}）`)
        .join('、');
      lines.push(`已持仓标的：${heldText} —— 这些不要再开同方向的仓`);
    }
    /*
     * ⚠️ **额度用完时明说**。
     *
     * 不说的话 Jev 仍然会提议开仓（它看到机会就想做），
     * 而风控会全部拒掉 —— 日志里一堆 `rejected`，看起来像风控在跟模型作对。
     * 说清了它就会主动选 `skip`，那一轮的日志就是干净的"额度用完"。
     */
    if (a.canOpenMore <= 0) {
      lines.push('⚠️ 持仓数已达上限 —— 本轮只能平仓或跳过，不能再开新仓。');
    } else if (a.entriesThisCycle >= a.maxEntriesPerCycle) {
      lines.push('⚠️ 本周期开仓额度已用完 —— 本轮只能平仓或跳过。');
    } else if (a.entriesThisHour >= a.maxEntriesPerHour) {
      lines.push('⚠️ 本小时开仓额度已用完 —— 本轮只能平仓或跳过。');
    } else {
      const room = Math.min(
        a.canOpenMore,
        a.maxEntriesPerCycle - a.entriesThisCycle,
        a.maxEntriesPerHour - a.entriesThisHour,
      );
      lines.push(
        `⇒ **本轮最多能开 ${room} 个新仓**（取持仓上限、本周期额度、本小时额度三者中最小的）。` +
          '如果要开多个，请优先挑机会最好的那几个。',
      );
    }
  }

  /*
   * 杠杆范围放**最后一行**：它是"你能选多少"的约束，
   * 而前面都是"这个标的长什么样"的事实。先事实、后约束。
   */
  if (leverageRange !== undefined) {
    lines.push(
      '',
      `可用杠杆 ${leverageRange.min}–${leverageRange.max}x` +
        `（取「策略上限」与「交易所对该币种上限」中较小的那个；账户级限制可能更低）`,
    );
  }
  return lines.join('\n');
}

/**
 * **把 baseUrl 拼成 `/v1/systemone` 的完整地址**。
 *
 * ## 为什么要单独抽成一个函数（2026-10-19 线上实测踩到）
 *
 * `resolveTeamGateway()` 返回的 baseUrl **已经带 `/v1`**：
 * ```
 *   实测值：http://127.0.0.1:3425/v1
 *   我的第一版：`${baseUrl}/v1/systemone`  ⇒  /v1/v1/systemone  ⇒  HTTP 404
 * ```
 *
 * 而那个 404 的正文把正确路径列了出来（"magpie serves … /v1/systemone …"）
 * —— 错误信息里已经有答案，只是拼接重复了。
 *
 * ⚠️ 这个 bug 的类型是**最容易漏的那种**：单元测试全绿、typecheck 全绿、
 * 构建全绿，**只有真的打一次网络才会现形**。所以把它抽成纯函数，
 * 让 `jevModel.test.ts` 能钉住"带不带 `/v1` 都拼成同一个地址"。
 */
export function jevEndpointUrl(baseUrl: string): string {
  /* 先剥尾部斜杠，再剥尾部的 `/v1`，最后自己加一次 —— 两种形状都对。 */
  const origin = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${origin}/v1/systemone`;
}

/**
 * 一次 HTTP 问五个问题。
 *
 * ## ⚠️ `criteria` 的形状**因 type 而异**（实测踩过两次 422）
 *
 * ```
 *   score  → 数组    ["很差","较差","一般","较好","很好"]
 *   choice → 字典    {"A":"…","B":"…","C":"…"}
 * ```
 * 写反了会 422，报错是 `Input should be a valid dictionary/list`。
 *
 * ## 为什么五个问题放一次调用
 *
 * 实测：五问一次 408ms、966 input tokens。拆成五次调用是 5 倍开销与 5 倍超时风险，
 * 而且**方向与档位本来就该在同一个上下文里一起判断**（分开问会让止损档与方向脱节）。
 */
export async function askJev(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      /*
       * ⚠️⚠️ **方向必须是三选一，不是"执行/跳过"二选一**（2026-10-19 修正）。
       *
       * 第一版写的是 `{ open: '执行', skip: '跳过' }`，然后代码里
       * `action: 'open_long'` 写死 —— 结果**只会开多仓**，空头机会全丢。
       * 用户问「JEV 模式下…其他的操作会吗」时我查代码才发现。
       *
       * 现在方向由 Jev 直接选，代码不再猜。
       */
      direction: {
        type: 'choice',
        /*
         * ⚠️ **用肯定句**：Jev 官方明确说它对否定句的读取不可靠
         *（见 `docs/JEV-README.md` 的实测记录）。
         */
        instructions:
          '根据上面给出的数字，现在应该做多、做空，还是跳过？' +
          '注意：【做多】的止损在价格下方、止盈在上方；【做空】反之。',
        criteria: {
          open_long: '做多（用【做多】那一组档位）',
          open_short: '做空（用【做空】那一组档位）',
          skip: '跳过（这次不做）',
        },
      },
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **开仓方式：让 Jev 判断**（2026-10-19 用户要求）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 用户原话：「要加一个 让JEV判断」（指着「开仓方式」那个下拉框）。
       *
       * ## 它为什么值得问
       *
       * ```
       *   市价   → 立刻成交，付 taker 手续费 + 滑点
       *   限价   → 挂单等回调，省手续费（maker），但可能等不到
       * ```
       * 两者的差别是**「这个机会会不会自己回来」** —— 而那是能从
       * 「动量强度 / 离均线多远 / 24h 涨跌幅」里读出来的判断：
       * ```
       *   已经涨了 5%、远离均线 ⇒ 大概会回调，值得等（限价）
       *   刚突破、动量强       ⇒ 不会回来了，别等（市价）
       * ```
       *
       * ⚠️ 我之前的说法（「Jev 看不到盘口深度，判断不了」）**只对了一半**：
       * 它确实看不到盘口，但"会不会回调"更多取决于**趋势强度**而不是盘口。
       * 用户要的是让 Jev 试，那就问它 —— 并且**在文案里说清它不知道什么**。
       */
      ...(opts.readEntryType() === 'jev'
        ? {
            entry_style: {
              type: 'choice' as const,
        instructions:
          '如果要开仓，用哪种下单方式？' +
          '【市价】立刻成交，付手续费和滑点，但一定进得去；' +
          '【限价】挂在当前价回退 0.3% 的位置等回调，省手续费，但可能等不到而错过。' +
          '判断依据：如果这波动量很强（刚突破、24h 涨跌大、远离均线），回调概率低，该用市价；' +
          '如果已经涨/跌了很多、离均线很远，回调概率高，值得等。',
        criteria: {
          market: '市价（立刻成交，不等回调）',
              limit: '限价（等回调 0.3%，可能等不到）',
            },
          },
        }
        : {}),
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **杠杆：让 Jev 判断**（2026-10-19 用户要求）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 用户原话：「自动模式：让JEV自己去判断要用多少杠杆，
       *           当然系统也要把当前币种\钱包可用杠杆范围告诉JEV」
       *
       * ## ⚠️ 这一问只在「自动模式」下才发
       *
       * 手动模式时杠杆由用户滑杆决定，问它没有意义（还会浪费 token）。
       * 由调用方在 `buildQuestions()` 里按配置决定要不要加这一问。
       *
       * ## ⚠️ 它看到的范围是【已经夹过的】
       *
       * `state` 里的「可用杠杆 1–Nx」里的 N = `min(策略上限, 币种级上限)`。
       * 所以 Jev 不可能选出一个"账户不允许"的值 ——
       * 账户级限制（子账户 5x）仍然靠 `setLeverage` 的降级兜底。
       */
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **保证金模式：让 Jev 判断**（2026-10-19 用户要求）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 用户原话：「开仓的保证金模式也要做到设置里面 3个都要 逐仓 全仓 JEV判断」
       *
       * ## 它该看什么
       *
       * ```
       *   逐仓 → 一个仓爆仓只亏那一笔保证金（隔离风险）
       *   全仓 → 所有仓位共用账户余额（单笔爆仓会动用全部资金）
       * ```
       * ⇒ 波动大（ATR 占比高）时该选逐仓；波动小、把握大时可以选全仓
       *（全仓能用上更多可用余额，不容易被单笔强平）。
       *
       * ⚠️ **只在配置是 `jev` 时才问** —— 手动模式问它没有意义。
       */
      ...(opts.readMarginMode() === 'jev'
        ? {
            margin_style: {
              type: 'choice' as const,
              instructions:
                '这个标的该用逐仓还是全仓？' +
                '【逐仓】每个仓位独立结算，一个仓爆仓只亏那一笔的保证金；' +
                '【全仓】所有仓位共用账户余额，单笔爆仓会动用到全部资金，但也不容易被单笔强平。' +
                '判断依据：波动大（ATR 占比高）、把握不大时用逐仓；波动小、把握大时全仓更抗噪。',
              criteria: {
                isolated: '逐仓（风险隔离，推荐）',
                crossed: '全仓（共用余额）',
              },
            },
          }
        : {}),
      ...(opts.readLeverageMode() === 'jev'
        ? {
            leverage: {
              type: 'score' as const,
              /*
               * ⚠️ **给具体数字，不给形容词**（2026-10-19 实盘后修正）。
               *
               * 原来写的是「分数越高越激进」+「波动大的标的要用小杠杆」——
               * 实测它选出来全是 3–7x，因为**"激进"这个词对分类器没有可操作含义**。
               *
               * 现在把杠杆换算成**它能理解的具体后果**：
               * ```
               *   4x  → 价格反向 25% 才爆仓
               *   20x → 价格反向 5% 就爆仓
               * ```
               * 那是同一个事实的不同表达，而后者是**可计算的因果**，
               * Jev 对它的判断比"激进"这种主观词稳得多。
               *
               * ⚠️ 反推公式：`爆仓距离 ≈ 100 / 杠杆`（逐仓、忽略维持保证金）。
               * 那是近似值，但**方向正确、数量级正确**，足够当判断依据。
               */
              instructions:
                '这个标的该用多大的杠杆？分数越高杠杆越大。' +
                '杠杆的实际含义是**爆仓距离**：4x ⇒ 价格反向约 25% 才爆仓；' +
                '10x ⇒ 反向 10% 爆仓；20x ⇒ 反向 5% 就爆仓。' +
                '判断依据：如果 ATR 占价超过 5%（波动很大），' +
                '一根 K 线就可能走 3–5%，那时 20x 会在正常波动里被强平，该选低分；' +
                '如果 ATR 只占 1–2%（波动温和），高杠杆不会因噪音爆仓，可以选高分。' +
                '【可用杠杆范围见上面 state 的账户状态之后那一行，不要超出它】',
              criteria: ['最保守（最低档）', '偏保守', '中等', '偏激进', '最激进（最高档）'],
            },
          }
        : {}),
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **`size_tier` 曾被误删**（2026-10-19 线上抓到，8/8 全失败）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故
       *
       * ```
       * 00:15:23 [Jev模式] 候选 8 · 开仓 0 · 失败 8
       * 00:15:23 ETHUSDT Jev 的档位答案无法识别：size=undefined stop="B" take="A"
       * ```
       * 每个标的都返回 `size=undefined` —— 因为**这个问题根本不在请求里**，
       * Jev 当然不会答它。
       *
       * ## 根因
       *
       * 我加 `entry_style` 时用 `size_tier: {` 作锚点做字符串替换，
       * 结果把 `size_tier` 整块替换掉了 —— 它从 `questions` 里消失了。
       *
       * ## 教训
       *
       * `questions` 的每一项都是**必需**的（下游 `asTier()` 拿不到就判失败）。
       * 以后往里插内容必须用"在某项**之前/之后**插入"的写法，
       * 而不是"替换某一项的开头"—— 后者一旦漏掉闭合就会吃掉整块。
       */
      size_tier: {
        type: 'choice',
        instructions: '如果要做，用哪一个仓位档？A 最保守，C 最激进。',
        criteria: { A: 'A 档（最保守）', B: 'B 档（中等）', C: 'C 档（最激进）' },
      },
      stop_tier: {
        type: 'choice',
        instructions: '如果要做，止损放在哪一个档？A 最近（1.0×ATR），C 最远（2.0×ATR）。',
        criteria: { A: 'A 档 1.0×ATR', B: 'B 档 1.5×ATR', C: 'C 档 2.0×ATR' },
      },
      take_tier: {
        type: 'choice',
        instructions: '如果要做，止盈放在哪一个档？A 最近，C 最远。',
        criteria: { A: 'A 档（最近）', B: 'B 档（中等）', C: 'C 档（最远）' },
      },
      setup: {
        type: 'score',
        instructions: '这个机会本身的强度如何？',
        criteria: ['很差', '较差', '一般', '较好', '很好'],
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  /*
   * ⚠️⚠️ **`baseUrl` 可能已经带 `/v1`**（2026-10-19 实测踩到）。
   *
   * `resolveTeamGateway()` 返回的是**团队模式用的出口**，而团队调的是
   * `/v1/chat/completions` —— 所以它给的 baseUrl 已经含 `/v1`：
   * ```
   *   实测：http://127.0.0.1:3425/v1
   *   我的第一版：`${baseUrl}/v1/systemone` ⇒ /v1/v1/systemone ⇒ HTTP 404
   * ```
   * 而 404 的正文是「magpie serves /v1/chat/completions, …, /v1/systemone, …」
   * —— 它明确告诉我正确路径是 `/v1/systemone`，只是我拼重复了。
   *
   * ⇒ 统一成"**先剥掉尾部的 `/v1`，再自己加 `/v1/systemone`**"。
   *   这样两种形状（带或不带 `/v1`）都对。
   */
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });

  if (!res.ok) {
    /* 读一小段正文 —— 形状变了/额度问题都靠它才看得见（不要把错误吞成"没有决策"）。 */
    const text = await res.text().catch(() => '');
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as JevResponse;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **P1：已有持仓的「继续持有 / 平掉」判断**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么需要它
 *
 * 第一版对已有持仓**直接跳过、根本不问 Jev**：
 * ```
 *   if (c.heldSide !== undefined) return '已有持仓，本模式不叠加'
 * ```
 * 后果：一台 JEV 模式的机器人开完仓之后就**再也不做任何判断**，
 * 只能等交易所侧的止损/止盈触发。那不是"Jev 自主交易"，
 * 那是"开仓后交给保护单"。
 *
 * ## ⚠️ 边界：这只是**提议**，不是命令
 *
 * 平仓决策仍然要走 `RiskEngine.reviewClose()`（`docs/AGENTS.md` §2.1：
 * 风控是通往订单的唯一路径）。本函数只回答"Jev 想不想平"，
 * **不直接下单、不撤保护单**。
 *
 * ⚠️ 而且**保护单必须先撤**才手动平仓（§2.7：`closePosition=true` 的条件单
 * 在手动平仓后依然存活，会朝反方向开出新仓）。那个撤单由既有平仓路径负责。
 */
export async function askJevForPosition(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      /*
       * ⚠️ **动作从 2 个扩展到 4 个**（2026-10-19 补「允许加减仓」）。
       *
       * 用户要求加减仓能力。系统本来就支持（`DecisionActionSchema` 有
       * `add_to_position` / `reduce_position`），只是 Jev 从来没被问过。
       *
       * ⚠️ **顺序很重要**：`hold` 放第一位。Jev 的 `choice` 在平局时倾向
       * 选第一个 —— 而"什么都不做"是**最安全的默认**。
       */
      action: {
        type: 'choice',
        instructions:
          '这个仓位现在该怎么做？' +
          '注意：止损止盈单已经在交易所挂着。',
        criteria: {
          hold: '继续持有（让止损止盈单继续工作）',
          add: '加仓（这个机会还在，值得加）',
          reduce: '减仓（锁定一部分利润，但留着仓位）',
          close: '全部平掉（理由已经不存在了）',
        },
      },
      conviction: {
        type: 'score',
        instructions: '你对"继续持有"的信心有多强？',
        criteria: ['很弱', '较弱', '一般', '较强', '很强'],
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as JevResponse;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **P2：移动止损（trailing stop）的判断**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么需要它
 *
 * 第一版**挂上止损之后再也不动**。后果：
 * ```
 *   一个已经浮盈 3% 的仓位，止损还在 -1.5×ATR 那里
 *   ⇒ 一次正常回调就把利润全吐回去（那正是"追高"亏钱的主要形态）
 * ```
 *
 * ## ⚠️ 边界（三条硬约束）
 *
 * ```
 * ① 只能【收紧】，不能【放宽】 —— 放宽止损等于增加风险，那必须由人决定
 * ② 必须走 RiskEngine（风控是通往订单的唯一路径）
 * ③ 新的止损必须在【盈利方向】上 —— 绝不允许把止损移到开仓价之外
 * ```
 *
 * 第 ③ 条尤其重要：如果 Jev 说"把多头止损移到开仓价下方很远"，
 * 那是**放宽**，必须拒掉。
 */
export async function askJevForTrailingStop(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      move_stop: {
        type: 'choice',
        instructions:
          '这个仓位已经有浮盈了。止损要不要往盈利方向收紧？' +
          '注意：只能收紧（离当前价更近），不能放宽。',
        criteria: {
          keep: '保持原止损不动',
          tighten: '收紧止损（锁定一部分利润）',
        },
      },
      how_much: {
        type: 'choice',
        instructions: '如果要收紧，收紧到哪一档？（三档都已算好）',
        criteria: {
          A: 'A 档（最保守，只锁一点点）',
          B: 'B 档（中等）',
          C: 'C 档（最激进，锁住大部分利润）',
        },
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as JevResponse;
}

/**
 * **标的名的稳定哈希**（2026-10-19）。
 *
 * 用途：让「持仓检查频率」在多持仓时**错开问询** ——
 * 用 `(轮次 + 哈希) % N` 而不是所有持仓同一个节奏。
 *
 * ⚠️ 必须是**确定性**的（同一标的名永远同一个值），否则节奏会乱跳。
 * 这里用一个简单的 FNV-1a 变体 —— 只需要分布均匀，不需要密码学强度。
 */
function hashSymbol(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * **解析本轮该用的杠杆**（2026-10-19 用户要求）。
 *
 * ## 两种模式
 *
 * ```
 *   manual → 用用户滑杆设的值
 *   jev    → 用 Jev 的 score 换算成范围内的档位
 * ```
 *
 * ## ⚠️ 无论哪种模式，最后都 `clamp` 到 `[1, cap]`
 *
 * `cap = min(策略上限, 币种级上限)`。
 * 用户把滑杆拉到 20x 而交易所只允许 10x 时，这里就会降到 10x ——
 * **不靠"界面上限"来保证正确性**（那可以被绕过），而在这里兜住。
 *
 * ⚠️ 账户级限制（子账户 5x）这里**看不到** —— 它由 `broker.setLeverage()`
 * 的 `-4421` 降级处理（`parseAdmittedLeverage` 从报错里挖真实上限）。
 *
 * @param score Jev 的 score（0–4）；手动模式传 `undefined`
 */
/**
 * **解析本轮该用的开仓方式**（2026-10-19 用户要求「让 JEV 判断」）。
 *
 * ```
 *   market → 市价（立刻成交）
 *   limit  → 限价（等回调 0.3%）
 *   jev    → 看 Jev 对 `entry_style` 的答案
 * ```
 *
 * ⚠️ Jev 没给答案时**退回市价** —— "一定进得去"比"省一点手续费"更重要：
 * 一个没成交的限价单等于什么都没做，而机会已经过去了。
 */
function resolveEntryType(
  opts: JevModeOptions,
  jevChoice: string | undefined,
): 'market' | 'limit' {
  const configured = opts.readEntryType();
  if (configured !== 'jev') return configured === 'limit' ? 'limit' : 'market';
  return jevChoice === 'limit' ? 'limit' : 'market';
}

/**
 * **解析本轮该用的保证金模式**（2026-10-19 用户要求）。
 *
 * ```
 *   isolated → 逐仓
 *   crossed  → 全仓
 *   jev      → 看 Jev 对 `margin_style` 的答案
 * ```
 *
 * ⚠️ Jev 没给答案时**退回逐仓** —— 那是更保守的一侧：
 * 全仓会让单笔爆仓动用到全部资金，不该因为"模型没答"而默认选它。
 */
function resolveMarginMode(
  opts: JevModeOptions,
  jevChoice: string | undefined,
): 'isolated' | 'crossed' {
  const configured = opts.readMarginMode();
  if (configured !== 'jev') return configured === 'crossed' ? 'crossed' : 'isolated';
  return jevChoice === 'crossed' ? 'crossed' : 'isolated';
}

function resolveLeverage(
  opts: JevModeOptions,
  score: number | undefined,
  symbol?: string,
): number {
  /*
   * ⚠️ **逐标的收紧**（2026-10-19）。
   *
   * `readLeverageCap()` 给的是**两类中较宽的那个**（20x）——
   * 因为 `buildJevModeModel()` 拿不到具体标的。
   * 而策略里 BTC/ETH 是 20x、山寨币是 10x：
   * ```
   *   若只按 20x 走，一个山寨币会被允许开到 20x —— 那是策略配置的两倍
   * ```
   * ⇒ 在这里按 `symbol` 再收一次。
   *
   * ⚠️ 山寨币的 10x 是**硬编码的保守值**，与 `defaultJevConfig()` 的
   * `altcoinMaxLeverage: 10` 对齐。它不随用户改策略而变 ——
   * 因为 JEV 模式用的是 `defaultJevConfig()`，不引用 `strategies` 表。
   */
  const isMajor = symbol !== undefined && /^(BTC|ETH)USDT$/.test(symbol);
  const cap = Math.max(1, Math.floor(isMajor ? opts.readLeverageCap() : Math.min(10, opts.readLeverageCap())));
  const mode = opts.readLeverageMode();

  if (mode !== 'jev') {
    return Math.min(cap, Math.max(1, Math.floor(opts.readLeverageManual())));
  }

  /*
   * Jev 的 `score` 是 0–4（5 档）。换算成范围内的等分档：
   * ```
   *   score 0 → 1x（最保守）
   *   score 4 → cap（最激进）
   * ```
   * ⚠️ 用 `round` 而不是 `floor` —— 否则 score=4 时永远到不了 cap。
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **杠杆映射改成"下限更高的分段"**（2026-10-19 实盘抓到）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 实盘症状
   *
   * ```
   *   Jev 选出的杠杆：3x / 4x / 4x / 4x / 6x / 6x / 7x
   *   配置范围：1–20x
   * ```
   * 全都挤在低端 —— 不是它不想选高，而是**映射把它的分数压小了**。
   *
   * ## 根因
   *
   * Jev 的 `score` 是 0–4，但它**实测倾向于给中间偏低的分数**
   *（0.5–1.5）—— 那是分类器的固有特性：它对"最激进"这种标签很谨慎。
   *
   * 而原来的线性映射：
   * ```
   *   score 0 → 1x      score 1 → 5.75x
   *   score 2 → 10.5x   score 4 → 20x
   * ```
   * 于是 score=1（它的常见值）只给到 5.75x。
   *
   * ## 新映射：抬高下限、保持上限
   *
   * ```
   *   score 0   → 25% cap   （守着"最保守"的语义，但不是 1x 那种无意义的小）
   *   score 1   → 40% cap
   *   score 2   → 60% cap
   *   score 3   → 80% cap
   *   score 4   → 100% cap
   * ```
   * cap=20 时：`5x / 8x / 12x / 16x / 20x`。
   *
   * ⚠️ **为什么 score=0 不是 1x**：
   * 1x 杠杆在合约里几乎等于"不用杠杆"，但那不是"最保守"的合理表达 ——
   * 真正的保守是**小仓位**（`size_tier` 已管这件事），不是把杠杆压到 1x。
   * 杠杆的作用是"占用多少保证金"，1x 会让保证金占用爆增。
   *
   * ⚠️ **为什么仍然保留 25% 的下限而不是 50%**：
   * 极端行情（ATR > 8%）下低杠杆确实更安全，25% × 20 = 5x 仍留了那个空间。
   */
  const LEVERAGE_CURVE = [0.25, 0.4, 0.6, 0.8, 1.0] as const;
  if (score === undefined || !Number.isFinite(score)) {
    /* Jev 没给分数 ⇒ 退到中间（60% cap），不猜"最激进"。 */
    return Math.min(cap, Math.max(1, Math.round(cap * 0.6)));
  }
  const clamped = Math.min(4, Math.max(0, score));
  /* 在相邻两个锚点之间线性插值 —— score 可能是 1.37 这种小数。 */
  const lo = Math.floor(clamped);
  const hi = Math.min(4, lo + 1);
  const frac = clamped - lo;
  const ratio = LEVERAGE_CURVE[lo]! + (LEVERAGE_CURVE[hi]! - LEVERAGE_CURVE[lo]!) * frac;
  return Math.min(cap, Math.max(1, Math.round(cap * ratio)));
}

/** `choice` 的答案收窄成 `Tier`；认不出就返回 
ull`（**不猜**）。 */
function asTier(v: string | undefined): Tier | null {
  if (v === 'A' || v === 'B' || v === 'C') return v;
  return null;
}

/** `confidence` 是 0–1 小数，而 `Decision.confidence` 是 0–100。 */
function confidenceToPercent(raw: number | undefined): number | null {
  if (raw === undefined || !Number.isFinite(raw)) return null;
  /* 钳到 [0,1] 再 ×100 —— 超界时**不丢样本**，只钳制。 */
  const clamped = Math.min(1, Math.max(0, raw));
  return Math.round(clamped * 100);
}

/** `score` 的答案（0..n-1）换算成 0–100。`legend` 的长度就是刻度数。 */
function setupScoreToPercent(a: JevAnswer | undefined): number | null {
  if (a === undefined || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  const scale = a.legend !== undefined ? Object.keys(a.legend).length - 1 : 4;
  if (scale <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, a.score / scale)) * 100);
}

/**
 * 一个标的的完整决策。
 *
 * 返回 
ull` = **本轮不开仓**（Jev 说跳过，或它的答案形状不对）。
 * 后者要写 warn —— 那是"网关侧形状变了"，不是业务结论。
 */
export interface JevDecisionOutcome {
  /** 组装好的决策（
ull` = 跳过）。 */
  decision: {
    symbol: string;
    action:
      | 'open_long'
      | 'open_short'
      | 'close_long'
      | 'close_short'
      | 'add_to_position'
      | 'reduce_position';
    leverage: number;
    positionSizeUsd: number;
    /**
     * 止损/止盈价。
     *
     * ⚠️ **平仓决策不需要它们** —— `close_long` / `close_short` 不带保护单
     *（平仓之后原来的保护单会被撤掉，见 `docs/AGENTS.md` §2.7）。
     * 所以类型是 
umber | null`，而不是强制要求一个数。
     */
    stopLoss: number | null;
    takeProfit: number | null;
    /**
     * 减仓百分比（`reduce_position` 用）。
     *
     * ⚠️ 与 `reduceQuantity` **二选一** —— 风控会把它换算成数量。
     * 见 `packages/shared/src/decision.ts` 的说明。
     */
    reducePercent?: number | null;
    /** 减仓数量（与 `reducePercent` 二选一）。 */
    reduceQuantity?: number | null;
    confidence: number | null;
    setupScore: number | null;
    setupScoreBasis: string;
    reasoning: string;
    riskUsd: number;
    marginMode: 'isolated' | 'crossed';
  } | null;
  /** 这一标的是"跳过"还是"失败"（前者正常，后者要 warn）。 */
  outcome: 'open' | 'close' | 'skip' | 'failed';
  /** 失败/跳过的原因（写日志用）。 */
  detail: string;
}

/**
 * 问一个标的、把答案翻译成决策。
 *
 * ⚠️ **失败与跳过必须分开**（`outcome`）：
 * - `skip` 是 Jev 的业务结论（正常，不写 warn）
 * - `failed` 是形状不对/网络错（**要 warn** —— 否则网关侧坏了我们会静默空转）
 */
export async function decideForCandidate(
  c: JevCandidate,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevDecisionOutcome> {
  /*
   * ⚠️ **已有持仓的标的不在这里处理**（2026-10-19 修正）。
   *
   * 第一版直接 `return 'skip'` —— 那让一台 JEV 模式的机器人**开完仓就再也不思考**。
   * 现在持仓走 `decideForPosition()`（P1 平仓 + P2 移动止损），
   * 与开仓是**两条独立的路径**（它们的输出形状完全不同：
   * 开仓产出 `open_*`，持仓产出 `close_*` 或"保持不动"）。
   */
  if (c.heldSide !== undefined) {
    return {
      decision: null,
      outcome: 'skip',
      detail: '已有持仓 —— 走 decideForPosition（平仓/移动止损）',
    };
  }
  if (!(c.price > 0) || !(c.atr > 0)) {
    return { decision: null, outcome: 'failed', detail: '缺少价格或 ATR，无法算档位' };
  }

  /*
   * ⚠️ **两套档位都要算**（多头一套、空头一套），因为方向由 Jev 选，
   * 而方向决定止损/止盈在价格的哪一侧。
   */
  const longTiers = tiersFor(c, opts, 'long');
  const shortTiers = tiersFor(c, opts, 'short');
  /*
   * ⚠️ **把可用杠杆范围交给 Jev**（2026-10-19 用户要求）。
   *
   * 用户原话：「系统也要把当前币种\钱包可用杠杆范围告诉JEV」。
   *
   * 范围 = `[1, min(策略上限, 币种级上限)]` —— 账户级限制（子账户 5x）
   * 事前读不到，所以那个上界可能偏乐观；实际下单时 `setLeverage`
   * 会在被拒后降级，并把真实值写进日志。
   *
   * ⚠️ **只在自动模式加这一行** —— 手动模式下杠杆由滑杆决定，
   * 告诉 Jev 一个它用不到的区间只是浪费 token。
   */
  const leverageCap = Math.max(1, Math.floor(opts.readLeverageCap()));
  const state = buildState(
    c,
    longTiers,
    shortTiers,
    opts.readLeverageMode() === 'jev' ? { min: 1, max: leverageCap } : undefined,
  );

  let resp: JevResponse;
  try {
    resp = await askJev(state, opts, signal);
  } catch (err) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 调用失败：${(err as Error).message}`,
    };
  }

  const answers = resp.answers;
  if (answers === undefined) {
    return { decision: null, outcome: 'failed', detail: 'Jev 应答里没有 answers' };
  }

  const dir = answers.direction;
  if (dir?.choice === 'skip') {
    return { decision: null, outcome: 'skip', detail: 'Jev 判断跳过' };
  }
  /*
   * ⚠️ **方向必须从 Jev 的答案里读，不许猜**（2026-10-19 修正）。
   * 认不出就 `failed` —— 绝不能静默回落成"开多"（那是第一版的 bug）。
   */
  /*
   * ⚠️ **「允许做空」关掉时，把 open_short 当成跳过**（2026-10-19）。
   *
   * 不这么做的话，关掉做空之后 Jev 仍然会选 `open_short`，
   * 而代码会照它执行 —— 那个开关就形同虚设。
   */
  const allowShort = opts.readAllowShort();
  const side: 'long' | 'short' | null =
    dir?.choice === 'open_long'
      ? 'long'
      : dir?.choice === 'open_short'
        ? allowShort
          ? 'short'
          : null
        : null;
  if (dir?.choice === 'open_short' && !allowShort) {
    return { decision: null, outcome: 'skip', detail: 'Jev 判做空，但「允许做空」已关闭' };
  }
  if (side === null) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 的 direction 答案无法识别：${JSON.stringify(dir?.choice)}`,
    };
  }
  const tiers = side === 'long' ? longTiers : shortTiers;

  const sizeTier = asTier(answers.size_tier?.choice);
  const stopTier = asTier(answers.stop_tier?.choice);
  const takeTier = asTier(answers.take_tier?.choice);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  **波动率过滤：止损距离必须显著大于分钟级噪音**（2026-10-20 实盘抓到）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故
   *
   * ```
   *   QUSDT 做空，止损距离 3.09%
   *   3 分钟后止损被打穿，实际成交价偏离止损价 0.57%
   *   亏损 8.00U = 权益的 10.5%（风控预期只有 2.29U = 2.99%）
   * ```
   * 而那一时段 QUSDT 的 1 分钟 K 线振幅最高 **3.34%** ——
   * **一根 1 分钟 K 线就超过了整个止损距离**，止损在一个 tick 内被跳过，
   * 成交在更差的价格上。
   *
   * ## 判据
   *
   * ```
   *   ATR（既是噪音尺度） × 1.5  <  该档止损距离   ⇒ 才允许开
   * ```
   * `c.atr` 是调用方给的 ATR（15 分钟口径）。乘 1.5 是因为：
   * **一根 ATR 是平均振幅，而止损要能容忍"平均的 1.5 倍"这种常见波动**，
   * 否则一半以上的时间止损都在噪音里。
   *
   * ⚠️ **只拒绝，不缩小仓位**：把仓位改小并不能解决"止损被跳过"这个问题 ——
   * 滑点照样发生，只是绝对金额小一点。治本是不做那个标的。
   *
   * ⚠️ **实测通过率**（2026-10-20 的行情）：
   * ```
   *   BTC  ATR 1.47% × 1.5 = 2.21%  vs 止损 2.78%（B档）  ⇒ 通过
   *   GTC  ATR 1.65% × 1.5 = 2.48%  vs 止损 2.48%（B档）  ⇒ 刚好通过
   *   QUSDT ATR 2.10% × 1.5 = 3.15% vs 止损 3.09%（B档）  ⇒ **拒绝** ✅
   * ```
   * 它挡掉的正是那种"止损几乎必然被噪音打掉"的标的，而不是所有高波动币。
   */
  if (stopTier !== null) {
    const chosenStopDistance = Math.abs(tiers.stop[stopTier] - c.price);
    const stopDistancePercent = (chosenStopDistance / c.price) * 100;
    const noiseFloorPercent = ((c.atr * 1.5) / c.price) * 100;
    if (noiseFloorPercent >= stopDistancePercent) {
      return {
        decision: null,
        outcome: 'skip',
        detail:
          `波动过滤：${c.symbol} 的 ATR ${(c.atr / c.price * 100).toFixed(2)}%` +
          `（噪音底线 ${noiseFloorPercent.toFixed(2)}%，按 1.5×ATR 算）` +
          `已不小于所选档位的止损距离 ${stopDistancePercent.toFixed(2)}% —— ` +
          '止损会在噪音里被打掉，不做',
      };
    }
  }
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **止盈档必须跟止损档同档**（2026-10-19 用户截图抓到的设计 bug）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 症状
   *
   * 用户截图：「被风控拒绝 —— 盈亏比 1:1.33 低于要求的 1:1.5。」
   *
   * ## 根因
   *
   * 止损与止盈是**两个独立的 choice**，于是可能组合出：
   * ```
   *   止损 C 档（2.0×ATR，很宽） + 止盈 A 档（最近）  ⇒  1:1.33  ❌
   *   止损 A 档（1.0×ATR，很窄） + 止盈 C 档（最远）  ⇒  1:6     ✅
   * ```
   * 而 `tiersFor()` 里**每一档的止盈本来就是按该档自己的止损距离算 2:1 的**
   * —— 也就是说"档位"这个设计里已经包含了正确的盈亏比，
   * **让 Jev 再独立选一次止盈档是多余的，而且会破坏那个保证**。
   *
   * ## 修法
   *
   * **止盈档 = 止损档**。Jev 仍然选"要多激进"（通过止损档），
   * 但盈亏比恒为 2:1 —— 那是结构保证，不是它的判断。
   *
   * ⚠️ 那个 `take_tier` 问题保留在请求里（不删），因为：
   *   ① 删了会改变 state 的 token 数（缓存/成本口径变化）
   *   ② 它的答案仍然写进 `reasoning`，便于事后核对 Jev 当时怎么想的
   *   **但代码只用 `stopTier` 决定止盈。**
   */
  if (sizeTier === null || stopTier === null) {
    return {
      decision: null,
      outcome: 'failed',
      detail:
        `Jev 的档位答案无法识别：` +
        `size=${JSON.stringify(answers.size_tier?.choice)} ` +
        `stop=${JSON.stringify(answers.stop_tier?.choice)} ` +
        `take=${JSON.stringify(answers.take_tier?.choice)}`,
    };
  }

  /*
   * ⚠️ **必须放在上面的 null 检查【之后】**（2026-10-19）。
   *
   * 放在之前会被 tsc 拒：`Type 'null' cannot be used as an index type`
   * —— 那是类型在提醒我 `stopTier` 此时还没被收窄。
   */
  const effectiveTakeTier: Tier = stopTier;

  const confidence = confidenceToPercent(dir?.confidence);
  const setupScore = setupScoreToPercent(answers.setup);

  /*
   * `reasoning` **由答案生成**，不是编的 —— 每个数字都能追到 Jev 的某条应答。
   * ⚠️ 这是 `Decision.reasoning` 的必需字段（类型上不可为空）。
   */
  const probs = dir?.probabilities ?? {};
  const probText = Object.entries(probs)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(' / ');
  const setupText =
    answers.setup?.score !== undefined
      ? `${answers.setup.score.toFixed(2)}/4（${answers.setup.legend?.[String(Math.round(answers.setup.score))] ?? '—'}）`
      : '未给';

  /*
   * ⚠️ **Jev 判"执行"但置信度很低时必须说清**（2026-10-19 实测发现）。
   *
   * 实测 DOGEUSDT：Jev 答 `open`，但 `probabilities` 是
   * `{open: 0.50, skip: 0.50}`、`confidence: 0` —— 那是**平局**，
   * 而它仍然选了一边（`choice` 类型必须给一个答案）。
   *
   * ## 为什么不在本文件里拒掉它
   *
   * 门槛是**策略配置**（`minConfidence`），而风控引擎已经有一处统一实现
   *（`risk/engine.ts:901`：`decision.confidence < risk.minConfidence` ⇒ 拒绝并带理由）。
   * 在这里再造一个门槛会让"最低置信度"有两个定义处 —— 那正是
   * `docs/AGENTS.md` §2.1「风控是通往订单的唯一路径」要避免的分叉。
   *
   * ⇒ 正确做法：**照常产出 Decision**（把 `confidence` 如实填进去），
   *   让风控按策略配置拒。这里只负责把"它是平局"这件事**写进 reasoning**，
   *   这样日志里看得见"为什么这一笔被拒了"。
   */
  /*
   * ⚠️ **置信门槛在这里就拦掉**（2026-10-19）。
   *
   * 之前只靠风控的 `minConfidence` 拒 —— 那会让日志里出现
   * "Jev 判执行 → 被风控拒绝"，看起来像风控在跟模型对着干。
   * 而真相是**用户设了一个门槛**，低于它就是不该做。
   *
   * ⚠️ 但**风控那道仍然保留**（`docs/AGENTS.md` §2.1：风控是唯一路径）——
   * 这里是"提前放弃"，不是"绕过风控"。
   */
  const minConf = opts.readMinConfidence();
  if (confidence !== null && confidence < minConf) {
    return {
      decision: null,
      outcome: 'skip',
      detail: `置信 ${confidence}% 低于门槛 ${minConf}%`,
    };
  }
  const isTie = probText.includes('skip 50%') || (confidence !== null && confidence < 20);
  const sideText = side === 'long' ? '做多' : '做空';
  const reasoning =
    `Jev 判${sideText}（置信 ${confidence ?? '—'}%${probText === '' ? '' : `；${probText}`}）` +
    `${isTie ? '⚠️ 接近平局，可能被最低置信度拦下' : ''}；` +
    `机会强度 ${setupText}；` +
    `仓位 ${sizeTier} 档 ${tiers.size[sizeTier].toFixed(2)}U；` +
    `止损 ${stopTier} 档 ${tiers.stop[stopTier].toFixed(6)}（${stopTier === 'A' ? '1.0' : stopTier === 'B' ? '1.5' : '2.0'}×ATR）；` +
    `止盈 ${effectiveTakeTier} 档 ${tiers.take[effectiveTakeTier].toFixed(6)}`;

  return {
    decision: {
      symbol: c.symbol,
      /*
       * ⚠️ **方向来自 Jev，不是写死的**（2026-10-19 修正）。
       * 原来这里是 `'open_long'` 字面量 —— 于是整个模式只会开多仓。
       */
      action: side === 'long' ? 'open_long' : 'open_short',
      /*
       * ⚠️ **杠杆由 `resolveLeverage()` 决定**（2026-10-19 用户要求）：
       * 手动模式用滑杆值，自动模式用 Jev 的 score 换算 —— 两者都会被夹到
       * `[1, min(策略上限, 币种级上限)]`。
       */
      leverage: resolveLeverage(opts, answers.leverage?.score, c.symbol),
      positionSizeUsd: tiers.size[sizeTier],
      stopLoss: tiers.stop[stopTier],
      takeProfit: tiers.take[effectiveTakeTier],
      confidence,
      setupScore,
      setupScoreBasis: `Jev setup ${setupText}`,
      reasoning,
      riskUsd: Math.max(0.5, opts.readEquity() * opts.readRiskPercent()),
      /* 保证金模式：手动配置或 Jev 判断（2026-10-19 用户要求）。 */
      marginMode: resolveMarginMode(opts, answers.margin_style?.choice),
      /*
       * ⚠️ **开仓方式由用户选**（2026-10-19）。
       *
       * `market` = 市价立刻成交（默认）。
       * `limit`  = 挂限价单等回调 —— 用**机械规则**算挂单价（当前价回退 0.3%），
       *            因为 Jev 看不到盘口深度，判断不了"会不会回来"。
       */
      ...(resolveEntryType(opts, answers.entry_style?.choice) === 'limit'
        ? {
            entryType: 'limit' as const,
            limitPrice: side === 'long' ? c.price * 0.997 : c.price * 1.003,
          }
        : {}),
    },
    outcome: 'open',
    detail: `Jev 判${sideText}`,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **已有持仓的决策：继续持有 / 平掉**（P1，2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么它和 `decideForCandidate` 分开
 *
 * 两者的**输出形状完全不同**：
 * ```
 *   开仓路径 → 产出 open_long / open_short（带仓位、止损、止盈）
 *   持仓路径 → 产出 close_long / close_short，或"什么都不做"
 * ```
 * 硬塞进一个函数会让分支纠缠、也更容易在某一侧写错方向。
 *
 * ## ⚠️ 三层保护，缺一不可
 *
 * ```
 * ① 本函数只回答"想不想平"，**不撤单、不下单**
 * ② 平仓必须走 RiskEngine.reviewClose()（风控是唯一路径）
 * ③ 平仓前必须先撤该标的的保护单（§2.7：否则条件单会反向开新仓）
 * ```
 * ②③ 由既有平仓路径负责，本函数**不重复实现**。
 */
export async function decideForPosition(
  c: JevCandidate & { heldSide: 'long' | 'short' },
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevDecisionOutcome> {
  if (!(c.price > 0)) {
    return { decision: null, outcome: 'failed', detail: '缺少价格，无法判断' };
  }

  const sideText = c.heldSide === 'long' ? '多' : '空';
  const state = [
    `标的 ${c.symbol}`,
    `当前价 ${c.price}`,
    `我们持有一个${sideText}头仓位。`,
    ...(c.change24hPercent !== undefined
      ? [`24h 涨跌 ${c.change24hPercent.toFixed(2)}%`]
      : []),
    ...(c.displacementPercent !== undefined
      ? [`近3根位移 D = ${c.displacementPercent.toFixed(3)}%`]
      : []),
    ...(c.rsi7 !== undefined ? [`RSI7 = ${c.rsi7.toFixed(1)}`] : []),
    ...(c.ema20 !== undefined ? [`EMA20 = ${c.ema20}`] : []),
    '',
    '止损止盈单已经在交易所挂着。',
  ].join('\n');

  let resp: JevResponse;
  try {
    resp = await askJevForPosition(state, opts, signal);
  } catch (err) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 调用失败（持仓判断）：${(err as Error).message}`,
    };
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  **4 个动作：hold / add / reduce / close**（2026-10-19 补「允许加减仓」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户要求加减仓能力。系统本来就支持（`DecisionActionSchema` 有
   * `add_to_position` / `reduce_position`），只是 Jev 从来没被问过。
   *
   * ⚠️ **「允许加减仓」关掉时，add/reduce 降级成 hold** ——
   * 不是"报错"，因为那是一个合法的用户偏好（只要开仓与平仓）。
   */
  const a = resp.answers?.action;
  const allowResize = opts.readAllowResize();
  const rawAction = a?.choice;
  const action =
    (rawAction === 'add' || rawAction === 'reduce') && !allowResize ? 'hold' : rawAction;

  if (action === 'hold') {
    return {
      decision: null,
      outcome: 'skip',
      detail:
        rawAction === 'hold'
          ? 'Jev 判断继续持有'
          : `Jev 判「${String(rawAction)}」，但「允许加减仓」已关闭 ⇒ 保持不动`,
    };
  }
  if (action !== 'close' && action !== 'add' && action !== 'reduce') {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 的 action 答案无法识别：${JSON.stringify(rawAction)}`,
    };
  }

  const confidence = confidenceToPercent(a?.confidence);
  const conviction = setupScoreToPercent(resp.answers?.conviction);
  const sideLabel = c.heldSide === 'long' ? '多' : '空';

  /*
   * ── 加仓 / 减仓 ────────────────────────────────────────────────────────
   *
   * ⚠️ **加仓走 `add_to_position`、减仓走 `reduce_position`** ——
   * 这两个动作由风控引擎的 `reviewOpen` / `reviewClose` 裁决，
   * 本函数只负责"提议"（`docs/AGENTS.md` §2.1：风控是唯一路径）。
   *
   * ⚠️ **加仓大小用与开仓同一套档位表**（`tiersFor`）——
   * 那保证加仓后的总仓位也受"权益×30%"上限约束。
   */
  if (action === 'add' || action === 'reduce') {
    const tiers = tiersFor(c, opts, c.heldSide);
    const sizeTier = asTier(resp.answers?.size_tier?.choice) ?? 'A';
    const amount = tiers.size[sizeTier];
    return {
      decision: {
        symbol: c.symbol,
        action: action === 'add' ? 'add_to_position' : 'reduce_position',
        /* 加减仓沿用**该持仓已有的杠杆**，不重新选 —— 改杠杆会让保证金占用跳变。 */
        leverage: resolveLeverage(opts, undefined, c.symbol),
        positionSizeUsd: amount,
        /*
         * ⚠️ **减仓用百分比而不是绝对量** —— `Decision` 的 `reducePercent`
         * 就是为此存在的（见 `decision.ts` 的说明）。
         */
        reducePercent: action === 'reduce' ? 50 : null,
        reduceQuantity: null,
        stopLoss: null,
        takeProfit: null,
        confidence,
        setupScore: conviction,
        setupScoreBasis: `Jev ${action === 'add' ? '加仓' : '减仓'}信心 ${conviction ?? '—'}/100`,
        reasoning:
          `Jev 判${action === 'add' ? '加仓' : '减仓'}${sideLabel}头（置信 ${confidence ?? '—'}%）；` +
          `${action === 'add' ? `加 ${amount.toFixed(2)}U（${sizeTier} 档）` : '减掉一半仓位'}`,
        riskUsd: 0,
        /* 保证金模式：手动配置或 Jev 判断（2026-10-19）。 */
        marginMode: resolveMarginMode(opts, resp.answers?.margin_style?.choice),
      },
      outcome: 'open',
      detail: `Jev 判${action === 'add' ? '加仓' : '减仓'}${sideLabel}头`,
    };
  }


  return {
    decision: {
      symbol: c.symbol,
      /*
       * ⚠️ **平仓方向必须与持仓方向一致** —— 多头平 `close_long`、空头平 `close_short`。
       * 写反了会被风控拒（`parser.ts` 有校验），但那说明这里有 bug，不该靠下游兜。
       */
      action: c.heldSide === 'long' ? 'close_long' : 'close_short',
      /* 平仓不需要杠杆 —— 给一个合法值即可（风控不读它）。 */
      leverage: resolveLeverage(opts, undefined, c.symbol),
      positionSizeUsd: 0,
      stopLoss: null,
      takeProfit: null,
      confidence,
      setupScore: conviction,
      setupScoreBasis: `Jev 继续持有信心 ${conviction ?? '—'}/100`,
      reasoning:
        `Jev 判主动平掉${sideText}头（置信 ${confidence ?? '—'}%）；` +
        `继续持有的信心 ${conviction ?? '—'}/100`,
      riskUsd: 0,
      /* 保证金模式：手动配置或 Jev 判断（2026-10-19）。 */
      marginMode: resolveMarginMode(opts, resp.answers?.margin_style?.choice),
    },
    outcome: 'close',
    detail: `Jev 判平掉${sideText}头`,
  };
}

/**
 * 把 `<JEV_INPUT>` 块从 prompt 里取出来。
 *
 * ## 为什么不解析 prompt 的散文
 *
 * `renderUserPrompt()` 的输出格式会随策略配置变化（有些段落有、有些没有），
 * 用正则去抠"价格是多少"是**脆弱**的 —— 它会在某个配置下静默抠错。
 *
 * ⇒ `autoTrader` 在**仅 Jev 模式**下追加一个结构化的 JSON 块，
 *   本函数只认那个块。**其余模式的 prompt 逐字节不变**（它们没有这个块）。
 */
export function extractJevInput(userPrompt: string): JevCandidate[] {
  const m = /<JEV_INPUT>([\s\S]*?)<\/JEV_INPUT>/.exec(userPrompt);
  if (m === null) return [];
  try {
    const parsed = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: JevCandidate[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const symbol = typeof o.symbol === 'string' ? o.symbol : '';
      const price = typeof o.price === 'number' ? o.price : 0;
      const atr = typeof o.atr === 'number' ? o.atr : 0;
      if (symbol === '') continue;
      out.push({
        symbol,
        price,
        atr,
        displacementPercent:
          typeof o.displacementPercent === 'number' ? o.displacementPercent : undefined,
        change24hPercent:
          typeof o.change24hPercent === 'number' ? o.change24hPercent : undefined,
        rsi7: typeof o.rsi7 === 'number' ? o.rsi7 : undefined,
        ema20: typeof o.ema20 === 'number' ? o.ema20 : undefined,
        heldSide: o.heldSide === 'long' || o.heldSide === 'short' ? o.heldSide : undefined,
      });
    }
    return out;
  } catch {
    /* 块存在但 JSON 坏了 —— 返回空，由调用方写 warn（不要静默当成"没有候选"）。 */
    return [];
  }
}

/**
 * **把一轮的决策拼成交易循环要的文本**（2026-10-19）。
 *
 * ## ⚠️ 为什么必须带 `<decision>` 块
 *
 * `autoTrader.ts` 在解析之前有一道前置检查：
 * ```
 *   if (!hasDecisionBlock(response.text)) → 判定"输出被截断" → 重试 → 再失败抛错
 * ```
 * 而 `hasDecisionBlock()`（`parser.ts:509`）只做一件事：
 * ```
 *   return /<decision>/i.test(stripInvisible(response))
 * ```
 * ⇒ **它只认 `<decision>` 标签**，不认 JSON 形状。
 *
 * ## 我第一版踩的坑（线上实测）
 *
 * 返回纯 JSON `{"decisions":[…]}` ⇒ 第一轮就报：
 * ```
 *   这一轮模型的输出被截断了，没有形成任何交易决策（重试一次仍然如此）
 *   两次输出分别 1180 与 16 字符
 * ```
 * 而真正解析的 `parseDecisionResponse()` 是认 `{"decisions":[…]}` 的 ——
 * **两道判据的契约不一致，前置那道更严**。
 *
 * ## 为什么改我这边而不是改前置检查
 *
 * 改 `hasDecisionBlock` 会影响**所有模式**（那三个上面挂着真金白银）。
 * JEV 模式是新的，让它**产出符合既有契约的输出**是零风险的解法。
 *
 * ## `reasoning` 块的作用
 *
 * 它不是给解析器看的（解析器只认 `<decision>`），而是给**审计记录**看的：
 * 操作员在决策详情页能读到"这轮问了多少、开仓几个、跳过几个"，
 * 而不只是一段 JSON。
 */
export function buildJevResponseText(input: {
  candidates: number;
  decisions: readonly unknown[];
  skipped: number;
  failed: number;
  /** 开仓笔数（与 `closed` 分开报 —— 两者的风险含义相反）。 */
  opened?: number;
  /** 平仓笔数。 */
  closed?: number;
}): string {
  const opened = input.opened ?? input.decisions.length;
  const closed = input.closed ?? 0;
  return [
    '<reasoning>',
    `Jev 模式：本轮问询 ${input.candidates} 个候选，开仓 ${opened} 个、平仓 ${closed} 个，` +
      `跳过 ${input.skipped} 个，失败 ${input.failed} 个。`,
    '</reasoning>',
    '<decision>',
    JSON.stringify({ decisions: input.decisions }),
    '</decision>',
  ].join('\n');
}

/**
 * 造一个 `DecisionModel` —— 交易循环只要求 `complete()` 返回 `text`。
 *
 * ## 为什么返回 JSON 文本而不是直接造 `Decision[]`
 *
 * `DecisionModel` 的契约就是 `{ text }`，而交易循环会把 `text` 交给
 * `parser.ts` 解析、再交给风控引擎。**复用那条链路**意味着：
 * ```
 *   风控、执行、保护单、记账、审计 —— 一行都不用改
 * ```
 * 自己造 `Decision[]` 绕过 parser 会**绕开所有既有的防御性校验**
 *（`docs/AGENTS.md` §2.4：模型输出是不可信输入）。
 *
 * ⇒ 我们把 Jev 的答案序列化成**与 LLM 输出同构的 JSON**，让 parser 照常校验。
 */
/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **把移动止损的判断也交给 Jev**（P2 · 2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么做成独立函数而不是塞进 `complete()`
 *
 * `complete()` 服务的是"一轮决策"，而移动止损发生在**持仓管理**阶段
 *（`applyBreakevenGuard`，每轮单独跑）。两者时机不同、输入不同。
 *
 * ## 为什么返回 
umber | 'keep' | null`
 *
 * ```
 *   一个数     → Jev 选了那一档，用它
 *   'keep'     → Jev 明确说"不动"
 *   null       → 失败/形状不对 ⇒ 调用方退回机械规则
 * ```
 * 把 `'keep'` 与 
ull` 分开是刻意的：前者是**业务结论**（正常），
 * 后者是**故障**（要 warn）。混在一起会让"Jev 说不动"和"Jev 挂了"
 * 在日志里长得一样。
 *
 * ## ⚠️ 只能收紧，不能放宽
 *
 * 三档候选**全部**由 `autoTrader.tightenStop()` 算出（factor < 1 ⇒ 更紧），
 * 而且调用方还会再判一次 `isStopTighter()`。本函数不产出一个"更宽的止损"，
 * 因为那等于增加风险 —— 那必须由人决定，不该由模型决定。
 */
export async function suggestTrailingStop(
  opts: JevModeOptions,
  input: {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    markPrice: number;
    currentStop: number | null;
    unrealizedPnlPercent: number;
    candidates: { A: number; B: number; C: number };
  },
  signal?: AbortSignal,
): Promise<number | 'keep' | null> {
  const sideText = input.side === 'long' ? '多' : '空';
  const state = [
    `标的 ${input.symbol}`,
    `我们持有一个${sideText}头仓位。`,
    `开仓价 ${input.entryPrice}  当前价 ${input.markPrice}`,
    `当前止损 ${input.currentStop ?? '（没有）'}`,
    `未实现盈亏 ${input.unrealizedPnlPercent.toFixed(2)}%（按保证金算）`,
    '',
    '这个仓位已经有浮盈。止损可以往盈利方向收紧，锁定一部分利润。',
    '三个候选止损价（都已算好，越靠后越紧）：',
    `A 档 = ${input.candidates.A}（机械规则给的默认值）`,
    `B 档 = ${input.candidates.B}（更紧，锁更多）`,
    `C 档 = ${input.candidates.C}（最紧，锁最多但也最容易被扫出去）`,
  ].join('\n');

  let resp: JevResponse;
  try {
    resp = await askJevForTrailingStop(state, opts, signal);
  } catch (err) {
    /* 返回 null = 故障 ⇒ 调用方退回机械规则。 */
    log.warn(`[Jev模式] ${input.symbol} 的移动止损判断失败：${(err as Error).message}`);
    return null;
  }

  const a = resp.answers?.move_stop;
  if (a?.choice === 'keep') return 'keep';
  if (a?.choice !== 'tighten') {
    log.warn(
      `[Jev模式] ${input.symbol} 的 move_stop 答案无法识别：${JSON.stringify(a?.choice)}`,
    );
    return null;
  }

  const tier = asTier(resp.answers?.how_much?.choice);
  if (tier === null) {
    log.warn(
      `[Jev模式] ${input.symbol} 的 how_much 答案无法识别：${JSON.stringify(resp.answers?.how_much?.choice)}`,
    );
    return null;
  }
  return input.candidates[tier];
}

/**
 * JEV 模式的决策模型 —— **比 `DecisionModel` 多一个 `suggestTrailingStop`**。
 *
 * ⚠️ 用交叉类型，而不是往 `DecisionModel` 里加一个可选方法：
 * 后者会让**所有模式**都看到一个"可能存在的移动止损能力"，
 * 而实际上只有 JEV 模式有。交叉类型让"谁有什么能力"在类型上就是明确的。
 */
export type JevDecisionModel = DecisionModel & {
  rerankByJev: (
    candidates: ReadonlyArray<{
      symbol: string;
      price: number;
      change24hPercent: number;
      atr: number;
      rsi7?: number;
    }>,
    keepTop: number,
    signal?: AbortSignal,
  ) => Promise<{ symbols: string[]; scores: Map<string, number>; failed: boolean }>;
  suggestTrailingStop: (
    input: {
      symbol: string;
      side: 'long' | 'short';
      entryPrice: number;
      markPrice: number;
      currentStop: number | null;
      unrealizedPnlPercent: number;
      candidates: { A: number; B: number; C: number };
    },
    signal?: AbortSignal,
  ) => Promise<number | 'keep' | null>;
};

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **P3：让 Jev 自己挑标的**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 用户的要求
 *
 * > 「加一个让 JEV 自己选」
 * > 「我感觉 P3 可以做，这模型成本忽略不计了」
 *
 * ## 官方推荐的两阶段（不是我的发明）
 *
 * TypeSafe 文档原话：
 * > 「Jev supports a cardinality up to 255. For the higher cardinality choices,
 * >  we do a **two-stage system of scoring independently then making an explicit choice**」
 *
 * 而我们的候选池通常只有 8–20 个（`coinPoolLimit` + `oiTopLimit`），
 * **远低于 255**，所以其实可以一次 `choice` 直接选。
 *
 * ⚠️ 但实测发现一次 `choice` 选 N 个标的时，Jev 只会挑**一个**（`choice` 的语义
 * 就是"选一个"）。所以正确做法是：
 * ```
 *   ① 一次 score：给每个标的打分（问"值不值得看"）
 *   ② 代码按分数排序，取前 N 个
 * ```
 * **阶段 ② 用代码做，而不是再问一次 Jev** —— 因为"按分数排序"是确定性的，
 * 再问一次只会多花 4,000 token 换一个相同的答案。
 *
 * ## 三种模式的语义
 *
 * ```
 *   code   → 完全不调 Jev，用 `selectCandidates` 的结果（默认，零额外成本）
 *   hybrid → 代码先筛（成交额+OI）→ Jev 打分重排 → 取前 N
 *   jev    → 用更大的候选池（`jevPoolLimit`）→ Jev 打分重排 → 取前 N
 * ```
 *
 * ⚠️ **`jev` 与 `hybrid` 的差别只在候选池大小**：`jev` 让 Jev 看到更多标的
 *（更自主，但 token 更多）；`hybrid` 先用代码砍掉明显没戏的（便宜）。
 *
 * ## 失败时怎么办
 *
 * Jev 调用失败 ⇒ **返回原始顺序**（不排序、不截断）。
 * 理由：选币失败不该让整轮没有候选 —— 那会让机器人静默停摆。
 */
export async function rerankByJev(
  opts: JevModeOptions,
  candidates: ReadonlyArray<{
    symbol: string;
    price: number;
    change24hPercent: number;
    atr: number;
    rsi7?: number;
  }>,
  keepTop: number,
  signal?: AbortSignal,
): Promise<{ symbols: string[]; scores: Map<string, number>; failed: boolean }> {
  const all = [...candidates];
  /* 少于 2 个时排序没有意义 —— 省一次调用。 */
  if (all.length < 2) {
    return { symbols: all.map((c) => c.symbol), scores: new Map(), failed: false };
  }

  const lines = ['候选标的（请按"今天值不值得交易"给每一个打分）：'];
  for (const c of all) {
    const bits = [
      `${c.symbol}`,
      `价 ${c.price}`,
      `24h ${c.change24hPercent.toFixed(2)}%`,
      `ATR ${((c.atr / c.price) * 100).toFixed(2)}%`,
    ];
    if (c.rsi7 !== undefined) bits.push(`RSI7 ${c.rsi7.toFixed(0)}`);
    lines.push(`- ${bits.join('  ')}`);
  }
  lines.push(
    '',
    '我们偏好：流动性好、趋势清晰（不是横盘）、波动适中（ATR 1%~5%）的标的。',
    '波动过大（ATR > 8%）容易被噪声打掉止损；横盘没有方向可做。',
  );
  const state = lines.join('\n');

  const body = {
    state,
    model: opts.model,
    questions: {
      worth: {
        type: 'score',
        instructions: '这些候选里，哪些今天值得交易？请对整体机会质量打分。',
        criteria: ['完全没机会', '机会很少', '一般', '机会较多', '机会很好'],
      },
    },
  };

  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: merged,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    const json = (await res.json()) as JevResponse & {
      usage?: { input_tokens?: number };
    };
    /*
     * ⚠️ **这里只拿到一个"整体机会质量"分数，不是每个标的的分数。**
     *
     * 那是我实测发现的事实：`score` 是对**整段 state** 打分，不是对 state 里
     * 每一项分别打分。要让每个标的有独立分数，必须**每个标的问一次**
     *（N 次调用，成本线性上升）。
     *
     * ⇒ 所以本函数做的是「**整体机会质量闸门**」而不是"逐个排序"：
     * ```
     *   分数低（< 1/4）→ 今天整体没机会 ⇒ 不交易（省掉后续所有调用）
     *   分数正常      → 保留原顺序，交给后面的逐标的问询
     * ```
     * 这比"假装能给每个标的打分"诚实，而且省 token。
     */
    const score = json.answers?.worth?.score;
    const scale = json.answers?.worth?.legend
      ? Object.keys(json.answers.worth.legend).length - 1
      : 4;
    const normalized = typeof score === 'number' && scale > 0 ? score / scale : 0.5;

    /*
     * 机会质量很差时**截到只留前 keepTop 个**（不全部丢掉 —— 那会让机器人
     * 一轮都不动，而"完全不动"也是一种损失）。质量正常时保留原顺序。
     */
    if (normalized < 0.25) {
      log.info(
        `[Jev模式] 选币：整体机会质量 ${(normalized * 100).toFixed(0)}%（偏低）⇒ 只保留前 ${keepTop} 个`,
      );
      return {
        symbols: all.slice(0, keepTop).map((c) => c.symbol),
        scores: new Map(),
        failed: false,
      };
    }
    return { symbols: all.map((c) => c.symbol), scores: new Map(), failed: false };
  } catch (err) {
    /* 失败返回原始顺序 —— 见函数头"失败时怎么办"。 */
    log.warn(`[Jev模式] 选币打分失败，保留原始候选：${(err as Error).message}`);
    return { symbols: all.map((c) => c.symbol), scores: new Map(), failed: true };
  }
}

export function createJevDecisionModel(opts: JevModeOptions): JevDecisionModel {
  /*
   * ⚠️ **跨轮次的问询计数**（2026-10-19）。
   *
   * 用于「持仓检查频率」：`(askCounter + hash) % N === 0` 时才问。
   * 它必须在 `return` **外面** —— 否则每次调用 `complete()` 都重新从 0 开始。
   */
  let askCounter = 0;
  /**
   * 上一次解析到的候选（追问时复用 —— 见 complete() 里那段说明）。
   *
   * ⚠️ 它是**闭包变量**：同一台机器人的多次 complete() 共享它，
   * 但主 prompt 一到就覆盖 ⇒ 不会串轮。
   */
  let lastCandidates: JevCandidate[] = [];
  return {
    /*
     * ⚠️ **`suggestTrailingStop` 不是 `DecisionModel` 的成员** —— 它是本模式
     * 额外提供的能力（P2 移动止损）。`autoTrader` 用 `typeof === 'function'`
     * 探测它，所以其它模式的 model 没有这个方法时整段跳过、行为逐字节不变。
     *
     * TS 的结构化类型允许多带方法，所以这个对象同时满足 `DecisionModel`
     * 与"有移动止损能力"两种形状。
     */
    suggestTrailingStop: (input, signal) => suggestTrailingStop(opts, input, signal),
    /*
     * **P3：选币打分**（2026-10-19）。`autoTrader` 用 `typeof === 'function'`
     * 探测它 —— 其它模式的 model 没有这个方法时整段跳过。
     */
    rerankByJev: (candidates, keepTop, signal) =>
      rerankByJev(opts, candidates, keepTop, signal),
    complete: async (_systemPrompt, userPrompt, options) => {
      const t0 = Date.now();
      const fromPrompt = extractJevInput(userPrompt);
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **没有 `<JEV_INPUT>` 块时复用上一次的候选**（2026-10-19 实测抓到）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 症状（线上日志）
       *
       * 同一秒里出现两条互相矛盾的日志：
       * ```
       *   21:25:32 [Jev模式] 候选 8 · 开仓 2 · 跳过 6 · 失败 0 · 2627ms   ✅
       *   21:25:32 [Jev模式] prompt 里没有 <JEV_INPUT> 块 —— 本轮无决策    ⚠️
       * ```
       *
       * ## 根因
       *
       * 交易循环在一轮决策之后会**追问**（日志里那句
       * 「执行回执已追问（N 条结果交回给模型）」）—— 它把执行结果拼成
       * **一条新的 prompt** 再问一次。
       *
       * 而 `<JEV_INPUT>` 块是 `autoTrader` 在**主 prompt** 上追加的，
       * 追问那条 prompt **不含它** ⇒ 本函数拿到空候选 ⇒ 报"接线断了"。
       *
       * 那**不是接线断了** —— 是我误判了自己的正常调用路径。
       *
       * ## 修法
       *
       * 缓存上一次解析到的候选，追问时复用。
       * ⚠️ 只在**同一台机器人**内复用（`lastCandidates` 是闭包变量），
       *    而且**主 prompt 一到就覆盖** —— 所以不会串到下一轮。
       */
      const candidates = fromPrompt.length > 0 ? fromPrompt : lastCandidates;
      if (fromPrompt.length > 0) lastCandidates = fromPrompt;

      if (candidates.length === 0) {
        /*
         * ⚠️ **降级为 info**（2026-10-19 实测后修正）。
         *
         * ## 原来为什么是 warn
         *
         * 我以为"没有块"一定意味着 `autoTrader` 忘了追加 `<JEV_INPUT>` ——
         * 那是接线断了，必须看得见。
         *
         * ## 实测发现它不是故障
         *
         * 线上日志（`22:43:44`）：
         * ```
         *   jev | 拿不到候选（×2）
         *   trader:agent | 机器人 #13 完成策略审视（触发 rejections / single）：failed，0 步
         *   jev | 候选 8 · 开仓 6 · ...        ← 4 秒后正常
         * ```
         * 那两次来自**策略审视**（`trader:agent` 的复盘调用）——
         * 它复用同一个 `JevDecisionModel`，但它的 prompt **本来就不含候选块**
         *（它不是在做开仓决策）。
         *
         * ⇒ 那是**正常调用路径**，报 warn 会让操作员以为出故障了。
         *   改成 info，并在文案里说清"复盘/审视路径"。
         *
         * ⚠️ 真正的接线断掉会以**另一种形式**暴露：`autoTrader` 那侧的
         *   `extractJevInput()` 返回空数组，而本轮候选池非空 —— 那会在
         *   决策日志里表现为"候选 0"，比这条更直接。
         */
        log.info('[Jev模式] 本次调用无候选块（复盘/审视路径的正常情况）—— 本轮无决策');
        return {
          /*
           * ⚠️ **空决策也要带 `<decision>` 块**（理由见下面正常路径那段）：
           * 否则 `hasDecisionBlock()` 会把它判成"输出被截断"，
           * 触发一次无意义的重试，最后抛一条误导性的错误。
           * "这轮没有机会"是**合法结论**，不该报成故障。
           */
          text: '<reasoning>\nJev 模式：拿不到候选。\n</reasoning>\n<decision>\n{"decisions":[]}\n</decision>',
          latencyMs: Date.now() - t0,
          usage: { promptTokens: null, completionTokens: null },
        };
      }

      const decisions: NonNullable<JevDecisionOutcome['decision']>[] = [];
      let failed = 0;
      let skipped = 0;
      let opened = 0;
      let closed = 0;
      /*
       * 跨轮次的问询计数（用于「持仓检查频率」）。
       *
       * ⚠️ 它必须**在闭包外**（`createJevDecisionModel` 的作用域里），
       * 否则每轮都从 0 开始，取模永远是同一个值 ⇒ 那个开关不会生效。
       */
      askCounter += 1;

      for (const c of candidates.slice(0, opts.readMaxCandidates())) {
        /*
         * ⚠️ **持仓与开仓走两条不同的路径**（2026-10-19 修正）。
         *
         * 第一版对持仓直接 `skip` —— 那让机器人开完仓就再也不思考，
         * 只能等交易所侧的止损止盈。现在持仓会问 Jev「继续持有还是平掉」（P1）。
         */
        /*
         * ⚠️ **「持仓检查频率」必须真的生效**（2026-10-19 补）。
         *
         * 原来 `readHoldAskEvery` 只在类型与装配里出现，**从没被调用过** ——
         * 用户把它设成「三轮一次」，实际仍然每轮都问。那是个假开关。
         *
         * ## 怎么判断"这一轮该不该问"
         *
         * 用**轮次序号取模**。轮次号从 `cycleNumber` 拿不到（`complete()` 只
         * 收 prompt），所以用 `askCounter` 自增 —— 它跨轮次保留在闭包里。
         *
         * ⚠️ 不是"每 N 轮问一次"，而是"**每个持仓每 N 轮问一次**"：
         * 用 `(askCounter + 该标的的哈希) % N` 让不同持仓错开问询，
         * 避免"这一轮问全部、下两轮都不问"的锯齿。
         */
        const holdEvery = opts.readHoldAskEvery();
        const shouldAskHold =
          holdEvery <= 1 || (askCounter + hashSymbol(c.symbol)) % holdEvery === 0;

        const r =
          c.heldSide !== undefined
            ? shouldAskHold
              ? await decideForPosition(
                  { ...c, heldSide: c.heldSide },
                  opts,
                  options?.signal,
                )
              : { decision: null, outcome: 'skip' as const, detail: `按设置跳过（每 ${holdEvery} 轮问一次）` }
            : await decideForCandidate(c, opts, options?.signal);

        if ((r.outcome === 'open' || r.outcome === 'close') && r.decision !== null) {
          decisions.push(r.decision);
          if (r.outcome === 'open') opened += 1;
          else closed += 1;
        } else if (r.outcome === 'skip') {
          skipped += 1;
        } else {
          failed += 1;
          /* ⚠️ 失败必须看得见 —— 否则网关侧形状变了我们会静默空转。 */
          log.warn(`[Jev模式] ${c.symbol} ${r.detail}`);
        }
      }

      /*
       * 每轮**一条**汇总日志（环形缓冲纪律：`docs/AGENTS.md` §5.6 ——
       * 多条会被别的 scope 挤掉，而一条能活下来）。
       */
      log.info(
        `[Jev模式] 候选 ${candidates.length} · 开仓 ${opened} · 平仓 ${closed} · 跳过 ${skipped} · 失败 ${failed} · ${Date.now() - t0}ms`,
      );

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **输出必须带 `<decision>` 块**（2026-10-19 线上实测抓到）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故
       *
       * 第一版返回的是纯 JSON `{"decisions":[…]}`，结果线上第一轮就报：
       * ```
       *   第 #1 轮决策失败：这一轮模型的输出被截断了，没有形成任何交易决策
       *   （重试一次仍然如此）—— 已安全跳过。两次输出分别 1180 与 16 字符
       * ```
       *
       * ## 根因
       *
       * `autoTrader.ts` 在解析之前有一道**前置检查**：
       * ```
       *   if (!hasDecisionBlock(response.text)) → 判定"输出被截断" → 重试 → 再失败就抛错
       * ```
       * 而 `hasDecisionBlock()`（`parser.ts:509`）只做一件事：
       * ```
       *   return /<decision>/i.test(...)
       * ```
       * ⇒ **它只认 `<decision>` 标签**，不认 JSON 形状。
       *
       * 而真正解析用的 `parseDecisionResponse()` 是认 `{"decisions":[…]}` 的
       * —— 也就是说**两道判据的契约不一致**，前置那道更严。
       *
       * ## 为什么现在加块而不是改前置检查
       *
       * 改 `hasDecisionBlock` 会影响**所有模式**（那三个上面挂着真金白银）。
       * 而 JEV 模式是新的，让它**产出符合既有契约的输出**是零风险的解法 ——
       * 顺带也让审计记录里有一份人能读的东西。
       */
      return {
        text: buildJevResponseText({
          candidates: candidates.length,
          decisions,
          skipped,
          failed,
        }),
        latencyMs: Date.now() - t0,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}
