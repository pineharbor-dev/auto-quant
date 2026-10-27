/**
 * **模拟盘起始余额的校验必须真的生效**（2026-10-27）。
 *
 * ## 这个文件钉住的是一个「写了但没接线」的缺陷
 *
 * `binance/paperWallet.ts` 里有一个 `validateStartingBalance()`，注释写得很清楚：
 * 拒绝 0 / 负数 / NaN / 过小 / 过大。但**它只被自己的单元测试调用过** ——
 * 生产代码里没有任何一处调用它。
 *
 * 于是实测形态（直接打 API）：
 *
 * ```
 *   POST /api/traders {"paperStartingBalance": 0}              → 200  ← 应当被拒
 *   POST /api/traders {"paperStartingBalance": 999999999999}   → 200  ← 应当被拒
 * ```
 *
 * 而这两个值都会**静默造成故障**：
 *
 *   · `0`     → 本地钱包余额 0，每一笔开仓都被「保证金不足」拒掉。
 *               界面表现是「机器人 running、每轮成功、但从不交易」——
 *               本仓反复记录的那类静默失能。
 *   · `1e12`  → 手滑多按几个 0。之后所有收益率都变成无限接近 0 的百分比，
 *               而界面上**看不出任何异常**。
 *
 * ## 为什么 0 必须被拒（而不是静默回落到默认值）
 *
 * 早期实现把 0 当成「没填」，回落到 `initial_equity` 再回落到 1000。
 * 结果：操作员填 0（意思明确是「我就要 0 本金」），系统给了 1000 并**按 1000 开仓**，
 * 而他填的那个数字在界面上再也找不到 —— **界面说了假话**。
 * 显式传了就必须校验；省略才是「用默认值」。
 *
 * ## 负向校准
 *
 * 去掉 `server.ts` 里那两处 `validateStartingBalance` 调用 → 本文件必须变红。
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
import { closeDb, initDb } from '../db/index.js';
import { aiModels, strategies, traders, users } from '../store/repositories.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

const JWT_SECRET = 'paper-balance-validation-test-secret-not-real';

let workDir: string;
let app: FastifyInstance;
let token = '';
let modelId = 0;
let strategyId = 0;

function fakeConnection(): ExchangeConnection {
  return {
    broker: {
      getAccountState: async () => ({
        equity: 1000,
        availableBalance: 1000,
        marginUsed: 0,
        unrealizedPnl: 0,
        walletBalance: 1000,
      }),
      getPositions: async () => [],
      getOpenOrders: async () => [],
    },
    market: { premiumIndex: async () => [] },
  } as unknown as ExchangeConnection;
}

function managerStub() {
  const impl: Record<string, unknown> = {
    isRunning: () => false,
    dryRunOf: () => true,
    runningSince: () => new Map<number, number>(),
    runningIds: () => [],
    statusOf: () => 'stopped',
    nextCycleAtOf: () => null,
    failedTraders: () => [],
    leverageCap: () => null,
    readCircuitBreaker: () => null,
    /* 详情/账户端点会问这个（模拟盘本金），给一个确定值便于断言。 */
    paperStartingBalanceOf: () => 1000,
  };
  return new Proxy({} as never, {
    get(_t, prop): unknown {
      const known = impl[String(prop)];
      return known !== undefined ? known : () => ({ ok: true });
    },
  });
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-paper-balance-'));
  initDb(path.join(workDir, 'test.sqlite'));
  const vault = new Vault(randomBytes(32));

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
    openReadOnlyConnection: async () => fakeConnection(),
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
  initDb(path.join(workDir, 'test.sqlite')).exec(
    'DELETE FROM positions; DELETE FROM orders; DELETE FROM trades; DELETE FROM traders;' +
      ' DELETE FROM strategies; DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM users;',
  );

  const user = users.create('admin_paper_balance', hashPassword('irrelevant'), 'owner');
  token = signToken(
    {
      sub: user.id,
      username: user.username,
      role: 'owner',
      credAt: users.credentialsChangedAt(user.id) ?? 0,
    },
    JWT_SECRET,
  );

  modelId = aiModels.create({
    provider: 'deepseek',
    label: '夹具模型',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyEnc: new Vault(randomBytes(32)).encrypt('fixture-llm-key'),
    temperature: 0.2,
    maxTokens: 1024,
    timeoutSeconds: 30,
    maxRetries: 0,
  }).id;
  strategyId = strategies.create({
    name: '夹具策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  }).id;
});

interface Injected {
  statusCode: number;
  body: unknown;
}

async function post(url: string, payload: unknown): Promise<Injected> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  let body: unknown = null;
  try {
    body = response.json();
  } catch {
    body = { __unparsable: response.body.slice(0, 200) };
  }
  return { statusCode: response.statusCode, body };
}

async function patch(url: string, payload: unknown): Promise<Injected> {
  const response = await app.inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  let body: unknown = null;
  try {
    body = response.json();
  } catch {
    body = { __unparsable: response.body.slice(0, 200) };
  }
  return { statusCode: response.statusCode, body };
}

/** 创建一个纯模拟盘机器人（不绑交易所账户）的请求体。 */
function paperTraderBody(paperStartingBalance?: number) {
  return {
    name: '夹具模拟盘',
    aiModelId: modelId,
    strategyId,
    cycleIntervalMinutes: 15,
    ...(paperStartingBalance === undefined ? {} : { paperStartingBalance }),
  };
}

/* -------------------------------------------------------------------------- */
/*  1) 创建：非法余额必须被拒                                                   */
/* -------------------------------------------------------------------------- */

describe('创建机器人：模拟盘起始余额的边界', () => {
  it('★★★ 显式传 0 → 拒绝（不能静默回落到默认值）', async () => {
    const result = await post('/api/traders', paperTraderBody(0));

    assert.equal(
      result.statusCode,
      400,
      `★ 0 余额必须被拒 —— 否则它会静默回落到默认值，` +
        `而操作员填的数字在界面上再也找不到（实际 ${result.statusCode} ${JSON.stringify(result.body)}）`,
    );
    assert.match(String((result.body as { error?: string }).error ?? ''), /余额/);
  });

  it('★★★ 过小（低于最小下单量）→ 拒绝，且原因带具体下限', async () => {
    const result = await post('/api/traders', paperTraderBody(5));

    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.match(
      String((result.body as { error?: string }).error ?? ''),
      /10/,
      '原因里必须写明下限（操作员才知道该改成多少）',
    );
  });

  it('★★★ 过大（手滑多按几个 0）→ 拒绝', async () => {
    const result = await post('/api/traders', paperTraderBody(999_999_999_999));

    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
  });

  it('★★★ 负数 → 拒绝（zod 这一层就该挡住）', async () => {
    const result = await post('/api/traders', paperTraderBody(-100));
    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
  });

  it('★ 合法余额（含边界值）→ 接受', async () => {
    for (const value of [10, 1000, 1_000_000_000]) {
      const result = await post('/api/traders', paperTraderBody(value));
      assert.equal(
        result.statusCode,
        200,
        `${value} 应当被接受（实际 ${result.statusCode} ${JSON.stringify(result.body)}）`,
      );
      const created = result.body as { paperStartingBalance: number };
      assert.equal(created.paperStartingBalance, value, '★ 填多少就该存多少');
    }
  });

  it('★ 省略余额 → 接受（省略 = 用默认值，与"显式填 0"不是一回事）', async () => {
    const result = await post('/api/traders', paperTraderBody());
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  });
});

/* -------------------------------------------------------------------------- */
/*  2) 编辑：同一条约束在 PATCH 上也必须成立                                    */
/* -------------------------------------------------------------------------- */

describe('编辑机器人：模拟盘起始余额的边界', () => {
  async function createPaperTrader(): Promise<number> {
    const result = await post('/api/traders', paperTraderBody(1000));
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    return (result.body as { id: number }).id;
  }

  it('★★★ PATCH 传非法余额 → 拒绝（两条路的约束必须一致）', async () => {
    const id = await createPaperTrader();

    for (const value of [0, 5, 999_999_999_999]) {
      const result = await patch(`/api/traders/${id}`, { paperStartingBalance: value });
      assert.equal(
        result.statusCode,
        400,
        `★ PATCH ${value} 必须被拒 —— 创建路径拒了而编辑路径没拒，` +
          `等于这个约束可以直接调 API 绕过（实际 ${result.statusCode} ${JSON.stringify(result.body)}）`,
      );
    }
  });

  it('★ PATCH 合法余额 → 接受，并真的落库', async () => {
    const id = await createPaperTrader();
    const result = await patch(`/api/traders/${id}`, { paperStartingBalance: 2500 });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(traders.get(id)?.paperStartingBalance, 2500, '★ 改完必须是新值');
  });
});
