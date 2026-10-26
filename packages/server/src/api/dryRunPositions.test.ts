/**
 * **模拟盘（`dry_run`）的持仓必须能在控制台里看见** —— 用户实测 ×2 的 BUG 回归测试。
 *
 * ## 症状（用户原话 + 线上截图）
 *
 * > ①「团队模式下 `/traders/11`，**当前持仓不显示实际持仓（实际已经有持仓）**」
 * > ②「和之前发现 BUG 一样，智能模式有持仓但是这里没有显示」
 *
 * `#11`（`ai_team`，徽章写着「模拟模式 —— 不会真的下单」）的卡片显示
 * **`持仓 0` + `保证金占用 0.00` + `当前无持仓`**，而**同一张卡里却写着
 * `浮动 +$0.32`（浮盈）** —— 浮盈不可能是 0 持仓。
 *
 * ## 根因（两条路由，同一个判断漏了）
 *
 * `GET /api/traders/:id/positions` 与 `GET /api/traders/:id/account` 都押在
 * `liveExchangeView()` 上，而它一律拿**交易所读数**当持仓来源。
 * 模拟盘的仓位在交易所**根本不存在**（它的成交是本地模拟的，从不真的下单 ——
 * `binance/broker.ts` 的 `if (this.dryRun) return this.simulateStandard(request)`），
 * 于是一律得到空数组：
 *
 * ```
 *   /positions → 200 []                       ← 用户看到的"没有持仓"
 *   /account   → positions: [] 而 ownUnrealizedPnl = +10   ← 同一张卡里的自相矛盾
 * ```
 *
 * ## 本文件钉住的四件事（缺一条修复就可能被"优化"回去）
 *
 * 1. **模拟盘 → 本地台账**（`positionsSource: 'local_mirror'`），且
 *    **持仓数 / 保证金占用 / 浮动盈亏三个数字同口径**（不再"0 持仓却有浮盈"）；
 * 2. **模拟盘短路发生在建连接之前** —— 交易所抖一下**不许**让它回 503：
 *    本地台账是它自己的真相，与交易所这一趟无关；
 * 3. **实盘行为一个字不变**：非纸面机器人仍然以**交易所**为准（`'exchange'`），
 *    即使本地台账里恰好有别的仓；
 * 4. **两条既有取舍保住**：机器人没在跑 → 返回本地台账；
 *    实盘读交易所失败 → **503**（不是拿本地镜像冒充 —— 那个取舍的原话是
 *    「一个会闪烁的表格比一个说"读不到"的表格更糟」）。
 *
 * ## 怎么让它不是恒真（负向校准）
 *
 * 把 `server.ts` 里 `isPaperTrader()` 的调用去掉（让它恒为 `false`，即回到修复前
 * 的行为）→ 本文件的"模拟盘"那组用例**必须变红**。校准的原始输出见任务报告。
 *
 * ## 为什么需要一个"假交易所连接"
 *
 * 第 2、3 条判据要求"交易所读成功但持仓为空"与"交易所读失败"两种情形 ——
 * 前者**正是这个 BUG 的形状**，而在测试里真去连交易所要网络、要凭据（本仓明令不许）。
 * 所以 `ApiDependencies.openReadOnlyConnection` 这个**只给测试用**的注入口是必需的：
 * 没有它，最容易错的那条分支永远测不到。
 *
 * 全程 `app.inject()`（不打网络、不起监听端口）、临时 sqlite、manager 是桩。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { defaultStrategyConfig } from '@aq/shared';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import { aiModels, exchanges, positions, strategies, traders, users } from '../store/repositories.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

const JWT_SECRET = 'dry-run-positions-test-secret-not-a-real-key';
/** 模拟盘那笔持仓（本地台账里的真相）。 */
const PAPER_SYMBOL = 'BTCUSDT';
const PAPER_ENTRY = 60_000;
const PAPER_QTY = 0.01;
const PAPER_MARGIN = 120;
/** 行情给的标记价 —— 比入场价高，于是浮盈为正（与用户截图同形）。 */
const MARK_PRICE = 61_000;
/** 交易所侧那条仓（用来证明**实盘**走的是交易所，而不是本地台账）。 */
const LIVE_SYMBOL = 'ETHUSDT';

let workDir: string;
let app: FastifyInstance;
let vault: Vault;
let token = '';
let traderId = 0;

/**
 * 交易所侧的**可控读数**。
 *
 * 用可变状态而不是"每个用例重建 app"：`buildServer()` 只跑一次，
 * 注入的连接工厂每次调用都读这两个对象 —— 于是同一套路由能覆盖全部分支。
 */
const exchange = {
  /** `getPositions()` 返回什么（模拟盘的真实情形是**空**）。 */
  positions: [] as Array<Record<string, unknown>>,
  /** `getOpenOrders()` 返回什么。 */
  openOrders: [] as Array<Record<string, unknown>>,
  /** 为真时建连接就抛错 —— 模拟"交易所读数失败"。 */
  fail: false,
};

/** 运行期事实（`dryRun` 不落库，它读的是运行中的那个实例）。 */
const runtime = {
  running: true,
  /** `null` = "它没在跑"（那份值此刻不存在）。 */
  dryRun: true as boolean | null,
};

/** 交易所读数里出现过的调用（用来证明"模拟盘没有碰交易所的持仓"）。 */
let exchangeCalls: string[] = [];

function fakeConnection(): ExchangeConnection {
  return {
    broker: {
      getAccountState: async () => {
        exchangeCalls.push('getAccountState');
        return { equity: 100, availableBalance: 95, marginUsed: 5, unrealizedPnl: 0, walletBalance: 100 };
      },
      getPositions: async () => {
        exchangeCalls.push('getPositions');
        return exchange.positions;
      },
      getOpenOrders: async () => {
        exchangeCalls.push('getOpenOrders');
        return exchange.openOrders;
      },
    },
    market: {
      premiumIndex: async () => [{ symbol: PAPER_SYMBOL, markPrice: String(MARK_PRICE) }],
    },
  } as unknown as ExchangeConnection;
}

function managerStub() {
  const impl: Record<string, unknown> = {
    isRunning: () => runtime.running,
    dryRunOf: () => runtime.dryRun,
    runningSince: () => new Map<number, number>(),
    runningIds: () => (runtime.running ? [traderId] : []),
    statusOf: () => (runtime.running ? 'running' : 'stopped'),
    nextCycleAtOf: () => null,
    failedTraders: () => [],
    leverageCap: () => null,
    readCircuitBreaker: () => null,
  };
  return new Proxy({} as never, {
    get(_t, prop): unknown {
      const known = impl[String(prop)];
      return known !== undefined ? known : () => ({ ok: true });
    },
  });
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-dryrun-positions-'));
  initDb(path.join(workDir, 'test.sqlite'));
  vault = new Vault(randomBytes(32));

  const dependencies = {
    vault,
    manager: managerStub(),
    jwtSecret: JWT_SECRET,
    publicConnection: fakeConnection(),
    balance: {
      get: async () => ({ ok: false, error: 'stub' }),
      getAll: async () => new Map(),
      invalidate: () => undefined,
      invalidateAll: () => undefined,
      walletBalanceOf: async () => null,
    },
    /*
     * ⚠️ **本文件存在的关键**：注入口让"交易所读成功、持仓为空"这条分支可达 ——
     * 它正是这个 BUG 的形状，而真去连交易所在测试里不可能。
     */
    openReadOnlyConnection: async () => {
      if (exchange.fail) throw new Error('测试：交易所连接失败');
      return fakeConnection();
    },
  } as unknown as ApiDependencies;
  app = await buildServer(dependencies);
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  exchange.positions = [];
  exchange.openOrders = [];
  exchange.fail = false;
  runtime.running = true;
  runtime.dryRun = true;
  exchangeCalls = [];

  initDb(path.join(workDir, 'test.sqlite')).exec(
    'DELETE FROM positions; DELETE FROM orders; DELETE FROM trades; DELETE FROM traders;' +
      ' DELETE FROM strategies; DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM users;',
  );

  const user = users.create('admin_dryrun_positions', hashPassword('irrelevant'), 'owner');
  token = signToken(
    {
      sub: user.id,
      username: user.username,
      role: 'owner',
      credAt: users.credentialsChangedAt(user.id) ?? 0,
    },
    JWT_SECRET,
  );

  const accountId = exchanges.create({
    exchange: 'binance',
    label: '夹具账户',
    apiKey: 'fixture-api-key',
    apiSecretEnc: vault.encrypt('fixture-api-secret'),
    testnet: true,
    canTrade: true,
  }).id;
  const modelId = aiModels.create({
    provider: 'deepseek',
    label: '夹具模型',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyEnc: vault.encrypt('fixture-llm-key'),
    temperature: 0.2,
    maxTokens: 1024,
    timeoutSeconds: 30,
    maxRetries: 0,
  }).id;
  const strategyId = strategies.create({
    name: '夹具策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  }).id;
  traderId = traders.create({
    name: '夹具机器人',
    exchangeAccountId: accountId,
    aiModelId: modelId,
    strategyId,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
  }).id;
  /* 落库的 `dry_run` 只作兜底（运行期事实优先）——先清干净，用例里按需设。 */
  traders.setDryRun(traderId, null);

  /* 本地台账里那笔**模拟盘持仓**：交易所侧没有它，而它才是这个机器人的真相。 */
  positions.insert({
    traderId,
    symbol: PAPER_SYMBOL,
    side: 'long',
    quantity: PAPER_QTY,
    entryPrice: PAPER_ENTRY,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: PAPER_MARGIN,
    stopLoss: 58_000,
    takeProfit: 66_000,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: '夹具：模拟盘持仓',
    status: 'open',
  });
});

interface Injected {
  statusCode: number;
  body: unknown;
}

async function get(url: string): Promise<Injected> {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  let body: unknown = null;
  try {
    body = response.json();
  } catch {
    body = { __unparsable: response.body.slice(0, 200) };
  }
  return { statusCode: response.statusCode, body };
}

const positionsUrl = () => `/api/traders/${traderId}/positions`;
const accountUrl = () => `/api/traders/${traderId}/account`;

function asArray(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `期望数组，实际是 ${JSON.stringify(value)}`);
  return value as Array<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/*  1) 模拟盘：持仓必须来自本地台账（这就是用户报的那个 BUG）                    */
/* -------------------------------------------------------------------------- */

describe('模拟盘（dry_run）：持仓以本地台账为准', () => {
  it('★★★ /positions 必须返回本地台账那笔仓 —— 而不是空数组', async () => {
    const result = await get(positionsUrl());

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const rows = asArray(result.body);
    assert.equal(
      rows.length,
      1,
      '★ 模拟盘机器人在 /positions 上丢了自己的持仓（修复前这里是 `[]`）：' +
        JSON.stringify(result.body),
    );
    assert.equal(rows[0]!.symbol, PAPER_SYMBOL);
    assert.equal(rows[0]!.side, 'long');
    assert.equal(rows[0]!.quantity, PAPER_QTY);
    assert.equal(rows[0]!.entryPrice, PAPER_ENTRY);
  });

  it('★★★ /account 必须给出本地台账持仓 + 可判定的来源标识（前端不再靠猜）', async () => {
    const result = await get(accountUrl());

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const body = result.body as Record<string, unknown>;
    assert.equal(
      body.positionsSource,
      'local_mirror',
      '★ 模拟盘的持仓来源必须是 local_mirror —— 前端据此区分"交易所真没仓"与"这是模拟仓"' +
        `（实际 ${JSON.stringify(body.positionsSource)}）`,
    );
    const rows = asArray(body.positions);
    assert.equal(rows.length, 1, `★ /account 的 positions 也必须是本地台账：${JSON.stringify(body)}`);
    assert.equal(rows[0]!.symbol, PAPER_SYMBOL);
  });

  it('★★★ 三个数字必须同口径：持仓数 1 / 保证金 120 / 浮盈 +10（不再"0 持仓却有浮盈"）', async () => {
    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;
    const rows = asArray(body.positions);

    /* 持仓数（前端 `positionCount: positions.length`）。 */
    assert.equal(rows.length, 1);
    /* 保证金占用（前端把 positions 的 marginUsed 求和 / 或读每行）。 */
    assert.equal(rows[0]!.marginUsed, PAPER_MARGIN);
    /* 浮动盈亏：同一个标记价算出来的 (+100 × 0.01 = +10)。 */
    assert.equal(rows[0]!.unrealizedPnl, 10);
    assert.equal(body.ownUnrealizedPnl, 10);

    /*
     * ⚠️ 用户报的那个矛盾本身：有浮盈就**必须**有持仓。
     *
     * 显式标成 `number` 是必需的：上面那条 `assert.equal(rows.length, 1)` 会把
     * `rows.length` 收窄成字面量类型 `1`，于是 `=== 0` 会被 tsc 判成"恒假"
     * （TS2367）—— 而这条断言要表达的正是"运行期不许出现 0 持仓 + 非零浮盈"。
     */
    const positionCount: number = rows.length;
    const ownPnl: number = Number(body.ownUnrealizedPnl);
    assert.ok(
      !(positionCount === 0 && ownPnl !== 0),
      '★ 出现"0 持仓却有浮盈"—— 那正是用户截图里的自相矛盾',
    );
  });

  it('★★ 模拟盘的挂单数来自本地 pending 行（交易所侧恒为空）', async () => {
    positions.insert({
      traderId,
      symbol: 'SOLUSDT',
      side: 'short',
      quantity: 1,
      entryPrice: 200,
      leverage: 5,
      liquidationPrice: null,
      marginUsed: 40,
      stopLoss: 220,
      takeProfit: 180,
      stopOrderId: null,
      tpOrderId: null,
      openReasoning: '夹具：模拟盘挂单',
      status: 'pending',
    });

    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;
    assert.equal(
      body.openOrderCount,
      1,
      `★ 模拟盘有一张待成交挂单，openOrderCount 却是 ${String(body.openOrderCount)}` +
        '（问交易所只会恒得 0 —— 与"0 持仓却有浮盈"同一族的矛盾）',
    );
    /* 挂单不是持仓：`positions` 只含 open 行。 */
    assert.equal(asArray(body.positions).length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/*  2) 模拟盘短路在"建连接之前"：交易所抖动不许让它变成 503                       */
/* -------------------------------------------------------------------------- */

describe('模拟盘：交易所读数失败也不影响它的持仓', () => {
  it('★★★ 交易所连接失败时，/positions 仍必须返回本地台账（而不是 503）', async () => {
    exchange.fail = true;

    const result = await get(positionsUrl());
    assert.equal(
      result.statusCode,
      200,
      '★ 模拟盘的持仓不需要交易所 —— 一次无关的网络故障不该让它变成"读不到"' +
        `（实际 ${result.statusCode} ${JSON.stringify(result.body)}）`,
    );
    const rows = asArray(result.body);
    assert.equal(rows.length, 1, JSON.stringify(result.body));
    assert.equal(rows[0]!.symbol, PAPER_SYMBOL);
  });

  it('★★★ 交易所连接失败时，模拟盘**不去问交易所的持仓**（短路在连接之前）', async () => {
    exchange.fail = true;

    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;

    assert.equal(result.statusCode, 200, JSON.stringify(body));
    assert.equal(body.positionsSource, 'local_mirror');
    assert.equal(asArray(body.positions).length, 1);
    assert.deepEqual(
      exchangeCalls.filter((c) => c === 'getPositions'),
      [],
      '★ 模拟盘不该调交易所的 getPositions —— 那里永远没有它的仓',
    );
    /*
     * ## 账户余额那一路：**不再问交易所**（2026-10-27 语义变更）
     *
     * 原来这里断言的是 `body.account === null`，理由写在上面那句注释里：
     * 「账户余额是账户级事实，仍然只能问交易所」。**那句话已经不成立了。**
     *
     * 用户明确要求：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的
     * 余额。也就是说，无需真实账户就能开启模拟盘机器人。」
     *
     * 所以模拟盘的账户读数现在由**本地台账**折算（`binance/paperWallet.ts`）：
     * ```
     *   walletBalance = 模拟起始余额 + 已实现净盈亏
     *   equity        = walletBalance + 浮盈
     * ```
     * 交易所连接失败与它**完全无关** —— 这比原来"失败就 null"更强：
     * 一个连不上交易所的模拟盘机器人，账户数字仍然是完整可用的。
     *
     * ⚠️ 断言的是"有值且来自本地"，不是"一定等于某个具体数"：
     * 具体数字由台账决定（起始余额、已实现盈亏、标记价），
     * 而这里要钉住的是**来源**。
     */
    assert.notEqual(body.account, null, '★ 模拟盘的账户读数必须来自本地台账，而不是交易所');
    const account = body.account as Record<string, number>;
    assert.ok(
      Number.isFinite(account.walletBalance),
      `★ 本地钱包必须给出 walletBalance（实际 ${JSON.stringify(body.account)}）`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  3) 实盘：一个字段都不变（仍以交易所为准）                                    */
/* -------------------------------------------------------------------------- */

describe('实盘（dry_run=0）：仍以交易所视图为准', () => {
  beforeEach(() => {
    runtime.dryRun = false;
    exchange.positions = [
      {
        symbol: LIVE_SYMBOL,
        side: 'short',
        quantity: 0.5,
        entryPrice: 3000,
        markPrice: 2990,
        leverage: 10,
        liquidationPrice: null,
        unrealizedPnl: 5,
        unrealizedPnlPercent: 3.33,
        marginUsed: 150,
        notional: 1495,
        marginType: 'cross',
      },
    ];
  });

  it('★★★ /positions 返回交易所那条仓（并**不是**本地台账那条）', async () => {
    const result = await get(positionsUrl());

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const rows = asArray(result.body);
    assert.equal(rows.length, 1, JSON.stringify(result.body));
    assert.equal(rows[0]!.symbol, LIVE_SYMBOL, '★ 实盘不能被本地台账顶替');
    assert.equal(rows[0]!.marginType, 'cross', '★ 实盘那条仓仍带交易所的保证金模式');
    assert.ok(
      !rows.some((r) => r.symbol === PAPER_SYMBOL),
      '★ 实盘路径不该把本地台账（那是别的机器人的模拟仓）混进来',
    );
  });

  it('★★★ /account 的来源标识必须是 exchange', async () => {
    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;

    assert.equal(body.positionsSource, 'exchange');
    assert.equal(asArray(body.positions)[0]!.symbol, LIVE_SYMBOL);
  });

  it('★★★ 交易所读数失败 → 503，**不拿本地镜像冒充**（既有取舍）', async () => {
    exchange.fail = true;

    const result = await get(positionsUrl());
    assert.equal(
      result.statusCode,
      503,
      '★ 实盘读不到交易所时回 503 是刻意的：一个会闪烁的表格比一个说"读不到"的表格更糟' +
        `（实际 ${result.statusCode} ${JSON.stringify(result.body)}）`,
    );

    const account = await get(accountUrl());
    const body = account.body as Record<string, unknown>;
    assert.equal(body.live, false);
    assert.equal(body.positionsSource, 'none', '★ 读不到时来源必须是 none，而不是伪装成本地台账');
    assert.deepEqual(asArray(body.positions), []);
  });
});

/* -------------------------------------------------------------------------- */
/*  4) 既有取舍：机器人没在跑 → 返回本地台账                                     */
/* -------------------------------------------------------------------------- */

describe('机器人没在跑：本地镜像是唯一的真相', () => {
  it('★ /positions 返回本地台账（浮盈是占位零 —— 这条按设计不读行情）', async () => {
    runtime.running = false;
    runtime.dryRun = null;

    const result = await get(positionsUrl());
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const rows = asArray(result.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.markPrice, PAPER_ENTRY, '★ 没有标记价时应回落到入场价（占位值）');
    assert.equal(rows[0]!.unrealizedPnl, 0);
    assert.equal(rows[0]!.marginUsed, PAPER_MARGIN, '★ 保证金占用仍是台账里的真实值');
  });

  it('★ /account 对"没在跑"给 none —— 前端据此不把它当实时读数', async () => {
    runtime.running = false;
    runtime.dryRun = null;

    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;
    assert.equal(body.live, false);
    assert.equal(body.positionsSource, 'none');
  });
});

/* -------------------------------------------------------------------------- */
/*  5) 判据的兜底：运行时读不到 dryRun 时，用落库的 `traders.dry_run`             */
/* -------------------------------------------------------------------------- */

describe('dryRun 判据的两级回落（运行期事实优先，落库值兜底）', () => {
  it('★★ 运行期读不到（null）而落库是 true → 仍按模拟盘处理', async () => {
    runtime.dryRun = null;
    traders.setDryRun(traderId, true);

    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;

    assert.equal(
      body.positionsSource,
      'local_mirror',
      '★ 一个没在跑（或读不到运行期 dryRun）的模拟盘机器人，其持仓同样只在本地 —— ' +
        '把它当实盘会让持仓再次变空',
    );
    assert.equal(asArray(body.positions).length, 1);
  });

  it('★★ 运行期读不到（null）而落库是 false → 按实盘处理（走交易所）', async () => {
    runtime.dryRun = null;
    traders.setDryRun(traderId, false);
    exchange.positions = [
      {
        symbol: LIVE_SYMBOL,
        side: 'long',
        quantity: 1,
        entryPrice: 100,
        markPrice: 101,
        leverage: 5,
        liquidationPrice: null,
        unrealizedPnl: 1,
        unrealizedPnlPercent: 5,
        marginUsed: 20,
        notional: 101,
      },
    ];

    const result = await get(accountUrl());
    const body = result.body as Record<string, unknown>;

    assert.equal(body.positionsSource, 'exchange');
    assert.equal(asArray(body.positions)[0]!.symbol, LIVE_SYMBOL);
  });
});

/* -------------------------------------------------------------------------- */
/*  4) 模拟盘的「保证金模式」必须显示出来（2026-10-18 用户截图指出）              */
/* -------------------------------------------------------------------------- */

describe('模拟盘：保证金模式从开仓单里取（不该恒为 —）', () => {
  /*
   * ## 这个用例防的是什么
   *
   * 用户截图指出：持仓页「保证金模式」一列**永远显示 `—`**。
   *
   * 根因：真实盘走 `liveExchangeView`，`marginType` 读自交易所的
   * `/fapi/v2/positionRisk`（实时值）；**而模拟盘走 `localPositionsFor`，
   * 它只读本地 `positions` 表 —— 那张表根本没有 `margin_type` 列**
   * （只有 `margin_used`），于是 `marginType` 恒为 `undefined`。
   *
   * 而模拟盘在交易所侧**本来就没有仓位**（实测 `#11` 用的账户「gaoshou3」
   * 在 `positionRisk` 里返回空），所以"实时读交易所"这条路对它永远读不到东西。
   *
   * ⇒ 正确来源是 `orders.margin_type` —— 开仓那一刻由服务端记下的值。
   */
  it('★★★ 模拟仓能显示全仓/逐仓（来自开仓单的 margin_type）', async () => {
    /*
     * 造一条带 `isolated` 的开仓单 —— 真实世界里它由 `recordOrder()` 在
     * `setMarginType` 成功之后写入。
     */
    /* 列名照真实 schema：`orders` 里是 `price` / `margin_used` / `margin_type`，
     * **没有** `leverage`（杠杆在 `positions` 表上）。 */
    const at = new Date().toISOString();
    getDb().run(
      `INSERT INTO orders
         (trader_id, exchange_order_id, client_order_id, symbol, side, type,
          purpose, status, quantity, price, margin_used, margin_type,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'BUY', 'MARKET', 'entry', 'FILLED', ?, ?, ?, 'isolated', ?, ?)`,
      traderId,
      `paper-ex-${Date.now()}`,
      `paper-cl-${Date.now()}`,
      PAPER_SYMBOL,
      PAPER_QTY,
      PAPER_ENTRY,
      PAPER_MARGIN,
      at,
      at,
    );

    const result = await get(positionsUrl());
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const rows = asArray(result.body);
    assert.equal(rows.length, 1, JSON.stringify(result.body));
    assert.equal(
      rows[0]!.marginType,
      'isolated',
      '★ 模拟盘的保证金模式必须显示出来（来源是开仓单的 margin_type）；' +
        `实际 ${JSON.stringify(rows[0]!.marginType)} —— 这一格恒为 undefined 时界面只能是 —`,
    );
  });

  it('★★ 没有开仓单时仍显示 —（绝不猜成 cross）', async () => {
    /* 表里没有任何带 margin_type 的订单 ⇒ 应当保持 undefined，不编造。 */
    const result = await get(positionsUrl());
    const rows = asArray(result.body);
    assert.equal(
      rows[0]!.marginType,
      undefined,
      '★ 认不出就必须是「不知道」—— 编一个 cross 会让用户以为仓位是全仓',
    );
  });
});