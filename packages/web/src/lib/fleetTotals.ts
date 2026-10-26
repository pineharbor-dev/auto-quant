/**
 * 舰队级（全部机器人 / 全部交易所账户）合计的**唯一**计算点。
 *
 * ## 为什么要单独一个模块
 *
 * 「账户里有多少钱」和「某个机器人挣了多少」是两个不同的量。它们混在一起时，
 * 共享钱包的同一笔本金会被数很多遍（下面就是实盘量到的数字）。这两个口径的
 * 算术只在这里算一次，页面只负责展示 —— 与「净盈亏只在 `trades.insert()` 里算
 * 一次」是同一个理由（`docs/AGENTS.md` §5.4：金额相关的算术只在一个地方算）。
 *
 * ## 为什么**不能**把归属权益（`TraderStats.equity`）加起来
 *
 * 这是本次修掉的 bug。实盘上量到的数字（三个机器人共用 `exchange_account_id = 1`）：
 *
 * ```
 * #4 测试机器人1    初始 9.9865   本机器人净盈亏 0.000000  → 归属权益  9.9865
 * #5 测试2          初始 9.9865   本机器人净盈亏 0.437526  → 归属权益 10.4240
 * #6 实盘3小时验证  初始 10.2586  本机器人净盈亏 0.000000  → 归属权益 10.2586
 * ──────────────────────────────────────────────────────────────────────────
 * Σ 归属权益 = 30.6690        Σ 初始权益 = 30.2316        账户里实际只有 10.4180
 * ```
 *
 * `Σ 初始权益 − 账户里的钱 = 19.81 USDT`，**就是被数了三遍的那笔本金**（三个机器人
 * 各自都带着同一份起始资金，而钱包只有一个）。于是控制台显示「总归属权益 30.67 USDT」
 * 与「总收益率 +1.45% / 初始投入 $30.23」—— 约为真实资金的 3 倍。
 *
 * 归属权益是**每个机器人**自己的量，它自带一份本金（`初始权益 + 本机器人净盈亏 +
 * 本机器人浮盈`，见 `attributedEquity()`）。共用同一个账户的机器人各自都带着同一笔
 * 本金，所以只有「**每个账户**算一次」才有意义 —— 不是「取第一个」，
 * 而是按 `exchangeAccountId` 分组（不同账户的钱包互不相干，跨账户相加才是对的）。
 *
 * 反过来，**已实现盈亏是可加的**：每个机器人只认自己挂过的订单对应的回合
 * （`docs/AGENTS.md` §2.3 的归属闸门），所以 `Σ(各机器人自己的 net_pnl)` 不会重复。
 */

import type { EquitySnapshot, TraderStats } from '@aq/shared';
import type { TraderRow } from './api';
import type { EquityContributor } from '../components/equityCurve';

/* -------------------------------------------------------------------------- */
/*  按账户分组                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 把机器人按交易所账户分组。
 *
 * 这是整个文件的地基：凡是"账户里的钱"都必须先过这一步，否则共享账户下的
 * 每个机器人都会各自贡献一份本金（19.81 那个 bug 就是这么来的）。
 */
export function groupTradersByAccount(traders: readonly TraderRow[]): Map<number, TraderRow[]> {
  const groups = new Map<number, TraderRow[]>();
  for (const trader of traders) {
    /*
     * ⚠️ **没有交易所账户的机器人不参与这个分组**（用户 2026-10-27 需求）。
     *
     * 纯模拟盘机器人（`exchangeAccountId === null`）的钱是**本地模拟出来的**，
     * 它不对应任何真实钱包。把它塞进"按账户汇总"里会凭空造出一个
     * 「账户权益」—— 而那个数字会被读成"我在交易所里有这么多钱"。
     *
     * 它的模拟余额在机器人自己的详情页上显示（那里明确标注是模拟盘）。
     */
    if (trader.exchangeAccountId === null) continue;
    const group = groups.get(trader.exchangeAccountId);
    if (group) group.push(trader);
    else groups.set(trader.exchangeAccountId, [trader]);
  }
  return groups;
}

/**
 * 一个账户的**起始资金**（本金）。
 *
 * 取**最早创建**的那个机器人的 `initialEquity`：它建号时服务端从交易所读到的
 * 钱包余额，就是这个账户被接入监控时的样子（`EquitySource: 'exchange'`）。
 * 后面的机器人读到的余额已经包含了前面机器人的盈亏，把它们的 `initialEquity`
 * 相加就是把同一笔本金数很多遍 —— 那正是本文件顶部那个 3 倍的 bug。
 *
 * 读不到余额时（`EquitySource: 'unavailable'`，早期行可能是 0）退回组内最大的
 * 正值：显示一个偏大的本金也胜过显示 0（后者会让收益率除零或凭空变成无限大）。
 */
export function committedCapitalOf(group: readonly TraderRow[]): number {
  const earliest = [...group].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  )[0];
  if (earliest && Number.isFinite(earliest.initialEquity) && earliest.initialEquity > 0) {
    return earliest.initialEquity;
  }

  const positives = group
    .map((trader) => trader.initialEquity)
    .filter((value) => Number.isFinite(value) && value > 0);
  return positives.length > 0 ? Math.max(...positives) : 0;
}

/* -------------------------------------------------------------------------- */
/*  合计                                                                       */
/* -------------------------------------------------------------------------- */

/** 账户权益是从哪来的 —— 页面据此说明这个数是读数还是推算。 */
export type AccountEquitySource =
  /** 该账户最新一条快照里交易所读到的 `accountEquity`。 */
  | 'snapshot'
  /** 服务端统计里的同一个字段（快照序列还没到）。 */
  | 'stats'
  /** 两边都没有：用「起始资金 + Σ 本机器人净盈亏 + Σ 本机器人浮盈」推算。 */
  | 'derived'
  /** 连起始资金都读不到（还没跑过一轮、也没有余额读数）—— 页面显示 `—`。 */
  | 'capital';

/** 一个交易所账户（共享钱包）的合计。 */
export interface FleetAccount {
  exchangeAccountId: number;
  /** 该账户下的机器人 id（按传入顺序）。 */
  traderIds: number[];
  /**
   * 账户里的钱。**每个账户只算一次** —— 同账户下的机器人读的是同一个钱包。
   */
  accountEquity: number;
  equitySource: AccountEquitySource;
  /**
   * **这条读数是【什么时候】的**（epoch ms；`null` = 不是从快照来的，是推算的）。
   *
   * ⚠️ 它防的是"过期读数冒充实时值"：`#9` 停了 10 天、快照是 43 天前的，
   * 而那个数字**看起来和实时值一模一样**（见 `latestAccountReading` 的说明）。
   * 页面据此可以说"读数过期"。
   */
  accountEquityAtMs: number | null;
  /**
   * 这条读数是否**已过期**（距现在超过 `ACCOUNT_READING_STALE_MS`）。
   *
   * 页面应当在它为 `true` 时**明确标注**，而不是把它当成"账户现在的钱"。
   */
  accountEquityStale: boolean;
  /** 该账户的起始资金（本金），见 `committedCapitalOf`。 */
  committedCapital: number;
  /** 该账户下各机器人自己的净已实现盈亏之和（可加）。 */
  realizedPnl: number;
  /** 各机器人自己的持仓浮盈之和（可加）。 */
  unrealizedPnl: number;
  openPositions: number;
  wins: number;
  losses: number;
  /**
   * 该账户下各机器人归属权益之和。
   *
   * ⚠️ **它不是账户里的钱**，也不参与任何合计 —— 保留它只为让页面能说清
   * "被多算了多少"（实测：这个账户 30.6690 vs 账户里 10.4180）。
   */
  attributedEquitySum: number;
}

export interface FleetTotals {
  accounts: FleetAccount[];
  /** traderId → 它所属账户的合计，供表格每一行直接引用，免得再分组一次。 */
  byTrader: Record<number, FleetAccount>;

  /** 账户口径的权益合计：**每个账户算一次再相加**。 */
  accountEquityFleet: number;
  /** 账户口径的起始资金合计。 */
  committedCapitalFleet: number;
  /** 账户口径的总收益率（0–100 的百分数；本金为 0 时是 0）。 */
  accountReturnPercent: number;

  /** Σ 各机器人自己的净已实现盈亏 —— 可加，和账户口径无关。 */
  realizedPnlFleet: number;
  unrealizedPnlFleet: number;
  openPositionsFleet: number;
  winsFleet: number;
  lossesFleet: number;

  traderCount: number;
  /** 统计已经回来的机器人数，用于「正在读取 N 个机器人的统计…」。 */
  tradersWithStats: number;
  /**
   * Σ 归属权益。**只能拿来说明"它不等于账户里的钱"**，页面上不得当作余额。
   */
  attributedEquitySumFleet: number;
}

export interface FleetInputs {
  traders: readonly TraderRow[];
  stats: Record<number, TraderStats>;
  /**
   * 每个机器人的快照序列（REST 与 socket 已经合并），只用来读**交易所给的**
   * 账户权益。缺省时退回 `TraderStats.accountEquity`。
   */
  snapshots?: Record<number, EquitySnapshot[]>;
  /**
   * **每个机器人自己在不在模拟盘**（来自 `stats.dryRun`，`null` = 没在运行）。
   *
   * ## 为什么汇总层需要它（2026-10-15 用户实测抓到）
   *
   * 模拟盘的 `exchangeNet` **恒为 0**（`SimulatedExchange.getIncome()` 返回空数组，
   * 因为回放里不存在资金费结算）—— 而"用交易所口径校准"在那种情况下会把
   * **正确的账本替换成 0**。实测 `#11` 的「交易盈亏」卡显示 `$0.00`，
   * 而同页的历史成交区有真实数据。
   *
   * 不传时按"未知"处理（既有行为：按 gap 判据走），所以旧调用点不会安静地变。
   */
  dryRun?: Record<number, boolean | null | undefined>;
}

/**
 * 该账户最新一次的**账户权益读数**。
 *
 * 同一账户下所有机器人的 `accountEquity` 都是同一个钱包，区别只在读数的时间；
 * 所以这里取**时间最新的那一条快照**，而不是相加、也不是取最大值 —— 取最大值
 * 在账户亏损时会把旧的高点当成当前的钱。
 */
/**
 * **该账户最新一次读数 + 它是什么时候的**（2026-10-14 加时刻）。
 *
 * ## 为什么必须把时刻一起返回（真事故）
 *
 * 线上 `#9` 与 `#11` 共用账户 #2，而 **`#9` 已停止 10 天**、它的快照是
 * **43 天前**的。修复前的实现"取第一个读数"→ 用到了 `#9` 的旧值。
 * 修成"取最新"之后，只要**同账户下还有一台在跑**，读到的就是新鲜值。
 *
 * ⚠️ **但两台都停了之后呢？** 那时"最新"也是 43 天前的 ——
 * 而页面会把它当成"账户现在的钱"显示。那正是 `LAYOUT.md` §7 禁止的
 * "文字说的不是事实"：一个过期 43 天的数字**看起来和实时值一模一样**。
 *
 * 所以调用方需要知道时刻，才能说"读数过期"而不是冒充实时值。
 */
function latestAccountReading(
  group: readonly TraderRow[],
  snapshots: Record<number, EquitySnapshot[]> | undefined,
): { value: number; atMs: number } | null {
  let newestAt = Number.NEGATIVE_INFINITY;
  let newestValue: number | null = null;
  if (snapshots) {
    for (const trader of group) {
      for (const snapshot of snapshots[trader.id] ?? []) {
        // 0 表示"这一行没有读到账户权益"（旧行或读取失败），不是"账户里没钱"。
        if (!(snapshot.accountEquity > 0)) continue;
        const at = Date.parse(snapshot.timestamp);
        if (!Number.isFinite(at) || at <= newestAt) continue;
        newestAt = at;
        newestValue = snapshot.accountEquity;
      }
    }
  }
  return newestValue === null ? null : { value: newestValue, atMs: newestAt };
}

/**
 * **账户读数超过多久算"过期"**（毫秒）。
 *
 * ## 为什么是 60 分钟
 *
 * 快照在**每次决策周期结束时**写一条，而机器人的周期是 15–30 分钟。
 * 取 60 分钟 = 最慢那档的两个周期 —— 即"连着两轮都没写进新快照"。
 * 那已经不只是网络抖动，而是"这台机器人真的没在跑"。
 *
 * ⚠️ 不能用"一个周期"（15–30 分钟）：正常轮询与写库有延迟，
 * 一次瞬时故障就会让页面闪"读数过期"，那是假告警（本项目反复踩过这一类）。
 */
const ACCOUNT_READING_STALE_MS = 60 * 60_000;

/**
 * **账本与交易所对不上** —— 判据的唯一实现（2026-10-14，2026-10-15 修模拟盘分支）。
 *
 * ```
 *   模拟盘（dryRun）      → 一律 false（交易所口径不存在，见下）
 *   incomeReadFailed 为真 → false（exchangeNet 是残缺读数）
 *   |gap| ≥ 0.01          → true（要用交易所的数校准）
 *   否则                  → false（账本可信，与交易所一致）
 * ```
 *
 * ## ⚠️ 为什么模拟盘必须先判掉（2026-10-15 用户实测抓到）
 *
 * 用户报（`#11`，模拟盘）：
 * ```
 *   历史成交区：25 笔 · 净额 -$0.58 · 6 盈 / 19 亏    ✅ 有数据
 *   胜率卡：    31.3% · 32 笔已平仓                    ✅ 有数据
 *   交易盈亏卡：$0.00                                   ❌ 空的
 * ```
 * **历史成交有数据、而汇总卡是 0** —— 因为两者走的是不同判据。
 *
 * 根因：`SimulatedExchange.getIncome()` **返回空数组**（模拟回放里不存在资金费
 * 结算，见它的注释），于是：
 * ```
 *   exchangeNet = 0                          ← 恒为 0，不是"真的没盈亏"
 *   gap = platformNet − 0 = platformNet      ← 恒等于账本自身
 *   ⇒ |gap| ≥ 0.01 必然成立（只要账本非零）
 *   ⇒ 判定"账本可疑" → 前端把 realized 换成 exchangeNet = 0
 *   ⇒ 卡片显示 $0.00，而账本里的 −0.0524 是真的
 * ```
 * **这不是"账本坏了"，而是"模拟盘根本没有交易接口的流水"** ——
 * 拿一个不存在的口径去"校准"，等于把正确的账本替换成 0。
 *
 * ⚠️ 判据改成"模拟盘一律 false"而不是"`exchangeNet === 0` 时 false"：
 * 后者会误伤**真的把钱亏光/赚回零**的实盘账户（那是合法的 0）。
 * 用 `dryRun` 这个**明确的模式标记**才是干净的判据。
 *
 * ⚠️ 0.01 这个阈值是**实测定的**：账本与交易所的正常舍入差在 1e-4 量级，
 * 而那次事故的差额是 12.55 —— 两者差两个数量级，所以 0.01 能干净地分开。
 * 改它必须同时改 `TradersPage` / `OverviewPage` / `traderStats` 三处的测试
 *（见 `equityAligned.test.ts` 钉住的那五条）。
 *
 * @param ledger 服务端算出的账目校验结论
 * @param dryRun 这个机器人**自己**在不在模拟盘（`stats.dryRun`）。
 *   ⚠️ `null` = 它没在运行（读不到），按"未知"处理 —— 此时**不排除**，
 *   因为既有行为（用交易所校准）对实盘是对的；而没在跑的机器人也不该有大差额。
 */
export function isLedgerSuspect(
  ledger: TraderRow['ledger'],
  dryRun?: boolean | null,
): boolean {
  if (ledger == null) return false;
  /*
   * 模拟盘：没有交易所流水可校准。见上面那段事故说明。
   */
  if (dryRun === true) return false;
  if (ledger.incomeReadFailed === true) return false;
  return Math.abs(ledger.gap) >= 0.01;
}

/**
 * **一个机器人的已实现净盈亏 —— 账本可信时用账本、否则用交易所**（2026-10-14）。
 *
 * ## 为什么要有这个函数
 *
 * 用户的原话：
 * > 「盈亏计算也不对啊！！！你做事情只做一半？？」
 *
 * 事实是：同一个数在**四个地方**各算了一遍，而我上一轮只修了其中一处：
 * ```
 *   ① 机器人列表页「盈亏」列        ← 修了
 *   ② 机器人列表页顶部汇总          ← 修了
 *   ③ 首页总览「已实现盈亏」        ← 【漏了】
 *   ④ 详情页「交易盈亏」            ← 之前修过
 * ```
 * ④ 与 ①②③ 用了两套代码 —— 那就是漏的原因。
 * **现在只有一个实现**：这里。别处一律调它。
 *
 * ## 为什么"用交易所"是更准的那个
 *
 * `trades.net_pnl` 被对账重建写坏过（39 笔 `source='reconciled'` 里
 * 16 笔 `pnl=0`，合计虚高 9.13）；而 `ledger.exchangeNet` 是**交易所自己的
 * 成交流水**算出来的，没有重建逻辑可以搞错它。
 *
 * ⚠️ 退回 `row?.realizedPnl ?? 0` 而不是 `ledger.exchangeNet`：没有统计行时
 * 连交易所流水都没读过，0 是"未知"而不是"没赚没亏"（页面会随后覆盖）。
 */
export function realizedPnlOf(
  trader: TraderRow,
  row: TraderStats | undefined,
  dryRun?: boolean | null,
): number {
  if (row === undefined) return 0;
  /*
   * ⚠️ `dryRun` 必须一路传进来 —— 模拟盘上 `exchangeNet` 恒为 0，
   * 用它校准会把正确账本替换成 0（见 `isLedgerSuspect` 的事故说明）。
   */
  if (!isLedgerSuspect(trader.ledger, dryRun)) return row.realizedPnl;
  return trader.ledger!.exchangeNet;
}

/**
 * **一个机器人的归属权益 —— 与已实现盈亏同一套判据**（2026-10-14）。
 *
 * ```
 *   账本可信 → stats.equity
 *   账本有差 → 起始权益 + 交易所口径净额 + 本机器人浮盈
 * ```
 *
 * ⚠️ 浮盈仍取 `row.unrealizedPnl`（本机器人自己的，来自最近的标记价）——
 * 交易所流水里没有"未实现"这个概念。
 *
 * ⚠️ 与 `realizedPnlOf` **必须同步**：只改一个就会出现"权益校准了、
 * 盈亏没校准"（那正是用户在机器人列表页看到的矛盾）。
 */
export function attributedEquityOf(
  trader: TraderRow,
  row: TraderStats | undefined,
  dryRun?: boolean | null,
): number {
  if (row === undefined) return trader.initialEquity;
  if (!isLedgerSuspect(trader.ledger, dryRun)) return row.equity;
  return trader.initialEquity + trader.ledger!.exchangeNet + row.unrealizedPnl;
}

/** 舰队合计。见本文件顶部：账户口径与机器人归属口径在这一处分开。 */
export function fleetTotals({ traders, stats, snapshots, dryRun }: FleetInputs): FleetTotals {
  const accounts: FleetAccount[] = [];
  /**
   * 这个机器人自己在不在模拟盘（`undefined` = 调用方没给 → 按"未知"处理）。
   *
   * 见 `FleetInputs.dryRun` 的说明：模拟盘的 `exchangeNet` 恒为 0，
   * 拿它校准会把正确账本替换成 0。
   */
  const dryRunOf = (traderId: number): boolean | null | undefined => dryRun?.[traderId];

  let accountEquityFleet = 0;
  let committedCapitalFleet = 0;
  let realizedPnlFleet = 0;
  let unrealizedPnlFleet = 0;
  let openPositionsFleet = 0;
  let winsFleet = 0;
  let lossesFleet = 0;
  let tradersWithStats = 0;
  let attributedEquitySumFleet = 0;

  /*
   * ⚠️ `byTrader` 把"某个机器人属于哪个账户"记下来，供页面按机器人反查账户口径
   * （`FleetTotals.byTrader` 是公开字段）。
   */
  const byTrader: Record<number, FleetAccount> = {};

  for (const [exchangeAccountId, group] of groupTradersByAccount(traders)) {
    let realizedPnl = 0;
    let unrealizedPnl = 0;
    let openPositions = 0;
    let wins = 0;
    let losses = 0;
    let attributedEquitySum = 0;

    for (const trader of group) {
      const row = stats[trader.id];
      if (row) tradersWithStats += 1;
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **已实现盈亏也要按交易所校准**（2026-10-14 用户报"只做一半"）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事实（线上）
       *
       * ```
       *   首页「已实现盈亏」+5.91（服务端按坏账本算的 Σ net_pnl）
       *   交易所口径真实    -7.03
       *   → 差 12.9 USDT：【显示盈利，实际亏损】
       * ```
       *
       * ## 根因
       *
       * `row.realizedPnl` 来自服务端的 `trades.net_pnl` —— 而那份账本被
       * 对账重建写坏过（39 笔 `source='reconciled'` 里 16 笔 `pnl=0`，
       * 合计虚高 9.13）。同一个原因也让「归属权益」偏了 12.55。
       *
       * ## 为什么修在【这里】
       *
       * 这是舰队合计的**唯一计算点** —— 首页、机器人列表页的顶部汇总都读它。
       * 上一轮我在 `TradersPage` 里各修了一遍，结果首页漏了。
       * **根因在这里，就该在这里修一次。**
       *
       * ## 判据与别处一字不差
       *
       * ```
       *   |ledger.gap| ≥ 0.01 且不是"收入读不到" → 用交易所的 exchangeNet
       *   否则                                   → 用账本（它与交易所一致）
       * ```
       * ⚠️ `incomeReadFailed` 为真时**必须退回账本** —— 那时的 `exchangeNet`
       * 是残缺读数（少了几段流水），拿它校准会比账本更离谱。
       *
       * ⚠️ 用 `realizedPnlOf()` 而不是直接写在这里：机器人列表页那一行也要
       * 同一个数（`calibratedOf`），两处必须共用一份实现。
       *
       * ⚠️ **`dryRun` 必须一起传**（2026-10-15）：模拟盘上 `exchangeNet` 恒为 0
       *（`SimulatedExchange.getIncome()` 返回空数组），拿它校准会把**正确的账本**
       * 替换成 0 —— 实测 `#11` 的「交易盈亏」卡因此显示 $0.00，而同页的历史成交区
       * 有真实数据（那里走 trades 表，不经过这个判据）。见 `isLedgerSuspect`。
       */
      realizedPnl += realizedPnlOf(trader, row, dryRunOf(trader.id));
      unrealizedPnl += row?.unrealizedPnl ?? 0;
      openPositions += row?.openPositions ?? 0;
      wins += row?.wins ?? 0;
      losses += row?.losses ?? 0;
      // 还没有统计时退回该机器人的起始权益：宁可显示"已知的本金"，
      // 也不要让这一格在第一帧读成 0（页面随后会被统计覆盖）。
      attributedEquitySum += row?.equity ?? trader.initialEquity;
    }

    const committedCapital = committedCapitalOf(group);

    /*
     * 账户权益的三个来源，按可信度排序。
     *
     * 「起始资金 + Σ 本机器人净盈亏 + Σ 本机器人浮盈」这条推算与归属权益用的是
     * 同一个恒等式，只是**本金只取一次** —— 这正是它和 Σ归属权益 的区别。
     */
    const reading = latestAccountReading(group, snapshots);
    let accountEquity = reading === null ? null : reading.value;
    let equitySource: AccountEquitySource = 'snapshot';
    /*
     * ⚠️ **读数时刻只对快照来源有意义** —— 另两个来源（stats / derived）没有
     * 可比的时刻，所以是 `null`（页面不会误标它们"过期"）。
     */
    let accountEquityAtMs: number | null = reading === null ? null : reading.atMs;

    if (accountEquity === null) {
      const fromStats = group.reduce(
        (max, trader) => Math.max(max, stats[trader.id]?.accountEquity ?? 0),
        0,
      );
      if (fromStats > 0) {
        accountEquity = fromStats;
        equitySource = 'stats';
      }
    }

    if (accountEquity === null && committedCapital > 0) {
      accountEquity = committedCapital + realizedPnl + unrealizedPnl;
      equitySource = 'derived';
    }

    if (accountEquity === null) {
      // 连本金都没有：这个账户还没有任何可信读数。0 在这里的含义是"未知"，
      // 页面据此显示 `—`，不要把它渲染成"账户是空的"（LAYOUT.md §7）。
      accountEquity = committedCapital;
      equitySource = 'capital';
    }

    /*
     * ⚠️ **过期判定只在"读数来自快照"时才成立** ——
     * stats / derived 两条来源没有可比时刻（`accountEquityAtMs === null`），
     * 把它们标成"过期"是假告警。
     */
    const accountEquityStale =
      accountEquityAtMs !== null && Date.now() - accountEquityAtMs > ACCOUNT_READING_STALE_MS;

    const account: FleetAccount = {
      exchangeAccountId,
      traderIds: group.map((trader) => trader.id),
      accountEquity,
      equitySource,
      accountEquityAtMs,
      accountEquityStale,
      committedCapital,
      realizedPnl,
      unrealizedPnl,
      openPositions,
      wins,
      losses,
      attributedEquitySum,
    };
    accounts.push(account);
    for (const trader of group) byTrader[trader.id] = account;

    accountEquityFleet += accountEquity;
    committedCapitalFleet += committedCapital;
    realizedPnlFleet += realizedPnl;
    unrealizedPnlFleet += unrealizedPnl;
    openPositionsFleet += openPositions;
    winsFleet += wins;
    lossesFleet += losses;
    attributedEquitySumFleet += attributedEquitySum;
  }

  return {
    accounts,
    byTrader,
    accountEquityFleet,
    committedCapitalFleet,
    accountReturnPercent:
      committedCapitalFleet > 0
        ? ((accountEquityFleet - committedCapitalFleet) / committedCapitalFleet) * 100
        : 0,
    realizedPnlFleet,
    unrealizedPnlFleet,
    openPositionsFleet,
    winsFleet,
    lossesFleet,
    traderCount: traders.length,
    tradersWithStats,
    attributedEquitySumFleet,
  };
}

/* -------------------------------------------------------------------------- */
/*  账户口径的权益曲线                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 把「每机器人一份快照」重排成「每账户一份」的贡献者，交给 `mergeEquityCurves`。
 *
 * 每个账户只贡献**一条序列**：把该账户下所有机器人的快照合并成一条时间线，
 * 每条快照的金额换成交易所给的 `accountEquity`（共享钱包权益）。同账户下的
 * 机器人读数是同一个数，所以"桶对齐后取最近一条"就是正确做法；`mergeEquityCurves`
 * 随即将**账户之间**求和 —— 不同账户是不同的钱包，跨账户相加才是对的，
 * 错的是把同一个钱包数 N 遍（本文件顶部那 19.81）。
 *
 * `baseline` 用该账户的起始资金，于是曲线在第一条快照之前是一条平线，
 * 而不是从 0 开始 —— 也不会是"三个机器人的本金之和"。
 *
 * 两个字段在账户口径下没有意义，因此明确置空而不是沿用某个机器人的值：
 * `openPositions` 是**本机器人**的持仓数（账户口径下应看交易所的净持仓，
 * 不是把各机器人的持仓相加）；浮盈换成账户的总浮盈 `accountUnrealizedPnl`。
 */
export function accountEquityContributor(
  traders: readonly TraderRow[],
  snapshots: Record<number, EquitySnapshot[]>,
): EquityContributor {
  const series: Record<number, EquitySnapshot[]> = {};
  const baseline: Record<number, number> = {};

  for (const [exchangeAccountId, group] of groupTradersByAccount(traders)) {
    const timeline: EquitySnapshot[] = [];
    for (const trader of group) {
      for (const snapshot of snapshots[trader.id] ?? []) {
        // 见 `latestAccountReading`：0 是"没读到"，画进曲线会把账户拉到底。
        if (!(snapshot.accountEquity > 0)) continue;
        timeline.push({
          ...snapshot,
          equity: snapshot.accountEquity,
          unrealizedPnl: snapshot.accountUnrealizedPnl,
          openPositions: 0,
        });
      }
    }
    if (timeline.length > 0) series[exchangeAccountId] = timeline;
    baseline[exchangeAccountId] = committedCapitalOf(group);
  }

  return { series, baseline };
}
