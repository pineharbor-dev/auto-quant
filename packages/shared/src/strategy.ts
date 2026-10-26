import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Coin universe                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the candidate-coin universe comes from.
 *
 * - `static`  : the user's hand-written symbol list
 * - `coinpool`: dynamically ranked universe (liquidity / momentum screen)
 * - `oi_top`  : symbols with the fastest open-interest growth
 * - `mixed`   : union of the above, de-duplicated, multi-source tags preserved
 */
export const CoinSourceTypeSchema = z.enum(['static', 'coinpool', 'oi_top', 'mixed', 'funnel']);
export type CoinSourceType = z.infer<typeof CoinSourceTypeSchema>;

/** How the dynamic `coinpool` universe is ranked. */
export const CoinPoolRankSchema = z.enum([
  'quote_volume', // 24h notional turnover — the most liquid majors
  'gainers', // 24h price change, descending
  'losers', // 24h price change, ascending
  'volatility', // 24h (high-low)/low — best for scalping regimes
  'funding_extreme', // largest |funding rate| — crowded positioning
]);
export type CoinPoolRank = z.infer<typeof CoinPoolRankSchema>;

export const CoinSourceConfigSchema = z.object({
  sourceType: CoinSourceTypeSchema.default('static'),
  /** Explicit symbols, e.g. `["BTCUSDT","ETHUSDT"]`. Normalised to upper-case. */
  staticCoins: z.array(z.string()).default([]),

  /** `mixed` mode toggles. */
  useCoinPool: z.boolean().default(false),
  useOITop: z.boolean().default(false),

  /** How many symbols the dynamic universe contributes. */
  coinPoolLimit: z.number().int().min(1).max(200).default(20),
  /**
   * **团队模式：漏斗的第一层要拉多少全市场候选**（`sourceType: 'funnel'` 用）。
   *
   * ⚠️ **这是"漏斗的入口宽度"，不是"最终候选数"** —— 最终数量由
   * `market/funnel.ts` 的 `DEFAULT_FUNNEL` 每层 `keep` 决定（默认 60 → 30）。
   *
   * 为什么不复用 `coinPoolLimit`：那是**另两种模式**在用的（只做一层排序取前 N），
   * 而漏斗需要**先拿到全市场** —— 否则"每层淘汰了多少"这个可解释性会失真
   *（第一层会显示"淘汰 0"，因为上游已经砍过了）。
   */
  funnelUniverseLimit: z.number().int().min(1).max(1500).default(500),
  coinPoolRank: CoinPoolRankSchema.default('quote_volume'),

  /**
   * Drop anything below this 24h turnover (USDT).
   *
   * ⚠️ **只挡成交额**，不挡稳定币 —— 稳定币是 `excludeStablecoins` 的事
   * （下面那个字段）。这两个判据曾被挤在同一行注释里，于是下面那个字段
   * 被写成了 schema 里不存在的名字，**被 zod 静默丢弃**，团队模式的
   * 候选池一直带着稳定币在跑。
   */
  minQuoteVolume24h: z.number().min(0).default(50_000_000),
  /**
   * 把**稳定币**（USDC / FDUSD / TUSD …）的永续从候选池里剔掉。
   *
   * ⚠️ 为什么需要一个显式开关而不是顺手过滤：`SymbolRegistry` 只按
   * `quoteAsset === 'USDT'` 过滤（`binance/symbols.ts`），那只挡掉了
   * **计价**资产是别的币的合约，挡不住**标的**本身是稳定币的
   * （`USDCUSDT` 这类报价与波动都接近锚定值的永续）。
   * 而它们不是无害的：名义波动接近 0、手续费与资金费占绝对主导，
   * 放进一个 8–20 个位置的候选池就是**挤掉真实机会**。
   *
   * ⚠️ 判据是**白名单**：`STABLE_BASE_ASSETS` 里列出的那些（名单外 → 视作普通标的、
   * 保留）。
   *
   * ⚠️ **默认 `false` 而不是 `true` —— 这是影响面的问题，不是风格问题。**
   * 存量策略（conservative / aggressive）的 `config_json` 里**没有这个键**，
   * 读出来时会落到 schema 默认值。若默认 `true`，那些**正在实盘跑**的策略
   * 会在下一次读取时**静默开始过滤稳定币** —— 候选池变了，而没人做过这个决定。
   * 本仓库对"另两种模式的选池行为逐字节不变"有明确要求（见 `coins.ts` funnel 分支的注释）。
   * 真正想要过滤的 `defaultAiTeamConfig()` 显式写 `true`，所以团队模式照样生效。
   */
  excludeStablecoins: z.boolean().default(false),
  /** Only consider symbols whose open interest exceeds this (USDT). */
  minOpenInterestUsd: z.number().min(0).default(5_000_000),

  /** How many symbols the OI-growth source contributes. */
  oiTopLimit: z.number().int().min(1).max(100).default(10),
  /** OI growth is measured over this window (hours). */
  oiTopWindowHours: z.number().int().min(1).max(24).default(4),
  /**
   * 候选评分门槛（0–100）。**0 表示关闭**（与其它风控字段同一约定）。
   *
   * 低于这个分数的标的**不进提示词**。
   *
   * 为什么需要它：实测单次决策的提示词是 69,678 字符 / 48,005 tokens，
   * 而其中相当一部分标的是陪跑的。**"多看"和"看得准"不是一回事** ——
   * 信号淹没在数据里本身就会让判断变差，不只是变贵。
   *
   * ⚠️ 门槛太严会把机会一起滤掉，而**"不交易"也是一种亏损**（错过机会）。
   * 所以在 AI 托管模式下它是 AI 可调的参数，且要按"改了什么、之后真实结果如何"来检验。
   */
  minScore: z.number().min(0).max(100).default(0),
});

/* -------------------------------------------------------------------------- */
/*  Indicators                                                                 */
/* -------------------------------------------------------------------------- */

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const KlineConfigSchema = z.object({
  /** Timeframe whose indicators are shown inline next to the price. */
  primaryTimeframe: TimeframeSchema.default('5m'),
  /** Every timeframe rendered into the prompt, oldest → newest. */
  selectedTimeframes: z.array(TimeframeSchema).min(1).default(['5m', '15m', '1h', '4h']),
  /**
   * How many candles are fetched and fed to the indicator calculations.
   *
   * Must comfortably exceed the longest indicator warm-up. MACD(26,9) needs 26
   * candles for the slow EMA plus 9 more for its signal line — 35 before the
   * histogram produces a single value — and EMA50 needs 50. A value of 30, the
   * intuitive default, silently yields an empty MACD.
   */
  primaryCount: z.number().int().min(10).max(1000).default(60),

  /**
   * **每个指标往提示词里渲染多少个最近的点。**
   *
   * ## 为什么它必须是一个参数，而不是写死的 30
   *
   * 实测：每个候选标的的区块约 **10,200 字**，而 7 个候选 ≈ 68,000 字 ——
   * 这是每轮约 49,700 tokens 的**主体来源**。它几乎全是逐根 K 线的原始数字数组：
   *
   *     价格: [106.5000, 106.3800, 106.4500, …]   ← 每个指标 30 个数
   *
   * 而 `30` 原来是 `series()` 的一个默认参数，**没有任何配置项** ——
   * 于是"给它更多历史还是更少"这个取舍，**由代码替 AI 做了**。
   *
   * 那违背了 AI 托管的前提。这个值现在可调，AI 可以自己权衡：
   *   · 点少 → 省 token、少干扰，但形态判断的依据变薄
   *   · 点多 → 依据厚，但每轮成本线性上升
   *
   * ## 默认值保持 30
   *
   * 它已经在生产上跑了 498 个周期、行为可预期。**改默认值等于改变所有既有机器人
   * 的输入，而那件事该由能衡量它的那一方来做** —— 也就是握着绩效数据的 AI，
   * 不是这一次代码改动。
   */
  promptPoints: z.number().int().min(5).max(120).default(30),
});

export const IndicatorConfigSchema = z.object({
  kline: KlineConfigSchema.default({}),

  enableEma: z.boolean().default(true),
  emaPeriods: z.array(z.number().int().min(2).max(400)).default([20, 50]),

  enableMacd: z.boolean().default(true),
  macdFast: z.number().int().min(2).default(12),
  macdSlow: z.number().int().min(3).default(26),
  macdSignal: z.number().int().min(2).default(9),

  enableRsi: z.boolean().default(true),
  rsiPeriods: z.array(z.number().int().min(2).max(200)).default([7, 14]),

  enableAtr: z.boolean().default(true),
  atrPeriods: z.array(z.number().int().min(2).max(200)).default([14]),

  enableVolume: z.boolean().default(true),
  enableOi: z.boolean().default(true),
  enableFundingRate: z.boolean().default(true),
  /** Taker buy/sell flow, used as a free substitute for paid net-flow feeds. */
  enableQuantData: z.boolean().default(false),
  /** Cross-sectional OI ranking table appended to the prompt. */
  enableOiRanking: z.boolean().default(false),
});
export type IndicatorConfig = z.infer<typeof IndicatorConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Risk control — enforced in code, outside the model's reach                  */
/* -------------------------------------------------------------------------- */

export const RiskControlConfigSchema = z.object({
  /** Hard ceiling on concurrently open positions. */
  maxPositions: z.number().int().min(1).max(20).default(3),

  /** Leverage is clamped at order-sizing time regardless of what the model asks. */
  btcEthMaxLeverage: z.number().int().min(1).max(125).default(5),
  altcoinMaxLeverage: z.number().int().min(1).max(125).default(5),
  /** Leverage applied when the model omits one. */
  defaultLeverage: z.number().int().min(1).max(125).default(3),

  /** Notional cap expressed as a multiple of account equity. */
  btcEthMaxPositionValueRatio: z.number().min(0.01).max(50).default(5),
  altcoinMaxPositionValueRatio: z.number().min(0.01).max(50).default(1),

  /** Percentage of equity allowed to sit in margin. */
  maxMarginUsage: z.number().min(1).max(100).default(90),
  /** Orders below this notional are rejected rather than rounded up. */
  minPositionSize: z.number().min(1).default(12),

  /** Reward:risk floor, e.g. 3 means TP distance must be >= 3x SL distance. */
  minRiskRewardRatio: z.number().min(0).max(50).default(3),
  /** Model confidence floor (0-100). */
  minConfidence: z.number().int().min(0).max(100).default(75),

  /**
   * **单笔交易的风险预算**（占权益的百分比）。默认 **2**。
   *
   * ## ⚠️ 为什么把它从"提示词里的硬编码常量"变成真字段（2026-10-13）
   *
   * ### 它原来是一个**死锁**
   *
   * `strategy/prompt.ts` 里有这么一段（**它一直对模型这么说**）：
   * > 「造成"空集"的两个变量 —— **规则、风险参数** —— 都在**你自己的权限里**。
   * >  （权益不归你管，那是账户所有者的。）」
   *
   * 而那个 2% 当时是 `prompt.ts` 里的 `const riskPerTradePercent = 2;` ——
   * **一个硬编码常量，不在任何 schema 里**。
   *
   * 也就是说：
   * ```
   *   提示词告诉模型「你可以改风险参数」
   *   而模型用 set_params 只能改 riskControl 里的字段 → 改不到这个 2%
   *   → 它「只能一直用 2% 熬着」（decisionTools.ts 里早就写下了这句话）
   * ```
   *
   * ### 死锁的代价（实测）
   *
   * ```
   *   权益 20.75 · 单笔风险 2% = 0.415 USDT
   *   币安最小名义 50 USDT → 止损上限只能 0.83%
   *   而 15m ATR 的常态是 2–4%
   *   → 差 2.4–5 倍 → **没有任何标的能通过** → 40+ 轮零决策
   * ```
   * 而 `#10`（ai_managed）的历史里，模型把 `minPositionSize` **连改 5 次**
   *（12→6→6→5.5→5.1），每次理由都是"账户太小、门槛不可达"，**每次结算都是负的** ——
   * 它在改一个**不是瓶颈**的参数。
   *
   * ### 所以把它做成字段
   *
   * 现在模型可以 `set_params({"riskControl":{"riskPerTradePercent":5}})` ——
   * **提示词那句话从此是真的**。
   *
   * ⚠️ **上界 20%**：那已经不是"风险预算"而是"押注"了。
   * 留出这个上界是为了不让一次误判毁掉账户；但**它不是"系统替你按 2% 走"**。
   */
  riskPerTradePercent: z.number().min(0.1).max(20).default(2),

  /**
   * **用"自身保证金"替代"权益百分比"作为单笔上限**（2026-10-13 用户要求）。
   *
   * ## 用户的原话
   *
   * > 「**不要限制单笔上限**（由于系统【逐仓】运行，所以一笔交易最多亏损保证金，
   * >  所以用户会自己控制，不需要系统限制最大止损金额），
   * >  改成**以自身保证金为限制**」
   *
   * ## 为什么这个改动是对的（逐仓的数学）
   *
   * 在**逐仓**下，一笔交易的**最大亏损就是它自己的保证金** ——
   * 强平不会动到别的仓位的钱（这正是 `marginMode: 'isolated'` 的含义）。
   * 所以：
   * ```
   *   旧口径：单笔亏损 ≤ 权益 2%    → 一个【人为的】比例
   *   新口径：单笔最多亏掉它的保证金 → 一个【物理的】事实
   * ```
   * 旧口径在**小账户**上会算出一个荒谬的窄止损带（实测：权益 20.75 × 2%
   * 在最小名义 50 上只能给 **0.83%**，而实际需要 2–4%）→ **40+ 轮零决策**。
   *
   * ## 打开时会发生什么
   *
   * ```
   *   · 不再用 `riskPerTradePercent` 反推止损带上限（提示词那一段会换掉）
   *   · `minRiskRewardRatio` 仍然**保留**（用户明确说："盈亏比和胜率的要求可以保留"）
   *   · 模型**自己决定每笔划多少保证金**（用户选的就是这个）
   * ```
   *
   * ⚠️ **默认 `false`** —— 既有机器人（尤其实盘 `#10`）的行为**逐字节不变**。
   * 打开必须是一次显式选择。
   */
  marginBasedLimit: z.boolean().default(false),

  /** Force an exchange-side stop loss on every entry. Strongly recommended. */
  requireStopLoss: z.boolean().default(true),
  /** Force an exchange-side take profit on every entry. */
  requireTakeProfit: z.boolean().default(true),

  /**
   * 持仓的**保证金模式**：逐仓还是全仓。
   *
   * ## ⚠️ 默认 `isolated`，而这是一个**刻意的非默认选择**
   *
   * 币安官方明文：**「All contracts and positions are defaulted to the Cross
   * Margin mode」** —— 也就是**不管它的话，账户就是全仓**。而这个系统在此之
   * 前从来没调用过 `setMarginType`，所以实盘上一直是全仓。
   *
   * ## 两者差在哪（这是默认值选 `isolated` 的全部理由）
   *
   * | | 全仓 CROSSED | 逐仓 ISOLATED |
   * |---|---|---|
   * | 保证金 | 该保证金资产的钱包**共享** | 每个 symbol 单独划 |
   * | 爆仓时 | **吃掉整个合约钱包** | **最多亏掉这一仓的保证金** |
   * | 强平价 | 由整个钱包决定，随别的仓位变化 | 只由该 symbol 自身决定 |
   *
   * 对一个**本金很小、同时开好几个仓**的账户，全仓意味着"任何一笔判断错到底，
   * 都可能把其他仓位的钱一起带走" —— 一次爆仓清空账户，而不是亏掉那一笔。
   * 逐仓把损失上限锁在单仓，**这对一个还在验证策略的系统是更对的默认**。
   *
   * ## 硬约束（决定了它什么时候能生效）
   *
   * 币安要求在**零持仓、零挂单**时才能改（`-4047` 有挂单 / `-4048` 有持仓）。
   * 所以它**不能带仓切换**：本系统在**每个 symbol 下第一单之前**设置，
   * 于是新开的仓从一开始就是逐仓，而已经存在的仓位保持原样（不强行平掉它们）。
   */
  marginMode: z.enum(['isolated', 'crossed']).default('isolated'),

  /**
   * 保护单是否开启币安的「触发价格保护」（`priceProtect`）。
   *
   * ## ⚠️ 默认 `false`，而默认值改过 —— 原来是 `true`
   *
   * 官方对 `priceProtect` 的定义是：价格触及 `stopPrice` 时，若**标记价与合约价
   * 的偏离率**超过该标的的 `triggerProtect` 阈值（BTC/ETH 是 5%，部分是 10%），
   * **本次触发受保护**。
   *
   * 好处是**不被瞬间影线打掉**。而代价是：**极端行情双价差拉大时，止损根本不会触发。**
   *
   * 对一个保证金账户来说那个取舍是反的 —— **止损的全部意义就是"该止损时一定止损"**。
   * 一张"在剧烈行情里不生效"的止损，恰好在你最需要它的那一刻缺席，而那时仓位正在
   * 快速亏钱。影线打掉止损只是少赚一次；止损不触发则可能亏掉保证金。
   *
   * 所以默认关掉，并把开关**交给 AI 与操作员**：低波动、流动性好的标的上打开它
   * 有道理；持仓已经很大、或标的波动剧烈时应当关掉。
   */
  priceProtectOnStop: z.boolean().default(false),
  /** Stop-loss distance as a % of entry, applied when the model omits one. */
  fallbackStopLossPercent: z.number().min(0.05).max(50).default(2.5),
  /** Take-profit distance as a % of entry, applied when the model omits one. */
  fallbackTakeProfitPercent: z.number().min(0.05).max(200).default(7.5),

  /**
   * 止损距离必须至少是**往返手续费**的多少倍（提案 §5 的手续费感知门槛）。
   *
   * 一笔止损比往返成本还近的交易，**即使方向做对了也是亏的**：价格必须先走完
   * 成本才开始为账户挣钱。这条校验把"手续费"从一个模型可以考虑的因素，变成一条
   * 由风控强制执行的入场边界（§2.1：风控是通往订单的唯一路径）。
   *
   * 3 是保守起点：止损幅度等于手续费时，胜率再高也只是在给交易所打工。
   * 0 表示关闭这条校验（与 `maxDailyLossPercent` 等字段同一约定）。
   */
  minStopLossFeeMultiple: z.number().min(0).max(50).default(3),
  /**
   * 保本止损：浮盈达到这个百分比时，把止损移到开仓价。
   *
   * **0 表示关闭**（与 `maxDailyLossPercent` 等字段同一约定）。
   *
   * 为什么需要它：实测平均持仓 4.6 分钟、手续费占毛盈亏 38%，
   * 而**一笔已经赚到钱的单又变回亏损单是最亏的做法**。
   * 既有的回撤守卫管的是"浮盈回吐太多就落袋"，管不了这件事 ——
   * 它给利润设了上限，而这里要的是"这笔不再可能亏"。
   *
   * ⚠️ 只能往有利方向移，永不回退（见 `risk/breakeven.ts`）。
   */
  breakevenTriggerPercent: z.number().min(0).max(100).default(0),
  /**
   * **追踪止损距离**（百分比，按价格算）。达到 `breakevenTriggerPercent` 之后，
   * 止损跟到"当前价往回退这么多"的位置，而不是停在开仓价。
   *
   * **0 = 只保本、不追踪**（保留旧行为，向后兼容）。
   *
   * ## 为什么要有它：实测"保本"回吐了 27% 的浮盈
   *
   * 只有保本时，止损停在成本价 —— 保护的是"不亏"，**锁不住任何利润**。
   * 实测那 12 笔"移动止损（保本离场）"的账：
   *
   *     峰值浮盈合计 52.3%  →  最终落袋 38.2%     回吐 14.1 个百分点
   *     #113 NEARUSDT  峰值 5.81% → 最终 2.40%
   *     #132 XRPUSDT   峰值 6.44% → 最终 3.63%
   *
   * 更扎心的对照：同期**唯一一笔真正止盈的单赚了 +0.7204**，
   * 比 21 笔止损加起来（+0.2087）还多 3.4 倍 —— 用户的原话「**这不是白玩吗**」。
   *
   * ## 怎么选值
   *
   * 它同时决定"给趋势留多少空间"和"能锁住多少"：
   *   · **太小**（如 0.3%）—— 正常波动就把你扫出去，等于把追踪止损当止盈用；
   *   · **太大**（如 5%）—— 峰值 6% 的仓位要回吐 5% 才走，锁不住什么。
   *
   * 起点建议取**保本阈值对应的价格幅度**量级（阈值 3% 对 3x 杠杆 ≈ 价格 1%），
   * 也就是 0.8–1.5% 这一档。⚠️ 这个值**必须由 AI 从自己的成交里校准** ——
   * 提示词里给了它 `get_skipped_outcomes` 与复盘工具，别拍脑袋定死。
   */
  trailingStopPercent: z.number().min(0).max(50).default(0),
  /**
   * 一张限价入场单**最多等多少分钟**，超过就自动撤掉。
   *
   * ## 为什么需要一条机械规则
   *
   * 模型能撤单了（`cancel_pending`），但那要求它**每轮都记得回头看**这件事：
   * 而"一张挂单还该不该等"恰恰是它容易往后放的那类判断 —— 它每轮要处理
   * 20 个候选、几个持仓、一堆约束，而"我半小时前挂了张单"很容易被挤出去。
   *
   * 它与 `breakevenTriggerPercent` / `drawdownGuard` 是同一类东西：
   * **保护一个已经做出的判断，恰恰是模型可靠地判断错的那件事。**
   * "等太久了就撤"没有任何需要判断的成分 —— 那是一条纯粹的时间规则。
   *
   * ## 为什么默认是 45 分钟
   *
   * 与模型自己的入场标准同量级：它按 **15m/1h** 判方向（提示词里写着"只在
   * 15m 与 1h 同向时才考虑入场"）。一条基于 15m 结构的挂单，45 分钟意味着
   * "三根 15m 都没等到" —— 那个结构大概率已经变了，而价位大概率也走掉了。
   *
   * 太长（比如 4 小时）等于让它一直占着持仓名额；太短（比如 5 分钟）则
   * 挂单根本来不及成交，等于把限价入场变成一个多余的步骤。
   *
   * **0 表示关闭**（与 `maxDailyLossPercent` 等字段同一约定）。
   */
  pendingEntryTimeoutMinutes: z.number().min(0).max(1440).default(45),
  /**
   * 读不到成交记录时，按这个**往返**手续费率校验（小数比例：0.001 = 0.10%）。
   *
   * 实测均值是 0.1000%（15 笔成交），但不同标的、不同 VIP 等级会不同，所以真实
   * 取值优先用成交记录算出来的 `Σfee / Σ名义价值`（见
   * `RiskEnvironment.roundTripFeeRate`）；这里的默认值只在"这个机器人还没有任何
   * 成交"时兜底。**不要把它写死成常量**：那会让这个数字在 VIP 账户上系统性偏高。
   */
  fallbackRoundTripFeeRate: z.number().min(0).max(0.05).default(0.001),
});
/**
 * ⚠️ **当前仓库内无人引用**（我全仓 grep 过）—— 但**刻意保留**。
 *
 * ## 为什么保留而不是删掉
 *
 * 1. **它属于跨端契约**：`@aq/shared` 的职责就是"zod schema + 领域类型"，
 *    而这个类型与 `RiskControlConfigSchema` **成对**。删掉类型、只留 schema，
 *    下一个要用它的人得自己再写一遍 `z.infer`。
 * 2. **它不可能"腐化"**：它是 `z.infer<typeof Schema>` ——
 *    schema 一改它**自动跟着改**，不存在"注释与实现漂移"那类风险。
 *    ⚠️ 这正是它与"死代码"的关键区别：**死代码会误导人，它不会**。
 * 3. **删除是不可逆的信息损失**，而保留的成本是零（类型不产生运行时代码）。
 *
 * ⚠️ 我核对了同类：全仓 13 个 `z.infer` 配套类型里 **10 个被引用**，
 * 未被引用的只有 3 个（本文件里这 3 个）—— 所以"成对导出"是这里的惯例，
 * 它们不是"忘了删"，是"暂时没人用"。
 *
 * ⚠️ 判断依据：`packages/shared/package.json` 是 `"private": true`
 * —— 它**不对外发布**，所以"下游用户可能依赖它"这个理由**不成立**。
 * 保留的理由是上面第 1–3 条，**不是**"怕破坏外部使用者"。
 */
export type RiskControlConfig = z.infer<typeof RiskControlConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Protection — drawdown giveback, throttling, circuit breakers                */
/* -------------------------------------------------------------------------- */

export const DrawdownGuardSchema = z.object({
  enabled: z.boolean().default(true),
  /** Only arm the guard once a position's peak profit exceeds this (%). */
  activationPercent: z.number().min(0).max(1000).default(1.5),
  /** Close when this fraction of the peak profit has been given back (0-1). */
  givebackRatio: z.number().min(0.05).max(1).default(0.5),
});
/**
 * ⚠️ **当前仓库内无人引用** —— 刻意保留，理由同 `RiskControlConfig` 上面那段
 *（成对的 schema 契约 / `z.infer` 不可能腐化 / 删除是不可逆的信息损失）。
 */
export type DrawdownGuard = z.infer<typeof DrawdownGuardSchema>;

export const ThrottleConfigSchema = z.object({
  /** A freshly opened position cannot be closed by the model before this. */
  minHoldMinutes: z.number().min(0).max(1440).default(3),
  /** Per-symbol lockout after a close. */
  reentryCooldownMinutes: z.number().min(0).max(1440).default(10),
  /** Entry orders allowed per decision cycle. */
  maxEntriesPerCycle: z.number().int().min(1).max(20).default(2),
  /** Entry orders allowed per rolling hour. */
  maxEntriesPerHour: z.number().int().min(1).max(60).default(6),
});

export const CircuitBreakerConfigSchema = z.object({
  /** Halt new entries once the day's realised loss exceeds this (% of equity). */
  maxDailyLossPercent: z.number().min(0).max(100).default(5),
  /** Halt new entries once equity falls this far below its high-water mark (%). */
  maxTotalDrawdownPercent: z.number().min(0).max(100).default(20),
  /** Consecutive LLM/execution failures before safe mode engages. */
  safeModeAfterFailures: z.number().int().min(1).max(50).default(3),
  /**
   * ⚠️ **当前未生效 —— 保留字段，不要以为它在工作。**
   *
   * 这个字段的意图是"处于安全模式时，等这么多周期再去探测模型一次"。
   * 而服务端**没有任何地方读它**：`AutoTrader` 的实现是"连续失败 N 次进入安全模式，
   * 下一次成功即退出"（`if (this.status === 'safe_mode') this.setStatus('running', null)`），
   * 中间没有节流探测。
   *
   * 也就是说调整它对行为**没有任何影响** —— 而字段名与这里原本的描述（"While in
   * safe mode, wait this many cycles before probing the model again"）都让人以为有。
   * **一个看起来能动、实际不动的旋钮比没有这个旋钮更糟**：操作员会以为自己在调节
   * 探测频率，而真实行为一点没变。
   *
   * 保留字段而不是删掉：删它会让所有已存在的策略读取失败（见 §5.4 那条
   * "每个新字段都必须有 `.default()`" 的反面）—— 一个字段消失比一个字段不生效
   * 更严重。要让它真的生效，需要在 `AutoTrader` 里加"安全模式下的探测节流"。
   */
  safeModeProbeCycles: z.number().int().min(1).max(100).default(3),
});

/* -------------------------------------------------------------------------- */
/*  Prompt sections — the strategy itself                                      */
/* -------------------------------------------------------------------------- */

export const TradingModeSchema = z.enum(['aggressive', 'conservative', 'scalping']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

export const PromptSectionsSchema = z.object({
  roleDefinition: z.string().default(''),
  tradingFrequency: z.string().default(''),
  entryStandards: z.string().default(''),
  decisionProcess: z.string().default(''),
});
/**
 * ⚠️ **当前仓库内无人引用** —— 刻意保留，理由同 `RiskControlConfig` 上面那段
 *（成对的 schema 契约 / `z.infer` 不可能腐化 / 删除是不可逆的信息损失）。
 */
export type PromptSections = z.infer<typeof PromptSectionsSchema>;

/* -------------------------------------------------------------------------- */
/*  Full strategy                                                              */
/* -------------------------------------------------------------------------- */

export const StrategyConfigSchema = z.object({
  /** Display name shown in the console. */
  name: z.string().min(1).max(80).default('Default strategy'),
  description: z.string().max(500).default(''),

  tradingMode: TradingModeSchema.default('conservative'),

  coinSource: CoinSourceConfigSchema.default({}),
  indicators: IndicatorConfigSchema.default({}),
  riskControl: RiskControlConfigSchema.default({}),
  drawdownGuard: DrawdownGuardSchema.default({}),
  throttle: ThrottleConfigSchema.default({}),
  circuitBreaker: CircuitBreakerConfigSchema.default({}),

  promptSections: PromptSectionsSchema.default({}),
  /** Appended verbatim to the system prompt. */
  customPrompt: z.string().max(20_000).default(''),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type StrategyConfigInput = z.input<typeof StrategyConfigSchema>;

/**
 * `StrategyConfig` 的**顶层键**（从 schema 派生，不手抄）——
 * 它回答的是「一份配置由哪几块组成」。
 *
 * ## 为什么要导出它
 *
 * 「套预设」与「这份配置还等于哪个预设」这两件事都必须**遍历同一份分区清单**，
 * 而两处各手写一遍就是同一件事有了两份定义 —— 加了新分区之后，漏掉的那一份
 * 会**静默地不参与比较**（于是徽章显示"稳健"，而某一块其实是别的预设留下的）。
 * 这正是本文件这一族缺陷的形状（`configSchemaGuard.test.ts` 记的就是"两套口径分叉"）。
 *
 * ⚠️ **`name` / `description` 也在其中，但那是"配置由哪几块组成"的事实，不是判据的一部分。**
 *
 * 三套预设的 `patch` 里**都没有** `name` / `description`（实测 `'name' in preset.patch === false` ×3）
 * —— 它们是**用户给策略起的名字**，而保存路径会把用户名写进 `config.name`。
 * 所以"还等于哪份预设"的判据必须**排除**这两个键，见 `PRESET_IDENTITY_EXCLUDED_KEYS`
 * 与 `presetOfConfig()` 的说明（把名字纳入比较会让每一条经界面保存的策略都显示"已偏离预设"）。
 */
export const STRATEGY_CONFIG_KEYS = Object.keys(
  StrategyConfigSchema._def.shape(),
) as ReadonlyArray<keyof StrategyConfig>;

/* -------------------------------------------------------------------------- */
/*  Factory defaults + presets                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A fully-populated config. Zod defaults fill every field.
 *
 * ## ⚠️ 为什么必须补 `coinSource`（2026-10-27 实测踩到）
 *
 * schema 的裸默认值是 `sourceType: 'static'` + `staticCoins: []` ——
 * 也就是**一个候选标的都没有**。于是"新建默认策略"建出来的东西看起来完全正常
 * （字段齐全、类型正确、界面能打开），但机器人启动时只会写一条：
 *
 *     机器人 #N 的配置里没有任何候选标的（静态列表为空、也没开动态候选池）
 *     —— 它不会交易任何东西。
 *
 * 而那条警告**不影响状态**：机器人显示 `running`、每轮周期"成功"、日志干净，
 * 唯一的症状是**什么都不发生**。本仓对这种形状有明确态度（见 `reachability.ts`）：
 * 一个"能启动但永远不会交易"的默认值，比一个启动就报错的默认值更糟。
 *
 * 所以这里用 `conservative` 预设的 `coinSource` 覆盖 —— 它与 `seedDefaults()`
 * 创建「默认策略 — 稳健」时用的正是同一个预设，两者口径一致：
 * `mixed` + BTC/ETH + 动态候选池。
 *
 * ⚠️ **只覆盖 `coinSource`，其余分区仍走 schema 默认值。**
 * 整体换成预设会改变杠杆、风控与门槛，那是一次行为变更，
 * 而这里要修的只是"没有候选标的"这一个缺陷。
 */
export function defaultStrategyConfig(): StrategyConfig {
  const base = StrategyConfigSchema.parse({});
  const conservative = STRATEGY_PRESETS.find((preset) => preset.id === 'conservative');
  if (!conservative) return base;
  return StrategyConfigSchema.parse({
    ...base,
    coinSource: { ...base.coinSource, ...conservative.patch.coinSource },
  });
}

/**
 * **智能托管（`ai_managed`）机器人的起始配置：不替模型预设边界。**
 *
 * ## 为什么它与 `defaultStrategyConfig()` 不同（用户的直接要求）
 *
 * 用户的原话：
 *
 * > 「这是智能托管模式，我去哪里改？……既然完全交给模型，那么怎么操作都由模型
 * >  决定啊，而不是系统就提前写死了，模型改还有什么意义呢？？」
 *
 * 他的话是对的，而且矛盾就在代码里：提示词对模型说
 * 「**这些数字全部来自你自己的策略配置，归你调 —— 用 `set_params` 改，下一轮就
 * 生效**……它们列在这里不是"不可更改的规定"，而是**你当前选定的边界**」——
 * **可"选定"这些边界的既不是模型，界面上也没有入口**：AI 托管的机器人不引用策略
 * （`strategyId = null`），所以策略编辑页对它无效；它的起点来自
 * `StrategyConfigSchema.parse({})`，也就是**一组保守的 schema 默认值**
 * （3 个持仓、5x 杠杆、逐仓、75 分门槛）。**"能改"与"替你定死"是互相矛盾的。**
 *
 * 所以智能托管的起点改成**处处顶格**：上限放到 schema 允许的最大值，
 * 门槛类字段归零（不设门槛），让"要不要保守"成为**模型自己每一轮的决定**，
 * 而不是系统替它在第一轮就做掉的决定。
 *
 * ## 唯一保留的一条：`requireStopLoss`
 *
 * 一个没有保护的杠杆仓位可以在几秒内亏光全部保证金 —— 那**不是一种策略选择**
 * （`patch.ts` 的 `STRUCTURAL_INVARIANTS` 也把它列为唯一的结构不变量，
 * 且改不动）。它与"限制模型的自由度"不是一回事：**它限制的是"裸奔"，
 * 不是"怎么交易"**。
 *
 * ## 保留在保守值的两项，以及为什么
 *
 * · `defaultLeverage` —— 只在模型**没有**给出杠杆时兜底。那是"没意见"的默认，
 *   不是对它的限制；把兜底也顶格等于替它下了一个激进的决定。
 * · `minPositionSize` / `fallbackStopLossPercent` / `fallbackTakeProfitPercent`
 *   —— 前者的下限由**交易所的最小名义**决定（填小了会被拒），后者只在模型
 *   没给保护位时用。它们都不是"边界"，改小没有意义。
 */
export function unboundedAiManagedConfig(): StrategyConfig {
  return StrategyConfigSchema.parse({
    riskControl: {
      /* 持仓数与杠杆：顶格（交易所给该账户的授信是 BTC 150x / 山寨 100x）。 */
      maxPositions: 20,
      btcEthMaxLeverage: 125,
      altcoinMaxLeverage: 125,
      /* 名义敞口上限：顶格（配合上面的杠杆，真正的总闸是 maxMarginUsage）。 */
      btcEthMaxPositionValueRatio: 50,
      altcoinMaxPositionValueRatio: 50,
      /* 保证金占用：允许用满。 */
      maxMarginUsage: 100,
      /* 门槛归零 —— "要不要出手"由模型判断，不由数字拦。 */
      minRiskRewardRatio: 0,
      minConfidence: 0,
      /* 止盈是策略选择，交给模型；止损是结构要求，保留。 */
      requireTakeProfit: false,
      requireStopLoss: true,
    },
  });
}

/**
 * **AI 团队模式**的初始配置。
 *
 * ## 为什么不复用 `unboundedAiManagedConfig()`
 *
 * 那份配置是**单智能体**的口径：上限顶格、门槛归零，让那一个模型自己决定。
 * 它**没有候选标的池**（默认 `staticCoins: []`）——
 * 而团队模式如果没有标的，会**跑得起来但永远不会交易任何东西**
 *（实测：日志报「配置里没有任何候选标的」，而界面显示"运行中"）。
 *
 * 用户 2026-10-12 的原话：
 * > 「开启以后，整个智能体团队就开始并发工作……然后做相应的动作
 * >  （**开仓、平仓、调仓**等等）」
 *
 * 一个不交易任何标的的机器人**不满足这个要求** —— 所以团队模式必须
 * 自带一个**可用的起点**。
 *
 * ## 风控口径：与智能托管一致的"不设边界"
 *
 * 用户明确要求「系统不再设置内置风控……风格由智能体负责」，
 * 而团队模式另有**风控官**在裁决之后把关（见 `riskOfficer.ts`）。
 * 所以数值口径与 `unboundedAiManagedConfig` 一致：上限顶格、门槛归零，
 * **唯一保留的是 `requireStopLoss`**（那是结构要求，不是策略偏好 ——
 * 没有止损的仓位等于没有下限）。
 *
 * ## 标的池为什么用**动态**而不是写死几个币
 *
 * 团队模式要「模拟真实专业量化机构」—— 而机构不会永远只盯两个币。
 * 用 `coinpool`（按成交额排序的全市场筛选）让它**每轮都能看到当下的机会**，
 * 同时用 `coinPoolLimit` 限制数量（候选太多会把提示词吃满）。
 */
export function defaultAiTeamConfig(): StrategyConfig {
  return StrategyConfigSchema.parse({
    coinSource: {
      /* 动态池 + 成交额排序：最主流、流动性最好的那些。 */
      sourceType: 'coinpool',
      useCoinPool: true,
      coinPoolLimit: 8,
      coinPoolRank: 'quote_volume',
      /* 同时看持仓量增长最快的 —— 那往往是"有新资金进来"的信号。 */
      useOITop: true,
      oiTopLimit: 4,
      /* 过滤掉稳定币与成交额太小的（滑点会把利润吃光）。 */
      excludeStablecoins: true,
      /* ⚠️ 字段名必须是 minQuoteVolume24h —— 写成 minQuoteVolume 会被 schema 静默丢弃。 */
      minQuoteVolume24h: 50_000_000,
    },
    riskControl: {
      maxPositions: 20,
      btcEthMaxLeverage: 125,
      altcoinMaxLeverage: 125,
      btcEthMaxPositionValueRatio: 50,
      altcoinMaxPositionValueRatio: 50,
      maxMarginUsage: 100,
      minRiskRewardRatio: 0,
      minConfidence: 0,
      requireTakeProfit: false,
      /* ⚠️ **保留**：没有止损的仓位等于没有下限。这是结构要求，不是策略偏好。 */
      requireStopLoss: true,
    },
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **`promptSections` 必须有内容**（2026-10-13 实测抓到 —— 一个真问题）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：团队模式的机器人**连"我是谁、怎么决策"都没被告知**
     *
     * 实测 `#11` 的 `promptSections`：
     * ```
     *   roleDefinition    0 字   ← 空
     *   tradingFrequency  0 字   ← 空
     *   entryStandards    0 字   ← 空（后来由策略师自己填了 941 字）
     *   decisionProcess   0 字   ← 空
     *   customPrompt      0 字   ← 空
     * ```
     * 而 `defaultAiTeamConfig()` **没有设 `promptSections`** ——
     * 于是它走 schema 的 `.default({})`，**四个字段全是空串**。
     *
     * ## 而这是策略师**自己诊断出来的**（`agent_experiments #81` 的 reason 原文）
     *
     * > 「All promptSections are **empty strings** — the decision agent has
     * >  **no behavioral guidance**, so it **defaults to inaction**.
     * >  Writing minimal entryStandards addresses the 'no instruction = no action'…」
     *
     * **它的诊断是对的**：一个没有被告知"什么时候该出手"的交易员，
     * 最自然的默认行为就是**什么都不做**（那永远不会有亏损）。
     *
     * ## ⚠️ 为什么这不违反"不设内置风控 / 风格由智能体负责"
     *
     * 两者的区别是**"边界"与"指引"**：
     * ```
     *   ✗ 边界（不该有）：「单笔风险 ≤ 权益 2%」「最少 75 分置信度」
     *                     —— 那是系统替它决定"多保守"
     *   ✓ 指引（该有）  ：「你是谁」「你的决策流程是什么」
     *                     —— 那是【工作说明书】，不是策略偏好
     * ```
     * 一个公司不会规定交易员"必须多保守"，但**会告诉他岗位职责**。
     * 没有后者，他不是"自由"，而是**茫然**。
     *
     * ## 所以这里给的是**流程与职责**，不是门槛
     *
     * ```
     *   roleDefinition   —— 你是团队的首席决策者（职责）
     *   decisionProcess  —— 你按什么步骤做决定（流程）
     *   tradingFrequency —— 节奏由你自己定（**不写死"少交易"**）
     *   entryStandards   —— **故意留空**：入场标准是**它的判断**，
     *                       而实测证明它自己会写（941 字，且写得很好）
     * ```
     * ⚠️ **`entryStandards` 留空是刻意的** —— 那正是"风格由智能体负责"的落点。
     */
    promptSections: {
      roleDefinition:
        '你是一支量化交易团队的首席决策者。团队里有行情分析师、技术分析师、' +
        '新闻整理员、情绪分析师、多空辩论者与风控官 —— 他们各自给你一份产出，' +
        '而**最终决定由你做出**。\n' +
        '⚠️ 你不是执行规则的机器：**市场变了，你的判断也该变**。',
      decisionProcess:
        '每一轮按这个顺序走：\n' +
        '1. **先看持仓**：已有仓位的逻辑是否还成立？被破坏就平掉（那是优先级最高的动作）。\n' +
        '2. **再看候选**：逐个问"这个标的现在有没有可执行的失效位"。\n' +
        '3. **再定方向**：多空都要看 —— 而"两边都不做"也是合法结论。\n' +
        '4. **最后定大小**：逐仓下你一笔最多亏掉它自己的保证金，所以**划多少是你的判断**。\n' +
        '⚠️ 每一步的结论都要能说出**依据**（哪个指标、哪条消息、什么结构）。',
      tradingFrequency:
        '节奏**由你自己决定**：系统没有规定你该多频繁交易。\n' +
        '⚠️ 但"不行动"必须是**一个结论**，不是**默认值** —— ' +
        '它应当来自"我看过了，确实没有可执行的机会"，而不是"我没找到理由动手"。',
    },
  });
}

/**
 * **JEV 模式（实验性）的初始配置**（2026-10-19）。
 *
 * ## 它与 `defaultAiTeamConfig()` 的关键差异
 *
 * | 项 | 团队模式 | JEV 模式 | 为什么 |
 * |---|---|---|---|
 * | 候选池 | 动态 `coinpool` 8 + OI 4 | **同团队** | 选币本来就是 Jev 的强项，给它足够的候选 |
 * | `minRiskRewardRatio` | 0 | **1.5** | Jev 不产生数字，盈亏比由**档位表**保证；给个下限兜住 |
 * | `minConfidence` | 0 | **40** | Jev 的 `confidence` 实测在 0.25–0.88 之间，40 是"略低于中位"的保守线 |
 * | `maxPositions` | 20 | **4** | 实验性模式，先小步验证 |
 *
 * ## ⚠️ 为什么 `requireStopLoss` 必须是 `true`
 *
 * 这不是策略偏好，是**结构要求**（`docs/AGENTS.md` §2.6）：一个没有止损的
 * 杠杆仓位是最糟糕的状态。Jev 选的是"止损档位"，而**挂单这件事由代码保证** ——
 * 两者不冲突，但下限不能放开。
 *
 * ## ⚠️ 为什么不给 `promptSections` 写交易指引
 *
 * 团队模式那套 prompt 是**给 LLM 读的散文**。Jev **不读散文、也不产生散文**
 *（实测：它的输入是结构化摘要，输出是三种类型化答案）。
 * 给它写"你是首席决策者"这种话是**无效的** —— 它不会因此改变行为。
 *
 * ⇒ 本模式真正影响 Jev 的"指引"是**问题怎么问**（`jevModel.ts` 里的
 *   `instructions` 与 `criteria`），不是 `promptSections`。
 *   所以这里留空，避免留下一个"看起来在起作用、实际没人读"的配置。
 */
export function defaultJevConfig(): StrategyConfig {
  return StrategyConfigSchema.parse({
    coinSource: {
      /* 与团队模式同一套动态池 —— 候选质量是 Jev 能发挥作用的前提。 */
      sourceType: 'coinpool',
      useCoinPool: true,
      coinPoolLimit: 8,
      coinPoolRank: 'quote_volume',
      useOITop: true,
      oiTopLimit: 4,
      excludeStablecoins: true,
      minQuoteVolume24h: 50_000_000,
    },
    riskControl: {
      /* 实验性：先限制在 4 个仓位，验证行为之后再放宽。 */
      maxPositions: 4,
      btcEthMaxLeverage: 20,
      altcoinMaxLeverage: 10,
      btcEthMaxPositionValueRatio: 5,
      altcoinMaxPositionValueRatio: 3,
      maxMarginUsage: 30,
      /*
       * ⚠️ **1.5 而不是 0**：Jev 的止盈档由代码按 2:1 算好，
       * 但万一它选了最近的一档，这个下限会替我们挡住"赚一点点就跑"。
       */
      minRiskRewardRatio: 1.5,
      /*
       * ⚠️ **40 而不是 0**：实测 Jev 的 confidence 分布是 0.25–0.88。
       * 40 分位略低于中位 —— 既不会把大部分机会挡掉，也不会放行最没把握的那些。
       * 这个值**是实验参数，不是定论**，观察后再调。
       */
      minConfidence: 40,
      requireTakeProfit: true,
      /* 结构要求，不可放宽（见上面的说明）。 */
      requireStopLoss: true,
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **移动止损：JEV 模式必须开它**（2026-10-19 · P2）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 为什么这不是"可选优化"而是必需
       *
       * JEV 模式的开仓档位里，止盈是**固定 2:1** 挂着的。如果止损永远不动，
       * 那么一个已经浮盈 3% 的仓位，一次正常回调就会把利润全部吐回去 ——
       * 这正是仓库里记录过的那笔账：
       * ```
       *   12 笔"保本离场"：峰值浮盈合计 52.3% → 最终落袋 38.2%（回吐 14.1 个点）
       *   而同期唯一一笔真正止盈的单赚了 +0.7204，
       *   比 21 笔止损加起来（+0.2087）还多 3.4 倍
       * ```
       *
       * ## 为什么是这两个值
       *
       * `breakevenTriggerPercent: 3` —— 浮盈 3%（按保证金算）时开始动止损。
       * 5x 杠杆下约等于价格走 0.6%，那是"这笔已经明显对了"的量级。
       *
       * `trailingStopPercent: 1` —— 之后止损跟到"当前价往回退 1%"。取仓库
       * 注释里建议的 0.8–1.5% 中间值：太小会被正常波动扫出去，太大锁不住利润。
       *
       * ⚠️ **这两个值是实验起点，不是定论** —— 观察之后该由数据来调
       *（这也是为什么它们放在策略配置里，而不是写死在代码里）。
       *
       * ⚠️ 机制本身是**既有的**（`risk/breakeven.ts` 的 `shouldMoveStopToBreakeven`），
       * 它保证"只往有利方向移、永不回退"。这里只是把参数打开，没有造新逻辑。
       */
      breakevenTriggerPercent: 3,
      trailingStopPercent: 1,
    },
    /*
     * `promptSections` **刻意留空** —— 理由见函数头那段：
     * Jev 不读散文。写了也只是让配置看起来更完整，实际没人读。
     */
  });
}

/**
 * Style presets mirroring the three trading modes. These only seed the
 * *prompt* sections and a few numeric knobs — the user is free to edit
 * everything afterwards.
 */
export interface StrategyPreset {
  id: string;
  label: string;
  summary: string;
  tradingMode: TradingMode;
  patch: Partial<StrategyConfigInput>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'conservative',
    label: '稳健',
    summary: '多重信号确认、低杠杆、宽止损、少交易。',
    tradingMode: 'conservative',
    patch: {
      tradingMode: 'conservative',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT'],
        useCoinPool: true,
        useOITop: true,
        coinPoolLimit: 15,
        coinPoolRank: 'quote_volume',
        minQuoteVolume24h: 100_000_000,
        minOpenInterestUsd: 10_000_000,
        oiTopLimit: 8,
        oiTopWindowHours: 4,
      },
      riskControl: {
        maxPositions: 2,
        btcEthMaxLeverage: 3,
        altcoinMaxLeverage: 3,
        defaultLeverage: 2,
        btcEthMaxPositionValueRatio: 3,
        altcoinMaxPositionValueRatio: 0.5,
        maxMarginUsage: 50,
        minPositionSize: 12,
        minRiskRewardRatio: 3,
        minConfidence: 80,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 2.5,
        fallbackTakeProfitPercent: 7.5,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
        /*
         * ⚠️ **这一行是一段真实生效的保护动作，不要再删它。**
         *
         * 它曾经被删过一次，理由是"模板声明了 8、而 schema 默认是 0，所以声明不生效"
         * —— **那条理由是假的，已实测推翻**（`t50` 审查抓出、队长复核）：
         *
         * ```
         *   StrategyConfigSchema.parse({ riskControl: { breakevenTriggerPercent: 8 } })
         *     .riskControl.breakevenTriggerPercent   → 8     ← 真的解析出来了，没被丢掉
         * ```
         *
         * 两个事实叠在一起才看清它：
         *   · 它写在 `patch.riskControl` **内**（层级正确），所以 zod 不会 strip 它；
         *   · 运行时**真的读它**：`autoTrader.ts` 的 `applyBreakevenGuard()` 取
         *     `activeConfig.riskControl.breakevenTriggerPercent`，`if (!(threshold > 0)) return 0;`
         *     ⇒ 8 让这条守卫**在工作**（浮盈 8% 把止损移到成本价）。
         *
         * ## 「模板声明值 ≠ schema 默认值」是 patch 的正常形态，不是缺陷
         *
         * 整套预设里**绝大多数**声明字段都如此（实测 129 个声明字段里，
         * 与 schema 默认值不同的有 82 个）—— 预设的意义本来就是"在默认值之上做选择"。
         * 判据应当是**声明值解析后逐字保留**，而不是"不许与默认值不同"。
         *
         * ⚠️ **改这个值之前先读 `strategyPresets.test.ts` 里那条行为级用例**
         * （它断言 `resolvePreset('conservative').riskControl.breakevenTriggerPercent === 8`）：
         * 那条用例就是为这次误删加的，删值会让它当场变红。
         */
        breakevenTriggerPercent: 8,
      },
      throttle: {
        minHoldMinutes: 30,
        reentryCooldownMinutes: 60,
        maxEntriesPerCycle: 1,
        maxEntriesPerHour: 2,
      },
      promptSections: {
        roleDefinition:
          '你是一名管理真实账户的稳健型加密货币合约交易员。保住本金是你的首要目标；错过一笔交易永远好过做错一笔交易。',
        tradingFrequency:
          '有选择地交易。连续多个周期不产生任何订单是完全正常且正确的。只在多重信号共振的高置信度机会上出手。',
        entryStandards:
          '入场前至少需要三个相互独立的确认（例如：多周期趋势一致、动能同向、持仓量与资金费支持）。拒绝"有可能"的机会，只接受"显而易见"的机会。',
        decisionProcess:
          '1) 先判断高周期趋势。2) 再看低周期结构与动能。3) 用持仓量和资金费做确认。4) 核验盈亏比至少达到 3:1。5) 按"止损被扫掉只损失不超过账户权益 1%"来确定仓位大小。6) 明确写出这笔交易的失效位。',
      },
      customPrompt:
        '绝不向亏损的仓位加仓。除非 1 小时与 15 分钟周期同时确认反转，否则绝不逆着 4 小时趋势开仓。',
    },
  },
  {
    id: 'aggressive',
    label: '进取',
    summary: '趋势突破、更高杠杆容忍度、更大仓位规模。',
    tradingMode: 'aggressive',
    patch: {
      tradingMode: 'aggressive',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useCoinPool: true,
        useOITop: true,
        coinPoolLimit: 30,
        coinPoolRank: 'gainers',
        minQuoteVolume24h: 30_000_000,
        minOpenInterestUsd: 5_000_000,
        oiTopLimit: 15,
        oiTopWindowHours: 2,
      },
      riskControl: {
        maxPositions: 5,
        btcEthMaxLeverage: 10,
        altcoinMaxLeverage: 7,
        defaultLeverage: 5,
        btcEthMaxPositionValueRatio: 8,
        altcoinMaxPositionValueRatio: 2,
        maxMarginUsage: 80,
        minPositionSize: 12,
        minRiskRewardRatio: 2,
        minConfidence: 70,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 3,
        fallbackTakeProfitPercent: 8,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
      },
      throttle: {
        minHoldMinutes: 5,
        reentryCooldownMinutes: 10,
        maxEntriesPerCycle: 3,
        maxEntriesPerHour: 10,
      },
      promptSections: {
        roleDefinition:
          '你是一名激进的加密货币永续合约动能交易员。你捕捉突破后的延续与波动扩张，接受较低的胜率，依靠不对称的盈亏比获利。',
        tradingFrequency:
          '保持活跃。每个周期扫描整个候选池，只要出现合格机会就拿下其中最优秀的一到三个。',
        entryStandards:
          '在放量且持仓量上升的整理区间被有效突破时入场。优先选择相对 BTC 走强的标的。不要追一根已经偏离突破位超过 3% 的K线。',
        decisionProcess:
          '1) 按相对强度与动能给候选标的排序。2) 找出清晰且紧凑的突破位。3) 用成交量与持仓量扩张做确认。4) 在被突破结构的另一侧精确设置止损。5) 目标至少是止损距离的 2 倍。',
      },
      customPrompt:
        '快速止损——突破失败即视为失效。让盈利单奔跑至目标位，不要过早止盈。',
    },
  },
  {
    id: 'scalping',
    label: '短线',
    summary: '短线动能、紧贴的目标位、快速换手。',
    tradingMode: 'scalping',
    patch: {
      tradingMode: 'scalping',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useCoinPool: true,
        useOITop: false,
        coinPoolLimit: 25,
        coinPoolRank: 'volatility',
        minQuoteVolume24h: 50_000_000,
        minOpenInterestUsd: 5_000_000,
        oiTopLimit: 4,
        oiTopWindowHours: 1,
      },
      indicators: {
        kline: { primaryTimeframe: '1m', selectedTimeframes: ['1m', '5m', '15m'], primaryCount: 60 },
        enableEma: true,
        emaPeriods: [9, 21],
        enableMacd: true,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        enableRsi: true,
        rsiPeriods: [7],
        enableAtr: true,
        atrPeriods: [14],
        enableVolume: true,
        enableOi: true,
        enableFundingRate: true,
        enableQuantData: true,
        enableOiRanking: false,
      },
      riskControl: {
        maxPositions: 3,
        btcEthMaxLeverage: 20,
        altcoinMaxLeverage: 10,
        defaultLeverage: 10,
        btcEthMaxPositionValueRatio: 10,
        altcoinMaxPositionValueRatio: 3,
        maxMarginUsage: 70,
        minPositionSize: 12,
        minRiskRewardRatio: 1.2,
        minConfidence: 65,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 0.6,
        fallbackTakeProfitPercent: 1.2,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
      },
      drawdownGuard: { enabled: true, activationPercent: 0.4, givebackRatio: 0.4 },
      throttle: {
        minHoldMinutes: 1,
        reentryCooldownMinutes: 3,
        maxEntriesPerCycle: 3,
        maxEntriesPerHour: 20,
      },
      promptSections: {
        roleDefinition:
          '你是一名加密货币永续合约的高频短线交易员。你交易订单流动能的短促爆发，持仓以分钟计而非小时计。',
        tradingFrequency:
          '要非常活跃。每个周期都重新评估，抓住当下最干净的短线动能机会。',
        entryStandards:
          '只在即时动能中入场：最新几根 1 分钟K线的高点/低点被刷新，且有主动买卖流支持。止损紧贴结构位。任何在一两根K线内没有触发的想法都应放弃。',
        decisionProcess:
          '1) 读 1 分钟微观结构与 5 分钟趋势。2) 定位最近的波段高低点。3) 在突破时结合订单流确认入场。4) 把止损放在波段另一侧。5) 目标为最近的流动性区域，快速止盈。',
      },
      customPrompt:
        '激进地保护利润——一笔已经赚到钱的短线单又变成亏损单是最糟糕的结果。除非有充分理由，绝不在资金费结算时刻前后持仓。',
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  预设的解析（"套上预设"到底得到哪一份配置）                                    */
/* -------------------------------------------------------------------------- */

/**
 * 把一份预设**解析成完整配置**：以 schema 默认值为底，再叠该预设的 `patch`。
 *
 * ## ⚠️ 为什么必须是「先重置、再叠 patch」，而不是「叠在当前配置上」
 *
 * 控制台原来那版是后者（`web/src/lib/strategy.ts` 的 `applyPreset`：拿**当前草稿**
 * 当底、用 `{ ...current, ...patch }` 合并）。后果是**未在 `patch` 里出现的字段
 * 一律继承上一份配置**，而三套预设声明的字段集合**并不相同**：
 *
 * | 字段 | conservative | aggressive | scalping |
 * |---|---|---|---|
 * | `indicators` | — | — | ✅ |
 * | `drawdownGuard` | — | — | ✅ |
 * | `breakevenTriggerPercent` | ✅（8） | — | — |
 *
 * 于是「短线 → 稳健」之后，用户拿到的是**稳健的提示词 + 短线的指标与回撤守卫**
 * （`drawdownGuard.activationPercent = 0.4%`，而保守档的 schema 默认是 `1.5%`）。
 * 三处证据都指向同一个判断：
 *   · 提示词里写进了「交易模式：conservative」（`strategy/prompt.ts:2537`）；
 *   · 徽章写着「预设：稳健」（`StrategyEditorPage.tsx` 的 `presetById(state.presetId)`）；
 *   · 而 `drawdownGuard` 与 `indicators` 是短线那一套。
 * **界面在三个地方说了同一件事的三分之一，而参数是第四件事。**
 *
 * ## 为什么"保留用户已改的字段"不是这里要的语义
 *
 * 预设（preset）在用户语言里是「模板」—— 它的含义是"照这一套来"。
 * 而"在现有配置上叠加几项"是另一种操作，它的正确名字是"合并"，且**必须逐项
 * 让用户确认改了哪些**。把两者混成一个下拉框，就是本缺陷的来源。
 * 所以这里把"套模板"的定义收窄成**可判定**的那一种：
 *   `resolvePreset(p).<任意键>` 恒等于 `p.patch` 里声明且有值的那一项，
 *   其余恒等于 schema 默认值。**与传入什么无关 —— 这个函数根本不接受"当前配置"。**
 *
 * ## 与"保留用户手改"的关系（诚实说明）
 *
 * 套预设会丢弃用户在这份草稿上的手改。控制台因此把应用预设做成**显式动作**，
 * 并在提示里说清"应用了哪些字段"（见 `StrategyEditorPage.tsx` 的
 * `applyPresetToDraft`）。这比"静默保留一半"要好 —— 后者得到的状态
 * 用户和系统都描述不出来。
 *
 * `unknown` 入参而不是 `StrategyPreset`：控制台从 `<select>` 只拿得到 id，
 * 这一层不该逼调用方先自己 `find`（那是同一个查找的三份实现）。
 */
export function resolvePreset(preset: StrategyPreset | string): StrategyConfig {
  const found =
    typeof preset === 'string' ? STRATEGY_PRESETS.find((p) => p.id === preset) : preset;
  /*
   * 找不到就抛，不回落。回落成"默认配置"会让一个拼错的/已删除的预设 id
   * **静默地变成一套合法但完全不同的参数** —— 而调用方以为自己套上了预设。
   */
  if (!found) throw new Error(`未知的策略预设：${String(preset)}`);
  const resolved = StrategyConfigSchema.parse(found.patch);
  /*
   * ⚠️ **自证**：`parse` 只接受 `unknown`，所以"patch 里写了但 schema 没有"的键
   * 会被 zod **静默丢掉**（`configSchemaGuard.test.ts` 记的就是这一族）。
   * 「声明即生效」是这三套模板的验收标准，所以这里把丢弃变成**当场可见的失败** ——
   * 一条永远不会被发现的静默丢弃，与"模板说了却不生效"是同一件事。
   *
   * ⚠️ **只在真的做了这个动作时才检查**：`resolvePreset` 是 `presetOfConfig`
   * 的内层循环（每份预设一次），所以这段必须保持 O(1) 的字段遍历。
   */
  for (const section of Object.keys(found.patch) as Array<keyof StrategyConfig>) {
    const claimed = found.patch[section];
    if (typeof claimed !== 'object' || claimed === null || Array.isArray(claimed)) continue;
    const actual = resolved[section] as unknown;
    if (typeof actual !== 'object' || actual === null) continue;
    /*
     * 两侧都收窄成 `Record<string, unknown>` 再取键：`patch` 的分区类型是
     * 各分区 `Input` 的联合（没有索引签名），直接 `claimed[field]` 过不了 TS
     * —— 而这里要的正是"**按名字**看这个键在不在"，与类型无关。
     */
    const claimedFields = claimed as Record<string, unknown>;
    const actualFields = actual as Record<string, unknown>;
    for (const field of Object.keys(claimedFields)) {
      if (claimedFields[field] === undefined) continue;
      if (!(field in actualFields)) {
        throw new Error(
          `预设 ${found.id} 的 patch.${String(section)}.${field} 不在 schema 里 —— ` +
            'zod 会静默丢弃它，于是模板声明了一个不会生效的值',
        );
      }
    }
  }
  return resolved;
}

/**
 * 「还等于哪份预设」的判据**不看**的两个键。
 *
 * ## 为什么必须排除它们（一次真实的"界面说假话"）
 *
 * 它们**不属于模板**：三套预设的 `patch` 里都**没有** `name` / `description`
 * （实测：`'name' in preset.patch === false` ×3）。它们是**用户给这条策略起的名字**。
 *
 * 而配置里那个 `name` 会被**保存路径写成用户名**：
 *   · 编辑器保存：`config: { ...validation.config, name: state.name.trim(), … }`；
 *   · 列表页"从预设新建"：`config.name = name ?? preset.label`（默认就是中文 `稳健/进取/短线`）。
 *
 * 于是把 `name` 纳入比较会出现这个荒谬结果：
 * ```
 *   resolvePreset('conservative')          → name = 'Default strategy'
 *   用户从列表页"从稳健新建"           → config.name = '稳健'
 *   参数逐字等于 conservative，但 name 不同 → presetOfConfig 返回 null
 * ```
 * ⇒ **任何经界面创建/保存的策略，参数明明就是那份模板，徽章却永不出现**，
 * 反而恒显示「已偏离预设」。**这正是本批要消灭的"界面说假话"本身。**
 *
 * 判据只比**模板真正声明过的字段**（参数分区），这才是"这套参数还是不是那套模板"
 * 该回答的问题。用户改名字 = 给策略命名，**不是**把它改成了另一套参数。
 */
export const PRESET_IDENTITY_EXCLUDED_KEYS = ['name', 'description'] as const;

/**
 * 这份配置**是不是就等于**该预设的定义（逐分区深度相等，**排除 name/description**）。
 *
 * ## 为什么需要它：`presetId` 是一个会过期的标签
 *
 * `strategies.preset_id` 只回答"这条策略是**从哪份模板克隆来的**"，它**不随配置改动更新**：
 *   · `PATCH /api/strategies/:id` 只收 `name` / `description` / `config`
 *     （`api/server.ts:1662-1667`）—— `presetId` 传了也会被丢掉；
 *   · 所以用户"套稳健 → 手改两个字段 → 保存"之后，库里 `preset_id` 仍是
 *     `conservative`，而配置已经**不等于** conservative 的定义。
 * 界面上那颗「预设：稳健」徽章于是变成一句**假事实**（列表页的那一行
 * 「稳健 | 短线 | 10×」就是这么来的）。
 *
 * 判据必须落在**配置本身**上，而不是落在那个字段上：本函数是"还能不能这样称呼它"
 * 的唯一实现，任何显示 `presetId` 的地方都应当先过它。
 *
 * ⚠️ 比较用 `JSON.stringify` 而不是逐字段 `===`：配置里有数组与嵌套对象
 * （`selectedTimeframes`、`staticCoins`、`kline`…），逐字段写会漏掉嵌套，
 * 而"漏掉的那一块不参与比较"正是本函数要消灭的失效模式。
 * 键的**顺序**在两边都来自 zod 的解析结果，所以同样的值一定得到同样的字符串。
 */
export function presetOfConfig(
  config: StrategyConfig,
  presets: readonly StrategyPreset[] = STRATEGY_PRESETS,
): StrategyPreset | null {
  const compared = STRATEGY_CONFIG_KEYS.filter(
    (key) => !(PRESET_IDENTITY_EXCLUDED_KEYS as readonly string[]).includes(key),
  );
  for (const preset of presets) {
    const canonical = resolvePreset(preset);
    if (compared.every((key) => JSON.stringify(canonical[key]) === JSON.stringify(config[key]))) {
      return preset;
    }
  }
  return null;
}
