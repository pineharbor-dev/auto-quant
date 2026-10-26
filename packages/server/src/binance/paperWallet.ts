import type { AccountState } from './account.js';

/**
 * 模拟盘的本地钱包 —— **不需要任何真实交易所账户**。
 *
 * ## 为什么需要它（用户 2026-10-27 的需求）
 *
 * 用户原话：
 * > 「创建模拟盘的时候，不应该只需要绑定钱包。还有，模拟盘不应该根据真实钱包的
 * >  余额，而应该可以自定义模拟盘的余额。也就是说，无需真实账户就能开启模拟盘机器人。」
 *
 * 在这之前，模拟盘（`dryRun=true`）只模拟了**下单**：`BinanceBroker` 的
 * `placeOrder` / `placeAlgoOrder` 都有 `if (this.dryRun)` 分支，不碰交易所。
 * 但**账户状态没有模拟** —— `getAccountState()` 直接走 `fetchAccountState(rest)`，
 * 也就是一次**真实的、签名的** `/fapi/v3/account` 请求。后果：
 *
 *   1. 没有真实 API Key → 连模拟盘都起不来（启动预检要求 `requireCredentials`）；
 *   2. 就算填了 Key，模拟盘看到的也是**真金白银的余额**，而它下的单在交易所
 *      根本不存在 —— 于是「可用余额」「保证金占用」这些数字与本地台账**永远对不上**。
 *
 * ## 这个模块的边界（诚实说明）
 *
 * 它**只**替代 `getAccountState()` 这一个读数。下单、持仓、挂单的模拟仍在
 * `BinanceBroker` 里（`simulateStandard` / `simulateAlgo`），本模块不重复那套逻辑。
 *
 * 因为 `getAccountState()` 是纯读数（无副作用、不参与撮合），把它换成一次本地
 * 计算**不会**让任何风控判断失效：风控读的是 `equity` / `availableBalance`，
 * 而这两个值现在由本地台账推出，比「查一个与本地仓位无关的真实账户」**更自洽**。
 *
 * ## 余额怎么算
 *
 * ```
 *   walletBalance    = 初始余额 + 已实现净盈亏（含手续费、资金费）
 *   unrealizedPnl    = Σ 各持仓浮盈（由调用方按标记价算好传入）
 *   equity           = walletBalance + unrealizedPnl
 *   marginUsed       = Σ 各持仓已用保证金
 *   availableBalance = equity − marginUsed
 * ```
 *
 * ⚠️ **不用固定百分比或随机数**：每个数字都来自本地台账，能事后逐笔核对 ——
 * 与仓库里「账是可核对的」那条口径一致。
 */
export interface PaperWalletSnapshotInput {
  /** 起始余额（操作员在创建机器人时填的那个数）。 */
  startingBalance: number;
  /** 已实现净盈亏累计（毛盈亏 − 手续费 − 资金费），由台账算出。 */
  realizedPnl: number;
  /** 当前所有持仓的未实现盈亏合计。 */
  unrealizedPnl: number;
  /** 当前所有持仓占用的保证金合计。 */
  marginUsed: number;
}

/**
 * 把本地台账的数字折算成一个 `AccountState`。
 *
 * 纯函数：同样的输入永远得到同样的输出，便于测试与回放。
 */
export function paperAccountState(input: PaperWalletSnapshotInput): AccountState {
  const startingBalance = finite(input.startingBalance);
  const realizedPnl = finite(input.realizedPnl);
  const unrealizedPnl = finite(input.unrealizedPnl);
  const marginUsed = finite(input.marginUsed);

  const walletBalance = startingBalance + realizedPnl;
  const equity = walletBalance + unrealizedPnl;

  return {
    equity,
    walletBalance,
    /*
     * 可用余额不允许为负 —— 交易所的 availableBalance 在穿仓时也是 0 而不是负数
     * （负数会让「仓位预算」这类计算得出一个荒谬的可用额度）。
     */
    availableBalance: Math.max(0, equity - marginUsed),
    unrealizedPnl,
    marginUsed,
    /* 模拟盘没有「挂单占用保证金」这一层（挂单在 `BinanceBroker` 里是立即成交的）。 */
    openOrderMargin: 0,
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 校验操作员填的起始余额。
 *
 * 返回 `null` 表示合法，否则返回面向操作员的中文原因。
 *
 * 上限 10 亿是刻意的：一个手滑多按几个 0 的余额会让后续所有「收益率」变成一个
 * 无限接近 0 的百分比，而界面上看不出任何异常 —— 那种错误只有上限能拦住。
 */
export function validateStartingBalance(value: number): string | null {
  if (!Number.isFinite(value)) return '起始余额必须是一个数字。';
  if (value <= 0) return '起始余额必须大于 0。';
  if (value < 10) return '起始余额太小（至少 10 USDT）—— 低于这个数任何仓位都会被最小下单量拒绝。';
  if (value > 1_000_000_000) return '起始余额过大（上限 10 亿）。';
  return null;
}
