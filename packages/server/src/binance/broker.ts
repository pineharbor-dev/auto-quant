import type { PositionSide } from '@aq/shared';
import { createLogger } from '../logger.js';
import { fetchAccountState, type AccountState } from './account.js';
import type { BinanceMarketData } from './market.js';
import type { BinanceRest } from './rest.js';
import { fetchIncome, type IncomeSummary } from './income.js';
import { normalizeSymbol, type SymbolRegistry } from './symbols.js';
import {
  BinanceApiError,
  type BinanceAccountV3,
  type BinanceAlgoOrderResponse,
  type BinanceAlgoStatus,
  type BinanceOrderResponse,
  type BinanceOrderSide,
  type BinanceOrderStatus,
  type BinanceOrderType,
  type BinancePositionRisk,
  type BinanceUserTrade,
  type BinanceIncome,
} from './types.js';

const log = createLogger('binance:broker');

/* -------------------------------------------------------------------------- */
/*  Domain shapes returned by the broker                                       */
/* -------------------------------------------------------------------------- */

// `AccountState` now lives in `./account.ts` so a balance can be read without
// bootstrapping a symbol registry. Re-exported here for callers that already
// import it from the broker.
export type { AccountState } from './account.js';

export interface ExchangePosition {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  marginUsed: number;
  notional: number;
  marginType: 'cross' | 'isolated';
}

/** The order types that must be sent to the Algo Order API. */
export const CONDITIONAL_ORDER_TYPES: ReadonlySet<string> = new Set([
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]);

export type OrderType = 'MARKET' | 'LIMIT' | BinanceOrderType;

export interface PlaceOrderRequest {
  symbol: string;
  side: BinanceOrderSide;
  type: OrderType;
  quantity?: number;
  price?: number;
  /**
   * The price at which a conditional order fires.
   *
   * Named `triggerPrice` because that is what the Algo Order API expects;
   * `stopPrice` survives only in order *responses*.
   */
  triggerPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  /**
   * `closePosition` makes the order close whatever the position size is at
   * trigger time. Mutually exclusive with `quantity` and `reduceOnly`; this is
   * the right choice for a bot's stop and target because it can never be left
   * behind as a partial residual.
   */
  closePosition?: boolean;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect?: boolean;
  clientOrderId?: string;
}

/**
 * A normalised handle for a placed order.
 *
 * Regular and algo orders have different identity spaces (`orderId` vs
 * `algoId`, `clientOrderId` vs `clientAlgoId`, `status` vs `algoStatus`).
 * Collapsing them here means the trading loop never has to branch on which
 * endpoint was used, which is where subtle bugs would otherwise live.
 */
export interface PlacedOrder {
  kind: 'order' | 'algo';
  /** `orderId` for regular orders, `algoId` for algo orders. */
  id: string;
  clientId: string;
  symbol: string;
  side: BinanceOrderSide;
  type: string;
  status: string;
  avgPrice: number;
  executedQty: number;
  /** True once the order can no longer change state. */
  terminal: boolean;
  raw: BinanceOrderResponse | BinanceAlgoOrderResponse;
}

export interface BrokerOptions {
  /** Simulate order placement while still reading real account data. */
  dryRun?: boolean;
  /** How long `waitForFill` polls before giving up. */
  fillTimeoutMs?: number;
  /**
   * **模拟盘的账户读数来源**（用户 2026-10-27 需求）。
   *
   * 传了它就**不再向交易所请求账户**，而是用这个函数返回的本地快照。
   * 于是模拟盘机器人可以**完全没有真实交易所账户** —— 这正是
   * 「无需真实账户就能开启模拟盘机器人」那条需求的落点。
   *
   * ## 为什么做成注入而不是在 `getAccountState` 里判 `dryRun`
   *
   * 因为余额的**算式**属于台账（已实现盈亏、持仓浮盈、保证金占用都在那边），
   * 而 broker 不该知道台账长什么样。注入让 `binance/` 这一层保持"只谈交易所"，
   * 台账那层负责给出数字 —— 两边各自的职责没有被搅在一起。
   *
   * ⚠️ **只在 `dryRun === true` 时才会被使用**（见 `getAccountState`）：
   * 实盘路径永远读交易所。这保证"多传了一个参数"不可能让实盘看到假余额。
   */
  paperAccount?: () => AccountState | Promise<AccountState>;
}

/* -------------------------------------------------------------------------- */
/*  Broker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * High-level Binance USDⓈ-M futures trading interface.
 *
 * Five pieces of hard-won correctness live here:
 *
 *  1. **Conditional orders go to the Algo Order API.** `POST /fapi/v1/order`
 *     rejects every conditional type with `-4120`. Getting this wrong means
 *     entries are opened with no stop loss at all, which is the single most
 *     dangerous failure this system can have.
 *  2. **One-way position mode.** Orders are sent with `positionSide=BOTH` and
 *     never with a signed quantity, because in one-way mode the sign of the
 *     amount is what encodes direction.
 *  3. **`closePosition` protection.** Stops and targets cover the whole position
 *     unconditionally, and Binance's prohibition on combining that flag with
 *     `quantity` or `reduceOnly` is enforced automatically.
 *  4. **Stale-order hygiene.** `closePosition` algo orders survive a manual
 *     close and would fire into a flat book, opening a fresh position in the
 *     opposite direction. Every manual exit cancels both regular *and* algo
 *     orders for the symbol first.
 *  5. **Never blind-retry an order.** An ambiguous outcome is reconciled by
 *     client id rather than resent.
 */
export class BinanceBroker {
  private readonly dryRun: boolean;
  private readonly fillTimeoutMs: number;

  /** 模拟盘账户读数来源；`null` 表示"没有提供"，仍走交易所。 */
  private readonly paperAccount: (() => AccountState | Promise<AccountState>) | null;

  constructor(
    private readonly rest: BinanceRest,
    private readonly market: BinanceMarketData,
    private readonly registry: SymbolRegistry,
    options: BrokerOptions = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.fillTimeoutMs = options.fillTimeoutMs ?? 10_000;
    this.paperAccount = options.paperAccount ?? null;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /* ---------------------------------------------------------------------- */
  /*  Account                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Account snapshot.
   *
   * ## 模拟盘读本地台账，实盘读交易所（2026-10-27）
   *
   * 原来这里无条件 `fetchAccountState(this.rest)` —— 一次**真实的、签名的**
   * `/fapi/v3/account` 请求。于是 `dryRun=true` 只模拟了"下单"，账户余额仍然是
   * 真金白银，且**没有真实 API Key 时连模拟盘都起不来**。
   *
   * 现在：`dryRun && paperAccount` 走本地台账，其余一律走交易所。
   *
   * ⚠️ **判据里同时要求 `dryRun`**，不只是"提供了 paperAccount"：
   * 让实盘路径没有任何办法读到模拟余额。一个被误传的参数不该能让实盘
   * 看到假数字 —— 那是本仓库最不能接受的那类故障（"一个字段说模拟、
   * 另一个字段在下真单"）。
   */
  async getAccountState(): Promise<AccountState> {
    if (this.dryRun && this.paperAccount) return await this.paperAccount();
    return fetchAccountState(this.rest);
  }

  /** Position mode: `true` when the account is in hedge (dual-side) mode. */
  async isHedgeMode(): Promise<boolean> {
    const response = await this.rest.signedRequest<{ dualSidePosition: boolean }>(
      'GET',
      '/fapi/v1/positionSide/dual',
    );
    return response.dualSidePosition === true;
  }

  /**
   * Force one-way mode, the only mode this bot reasons about.
   * Binance refuses the change while any position or open order exists.
   */
  async ensureOneWayMode(): Promise<{ changed: boolean; warning: string | null }> {
    if (this.dryRun) return { changed: false, warning: null };
    const hedge = await this.isHedgeMode();
    if (!hedge) return { changed: false, warning: null };

    const positions = await this.getPositions();
    /*
     * ⚠️ **读不到挂单 ≠ 没有挂单。**（与 `reconcileTradeHistory` 那个 P0 同一种形状）
     *
     * 这里原来对两个查询各挂一个 `.catch(() => [])`，于是**一次网络抖动**就让
     * 计数变成 0，判定 `positions.length > 0 || openOrders > 0 || openAlgo > 0`
     * 随之放行，去 POST 切换持仓模式 —— 而币安在"有持仓或挂单"时会用 `-4067`
     * 拒绝；更糟的是这段代码之前的判断已经假设没有挂单了，**切换成功后所有单
     * 都会因为 `positionSide: 'BOTH'` 与双向模式不兼容而吃 `-4061`**。
     *
     * 所以读不到时**保守地不切换**：返回 warning 而不是误判"账户是空的"。
     * 这里**不抛**异常：切换失败只是少一次优化，绝不该让机器人起不来。
     */
    let openOrders: number;
    let openAlgo: number;
    try {
      openOrders = (await this.getOpenOrders()).length;
      openAlgo = (await this.getOpenAlgoOrders()).length;
    } catch (error) {
      return {
        changed: false,
        warning:
          `无法确认账户上是否还有挂单（${(error as Error).message}）—— ` +
          '因此本次不切换持仓模式（读不到不等于没有）。请稍后重启重试。',
      };
    }
    if (positions.length > 0 || openOrders > 0 || openAlgo > 0) {
      return {
        changed: false,
        warning:
          '账户当前是双向持仓模式。请先清空所有持仓与挂单，然后重启机器人，它才能切换为单向持仓模式。',
      };
    }

    try {
      await this.rest.signedRequest('POST', '/fapi/v1/positionSide/dual', {
        dualSidePosition: 'false',
      });
      log.info('账户已切换为单向持仓模式');
      return { changed: true, warning: null };
    } catch (error) {
      return {
        changed: false,
        warning: `无法切换为单向持仓模式：${(error as Error).message}`,
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Positions                                                              */
  /* ---------------------------------------------------------------------- */

  /** Open positions only — Binance returns a row for every symbol it knows. */
  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    const rows = await this.rest.signedRequest<BinancePositionRisk[]>(
      'GET',
      '/fapi/v2/positionRisk',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );

    const results: ExchangePosition[] = [];
    for (const row of rows) {
      const quantity = Number(row.positionAmt) || 0;
      if (quantity === 0) continue;

      const entryPrice = Number(row.entryPrice) || 0;
      const markPrice = Number(row.markPrice) || 0;
      const unrealizedPnl = Number(row.unRealizedProfit) || 0;
      const leverage = Number(row.leverage) || 1;
      const notional = Math.abs(Number(row.notional) || markPrice * Math.abs(quantity));

      // In one-way mode the sign of positionAmt carries the direction and
      // positionSide is always BOTH.
      const side: PositionSide = row.positionSide === 'SHORT' || quantity < 0 ? 'short' : 'long';

      // `/fapi/v2/positionRisk` exposes no initial-margin field, so derive it.
      const marginUsed =
        row.marginType === 'isolated' ? Math.abs(Number(row.isolatedWallet) || 0) : notional / leverage;

      const liquidationPrice = Number(row.liquidationPrice);

      results.push({
        symbol: row.symbol,
        side,
        quantity: Math.abs(quantity),
        entryPrice,
        markPrice,
        leverage,
        liquidationPrice:
          Number.isFinite(liquidationPrice) && liquidationPrice > 0 ? liquidationPrice : null,
        unrealizedPnl,
        unrealizedPnlPercent: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
        marginUsed,
        notional,
        marginType: row.marginType,
      });
    }
    return results;
  }

  /* ---------------------------------------------------------------------- */
  /*  Leverage & margin                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * 交易所对某个标的**实际允许**的最大杠杆。
   *
   * ## 为什么需要它（`GET /fapi/v1/leverageBracket`）
   *
   * 官方口径是：**能设的最大杠杆 = min(名义价值所在档的 `initialLeverage`, 账户级限制, symbol 上限)**。
   * 而账户级那一项对**子账户**尤其要紧 —— 官方 FAQ 明文：
   *
   * > Starting from 12 August 2025, leverage levels over 5x are **not** available to
   * > Futures Accounts created by **regular users' sub-accounts**.
   *
   * 也就是说：**同一份配置，跑在主账户上能用 20x，跑在子账户上只能 5x** —— 而在此之前
   * 我们完全不知道这件事（`leverageBracket` 在这个仓库里一次都没被调用过）。
   *
   * ## 为什么取"最高档"的 `initialLeverage`
   *
   * 档位是按**名义价值**分的：仓位越大，允许的杠杆越低。而我们问的是
   * **"这个标的能设到多少"** —— 那正是**最小仓位那一档**（brackets[0]）的值。
   * 真正下单时的名义价值如果更大，`setLeverage` 会以 `-2027`/`-2028` 拒回来，
   * 那时再降 —— **宁可在这里给一个偏乐观的上界，也不要凭空收紧模型的可用空间**。
   *
   * 返回 `null` = **不知道**（读失败、dry-run、或响应形状不认识）。
   * 调用方据此退回"只用配置的上限" —— 读不到档位不该让交易停下来。
   */
  async getMaxLeverage(symbol: string): Promise<number | null> {
    if (this.dryRun) return null;
    const normalized = normalizeSymbol(symbol);
    try {
      const rows = await this.rest.signedRequest<
        Array<{ symbol: string; brackets: Array<{ initialLeverage: number; notionalCap: number }> }>
      >('GET', '/fapi/v1/leverageBracket', { symbol: normalized });
      const row = rows.find((r) => r.symbol === normalized) ?? rows[0];
      if (!row || !Array.isArray(row.brackets) || row.brackets.length === 0) return null;
      /*
       * 第一档 = 名义价值最小的那一档 = 允许杠杆最高的那一档。
       * 不假设它已排序：取 `initialLeverage` 的最大值更稳。
       */
      const best = row.brackets.reduce(
        (max, b) => (Number(b.initialLeverage) > max ? Number(b.initialLeverage) : max),
        0,
      );
      return best > 0 ? best : null;
    } catch (error) {
      log.warn(`读取 ${normalized} 的杠杆档位失败（本轮只用配置上限）：${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Set leverage for a symbol.
   *
   * `-4046` ("no need to change leverage") is benign; `-4168` means open orders
   * block the change, which is not fatal because sizing is clamped anyway.
   */
  async setLeverage(
    symbol: string,
    leverage: number,
  ): Promise<{ ok: boolean; leverage: number; note?: string }> {
    const normalized = normalizeSymbol(symbol);
    if (this.dryRun) return { ok: true, leverage };

    const current = await this.getPositions(normalized);
    if (current.length > 0) {
      return {
        ok: false,
        leverage: current[0]?.leverage ?? leverage,
        note: `${normalized} 已有持仓，杠杆保持不变`,
      };
    }

    try {
      const response = await this.rest.signedRequest<{ leverage: number; symbol: string }>(
        'POST',
        '/fapi/v1/leverage',
        { symbol: normalized, leverage },
      );
      return { ok: true, leverage: Number(response.leverage) || leverage };
    } catch (error) {
      if (error instanceof BinanceApiError) {
        if (error.code === -4046) return { ok: true, leverage };
        if (error.code === -4168) {
          return {
            ok: false,
            leverage,
            note: `${normalized} 有挂单未成交，杠杆保持不变`,
          };
        }
        /*
         * ⚠️ **"你这个杠杆不允许"是一个可以挽救的失败，不该让整轮开仓白跑。**
         *
         * 交易所拒绝杠杆有几个码，语义都是"太高了"，而**上限它自己会说出来**：
         *
         *   · `-4203` Change leverage failed（该账户/该档位不允许这个值）
         *   · `-4205` 超出账户允许的最大杠杆（**开户未满 30 天**在这一档）
         *   · `-4209` Current symbol max leverage limit is %sx（**消息里带数字**）
         *   · `-4421` **Subaccounts are restricted from using leverage greater than 5x**
         *     —— **子账户的账户级硬限制**，消息里同样带数字。
         *
         * ## 为什么 `-4421` 必须在这里（2026-10-02 实测漏掉它）
         *
         * 线上日志：
         *
         *     open_long ETHUSDT 执行失败：币安错误 -4421：
         *     Subaccounts are restricted from using leverage greater than 5x.
         *
         * 币安自 2025-08-12 起对"普通用户创建的**子账户**"限制 5x。而 `leverageBracket`
         * 只反映 **symbol 那一层**（实测 BTC 150x、山寨 75x）—— **账户级那一层它看不到**。
         * 所以配置里写着 20x 时，事前没有任何本地信息能拦住它，**只有这条错误消息知道**。
         *
         * 漏掉它的后果是**整轮开仓作废**（模型提案合规、风控放行、交易所拒绝），
         * 而模型下一轮会照样再试一次 —— 这正是用户说的那种"系统不会自己处理"。
         */
        if (
          error.code === -4203 ||
          error.code === -4205 ||
          error.code === -4209 ||
          error.code === -4421
        ) {
          const admitted = parseAdmittedLeverage(error.message);
          const target = admitted ?? Math.max(1, Math.floor(leverage / 2));
          if (target < leverage) {
            const retry = await this.retryLeverage(normalized, target);
            if (retry !== null) {
              return {
                ok: true,
                leverage: retry,
                note:
                  `${normalized} 的杠杆从 ${leverage}x 降到 ${retry}x` +
                  `（交易所不允许更高${admitted !== null ? `，它自己说的上限是 ${admitted}x` : ''}）。`,
              };
            }
          }
        }
      }
      throw error;
    }
  }

  /**
   * 逐级降到交易所接受为止。返回**实际设上的杠杆**，全都不行时返回 `null`。
   *
   * 二分而不是每次减 1：一个 20x 的请求最多 5 次请求就能落到 1x，
   * 而"每次减 1"最坏是 19 次。这个方法只在**已经被拒之后**才跑，所以
   * 正常路径（一次成功）完全不受影响。
   */
  private async retryLeverage(symbol: string, from: number): Promise<number | null> {
    let high = from;
    let low = 1;
    let best: number | null = null;
    for (let attempt = 0; attempt < 6 && low <= high; attempt += 1) {
      const mid = Math.floor((low + high) / 2);
      try {
        await this.rest.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage: mid });
        best = mid;
        low = mid + 1;
      } catch (retryError) {
        if (retryError instanceof BinanceApiError && retryError.code === -4168) {
          /* 有挂单挡住了 —— 那不是"杠杆太高"，再降也没用。 */
          return best;
        }
        high = mid - 1;
      }
    }
    return best;
  }

  /** Set margin type for a symbol. Cannot change while positions are open. */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<boolean> {    if (this.dryRun) return true;
    const normalized = normalizeSymbol(symbol);
    try {
      await this.rest.signedRequest('POST', '/fapi/v1/marginType', {
        symbol: normalized,
        marginType,
      });
      return true;
    } catch (error) {
      if (error instanceof BinanceApiError && error.code === -4046) return true;
      if (error instanceof BinanceApiError && error.code === -4047) return false;
      log.warn(`设置 ${normalized} 的保证金模式为 ${marginType} 失败：${(error as Error).message}`);
      return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Order placement                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Place an order of any type, routing conditional types to the Algo API.
   *
   * **Every value is normalised here, before it leaves the process.** Quantity is
   * floored to `stepSize`, limit and trigger prices are snapped to `tickSize`,
   * and a trigger is kept on the side of the market its order type requires.
   *
   * This is deliberately not the caller's responsibility. A previous version
   * trusted the risk engine to have produced valid numbers — but the risk engine
   * only guarantees the *direction* of a stop, not its tick alignment, so the
   * exchange rejected every stop with `-1111 Precision is over the maximum
   * defined for this asset` and positions ran unprotected. The adapter is the
   * only layer that both knows the symbol filters and is on the path of every
   * order, which makes it the right place for this.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlacedOrder> {
    const symbol = normalizeSymbol(request.symbol);
    const isConditional = CONDITIONAL_ORDER_TYPES.has(request.type);

    const normalised: PlaceOrderRequest = { ...request, symbol };

    // Quantity: always floor, so rounding can never ask for more than intended.
    if (typeof request.quantity === 'number' && request.quantity > 0) {
      const rounded = this.registry.roundQuantity(symbol, request.quantity);
      if (rounded <= 0) {
        throw new Error(
          `${symbol} 的下单数量 ${request.quantity} 按步长 ${this.registry.require(symbol).stepSize} 取整后为 0`,
        );
      }
      normalised.quantity = rounded;

      /*
       * 取整后的名义价值必须仍然达到交易所的下限。
       *
       * ⚠️ 这一条是实测撞出来的：风控校验的是**取整之前**的名义价值，
       * 于是"6 USDT ≥ 5 USDT"通过了，而按步长向下取整之后真正发出去的名义
       * 已经低于 5 —— 交易所拒单：`-4164 Order's notional must be no smaller than 5`。
       *
       * **风控只保证方向与量级，不保证精度**（这一点在 `placeOrder` 的类注释里
       * 已经写着，同样的道理适用于名义价值而不只是触发价）。适配器是唯一同时
       * 知道合约过滤器、又在每一张订单路径上的层 —— 所以判定在这里。
       *
       * **为什么本地判定比让交易所拒绝更重要**：
       * `-4164` 只告诉操作员"名义太小"，看不出是**取整**造成的，
       * 也看不出差了多少。这里把三个数字（实际名义、下限、步长）一次说清，
       * 让"为什么这张单下不出去"变成一个可定位的问题。
       */
      /*
       * ⚠️ **`closePosition` 的单必须豁免这个检查。**
       *
       * 币安的错误信息里那句「unless you choose reduce only」就是这个意思：
       * `closePosition: true` 的条件单只用于平掉既有仓位，**不受名义下限约束**。
       *
       * 我们的止损/止盈正是这么挂的（`placeProtection` 传 `closePosition: true`）。
       * 如果这里把它们一起拒掉，**仓位会失去保护** ——
       * 那是 §2.6 说的最糟状态，而且比"名义太小下不出去"严重得多。
       */
      /*
       * ⚠️ **市价单也必须能算出参考价。**
       *
       * 原来的写法是 `request.price ?? request.triggerPrice ?? 0`，而**开仓用的是市价单**
       * —— 它既没有 `price` 也没有 `triggerPrice`，于是 `refPrice` 恒为 0、
       * **整个名义检查被静默跳过**。实测里 `-4164` 因此仍然反复出现：
       * 那个检查对"市价开仓"从来没运行过，而市价开仓正是最常见的路径。
       *
       * **一次「加了检查但检查不生效」比没有检查更糟** ——
       * 它会让人（包括我自己）以为问题已经堵住了。
       *
       * 所以价格取不到时**主动去问交易所**（与下面条件单分支用的是同一个方法）。
       * 拿不到标记价时**放行而不是拒绝**：一个取不到价格的网络问题，
       * 不该让一笔合法订单下不出去 —— 那种情况交给交易所去判。
       */
      /*
       * ⚠️ **`reduceOnly` 也必须豁免 —— 它和 `closePosition` 是同一句话。**
       *
       * 币安原文是「unless you choose reduce only」：只减仓的委托不受名义下限
       * 约束（它不会增加敞口）。这里原来只豁免了 `closePosition`，于是
       * **一个部分平仓后剩下的残仓（名义 < 5/20/50 USDT）永远平不掉**：
       * `executeClose` / `emergencyFlatten` 在发单**之前**就抛"名义价值不足"，
       * 仓位 stranded 在交易所上，而系统只能打一条"需要人工介入"。
       *
       * 一个退不出去的仓位比一条被拒的委托危险得多 —— 所以豁免。
       */
      const exemptFromMinNotional =
        request.closePosition === true || request.reduceOnly === true;

      let refPrice = request.price && request.price > 0 ? request.price : request.triggerPrice ?? 0;
      if (!(refPrice > 0) && !exemptFromMinNotional) {
        refPrice = await this.getMarkPrice(symbol).catch(() => 0);
      }
      if (refPrice > 0 && !exemptFromMinNotional) {
        const info = this.registry.require(symbol);
        const notional = rounded * refPrice;
        if (info.minNotional > 0 && notional < info.minNotional) {
          const neededQty = this.registry.roundQuantity(symbol, info.minNotional / refPrice);
          /*
           * 说清"需要多少数量"而不只是"不够"：如果连**下限对应的数量**取整后
           * 仍然不足，那这一类标的在这个价位上根本开不出来（步长太粗），
           * 那是与"仓位太小"完全不同的结论，操作员该做的是换标的而不是加仓。
           */
          const bumpNote =
            neededQty >= rounded
              ? `至少需要 ${neededQty}（按 ${info.stepSize} 步长）`
              : `按 ${info.stepSize} 步长取整后无法达到下限 —— 该标的在当前价位开不出来`;
          throw new Error(
            `${symbol} 的名义价值不足：${rounded} × ${refPrice} = ${notional.toFixed(4)} USDT，` +
              `低于交易所下限 ${info.minNotional} USDT。${bumpNote}。` +
              `（数量 ${request.quantity} 按步长取整为 ${rounded} 之后才不足 —— 调整仓位时要把这一步算进去。）`,
          );
        }
      }
    }

    if (isConditional) {
      if (!(request.triggerPrice && request.triggerPrice > 0)) {
        throw new Error(`条件单 ${request.type} 缺少触发价`);
      }
      // The mark price is needed to keep the trigger on the correct side after
      // rounding, so fetch it rather than assuming.
      const markPrice = await this.getMarkPrice(symbol).catch(() => 0);
      normalised.triggerPrice = this.registry.roundTriggerPrice(
        symbol,
        request.triggerPrice,
        request.type,
        request.side,
        markPrice,
      );

      /*
       * ⚠️ **标记价取不到时放行，而不是当成"会立即触发"拒绝** —— 与上面名义检查
       * 的 `if (refPrice > 0 && …)` 是同一个模式，也与 `autoTrader` 调用方自己的
       * `markNow > 0 &&` 守卫一致。
       *
       * `isValidTrigger()` 的第一行是 `!(marketPrice > 0) → false`，所以
       * `markPrice === 0`（`getMarkPrice` 两个数据源都取不到）会让**任何**合法
       * 触发价都被判成"会立即触发"。那是一个网络故障，却会把一笔健康的持仓
       * 按 `requireStopLoss` 触发**不必要的紧急全平** —— 真实滑点 + taker 手续费，
       * 而且审计里记的还是误导性的原因。
       *
       * 放行不等于不校验：交易所仍会用自己的标记价判 `-2021`，那是权威判定。
       */
      if (
        markPrice > 0 &&
        !this.registry.isValidTrigger(normalised.triggerPrice, request.type, request.side, markPrice)
      ) {
        // Refuse locally with a clear message rather than letting Binance answer
        // `-2021 Order would immediately trigger`, which says nothing about why.
        throw new Error(
          `${symbol} 的 ${request.type} 触发价 ${normalised.triggerPrice} 会立即触发（当前标记价 ${markPrice}），已拒绝下单`,
        );
      }
    } else if (typeof request.price === 'number' && request.price > 0) {
      // A buy limit must not round up into a worse price, nor a sell limit down.
      normalised.price = this.registry.roundLimitPrice(
        symbol,
        request.price,
        request.side === 'BUY' ? 'down' : 'up',
      );
    }

    if (isConditional) return this.placeAlgoOrder(normalised as PlaceOrderRequest & { symbol: string });
    return this.placeStandardOrder(normalised as PlaceOrderRequest & { symbol: string });
  }

  private async placeStandardOrder(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const params: Record<string, unknown> = {
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      // One-way mode: always BOTH. Never send a signed quantity.
      positionSide: 'BOTH',
      newClientOrderId: request.clientOrderId,
    };

    if (request.type === 'MARKET') {
      // `quoteOrderQty` is not supported on USDⓈ-M futures; `quantity` is required.
      params.quantity = request.quantity;
      if (request.reduceOnly) params.reduceOnly = true;
    } else {
      params.quantity = request.quantity;
      params.price = request.price;
      params.timeInForce = request.timeInForce ?? 'GTC';
      params.reduceOnly = request.reduceOnly ?? false;
    }

    if (this.dryRun) return this.simulateStandard(request);

    const response = await this.rest.signedRequest<BinanceOrderResponse>(
      'POST',
      '/fapi/v1/order',
      params,
      /*
       * ⚠️ **下单请求绝不因为"结果未知"而重发。**
       *
       * 类注释（见文件头）承诺的是 "Never blind-retry an order" —— 而这条承诺
       * 原来只停在注释里：`signedRequest` 对所有请求一视同仁地重试 3 次，
       * 于是**一次传输超时（`AbortSignal.timeout`）就会把同一张市价单再发一遍**。
       * 若第一张其实已经成交，`newClientOrderId` 不会挡住它（币安只要求该 id 在
       * **未成交委托**中唯一）→ **仓位翻倍，而且多出来的那一半没有保护单**。
       *
       * `avoidAmbiguousRetry` 只屏蔽"结果未知"的重试（传输层错误、5xx）；
       * `-1021` 时钟漂移与 `429` 限流仍然重试 —— 那两个是**明确未被接受**，
       * 重发是安全的，而时钟漂移的重试正是下单能正常工作所依赖的。
       */
      { avoidAmbiguousRetry: true },
    );
    log.debug(`order ${request.type} ${request.side} ${request.symbol} → ${response.status}`, {
      orderId: response.orderId,
      qty: response.origQty,
      avgPrice: response.avgPrice,
    });
    return normalizeStandard(response);
  }

  /**
   * Place a conditional order on the Algo Order API.
   *
   * `closePosition=true` must not be combined with `quantity` or `reduceOnly`,
   * so those are stripped rather than sent and rejected.
   */
  private async placeAlgoOrder(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const params: Record<string, unknown> = {
      algoType: 'CONDITIONAL',
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      positionSide: 'BOTH',
      // The Algo API calls this `triggerPrice`; `stopPrice` is response-only now.
      triggerPrice: request.triggerPrice,
      workingType: request.workingType ?? 'MARK_PRICE',
      priceProtect: request.priceProtect ?? true,
      clientAlgoId: request.clientOrderId,
    };

    if (request.closePosition) {
      params.closePosition = true;
    } else {
      params.quantity = request.quantity;
      params.reduceOnly = request.reduceOnly ?? true;
    }

    if (this.dryRun) return this.simulateAlgo(request);

    const response = await this.rest.signedRequest<BinanceAlgoOrderResponse>(
      'POST',
      '/fapi/v1/algoOrder',
      params,
      // 与普通下单同理：条件单「结果未知」时重发，可能挂出两张保护单。
      { avoidAmbiguousRetry: true },
    );
    log.debug(
      `algo ${request.type} ${request.side} ${request.symbol} trigger=${response.triggerPrice} → ${response.algoStatus}`,
      { algoId: response.algoId, closePosition: response.closePosition },
    );
    return normalizeAlgo(response);
  }

  /* ---------------------------------------------------------------------- */
  /*  Order queries                                                          */
  /* ---------------------------------------------------------------------- */

  async getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
    return this.rest.signedRequest<BinanceOrderResponse[]>(
      'GET',
      '/fapi/v1/openOrders',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );
  }

  /**
   * 查**单张普通订单**（`GET /fapi/v1/order`）。
   *
   * ## 为什么需要它 —— 限价入场
   *
   * `getOpenOrders` 只能回答"它**还挂着**吗"，回答不了"它**成交了吗**"：
   * 一张已经成交的限价单会从挂单列表里消失，和"被撤销"长得一模一样。
   *
   * 而限价入场要的恰恰是后者 —— 挂单之后系统必须能问出三种结果：
   * **成交了**（转正成持仓）、**撤了/过期了**（从未成为持仓）、**还挂着**（继续等）。
   *
   * 与 `getAlgoOrder` 同一个形状：读不到返回 `null`，由调用方决定"下一轮再问"，
   * **不让一次读失败被误当成一种结论**。
   */
  async getOrder(symbol: string, orderId: string | number): Promise<BinanceOrderResponse | null> {
    if (this.dryRun) return null;
    try {
      return await this.rest.signedRequest<BinanceOrderResponse>('GET', '/fapi/v1/order', {
        symbol: normalizeSymbol(symbol),
        orderId,
      });
    } catch (error) {
      log.debug(`getOrder(${symbol}, ${orderId}) failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Open algo orders. Weight 1 with a symbol, **40 without** — so this is always
   * called per symbol.
   */
  async getOpenAlgoOrders(symbol?: string): Promise<BinanceAlgoOrderResponse[]> {
    const response = await this.rest.signedRequest<BinanceAlgoOrderResponse[] | { orders?: BinanceAlgoOrderResponse[] }>(
      'GET',
      '/fapi/v1/openAlgoOrders',
      symbol ? { symbol: normalizeSymbol(symbol), algoType: 'CONDITIONAL' } : { algoType: 'CONDITIONAL' },
    );
    if (Array.isArray(response)) return response;
    return response.orders ?? [];
  }

  /**
   * Query a single algo order, including ones that are no longer open.
   *
   * This is the **only** reliable way to tell a stop that fired from a target
   * that fired: once the position closes, Binance removes the surviving
   * `closePosition` order too, so both ids disappear from `openAlgoOrders` and
   * their absence cannot distinguish them. The triggered order reports
   * `FINISHED` (or `TRIGGERED`); the other reports `CANCELED`/`EXPIRED`.
   */
  /**
   * 查一张条件单（含**已经不在挂单列表里**的那些）。
   *
   * ## ⚠️ 2026-10-14：区分"读失败"与"交易所说它不存在"
   *
   * 原来这个方法的 `catch` 把**所有**错误都变成 `null` —— 而下游
   *（`finalStatusOf`）把 `null` 读成"这一轮不下结论"，于是**静默跳过**。
   *
   * 那个取舍本身是对的（读不到时不该改账），但它有一个**死锁**：
   * ```
   *   交易所真的查不到这张单（-2013 Order does not exist）
   *   → 永远返回 null → 永远跳过 → 那些行【永远】停在 NEW
   * ```
   * 线上实测（`#11`）：**42 条**本地 `NEW` 的条件单，逐个查都回
   * `{"code":-2013,"msg":"Order does not exist."}` —— 而界面一直显示它们"已挂单"。
   *
   * ## 修法：把"交易所明确说它不存在"翻译成一个**可判定的答案**
   *
   * ```
   *   -2013（Order does not exist）→ 返回 'not-found'
   *   其它错误（网络 / 鉴权 / 限流）→ 返回 null（仍然"不下结论"）
   * ```
   * ⚠️ **安全边界不变**：只有交易所**自己说**这张单不存在时，我们才敢写终态。
   * 网络抖动、鉴权失败仍然什么都不写 —— 那些"读不到"与"不存在"是两件事，
   * 而把它们混成一件正是这个 bug 的成因。
   */
  async getAlgoOrder(algoId: string | number): Promise<BinanceAlgoOrderResponse | null | 'not-found'> {
    if (this.dryRun) return null;
    try {
      return await this.rest.signedRequest<BinanceAlgoOrderResponse>('GET', '/fapi/v1/algoOrder', {
        algoId,
      });
    } catch (error) {
      const message = (error as Error).message;
      /*
       * ⚠️ 判据用**错误码**（`-2013`），不用文案 —— 文案会随语言/版本变。
       * 同时兼容 `Order does not exist` 这句（旧响应可能不带 code）。
       */
      if (/-2013\b/.test(message) || /Order does not exist/i.test(message)) {
        return 'not-found';
      }
      log.debug(`getAlgoOrder(${algoId}) failed: ${message}`);
      return null;
    }
  }

  /** Poll a regular order until it reaches a terminal state. */
  async waitForFill(order: PlacedOrder, timeoutMs = this.fillTimeoutMs): Promise<PlacedOrder> {
    if (this.dryRun || order.terminal) return order;

    const deadline = Date.now() + timeoutMs;
    let latest = order;
    let delay = 250;

    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 1500);
      try {
        latest =
          order.kind === 'order'
            ? normalizeStandard(
                await this.rest.signedRequest<BinanceOrderResponse>('GET', '/fapi/v1/order', {
                  symbol: order.symbol,
                  /*
                   * ⚠️ **用字符串，不要 `Number(order.id)`。**
                   * 币安新版单号 19 位（超过 JS 安全整数）：`Number()` 之后
                   * 末几位就变了，拿它去查会**永远查不到** → 这里会一路轮询到超时、
                   * 把一张其实已经成交的单判成"未确认"。
                   */
                  orderId: order.id,
                }),
              )
            : normalizeAlgo(
                await this.rest.signedRequest<BinanceAlgoOrderResponse>('GET', '/fapi/v1/algoOrder', {
                  algoId: order.id,
                }),
              );
      } catch (error) {
        log.debug(`poll for ${order.kind} ${order.id} failed: ${(error as Error).message}`);
        continue;
      }
      if (latest.terminal) return latest;
    }

    log.warn(`${order.symbol} 的 ${order.kind} 单 #${order.id} 在 ${timeoutMs}ms 内没有进入终态`, {
      status: latest.status,
    });
    return latest;
  }

  /* ---------------------------------------------------------------------- */
  /*  Cancellation                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * 撤一张单。
   *
   * ⚠️ `orderId` **按字符串原样发送**（接受 number 只为兼容旧调用点）——
   * 19 位单号经 `Number()` 转换会丢精度，那样撤单请求会命中一个**不存在的单号**，
   * 币安回 `-2011`，而这里把 `-2011` 当成"它已经不在交易所了"= 成功 ——
   * 于是系统以为撤掉了，**那张单其实还挂着**。
   */
  async cancelOrder(
    symbol: string,
    orderId: string | number,
    kind: 'order' | 'algo' = 'order',
  ): Promise<boolean> {
    if (this.dryRun) return true;
    const normalized = normalizeSymbol(symbol);
    try {
      if (kind === 'algo') {
        await this.rest.signedRequest('DELETE', '/fapi/v1/algoOrder', {
          symbol: normalized,
          algoId: orderId,
        });
      } else {
        await this.rest.signedRequest('DELETE', '/fapi/v1/order', {
          symbol: normalized,
          orderId,
        });
      }
      return true;
    } catch (error) {
      // -2011 "Unknown order sent" means it already filled or was cancelled.
      if (error instanceof BinanceApiError && error.code === -2011) return true;
      log.warn(`撤销 ${symbol} 的 ${kind} 单 #${orderId} 失败：${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Cancel every resting order for a symbol — **both** regular and algo.
   *
   * Called immediately before and after any manual exit. A leftover
   * `closePosition` algo order would otherwise fire into a flat book and open a
   * brand new position in the opposite direction.
   *
   * ## 契约：**撤不掉就抛**
   *
   * 这个方法原来把失败**吞成一行 `log.warn`**（`Promise.allSettled` + 只记日志），
   * 于是所有按"它会抛"写出来的调用点都成了**死代码** —— 最典型的是
   * `applyBreakevenGuard` / `executeAdjust` 里的「撤不掉就不要挂新的」：
   * 撤单真的失败时 `catch` 永不触发 → 继续挂新单 → 必然吃 `-4130`
   * （币安不允许同一仓位存在两张条件单）→ 判为"没有有效止损" →
   * 按 §2.6 市价平掉一个**本来有保护、而且可能正在盈利**的仓位。
   * 2026-09-22 那笔 ADAUSDT（净 −0.0166）就是这个形状。
   *
   * 同一条纪律在 `executeClose` 里写对了（`cancelOrder` 的返回值被检查），
   * 在这里漏了：**适配层用"返回值"表达失败、调用层用"异常"表达失败，
   * 两者之间没有类型约束**，编译器抓不到。所以这里统一成异常。
   *
   * `-2011`（Unknown order sent：单子已经成交或被撤）不算失败 —— 那正是
   * "已经不在交易所了"这个我们要的结果。
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    if (this.dryRun) return;
    const normalized = normalizeSymbol(symbol);

    const results = await Promise.allSettled([
      this.rest.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: normalized }),
      // Separate endpoint: `allOpenOrders` does not touch algo orders.
      this.rest.signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: normalized }),
    ]);

    const failures: string[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        const error = result.reason as BinanceApiError;
        if (error instanceof BinanceApiError && error.code === -2011) continue;
        const why = error?.message ?? String(error);
        log.warn(`撤销 ${normalized} 的全部挂单时部分失败：${why}`);
        failures.push(why);
      }
    }

    if (failures.length > 0) {
      throw new Error(`撤销 ${normalized} 的挂单失败（${failures.join('；')}）—— 交易所侧可能仍有挂单。`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Fills                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Recent fills for a symbol, used to reconcile fees and realised PnL. */
  async getUserTrades(symbol: string, limit = 50): Promise<BinanceUserTrade[]> {
    if (this.dryRun) return [];
    return this.rest.signedRequest<BinanceUserTrade[]>('GET', '/fapi/v1/userTrades', {
      symbol: normalizeSymbol(symbol),
      limit,
    });
  }

  /**
   * The account's income ledger — realised PnL, commission, funding, transfers.
   *
   * The runtime reads it to discover symbols it may have missed and to attribute
   * funding fees, neither of which is visible in the order flow.
   */
  async getIncome(options: {
    startTime: number;
    endTime?: number;
    symbol?: string;
    incomeType?: string;
  }): Promise<BinanceIncome[]> {
    if (this.dryRun) return [];
    return fetchIncome(this.rest, options);
  }

  /** Mark price straight from the exchange — used to price fallback stops. */
  async getMarkPrice(symbol: string): Promise<number> {
    const [premium] = await this.market.premiumIndex(symbol);
    const value = Number(premium?.markPrice);
    if (Number.isFinite(value) && value > 0) return value;
    const [ticker] = await this.market.ticker24h(symbol);
    return Number(ticker?.lastPrice) || 0;
  }

  /* ---------------------------------------------------------------------- */
  /*  Dry-run simulation                                                     */
  /* ---------------------------------------------------------------------- */

  private async simulateStandard(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const markPrice = (await this.getMarkPrice(request.symbol)) || request.price || 0;
    const at = Date.now();
    const qty = request.quantity ?? 0;

    log.info(
      `[dry-run] ${request.type} ${request.side} ${request.symbol} qty=${qty} @ ~${markPrice}`,
    );

    const response: BinanceOrderResponse = {
      clientOrderId: request.clientOrderId ?? `dry-${at}`,
      cumQty: String(qty),
      cumQuote: String(qty * markPrice),
      executedQty: String(qty),
      orderId: at,
      avgPrice: String(markPrice),
      origQty: String(qty),
      price: String(request.price ?? 0),
      reduceOnly: request.reduceOnly ?? false,
      side: request.side,
      positionSide: 'BOTH',
      status: 'FILLED',
      stopPrice: '0',
      closePosition: false,
      symbol: request.symbol,
      timeInForce: request.timeInForce ?? 'GTC',
      type: request.type as BinanceOrderType,
      origType: request.type as BinanceOrderType,
      updateTime: at,
      workingType: 'MARK_PRICE',
      priceProtect: false,
    };
    return normalizeStandard(response);
  }

  private async simulateAlgo(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const at = Date.now();
    log.info(
      `[dry-run] algo ${request.type} ${request.side} ${request.symbol} trigger=${request.triggerPrice} closePosition=${request.closePosition ?? false}`,
    );

    const response: BinanceAlgoOrderResponse = {
      algoId: at,
      clientAlgoId: request.clientOrderId ?? `dry-algo-${at}`,
      algoType: 'CONDITIONAL',
      orderType: request.type as BinanceOrderType,
      symbol: request.symbol,
      side: request.side,
      positionSide: 'BOTH',
      timeInForce: 'GTC',
      quantity: String(request.quantity ?? 0),
      algoStatus: 'NEW',
      triggerPrice: String(request.triggerPrice ?? 0),
      price: '0',
      closePosition: request.closePosition ?? false,
      reduceOnly: request.reduceOnly ?? false,
      workingType: request.workingType ?? 'MARK_PRICE',
      priceProtect: request.priceProtect ?? true,
      createTime: at,
      updateTime: at,
      triggerTime: 0,
    };
    return normalizeAlgo(response);
  }
}

/* -------------------------------------------------------------------------- */
/*  Normalisation                                                              */
/* -------------------------------------------------------------------------- */

const TERMINAL_ORDER_STATUSES: ReadonlySet<BinanceOrderStatus> = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

/** `TRIGGERED` is not terminal: the resulting order still has to fill. */
const TERMINAL_ALGO_STATUSES: ReadonlySet<BinanceAlgoStatus> = new Set([
  'FINISHED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

export function normalizeStandard(response: BinanceOrderResponse): PlacedOrder {
  const executed = Number(response.executedQty) || 0;
  const original = Number(response.origQty) || 0;
  /*
   * ⚠️ **「已经成交完」也是终态，即使 `status` 还写着 `NEW`。**
   *
   * 实测（一个真实成交的市价开仓单）：轮询拿到的是
   *
   *     {"status":"NEW","executedQty":"0.000","origQty":"0.009","avgPrice":"0.00"}
   *
   * 而**持仓那边确实出现了 0.009** —— 单子成交了，只是这一份轮询响应里
   * `status` 还是 `NEW`、`executedQty` 还是 0。原来的判断只看 `status`，
   * 于是 `waitForFill` 一直轮询到超时，返回一份"没有成交"的快照。
   *
   * 后果不是"显示不好看"：开仓路径拿到 `executedQty === 0` 之后用
   * `filled.executedQty || quantity` 回退成请求数量，**把一次未确认的成交
   * 记成了完全成交**，而 `status` 字段留下 `NEW` —— 账本与界面从此各说各话。
   *
   * 所以终态要按**事实**判断：成交数量已经等于原始数量，就是成了。
   * 容差用相对值而不是浮点相等（数量经交易所四舍五入，不保证位级相同）——
   * 与 `autoTrader` 里 `fullyExecuted` 的判据保持同一个口径。
   */
  const fullyExecuted = executed > 0 && original > 0 && executed >= original * (1 - 1e-9);
  return {
    kind: 'order',
    id: String(response.orderId),
    clientId: response.clientOrderId,
    symbol: response.symbol,
    side: response.side,
    type: response.type,
    status: response.status,
    avgPrice: Number(response.avgPrice) || 0,
    executedQty: executed,
    terminal: TERMINAL_ORDER_STATUSES.has(response.status) || fullyExecuted,
    raw: response,
  };
}

export function normalizeAlgo(response: BinanceAlgoOrderResponse): PlacedOrder {
  return {
    kind: 'algo',
    id: String(response.algoId),
    clientId: response.clientAlgoId,
    symbol: response.symbol,
    side: response.side,
    type: response.orderType,
    status: response.algoStatus,
    // An untriggered algo order has no fill; `actualPrice` appears once it fires.
    avgPrice: Number(response.actualPrice ?? 0) || 0,
    executedQty: Number(response.actualQty ?? 0) || 0,
    terminal: TERMINAL_ALGO_STATUSES.has(response.algoStatus),
    raw: response,
  };
}

export function isFilled(order: PlacedOrder): boolean {
  return order.executedQty > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从交易所那句"你这个杠杆不允许"里**挖出它自己承认的上限**。
 *
 * 三个错误码里只有 `-4209` 会明说数字：
 *
 * > Current symbol max leverage limit is **5x**
 *
 * 而 `-4203` / `-4205` 只给一句英文（"Change leverage failed" / 超出账户允许的
 * 最大杠杆），**括号里可能带数字也可能不带** —— 所以这里做的是"能挖到就挖，
 * 挖不到返回 `null`"，由调用方退回二分降级。
 *
 * 为什么值得挖：`leverageBracket` 只能给出 **symbol 那一层**的上界
 * （实测 BTC 150x、山寨 75x），而**账户级那一层它不反映**（子账户、开户未满
 * 30 天之类的限制都在那里）。所以那句报错是那个数字**唯一**的来源 ——
 * 拿到它就能一步到位，而不是盲降几次。
 */
export function parseAdmittedLeverage(message: string | undefined): number | null {
  if (!message) return null;
  /*
   * 匹配这几种说法：
   *
   *   · `... limit is 5x` / `... maximum is 20x` / `... allows 5x`   （-4209 等）
   *   · `... leverage greater than 5x`                              （**-4421 子账户限制**）
   *
   * ⚠️ `greater than` 这一支是 2026-10-02 补的：`-4421` 的原话是
   * 「Subaccounts are restricted from using leverage **greater than 5x**」——
   * 不加它就解析不出来，只能走"逐级折半"（20 → 10 → 5），
   * 多两次注定被拒的往返请求。**上限它自己都说了，就不该去猜。**
   *
   * 数字取 1–125（币安的上限区间），避免把消息里别的数字（比如 "30 days"）当成杠杆。
   */
  const match =
    /(?:limit is|maximum is|allows|max leverage(?: limit)? is|greater than)\s*(\d{1,3})\s*x/i.exec(
      message,
    );
  if (!match || !match[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 1 && value <= 125 ? value : null;
}

