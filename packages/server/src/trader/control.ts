/**
 * **运行期开关中心**（2026-10-18）。
 *
 * ## 为什么需要它
 *
 * 用户要一个新标签「机器人控制」，专门放**实时生效**的配置：
 *
 * > 「是实时生效的那种（不受机器人运行影响），运行中机器人改了这里配置也会马上生效的，
 * >   以后我计划放很多功能进去，目前只需要做一个功能：JEV 模型开关」
 *
 * ## 它和 `.env` 的区别（这是整个设计的核心）
 *
 * | | `.env` | 本模块 |
 * |---|---|---|
 * | 生效时机 | **重启进程** | **下一次读取就生效**（毫秒级） |
 * | 谁能改 | 运维（SSH 进服务器） | **操作员点开关** |
 * | 适合放什么 | 启动期才需要的东西（端口、密钥、路径） | 运行期要调的策略开关 |
 *
 * `AQ_JEV_PREFILTER` 原本在 `.env` 里 —— 改一次要 SSH + 重启，
 * 而重启会**打断正在跑的决策周期**。这不是"实时生效"。
 *
 * ## 三层取值（后者覆盖前者）
 *
 * ```
 *   ① 代码默认值
 *   ② `.env`（部署时的初始意图 —— 仍然尊重它，否则老部署会突然变行为）
 *   ③ `settings` 表（操作员在界面上点的 —— **最高优先级**）
 * ```
 *
 * ⚠️ **但"界面没设过"时以 `.env` 为准**，这一点很重要：
 * 已经部署的服务器 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
 * 如果界面一上来就把它当成 `off`（因为表里没记录），那是**静默改行为**。
 *
 * ## 为什么用 `settings` 表而不是新表
 *
 * `settings` 已经是本项目的 key-value 运行期配置表（`agent_last_wake`、
 * `foreign_activity:8` 之类都放这里）。加新表要迁移，而这里没有那个必要。
 *
 * ## 关于缓存
 *
 * **不做缓存**。每次读都是一次 index seek（`settings` 表很小），
 * 而"实时生效"的语义要求**读到的一定是最新值** —— 缓存会让"点了没反应"
 * 这种事重新出现。用 `Map` 缓存 1 秒也许省不了多少，却引入了失效时机的问题。
 */
import { settings } from '../store/repositories.js';

/**
 * 一个**布尔型**运行期开关。
 *
 * ## 为什么要有 `envKey`
 *
 * 老部署靠 `.env` 控制行为。界面从没被点过时，必须回落到 `.env`
 * —— 否则升级之后所有老部署的行为会静默改变（见文件头那段）。
 */
export interface RuntimeSwitchSpec {
  /**
   * 存储键（`settings` 表里的 key）。
   *
   * ⚠️ **一旦发布就不能改名** —— 它是持久化契约，改名等于把操作员的选择丢掉。
   */
  key: string;
  /** 界面上显示给她看的标题。 */
  label: string;
  /** 一句话说清"关掉之后会发生什么"（用户关心的是后果，不是实现）。 */
  effect: string;
  /** 对应的 `.env` 变量名（未设过界面值时回落到它）。 */
  envKey: string;
  /** `.env` 也没写时的默认值。 */
  fallback: boolean;
}

/**
 * **当前所有可运行期切换的开关**。
 *
 * ## 加一个新功能就是往这里加一行
 *
 * 用户说「以后我计划放很多功能进去」—— 所以这张表就是那个"扩展位"。
 * 加一行之后：
 * ```
 *   ① 界面自动多出一个开关（前端从 /api/control/switches 拉这张表）
 *   ② 代码里用 `isSwitchOn('xxx')` 读
 * ```
 * **不需要改接口、不需要改前端组件。**
 */
export const RUNTIME_SWITCHES: readonly RuntimeSwitchSpec[] = [
  {
    key: 'jev_prefilter',
    label: 'Jev 模型初筛',
    effect: '关闭后整个智能体团队都不再调用 Jev —— 每轮会重新分析全部标的（更慢，但不会筛掉任何机会）',
    envKey: 'AQ_JEV_PREFILTER',
    /*
     * ⚠️ **默认 `false`**：新部署不该悄悄开始调用一个外部决策模型。
     * 老部署的 `.env` 里写着 `on`，会走第 ② 层读成 `true` —— 行为不变。
     */
    fallback: false,
  },
];

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **JEV 模式的可调选项**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户的原话：
 * > 「我感觉 P3 可以做，这模型成本忽略不计了，但是**要有开关**（像团队模式一样，
 * >   这边增加 P3 选项和其他你觉得必要的选项，**不要全部写死**）」
 *
 * ## 为什么单独一张表，而不是塞进 `RUNTIME_SWITCHES`
 *
 * `RUNTIME_SWITCHES` 是**布尔开关**（开/关）。而这里有的是**枚举**
 *（选币方式：代码筛选 / Jev 两阶段 / 混合）、有的是**数字**（置信门槛、风险比例）。
 *
 * 强行塞进布尔表会让类型变成 `boolean | string | number` ——
 * 而那种联合类型在读取处必然要写一堆 `typeof` 判断，正是缺陷温床。
 *
 * ## ⚠️ 每一项都必须有 `why`
 *
 * 用户不懂 JEV 的实际用法，所以界面上**必须解释这一项在做什么**、
 * 改了会有什么后果。只给一个下拉框等于让他瞎猜。
 */
export interface JevOptionSpec {
  key: string;
  label: string;
  /** 一句话说明「它是什么、改了会怎样」—— 用户靠它做决定。 */
  why: string;
  kind: 'boolean' | 'enum' | 'number';
  /** `enum` 的候选值（`value` 存库，`label` 给人看）。 */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** `number` 的取值范围与单位。 */
  range?: { min: number; max: number; step: number; unit: string };
  /** 默认值（字符串形式，落库统一用字符串）。 */
  fallback: string;
  /**
   * ⚠️ **改这一项需要重启机器人才生效**吗？
   *
   * 大多数项是**下一轮就读到**（实时生效），但有几项是在
   * `buildJevModeModel()` 装配时读的（例如 `maxCandidates`），
   * 那些必须重启。界面上要如实标注 —— 否则用户改完以为生效了。
   */
}

export const JEV_OPTIONS: readonly JevOptionSpec[] = [
  {
    key: 'coin_select',
    label: '选币方式',
    why:
      '决定「谁来挑标的」。代码筛选用成交额 + 持仓量榜（快、稳、免费）；' +
      'Jev 两阶段让 Jev 从全市场里挑（更自主，但 Jev 只看得到价格/RSI/ATR 等几个数字）；' +
      '混合 = 代码先筛 20 个、Jev 再从中挑（推荐）。',
    kind: 'enum',
    options: [
      { value: 'code', label: '按成交额自动筛（默认，不花额外费用）' },
      { value: 'hybrid', label: '自动筛 20 个 → 让 Jev 自己挑（推荐）' },
      { value: 'jev', label: '让 Jev 从全市场 100 个里自己选' },
    ],
    fallback: 'code',
  },
  {
    key: 'entry_type',
    label: '开仓方式',
    why:
      '市价 = 立刻成交（滑点大一点，但一定进得去）；' +
      '限价 = 挂单等回调（省手续费，但可能等不到、错过机会）。' +
      'Jev 看不到盘口深度，所以「等回调」这件事它判断不了 —— 限价用的是机械规则（当前价回退 0.3%）。',
    kind: 'enum',
    options: [
      { value: 'market', label: '市价（默认，立刻成交）' },
      { value: 'limit', label: '限价等待（回退 0.3% 挂单）' },
      { value: 'jev', label: '让 Jev 判断（看动量强度决定要不要等）' },
    ],
    fallback: 'market',
  },
  {
    key: 'leverage_mode',
    label: '杠杆',
    why:
      '决定用多大杠杆。' +
      '「手动」由你设定（滑杆上限 = 策略上限与交易所对该币种上限中较小的那个）；' +
      '「让 Jev 判断」把可用范围交给它选 —— 它看得到 ATR 和 24h 涨跌，' +
      '波动大时会选小杠杆。' +
      '⚠️ 两种模式都受账户级限制约束（例如子账户可能被币安限制在 5x），' +
      '超了会自动降级并在日志里写明。',
    kind: 'enum',
    options: [
      { value: 'manual', label: '手动设定（用滑杆）' },
      { value: 'jev', label: '让 Jev 判断' },
    ],
    fallback: 'manual',
  },
  {
    key: 'leverage_manual',
    label: '杠杆倍数',
    why:
      '手动模式下的杠杆。数值越大，同样保证金能开的名义越大，但爆仓距离也越近。' +
      '上限来自「策略配置」——JEV 模式的默认策略里山寨币 10x、BTC/ETH 20x。' +
      '⚠️ 账户级限制可能更低（例如币安对子账户限 5x），' +
      '那种情况实际会用交易所允许的最高值，并在日志里写明。',
    kind: 'number',
    /*
     * ⚠️ **上限取 20 而不是 125**（2026-10-19 修正）。
     *
     * `defaultJevConfig()` 里 `btcEthMaxLeverage: 20`、`altcoinMaxLeverage: 10`。
     * 滑杆原来给到 125（币安的绝对上限），但**用户拖到 30x 也不会生效**
     *（`resolveLeverage` 会夹到 10 或 20）—— 那是一个"假的可选范围"，
     * 比不显示更糟：用户会以为拖上去真的变了。
     *
     * ⇒ 滑杆上限 = 策略里最宽的那一档（20x）。
     * 具体标的仍会按 `btcEthMaxLeverage` / `altcoinMaxLeverage` 二次收紧。
     */
    range: { min: 1, max: 20, step: 1, unit: 'x' },
    fallback: '5',
  },
  {
    key: 'margin_mode',
    label: '保证金模式',
    why:
      '逐仓 = 每个仓位独立结算，一个仓爆仓只亏那一笔的保证金（推荐）；' +
      '全仓 = 所有仓位共用账户余额，单笔爆仓会动用到全部资金。' +
      '「让 Jev 判断」会按波动和把握程度选 —— 波动大时它应该选逐仓。' +
      '⚠️ 切换只在**该标的没有持仓和挂单**时能生效，否则本轮继续用原模式。',
    kind: 'enum',
    options: [
      { value: 'isolated', label: '逐仓（默认，风险隔离）' },
      { value: 'crossed', label: '全仓（共用余额）' },
      { value: 'jev', label: '让 Jev 判断' },
    ],
    fallback: 'isolated',
  },
  {
    key: 'allow_short',
    label: '允许做空',
    why: '关掉之后 Jev 只能选做多 —— 下跌行情里会一直跳过。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'allow_resize',
    label: '允许加减仓',
    why: '开仓之后 Jev 可以判断「加仓 / 减仓 / 保持 / 平掉」。关掉则只做开仓与平仓。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'allow_trailing',
    label: '允许移动止损',
    why:
      '浮盈达标后把止损往盈利方向收紧（只收紧、绝不放宽）。' +
      '关掉则止损挂上后永不动 —— 实测那样会回吐大部分浮盈。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'max_pump_percent',
    label: '追高上限',
    why:
      '24 小时涨幅超过这个百分比的标的不做。' +
      '⚠️ 这些币成交额爆发所以会排在候选池前面，但它们是**已经涨完了**的币 —— ' +
      '实盘实测：候选里出现 +106%（RSI 80.8）和 +42% 的币，' +
      'Jev 给了 97-98% 置信度要做多，那就是追高。' +
      '设 0 = 不限制（不建议）。',
    kind: 'number',
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  **为什么需要这个过滤**（2026-10-20 实盘抓到）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 症状
     *
     * ```
     *   候选池：BRUSDT +42%、JCTUSDT +106%（RSI 80.76）
     *   Jev：QUSDT 做多 97%、BRUSDT 做多 97%、PHAUSDT 做多 98%
     *   ⇒ 它"很确定"这些会继续涨 —— 而那正是追高的形状
     * ```
     * 那段时间账户在跌（BTC -0.94%、ETH -1.40%），但候选池里**全是暴涨币**。
     *
     * ## 根因不在 Jev，在选币
     *
     * 选币按「成交额 + 持仓量」排序，而暴涨币的成交额会爆炸式增长 ⇒
     * 它们总是排在最前面，把正常标的挤出候选池。
     * 于是 Jev 看到的"全部市场"其实是一张**涨幅榜**。
     *
     * ## 为什么阈值定 20%
     *
     * ```
     *   日内 +20% 在合约里已经是很强的单边行情
     *   那时进场做多 = 给早期的多头接盘（他们正在派发）
     *   而做空 = 逆着最强势的标的，同样危险
     *   ⇒ 两边都不该碰，直接跳过
     * ```
     * 20% 也是「正常趋势」与「爆炒」的分界线：主流币日内很少超过 15%，
     * 而垃圾币一天 50-100% 很常见。
     *
     * ## ⚠️ 这是过滤，不是判断
     *
     * 代码只回答"涨太多了，跳过"，**不判断该不该做空**。
     * 那是 Jev 的事 —— 我们只把明显不该参与的场景排除掉。
     */
    range: { min: 0, max: 200, step: 5, unit: '%' },
    fallback: '20',
  },
  {
    key: 'min_confidence',
    label: '出手门槛',
    why:
      'Jev 有多确定才允许开仓。' +
      '「只做有把握的」会放弃约一半机会（实测 Jev 置信多在 25–65 之间）；' +
      '「有机会就做」连 50:50 的平局也会执行。',
    kind: 'enum',
    options: [
      { value: '55', label: '只做有把握的（约一半机会）' },
      { value: '40', label: '平衡（默认）' },
      { value: '20', label: '有机会就做' },
      { value: '0', label: '全部都做（含平局）' },
    ],
    fallback: '40',
  },
  {
    key: 'risk_percent',
    label: '单笔风险',
    why:
      '一笔最多亏掉账户的百分之几。它同时决定仓位大小 —— ' +
      '设 1% 时，一笔打止损只损失账户的 1%。' +
      '⚠️ 超过 5% 属于激进区间：连亏 5 次就会失去账户的 1/4 以上。' +
      '50% 意味着一次止损就亏掉一半账户 —— 那是"一把定生死"的用法。',
    kind: 'number',
    /*
     * ⚠️ **范围 1–50%（2026-10-19 用户要求改成滑杆）**。
     *
     * 用户原话：「这个改成滑动吧范围1-50」
     *
     * ## 这个范围为什么需要提醒
     *
     * ```
     *   1%  → 连亏 10 次损失 ~10%（正常量化区间）
     *   5%  → 连亏 10 次损失 ~40%
     *   50% → 一次止损亏掉一半账户
     * ```
     * 所以 `why` 里明说了「超过 5% 属于激进区间」和 50% 的含义 ——
     * **不阻止用户选，但要让他知道自己在选什么**（这是产品判断，
     * 不是技术限制：仓位公式本身对 50% 一样成立）。
     *
     * ⚠️ 下界 1 而不是 0.5：滑杆的步长是 1，0.5 会落在两格之间。
     *   需要更小的风险时应该用更大的账户，而不是 0.5% 的仓位。
     */
    range: { min: 1, max: 50, step: 1, unit: '%' },
    fallback: '1',
  },
  {
    key: 'min_rr',
    label: '止盈止损比',
    why:
      '止盈距离 ÷ 止损距离。设「2:1」时，赚一次抵两次亏。' +
      '设得越高，单笔赚得越多但越难达到（可能一直不成交）；' +
      '设「1.5:1」容易成交，但长期要靠更高胜率才赚钱。',
    kind: 'enum',
    options: [
      { value: '1.5', label: '1.5 : 1（容易成交）' },
      { value: '2', label: '2 : 1（默认，推荐）' },
      { value: '2.5', label: '2.5 : 1（要求更高）' },
      { value: '3', label: '3 : 1（很难成交）' },
    ],
    fallback: '2',
  },
  {
    key: 'max_candidates',
    label: '每轮看几个标的',
    why:
      '决定成本与耗时。越少越省，但也可能错过机会。' +
      '（界面上会实时显示每天大约花多少钱。）',
    kind: 'enum',
    options: [
      { value: '4', label: '省（4 个）' },
      { value: '8', label: '标准（8 个，默认）' },
      { value: '12', label: '多（12 个）' },
      { value: '20', label: '全力（20 个）' },
    ],
    fallback: '8',
  },
  {
    key: 'breakeven_trigger_percent',
    label: '保本触发点',
    why:
      '浮盈达到这个百分比后，把止损移到成本价（保本）。' +
      '⚠️ **这个值太小会让止盈永远触发不了** —— 实盘实测：' +
      '设 3% 时，浮盈刚过 3% 就保本，然后价格一回落就离场，' +
      '赚 0.9% 就跑，而止盈设在 +5%~11% 从没到过。' +
      '设大一点（如 8%）才能让利润真正跑起来。',
    kind: 'number',
    /*
     * ⚠️ **从 3% 提到 8%**（2026-10-19 实盘数据驱动）。
     *
     * ## 实盘证据（#14，17 笔全部 stop_loss/drawdown_guard，止盈 0 次）
     *
     * ```
     *   设置：止损 1.2–5.9%，止盈 2.4–11.9%（2:1）
     *   实际：平均盈 +0.21U，平均亏 -0.82U（1:3.85）
     * ```
     *
     * ## 根因：移动止损抢跑
     *
     * ```
     *   浮盈 3% → 止损移到保本 → 价格回落 1% → 离场，赚 0.9%
     *   ⇒ 止盈设在 +5%~11%，但仓位在 +0.9% 就走了
     * ```
     *
     * 于是"2:1 盈亏比"变成"0.9% 赚 / 4% 亏" —— 数学上必亏。
     *
     * ## 为什么 8%
     *
     * ```
     *   止盈距离通常是 2.4–11.9%
     *   保本点设在 8% ⇒ 价格必须先走完 2/3 的止盈距离才触发保本
     *   ⇒ 有机会走到止盈，而不是在半路被保本止损截住
     * ```
     */
    range: { min: 0, max: 50, step: 1, unit: '%' },
    fallback: '8',
  },
  {
    key: 'trailing_stop_percent',
    label: '追踪止损距离',
    why:
      '触发保本后，止损按这个距离跟随价格（只往有利方向移）。' +
      '设 1% 意味着价格回落 1% 就离场 —— 太紧，正常波动就会打掉；' +
      '设 3% 给价格更多呼吸空间。',
    kind: 'number',
    /*
     * ⚠️ **从 1% 提到 3%**（2026-10-19）。
     *
     * 1% 追踪在加密合约里**小于一根 15 分钟 K 线的正常波动**
     *（实测 ATR 占价 1.85%–14%）—— 等于"一有波动就离场"。
     *
     * 3% 让它能扛住正常回撤，同时仍在保护利润。
     */
    range: { min: 0, max: 20, step: 0.5, unit: '%' },
    fallback: '3',
  },
  {
    key: 'max_daily_loss_percent',
    label: '单日亏损熔断',
    why:
      '当天已实现亏损达到这个百分比就停止开仓（已有仓位仍会正常管理）。' +
      '⚠️ 它是**最后一道保险**：设 5% 意味着一天最多亏 5%，' +
      '设 30% 意味着能扛住 30% 的回撤才停手。' +
      '设 0 = 关闭这条熔断（不推荐，但极端情况下可以）。',
    kind: 'number',
    /*
     * ⚠️ **范围 0–100%，0 = 关闭**（2026-10-19 用户要求可配置）。
     *
     * 用户原话：「熔断改成可配置的，设立一个30%先」
     *
     * ## 为什么默认给 30 而不是原来的 5
     *
     * 原来写死 5%，而实盘一天就亏到 11% 触发熔断 ——
     * 那个 5% 是为"稳健跑几个月"定的，不适合**短期测试 Jev 的能力**。
     *
     * 用户明确说「激进能好测试他能力」，30% 让他能在一天内看到
     * 更多交易样本（而不是亏 5% 就停摆）。
     *
     * ⚠️ **代价**：30% 意味着一天可能亏掉近三分之一账户。
     *   那不是"安全的"，是"为了测试效率主动承担的"。
     */
    range: { min: 0, max: 100, step: 5, unit: '%' },
    fallback: '30',
  },
  {
    key: 'max_margin_usage',
    label: '保证金占用上限',
    why:
      '所有仓位合计最多占用权益的百分之几。' +
      '⚠️ 它是**决定"能同时开几个仓"的关键**：' +
      '设 30% 时，6x 杠杆下每仓占 12U，85U 账户只能开 2 个；' +
      '设 80% 时能开 5-6 个。' +
      '它与「最大同时持仓」是两回事：那个限制数量，这个限制资金占用。',
    kind: 'number',
    /*
     * ⚠️ **从 30% 提到 60%**（2026-10-19 实盘数据驱动）。
     *
     * ## 实盘症状
     *
     * ```
     *   09:24 那轮：Jev 提议开 6 个，只成交 2 个
     *   被拒原因：「已达最大保证金占用」
     *   保证金 25.09U / 权益 83.4 = 30.1%（上限 30%）
     * ```
     * 而 `max_positions` 配的是 20 —— **两者严重矛盾**：
     * ```
     *   20 个仓位 × 5% 单笔风险 = 100% 账户风险
     *   ⇒ 数学上不可能，必然被保证金上限截住
     * ```
     *
     * ## 为什么 60%
     *
     * ```
     *   60% 保证金占用 = 权益的 60% 被锁在保证金里
     *   留 40% 缓冲应对浮亏（逐仓下浮亏会吃掉可用余额）
     *   ⇒ 比 30% 能多开一倍仓位，又不至于一点缓冲都没有
     * ```
     * ⚠️ 设 100% 意味着满仓 —— 任何浮亏都可能触发强平，不建议。
     */
    range: { min: 10, max: 100, step: 5, unit: '%' },
    fallback: '60',
  },
  {
    key: 'max_positions',
    label: '最大同时持仓',
    why:
      '同时最多持有几个仓位。到上限后新的机会会被风控拒掉。' +
      '⚠️ 它和「每周期开仓上限」是两件事：这个限制"总共能有多少"，' +
      '那个限制"一轮最多新开几个"。' +
      '持仓越多越分散风险，但也越难盯住、且每个仓位的保证金被摊薄。',
    kind: 'number',
    range: { min: 1, max: 20, step: 1, unit: '个' },
    fallback: '4',
  },
  {
    key: 'max_entries_per_cycle',
    label: '每周期开仓上限',
    why:
      '一个周期（15 分钟）最多新开几个仓。设 2 意味着即使 Jev 判了 6 个机会，' +
      '也只会执行前 2 个。' +
      '⚠️ 这是**防止一轮行情里同时踩进多个相关标的**的保护 —— ' +
      '同一板块的几个币往往一起涨跌，开满会变成一笔大赌注。',
    kind: 'number',
    range: { min: 1, max: 20, step: 1, unit: '个' },
    fallback: '2',
  },
  {
    key: 'max_entries_per_hour',
    label: '每小时开仓上限',
    why:
      '一小时内的总开仓数上限（跨周期累计）。' +
      '它防止"连续几轮都在开仓"导致一天开几十笔、手续费吃掉利润。',
    kind: 'number',
    range: { min: 1, max: 50, step: 1, unit: '个' },
    fallback: '6',
  },
  {
    key: 'hold_ask_every',
    label: '持仓检查频率',
    why:
      '多久问一次 Jev「这个仓位还该拿着吗」。' +
      '问得越勤反应越快、越贵；问得稀省 token，但可能错过平仓时机。',
    kind: 'enum',
    options: [
      { value: '1', label: '每轮都问（默认，最灵敏）' },
      { value: '2', label: '两轮一次' },
      { value: '3', label: '三轮一次（省 2/3）' },
    ],
    fallback: '1',
  },
];

/**
 * 按 key 找到规格。找不到返回 `null`（**不抛**）。
 *
 * 调用方拿到的 `null` 应当当成"这个开关不存在"，而不是"关着"——
 * 两者含义不同（后者会让一个拼错的 key 静默失效）。
 */
export function switchSpec(key: string): RuntimeSwitchSpec | null {
  return RUNTIME_SWITCHES.find((s) => s.key === key) ?? null;
}

/** `.env` 里那个变量的值转成布尔。`on` / `true` / `1` / `yes` 都算开。 */
function envBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/**
 * **读一个开关的当前值**（三层取值，见文件头）。
 *
 * ⚠️ `settings.get()` 可能抛（表还没建、连接断了）——
 * 那种情况下**回落到 `.env` / 默认值**，不把异常抛给调用方。
 * 理由：一个读配置失败不该让整轮决策崩掉。
 */
export function isSwitchOn(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const spec = switchSpec(key);
  if (spec === null) {
    /*
     * 未知 key：**返回 false 但不当成"关着"** —— 这里没有日志通道，
     * 由调用方（`/api/control`）在设置不存在的开关时报 400。
     * 读路径上静默 false 是安全的（不会误开任何功能）。
     */
    return false;
  }

  /* ③ 界面设过的值（最高优先级）。 */
  try {
    const stored = settings.get(`control:${spec.key}`);
    if (stored !== undefined) {
      const parsed = envBoolean(stored);
      if (parsed !== null) return parsed;
    }
  } catch {
    /* 读不到就走下面两层 —— 不因为"读配置失败"而改变默认行为。 */
  }

  /* ② `.env` 的初始意图。 */
  const fromEnv = envBoolean(env[spec.envKey]);
  if (fromEnv !== null) return fromEnv;

  /* ① 代码默认值。 */
  return spec.fallback;
}

/**
 * **写一个开关**（界面点开关时调）。
 *
 * ⚠️ **不校验 key 是否存在** —— 那是路由层的职责（它要返回 400 和中文原因）。
 * 这里只负责落库。
 */
export function setSwitch(key: string, on: boolean): void {
  settings.set(`control:${key}`, on ? 'on' : 'off');
}

/**
 * **界面要展示的完整状态**：每个开关的当前值 + 它现在是从哪一层读来的。
 *
 * ## 为什么要带上 `source`
 *
 * 操作员看到"Jev 开着"时，如果不知道那是**自己点的**还是**部署时的默认**，
 * 就没法判断"我改了会不会影响别人/会不会重启后变回去"。
 *
 * ```
 *   source: 'ui'    → 界面上设的（重启也保持）
 *   source: 'env'   → .env 里的初始值（界面上从没点过）
 *   source: 'default' → 代码默认值（.env 里也没有）
 * ```
 */
export interface SwitchState {
  key: string;
  label: string;
  effect: string;
  on: boolean;
  source: 'ui' | 'env' | 'default';
}

export function listSwitches(env: NodeJS.ProcessEnv = process.env): SwitchState[] {
  return RUNTIME_SWITCHES.map((spec) => {
    let stored: boolean | null = null;
    try {
      stored = envBoolean(settings.get(`control:${spec.key}`));
    } catch {
      stored = null;
    }
    if (stored !== null) {
      return { key: spec.key, label: spec.label, effect: spec.effect, on: stored, source: 'ui' };
    }
    const fromEnv = envBoolean(env[spec.envKey]);
    if (fromEnv !== null) {
      return {
        key: spec.key,
        label: spec.label,
        effect: spec.effect,
        on: fromEnv,
        source: 'env',
      };
    }
    return {
      key: spec.key,
      label: spec.label,
      effect: spec.effect,
      on: spec.fallback,
      source: 'default',
    };
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  JEV 选项的读写                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 按 key 找 JEV 选项的规格。找不到返回 `null`（**不抛**）。 */
export function jevOptionSpec(key: string): JevOptionSpec | null {
  return JEV_OPTIONS.find((s) => s.key === key) ?? null;
}

/**
 * **读一个 JEV 选项的当前值**（字符串形式，与落库一致）。
 *
 * 三层取值与 `isSwitchOn` 同一条纪律：
 * ```
 *   ① 界面上设的（settings 表）   ← 最高
 *   ② 代码默认值（fallback）
 * ```
 * ⚠️ JEV 选项**不读 `.env`** —— 它们是新模式专属的，没有"老部署兼容"的问题，
 * 多一层只会让"这个值到底从哪来"更难回答。
 */
/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **JEV 参数预设**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话（2026-10-20）：
 * > 「里面增加一个预设模式，把你觉得最能挣钱得参数 设置一个内置预设，
 * >  以后可以一键快速设置」
 *
 * ## 为什么需要预设
 *
 * JEV 有 16 个参数，它们**互相耦合**：
 * ```
 *   risk_percent 调大 ⇒ 单笔保证金变大 ⇒ max_margin_usage 会更快用完
 *   min_rr 调大      ⇒ 止盈更难达到   ⇒ 胜率下降，需要更高 min_confidence 补偿
 *   max_positions 调大 ⇒ 保证金被摊薄  ⇒ 每个仓位变小，止损占比反而降低
 * ```
 * 操作员一个个调很难同时满足这些约束 —— 参数之间不是独立的。
 * 预设把**一组自洽的参数**作为整体发出去，避免"调了 A 忘了 B"。
 *
 * ## `balanced` 这一组是怎么定的（不是拍脑袋）
 *
 * 基于 2026-10-19~20 的实盘数据（65 笔）：
 * ```
 *   止盈 6 笔 → 平均 +3.99/笔
 *   止损 51 笔 → 平均 -0.65/笔
 *   单笔止盈是单笔止损的 6 倍 —— 数学上该赚，但止盈率只有 10.5%
 *   大亏 17 笔里 16 笔是"逆势做多"（空头行情里一直抄底）
 * ```
 * ⇒ 两个结论直接落进参数：
 * 1. **止盈率太低 ⇒ `min_rr` 从 2.5 回到 2.0**（2.5 的目标太远，几乎打不到）
 * 2. **低质量单太多 ⇒ `min_confidence` 提到 55**（只做有把握的）
 * 3. **一次开 10 个太激进 ⇒ `max_entries_per_cycle` 降到 3**
 * 4. **20 个仓位盯不住 ⇒ `max_positions` 降到 8**
 *
 * ⚠️ **`max_margin_usage` 保持 60%**：8 个仓位 × 5% 风险 = 40%，
 * 60% 留了 20 个百分点的缓冲。
 */
export interface JevPreset {
  id: string;
  label: string;
  summary: string;
  /** 每一个键都必须在 `JEV_OPTIONS` 里存在，且值必须合法 —— 见 `applyJevPreset`。 */
  values: Readonly<Record<string, string>>;
}

export const JEV_PRESETS: readonly JevPreset[] = [
  {
    id: 'balanced',
    label: '均衡（推荐）',
    summary: '只做有把握的、目标 2:1、一轮最多 3 仓。基于实盘 65 笔数据定的一组自洽参数。',
    values: {
      coin_select: 'jev',
      entry_type: 'jev',
      leverage_mode: 'jev',
      margin_mode: 'jev',
      min_confidence: '55',
      min_rr: '2',
      risk_percent: '5',
      max_positions: '8',
      max_entries_per_cycle: '3',
      max_entries_per_hour: '10',
      max_margin_usage: '60',
      max_daily_loss_percent: '30',
      breakeven_trigger_percent: '5',
      trailing_stop_percent: '3',
      max_candidates: '8',
      hold_ask_every: '1',
      allow_short: 'true',
      allow_resize: 'true',
      allow_trailing: 'true',
      leverage_manual: '20',
      max_pump_percent: '20',
    },
  },
  {
    id: 'aggressive',
    label: '激进（测试用）',
    summary: '宽进宽出、每轮最多 10 仓、风控放宽。只适合短期验证能力，不适合长期跑。',
    values: {
      coin_select: 'jev',
      entry_type: 'jev',
      leverage_mode: 'jev',
      margin_mode: 'jev',
      min_confidence: '20',
      min_rr: '2',
      risk_percent: '8',
      max_positions: '20',
      max_entries_per_cycle: '10',
      max_entries_per_hour: '20',
      max_margin_usage: '80',
      max_daily_loss_percent: '30',
      breakeven_trigger_percent: '8',
      trailing_stop_percent: '3',
      max_candidates: '8',
      hold_ask_every: '1',
      allow_short: 'true',
      allow_resize: 'true',
      allow_trailing: 'true',
      leverage_manual: '20',
      max_pump_percent: '30',
    },
  },
  {
    id: 'conservative',
    label: '保守',
    summary: '只做最有把握的、目标 2.5:1、单笔风险 2%、最多 4 仓。回撤优先。',
    values: {
      coin_select: 'code',
      entry_type: 'jev',
      leverage_mode: 'jev',
      margin_mode: 'isolated',
      min_confidence: '55',
      min_rr: '2.5',
      risk_percent: '2',
      max_positions: '4',
      max_entries_per_cycle: '2',
      max_entries_per_hour: '6',
      max_margin_usage: '40',
      max_daily_loss_percent: '10',
      breakeven_trigger_percent: '5',
      trailing_stop_percent: '2',
      max_candidates: '4',
      hold_ask_every: '1',
      allow_short: 'true',
      allow_resize: 'false',
      allow_trailing: 'true',
      leverage_manual: '10',
      max_pump_percent: '10',
    },
  },
];

/**
 * **应用一个预设**（全量覆盖 16 个参数）。
 *
 * ## 为什么是"全量覆盖"而不是"只改预设里写到的键"
 *
 * 预设的意义是**一组自洽的参数**。如果只覆盖一部分，剩下的会停留在上一组的值上 ——
 * 于是"我套了保守预设，但 `max_daily_loss_percent` 还是激进档的 30%"这类
 * 半生效状态就会出现，而界面上看不出来。
 *
 * ## 校验
 *
 * 每个键都必须存在于 `JEV_OPTIONS` 且值合法（枚举值必须在选项里、
 * 数值必须在区间内）—— **写错的预设应该在测试里就红**，
 * 不能让它在运行时静默写进一个非法值。
 *
 * @returns 实际写入的键数量；有任何非法键时**一个都不写**（原子性）。
 */
export function applyJevPreset(presetId: string): { applied: number; unknown: string[] } {
  const preset = JEV_PRESETS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) return { applied: 0, unknown: [`preset:${presetId}`] };

  const specs = new Map(JEV_OPTIONS.map((spec) => [spec.key, spec]));
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(preset.values)) {
    const spec = specs.get(key);
    if (spec === undefined) {
      invalid.push(key);
      continue;
    }
    if (spec.kind === 'enum') {
      /* `options` 在类型上可选 —— 枚举型没给选项本身就是配置错误，算非法。 */
      const options = spec.options ?? [];
      if (!options.some((option) => option.value === value)) invalid.push(`${key}=${value}`);
    } else if (spec.kind === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) invalid.push(`${key}=${value}`);
      else if (spec.range !== undefined && (parsed < spec.range.min || parsed > spec.range.max)) {
        invalid.push(`${key}=${value}(超出 ${spec.range.min}–${spec.range.max})`);
      }
    } else if (spec.kind === 'boolean') {
      if (value !== 'true' && value !== 'false') invalid.push(`${key}=${value}`);
    }
  }
  /* 有任何一个非法 ⇒ 一个都不写（原子性：不留半套参数）。 */
  if (invalid.length > 0) return { applied: 0, unknown: invalid };

  for (const [key, value] of Object.entries(preset.values)) setJevOption(key, value);
  return { applied: Object.keys(preset.values).length, unknown: [] };
}

export function getJevOption(key: string): string {
  const spec = jevOptionSpec(key);
  if (spec === null) return '';
  try {
    const stored = settings.get(`jev:${spec.key}`);
    if (stored !== undefined && stored !== '') return stored;
  } catch {
    /* 读不到就用默认值 —— 一个读配置失败不该让整轮决策崩掉。 */
  }
  return spec.fallback;
}

/** 读一个布尔型 JEV 选项。 */
export function jevBool(key: string): boolean {
  const v = getJevOption(key).trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/** 读一个数字型 JEV 选项。超出范围时**钳制**（不抛）。 */
export function jevNumber(key: string): number {
  const spec = jevOptionSpec(key);
  const raw = Number(getJevOption(key));
  if (!Number.isFinite(raw)) return spec?.fallback !== undefined ? Number(spec.fallback) : 0;
  if (spec?.range === undefined) return raw;
  return Math.min(spec.range.max, Math.max(spec.range.min, raw));
}

/**
 * 读一个枚举型 JEV 选项。
 *
 * ⚠️ **不在候选里就回落到默认值**（不猜、不抛）——
 * 那可能是有人手工改了库，或者枚举项被删了。
 */
export function jevEnum(key: string): string {
  const spec = jevOptionSpec(key);
  if (spec === null) return '';
  const v = getJevOption(key);
  const allowed = spec.options?.map((o) => o.value) ?? [];
  return allowed.includes(v) ? v : spec.fallback;
}

/**
 * **写一个 JEV 选项**（界面点保存时调）。
 *
 * ⚠️ 校验在路由层做（它要返回 400 和中文原因）。这里只负责落库。
 */
export function setJevOption(key: string, value: string): void {
  settings.set(`jev:${key}`, value);
}

/** 界面要展示的 JEV 选项状态（含「从哪来」）。 */
export interface JevOptionState {
  key: string;
  label: string;
  why: string;
  kind: 'boolean' | 'enum' | 'number';
  options?: ReadonlyArray<{ value: string; label: string }>;
  range?: { min: number; max: number; step: number; unit: string };
  value: string;
  /** `ui` = 界面上设过；`default` = 用代码默认值。 */
  source: 'ui' | 'default';
  /** 改它是否要重启机器人才生效。 */

}

export function listJevOptions(): JevOptionState[] {
  return JEV_OPTIONS.map((spec) => {
    let stored: string | undefined;
    try {
      stored = settings.get(`jev:${spec.key}`);
    } catch {
      stored = undefined;
    }
    const hasUi = stored !== undefined && stored !== '';
    return {
      key: spec.key,
      label: spec.label,
      why: spec.why,
      kind: spec.kind,
      ...(spec.options !== undefined ? { options: spec.options } : {}),
      ...(spec.range !== undefined ? { range: spec.range } : {}),
      value: hasUi ? stored! : spec.fallback,
      source: hasUi ? 'ui' : 'default',

    };
  });
}


