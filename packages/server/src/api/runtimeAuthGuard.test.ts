/**
 * **运行时鉴权回归测试** —— 未认证请求打敏感端点必须 401，且**零副作用**。
 *
 * ## 为什么需要它（台账 `SEC-03`）
 *
 * `routeAuthGuard.test.ts` 是**静态**判据：它读 `server.ts` 的源码，断言每条路由
 * 附近出现了 `authed`。那条守卫能抓"新增路由忘了写 `authed`"，但抓不住
 * **注册参数写错、中间件改名、装错实例** —— 也就是本仓反复出现的「接线类」缺陷。
 * 源码里写着 `authed`，而运行时那条路由实际没挂上，静态判据一样是绿的。
 *
 * 本文件补的就是那一层：**真的建一个 Fastify 应用、真的发请求**，看它回什么。
 *
 * ## 三条判据（缺一条这个文件就是空转）
 *
 * 1. **状态码**：不带令牌 / 伪造令牌 / 用别的密钥签的令牌 / 已过期令牌 /
 *    已撤销令牌 → **一律 401**。
 * 2. **零副作用**：`deps.manager` 是 `Proxy`，**任何一次方法访问与调用都被记账**。
 *    断言「该端点对应的副作用没有被触发」—— 而不是只看状态码。
 * 3. **接线证明（不是恒真式）**：光有 401 证明不了 handler 里有副作用，所以
 *    另有一组**带有效令牌**的用例，断言"请求真的走到了业务层，且那个副作用
 *    在记账里出现了"。两组一起才排除了"handler 里其实什么都没有"这种恒真。
 *
 * 最后还有一条**登记表完整性**扫描：`server.ts` 里每条 `/api/**` 写端点都必须在
 * `SENSITIVE_ENDPOINTS` 里出现，或明确列在 `INTENTIONALLY_EXCLUDED`（附理由）。
 * 新加一条写端点而忘了登记 → 这条会红。
 *
 * ## 负向校准（怎么证明它不是恒真）
 *
 * 把 `server.ts` 的 `const authed = { preHandler: … }` 改成 `= {}`（模拟
 * "中间件接错/摘掉"）后，本文件的 401 用例**必须变红**；
 * 详见任务报告的校准输出。若改坏了它还是绿的，就说明这里在空转。
 *
 * ## 不落真单
 *
 * 全程 `app.inject()`（不打网络、不起监听端口）；`manager` 是桩，
 * `deps.vault` 只对测试自己生成的密文解密；`beforeEach` 每次重建夹具。
 * 夹具里**没有**写入任何真实凭据 —— `exchange_accounts.api_secret_enc` 存的是
 * 这个测试自己 `vault.encrypt()` 出来的密文。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { defaultStrategyConfig } from '@aq/shared';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { aiModels, exchanges, strategies, traders, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

const JWT_SECRET = 'runtime-auth-test-secret-not-a-real-key';
/** 攻击者自己那把密钥 —— 用它签的令牌必须被拒。 */
const ATTACKER_SECRET = 'attacker-controlled-secret-not-a-real-key';
const OWNER = 'admin_runtime_auth';
const PASSWORD_HASH = hashPassword('irrelevant-for-this-test');

let workDir: string;
let app: FastifyInstance;
let vault: Vault;

/** 夹具 id（`beforeEach` 里重建）。 */
let traderId = 0;
let strategyId = 0;
let accountId = 0;
let modelId = 0;
let validToken = '';

/**
 * **副作用记账** —— 本文件的核心探针。
 *
 * `deps.manager` 被一个 `Proxy` 包住：任何属性**访问**都进 `read`，任何方法**调用**
 * 都进 `calls`。于是「这个端点有没有碰到交易层」不再依赖读代码，而是可断言的。
 *
 * 用它而不是"逐个方法换 spy"：**逐个列会漏**（新方法/新调用点不需要改这里），
 * 而 Proxy 是"默认记账"—— 漏报的方向反过来，正是我们要的方向。
 */
interface ManagerLedger {
  calls: string[];
  read: string[];
}

function emptyLedger(): ManagerLedger {
  return { calls: [], read: [] };
}

let ledger: ManagerLedger = emptyLedger();

/**
 * 造一个**会记账的** manager 桩。
 *
 * 已知成员返回真实形状（这样"带有效令牌"的用例能跑到 handler 深处，
 * 而不是在中间层以一条 TypeError 的 500 结束 —— 那会让本文件以错误的方式变绿）；
 * 未知成员返回一个记账并返回 `{ ok: true }` 的函数，从而**不因未实现而失败**。
 */
function managerStub(): TraderManager {
  const impl: Record<string, unknown> = {
    // 只读成员（`/api/health`、`/api/system`、`/api/traders` 会读）
    runningSince: () => new Map<number, number>(),
    runningIds: () => [] as number[],
    statusOf: () => 'stopped',
    nextCycleAtOf: () => null,
    isRunning: () => false,
    failedTraders: () => [],
    dryRunOf: () => null,
    leverageCap: () => null,
    readCircuitBreaker: () => null,
    // 副作用成员
    startTraderAsync: () => ({ ok: true as const, preflight: [] }),
    stopTrader: async () => undefined,
    closeAllPositions: async () => ({ closed: [], cancelledPending: 0, failed: [], stillRunning: false }),
    closePosition: async () => ({ avgPrice: 0, fee: 0, stillRunning: false }),
    runCycleNow: async () => 'stub-cycle',
    requestAgentReview: () => ({ accepted: true, note: 'stub' }),
    reconcileTrader: async () => ({ recovered: 0, corrected: 0 }),
  };

  return new Proxy({} as TraderManager, {
    get(_target, prop): unknown {
      const name = String(prop);
      ledger.read.push(name);
      const known = impl[name];
      if (known !== undefined) {
        return (...args: unknown[]) => {
          ledger.calls.push(name);
          return (known as (...a: unknown[]) => unknown)(...args);
        };
      }
      /* 未知成员：记账后返回一个良性函数 —— 见 `managerStub` 的说明。 */
      return (..._args: unknown[]) => {
        ledger.calls.push(name);
        return { ok: true };
      };
    },
  });
}

/**
 * 造一个够用的 balance 桩。
 *
 * ⚠️ **不能留空对象**：`PATCH /api/exchange-accounts/:id` 在改完之后会调
 * `deps.balance.invalidate(id)` 并紧接着读 `deps.balance.getAll()`（列表端点）。
 * 桩里缺一个成员，请求就会以 `{"error":"deps.balance.invalidate is not a function"}`
 * 的 **400** 结束 —— 而不是以断言失败告诉我们行为变了。
 * 那种失败会让"接线证明"的用例以**看不出原因**的方式变红。
 */
function balanceStub(): BalanceService {
  return {
    get: async () => ({ ok: false as const, error: 'stub' }),
    getAll: async () => new Map(),
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    walletBalanceOf: async () => null,
  } as unknown as BalanceService;
}

/* -------------------------------------------------------------------------- */
/*  敏感端点登记表                                                             */
/* -------------------------------------------------------------------------- */

interface SensitiveEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 带占位符的**真实**路径（用来与 `server.ts` 的路由表对账）。 */
  route: string;
  /** 实际请求的路径（占位符换成夹具 id）。 */
  url: string;
  payload?: Record<string, unknown>;
  /**
   * 这条端点**在带有效令牌时应当在 `manager` 上留下的调用名**。
   *
   * 它不是文档：`接线证明` 那组用例会**逐条断言它真的出现**，并断言它对应的端点
   * 在**未认证**时一次都不出现。于是这张表有了两个方向的力量：
   *   · 写错（断言一个不会发生的调用）→ 带令牌的用例红；
   *   · 该登记的端点漏登记 → `登记表完整性` 用例红。
   *
   * 不走 `manager` 的端点（策略/凭据/模型/账户）**不写这个字段** ——
   * 它们的接线证明是"带令牌时库里真的变了"（见下面的用例）。
   */
  expectsManagerCall?: string;
  /** 为什么它是敏感的（一句话）。 */
  why: string;
}

/**
 * **本文件覆盖的敏感端点**。
 *
 * 判据：能让资金/交易/凭据状态发生变化的端点。清单来自
 * `接口安全审计.md §4`（危险端点清单）与台账 `SEC-02`/`SEC-03`。
 */
function sensitiveEndpoints(): SensitiveEndpoint[] {
  return [
    {
      method: 'POST',
      route: '/api/traders/:id/start',
      url: `/api/traders/${traderId}/start`,
      /**
       * ⚠️ **`dryRun: false` 是刻意的**：这条路由的默认值是 `?? true`（默认纸面），
       * 所以只有显式传 false 才是"真实资金"那条路径 —— 未认证必须 401 且
       * **绝不能**触达 `startTraderAsync`。台账 `RED-01`：不得把 `?? true`
       * 改成 `?? false`，那条方向反转会让"误调用即实盘"。
       */
      payload: { dryRun: false },
      expectsManagerCall: 'startTraderAsync',
      why: '可以让机器人以**实盘**模式启动（真实资金下单）',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/stop',
      url: `/api/traders/${traderId}/stop`,
      expectsManagerCall: 'stopTrader',
      why: '改变机器人运行状态',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/positions/close-all',
      url: `/api/traders/${traderId}/positions/close-all`,
      expectsManagerCall: 'closeAllPositions',
      why: '**真实市价平掉全部持仓 + 撤全部挂单**',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/positions/:symbol/close',
      url: `/api/traders/${traderId}/positions/BTCUSDT/close`,
      expectsManagerCall: 'closePosition',
      why: '真实市价平掉单标的持仓',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/run-once',
      url: `/api/traders/${traderId}/run-once`,
      expectsManagerCall: 'runCycleNow',
      why: '立即跑一轮完整决策（可能真实开仓）',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/jev-options/:key',
      url: `/api/traders/${traderId}/jev-options/min_confidence`,
      payload: { value: '0' },
      /*
       * ⚠️ **不走 `manager`**（所以没有 `expectsManagerCall`）——
       * 它写 `settings` 表，改的是 JEV 模式下一轮的判断门槛。
       *
       * 为什么敏感：把 `min_confidence` 设成 0 会让**所有** Jev 判断都被执行
       *（包括 50:50 的平局）；把 `risk_percent` 设成 5 会让单笔风险放大 5 倍。
       * 能把这种东西拨来拨去的端点，未认证时必须 401 且零副作用。
       */
      why: '改 JEV 模式的风险参数（置信门槛、单笔风险比例等）—— 会立刻改变交易行为',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/jev-presets/:presetId',
      url: `/api/traders/${traderId}/jev-presets/balanced`,
      /*
       * ⚠️ **不走 `manager`**（所以没有 `expectsManagerCall`）—— 它一次写 20+ 条
       * `settings`，把整组 JEV 参数换成预设值。
       *
       * 为什么敏感：`balanced` 预设会把 `risk_percent` / `max_positions` /
       * `max_margin_usage` 一起改掉 —— 那是**一次调用就改变整个风险特征**。
       * 未认证时必须 401 且零副作用。
       */
      why: '一键套用 JEV 参数预设 —— 一次改写 20+ 个风险参数，会立刻改变交易行为',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/control/:key',
      url: `/api/traders/${traderId}/control/jev_prefilter`,
      payload: { on: false },
      /*
       * ⚠️ **不走 `manager`**（所以没有 `expectsManagerCall`）——
       * 它直接写 `settings` 表，改的是"下一轮决策怎么跑"。
       *
       * 但它**确实是敏感的**：关掉 Jev 会让整个团队不再调用那个模型，
       * 进而改变每轮的标的范围与耗时。能把这种开关拨来拨去的端点，
       * 未认证时必须 401 且零副作用。
       */
      why: '改运行期开关（例如关掉 Jev 初筛）—— 会立刻改变整个团队下一轮的调用行为',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/reconcile',
      url: `/api/traders/${traderId}/reconcile`,
      expectsManagerCall: 'reconcileTrader',
      why: '重建账本（改本地记录）',
    },
    {
      method: 'POST',
      route: '/api/traders/:id/agent-review',
      url: `/api/traders/${traderId}/agent-review`,
      expectsManagerCall: 'requestAgentReview',
      why: '真实模型调用 + 可能改参数',
    },
    {
      method: 'DELETE',
      route: '/api/traders/:id',
      url: `/api/traders/${traderId}`,
      expectsManagerCall: 'stopTrader',
      why: '停止并删除机器人',
    },
    {
      method: 'PATCH',
      route: '/api/strategies/:id',
      url: `/api/strategies/${strategyId}`,
      payload: { name: '被改过的策略名' },
      why: '改策略参数（运行中的机器人下一轮生效）',
    },
    {
      method: 'PATCH',
      route: '/api/traders/:id',
      url: `/api/traders/${traderId}`,
      payload: { name: '被改过的机器人名' },
      why: '改机器人配置（周期、模式等）',
    },
    {
      method: 'POST',
      route: '/api/strategies',
      url: '/api/strategies',
      payload: { name: '未认证建的策略', config: defaultStrategyConfig() },
      why: '新建策略（未认证者可往库里塞配置）',
    },
    {
      method: 'PATCH',
      route: '/api/ai-models/:id',
      url: `/api/ai-models/${modelId}`,
      payload: { label: '被改过的模型名' },
      why: '改模型配置（可换 provider/baseUrl —— 出站目标随之改变）',
    },
    {
      method: 'PATCH',
      route: '/api/auth/account',
      url: '/api/auth/account',
      payload: { currentPassword: 'x', newPassword: 'yyyyyyyy' },
      why: '改控制台凭据（接管控制台）',
    },
    {
      method: 'POST',
      route: '/api/auth/password',
      url: '/api/auth/password',
      payload: { currentPassword: 'x', newPassword: 'yyyyyyyy' },
      why: '同上的旧前端别名',
    },
    {
      method: 'PATCH',
      route: '/api/exchange-accounts/:id',
      url: `/api/exchange-accounts/${accountId}`,
      payload: { testnet: false },
      why: '可把凭据切成实盘（`testnet: false`）或换密钥',
    },
  ];
}

/**
 * `SENSITIVE_ENDPOINTS` **有意不覆盖**的写端点 —— 每条都要写明理由。
 *
 * 这张表的作用是让"漏登记"变红，而不是让人随手把新端点塞进来消掉红。
 */
const INTENTIONALLY_EXCLUDED: ReadonlyMap<string, string> = new Map([
  ['POST /api/auth/register', '恒回 410（不写库、不鉴权不适用）—— 见 server.ts:788'],
  ['POST /api/auth/login', '登录本身：没有令牌可用；安全性由失败节流承担（authFlow.test.ts 已覆盖）'],
  ['POST /api/traders/:id/selfcheck', '只写 runtime_logs（无交易副作用）；不在台账 SEC-03 的验收清单里'],
  ['DELETE /api/ai-models/:id', '删模型配置；不在台账 SEC-03 的验收清单里'],
  ['DELETE /api/strategies/:id', '删策略配置；同上'],
  ['DELETE /api/exchange-accounts/:id', '删凭据；同上'],
  ['POST /api/ai-models', '新建模型（写库 + 出站探测）；同上'],
  ['POST /api/ai-models/:id/set-default', '写一个 settings 键；同上'],
  ['POST /api/ai-models/:id/test', '真实出网探测；同上'],
  ['POST /api/ai-models/test-draft', '真实出网探测；同上'],
  ['POST /api/ai-models/discover', '真实出网探测；同上'],
  ['POST /api/strategies/:id/check', '真实模型调用（计费）；同上'],
  ['POST /api/exchange-accounts', '新建凭据（写库）；同上'],
  ['POST /api/exchange-accounts/:id/test', '真实出网探测；同上'],
  ['POST /api/exchange-accounts/test-draft', '真实出网探测；同上'],
  ['POST /api/traders', '新建机器人（不启动）；同上'],
]);

/* -------------------------------------------------------------------------- */
/*  夹具                                                                       */
/* -------------------------------------------------------------------------- */

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-runtime-auth-'));
  initDb(path.join(workDir, 'test.sqlite'));

  vault = new Vault(randomBytes(32));
  const dependencies: ApiDependencies = {
    vault,
    manager: managerStub(),
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: balanceStub(),
  };
  app = await buildServer(dependencies);
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 每次重建夹具。
 *
 * ⚠️ **必须写真的行**（而不是"反正 401 就不会读到"）：这些 id 会被放进 URL，
 * 而本文件的接线证明用例要求请求能真的走到 handler 深处 —— 一个不存在的 id
 * 会在业务层以 404 结束，于是"走到了业务层"这件事就没被证到。
 */
beforeEach(() => {
  ledger = emptyLedger();
  initDb(path.join(workDir, 'test.sqlite')).exec(
    'DELETE FROM positions; DELETE FROM orders; DELETE FROM trades; DELETE FROM traders;' +
      ' DELETE FROM strategies; DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM users;',
  );

  const user = users.create(OWNER, PASSWORD_HASH, 'owner');
  validToken = signToken(
    {
      sub: user.id,
      username: user.username,
      role: 'owner',
      credAt: users.credentialsChangedAt(user.id) ?? 0,
    },
    JWT_SECRET,
  );

  accountId = exchanges.create({
    exchange: 'binance',
    label: '夹具账户',
    apiKey: 'fixture-api-key',
    apiSecretEnc: vault.encrypt('fixture-api-secret'),
    testnet: true,
    canTrade: true,
  }).id;

  modelId = aiModels.create({
    provider: 'deepseek',
    label: '夹具模型',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyEnc: vault.encryptOptional('fixture-llm-key'),
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

  traderId = traders.create({
    name: '夹具机器人',
    exchangeAccountId: accountId,
    aiModelId: modelId,
    strategyId,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
  }).id;
});

/* -------------------------------------------------------------------------- */
/*  辅助                                                                       */
/* -------------------------------------------------------------------------- */

interface Injected {
  statusCode: number;
  body: Record<string, unknown>;
}

async function inject(
  method: string,
  url: string,
  options: { token?: string | null; payload?: Record<string, unknown>; rawToken?: string } = {},
): Promise<Injected> {
  const token = options.rawToken ?? options.token ?? null;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await app.inject({
    method: method as 'GET',
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = response.json() as Record<string, unknown>;
  } catch {
    body = { __unparsable: response.body.slice(0, 200) };
  }
  return { statusCode: response.statusCode, body };
}

/** 该端点对应的副作用名 —— 由登记表的 `trigger` 决定（见 `assertZeroSideEffects`）。 */
function assertNoManagerCalls(context: string): void {
  assert.deepEqual(
    ledger.calls,
    [],
    `${context}：未认证请求**触达了业务层/交易层** —— 记账到的调用：${ledger.calls.join('、')}`,
  );
}

/** 一个用别的密钥签的令牌（签名不合法）。 */
function forgedToken(): string {
  return signToken(
    { sub: 1, username: 'attacker', role: 'owner', credAt: 0 },
    ATTACKER_SECRET,
  );
}

/** 一个已过期但签名合法的令牌。 */
function expiredToken(): string {
  return signToken({ sub: 1, username: OWNER, role: 'owner', credAt: 0 }, JWT_SECRET, -60);
}

/**
 * 改过凭据之后，此前签发的合法令牌必须立刻失效。
 *
 * ⚠️ **先真的盖一次"凭据变更"时间戳**再签 `credAt: 0` 的令牌 —— 否则在
 * "从未改过凭据"的库上（`credentials_changed_at` 为空 → 判定基准也是 0），
 * 这张令牌恰恰是**有效**的，用例名与行为就对不上了。
 *
 * ⚠️ **这个函数读取数据库**，所以它只能在 `beforeEach` 之后调用 ——
 * 在 `describe` 体里调用会拿到一个"还没有用户"的库（实测就是
 * `Cannot read properties of undefined (reading 'id')`）。
 * 因此令牌在**用例内部**按需生成，而不是在收集阶段预先算好。
 */
function revokedToken(): string {
  const user = users.findByUsername(OWNER)!;
  users.markCredentialsChanged(user.id);
  return signToken(
    { sub: user.id, username: user.username, role: 'owner', credAt: 0 },
    JWT_SECRET,
  );
}

/* -------------------------------------------------------------------------- */
/*  1) 未认证 / 非法令牌 → 401 且零副作用                                       */
/* -------------------------------------------------------------------------- */

describe('未认证请求打敏感端点：一律 401 且零副作用', () => {
  /*
   * 四种"未认证"的形态，每种都要单独跑一遍。
   *
   * ⚠️ 令牌**在用例体里生成**（不是在这里预先算好）：只有"已撤销"那一种要读库，
   * 而收集阶段还没有任何夹具 —— 那时生成会抛错，把整组用例变成红。
   * ⚠️ 形态**直接写成 inject 的参数**（而不是一个 token 字段再加分支）：
   * 分支写进用例就得靠 `in` 判断，而那正是"看着覆盖了、实际没传对"的位置。
   */
  const anonymous: Array<{
    name: string;
    auth: () => { token?: null; rawToken?: string };
  }> = [
    { name: '不带 Authorization 头', auth: () => ({ token: null }) },
    { name: '带但不合法（伪造签名）', auth: () => ({ rawToken: forgedToken() }) },
    { name: '已过期但签名合法', auth: () => ({ rawToken: expiredToken() }) },
    { name: '凭据变更后已撤销', auth: () => ({ rawToken: revokedToken() }) },
  ];

  for (const variant of anonymous) {
    it(`【${variant.name}】每个敏感端点都必须 401，且不触达 manager`, async () => {
      const auth = variant.auth();
      for (const endpoint of sensitiveEndpoints()) {
        const before = ledger.calls.length;
        const result = await inject(endpoint.method, endpoint.url, {
          ...auth,
          ...(endpoint.payload ? { payload: endpoint.payload } : {}),
        });

        assert.equal(
          result.statusCode,
          401,
          `${variant.name} → ${endpoint.method} ${endpoint.url} 期望 401（${endpoint.why}），` +
            `实际 ${result.statusCode} ${JSON.stringify(result.body).slice(0, 200)}`,
        );
        // 零副作用：不是"看状态码猜"，而是**记账为空**。
        assert.deepEqual(
          ledger.calls.slice(before),
          [],
          `${variant.name} → ${endpoint.method} ${endpoint.url} 触达了 manager：` +
            `${ledger.calls.slice(before).join('、')}`,
        );
      }
      /*
       * 再收一次全局口：跑完这一整轮，manager 的一次调用都不该出现过。
       * （上面的逐条断言能指出是哪一条，这条防的是"断言写漏一个端点"。）
       */
      assertNoManagerCalls(`${variant.name} 的全部敏感端点`);
    });
  }

  it('未认证时，策略与凭据**确实没有被改动**（不止是状态码）', async () => {
    const strategyBefore = strategies.get(strategyId)!;
    const accountBefore = exchanges.get(accountId)!;

    for (const endpoint of sensitiveEndpoints()) {
      await inject(endpoint.method, endpoint.url, {
        token: null,
        ...(endpoint.payload ? { payload: endpoint.payload } : {}),
      });
    }

    assert.equal(strategies.get(strategyId)!.name, strategyBefore.name, '策略被未认证请求改掉了');
    assert.equal(exchanges.get(accountId)!.testnet, accountBefore.testnet, '凭据环境被未认证请求改掉了');
    assert.ok(traders.get(traderId), '机器人被未认证请求删掉了');
    // 口令也必须在：改密码那条路由如果漏了鉴权，这里会红。
    assert.equal(users.findByUsername(OWNER)!.passwordHash, PASSWORD_HASH, '口令被未认证请求改掉了');
  });
});

/* -------------------------------------------------------------------------- */
/*  2) 接线证明：带有效令牌时，副作用**真的**会发生（反恒真）                    */
/* -------------------------------------------------------------------------- */

describe('接线证明（带有效令牌时必须真的走到业务层 —— 否则上面的 401 是恒真的）', () => {
  it('POST /api/traders/:id/start + dryRun:false 会真的调用 manager.startTraderAsync', async () => {
    const result = await inject('POST', `/api/traders/${traderId}/start`, {
      token: validToken,
      payload: { dryRun: false },
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.ok(
      ledger.calls.includes('startTraderAsync'),
      `带有效令牌的 start 没有触达 manager.startTraderAsync（记账：${ledger.calls.join('、') || '空'}）` +
        ' —— 那说明这个端点根本没接上，上面的 401 断言就是恒真的',
    );
  });

  it('POST /api/traders/:id/positions/close-all 会真的调用 manager.closeAllPositions', async () => {
    const result = await inject('POST', `/api/traders/${traderId}/positions/close-all`, {
      token: validToken,
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.ok(
      ledger.calls.includes('closeAllPositions'),
      `带有效令牌的 close-all 没有触达 manager.closeAllPositions（记账：${ledger.calls.join('、') || '空'}）`,
    );
  });

  it('POST /api/traders/:id/run-once 会真的调用 manager.runCycleNow', async () => {
    const result = await inject('POST', `/api/traders/${traderId}/run-once`, { token: validToken });

    // 503 = 全局熔断拦下（另一种"没触达"的合法原因）—— 那种情况下不该有调用。
    if (result.statusCode === 503) {
      assertNoManagerCalls('运行期全局熔断生效时的 run-once');
      return;
    }
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.ok(
      ledger.calls.includes('runCycleNow'),
      `带有效令牌的 run-once 没有触达 manager.runCycleNow（记账：${ledger.calls.join('、') || '空'}）`,
    );
  });

  it('PATCH /api/strategies/:id 带有效令牌时**真的**改到库', async () => {
    const result = await inject('PATCH', `/api/strategies/${strategyId}`, {
      token: validToken,
      payload: { name: '被合法请求改过的名字' },
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(strategies.get(strategyId)!.name, '被合法请求改过的名字');
  });

  it('PATCH /api/exchange-accounts/:id 带有效令牌时**真的**改到库', async () => {
    const result = await inject('PATCH', `/api/exchange-accounts/${accountId}`, {
      token: validToken,
      payload: { testnet: true },
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(exchanges.get(accountId)!.testnet, true);
  });

  it('令牌签名密钥不是"随便什么都行"：用别的密钥签的令牌打 /api/auth/me 必须 401', async () => {
    const result = await inject('GET', '/api/auth/me', { rawToken: forgedToken() });
    assert.equal(result.statusCode, 401);
  });

  /**
   * **表驱动**地把 `expectsManagerCall` 兑现：登记表里每一条声称"会调用某个 manager 方法"
   * 的端点，都必须**真的**调到它。
   *
   * 这一条把登记表从"文档"变成"判据"：断言了一个不会发生的调用（写错）→ 这里红；
   * 少登记了某个会走 manager 的端点 → 它在"未认证 401"那组里虽然也是绿的，
   * 但**没有接线证明**，而登记表那组会因为它没登记而红。
   */
  it('登记表声明的每条 manager 调用，带有效令牌时必须真的发生（表驱动反恒真）', async () => {
    const claimed = sensitiveEndpoints().filter((e) => e.expectsManagerCall);
    assert.ok(claimed.length >= 6, `只登记了 ${claimed.length} 条 manager 调用 —— 判据可能失效`);

    for (const endpoint of claimed) {
      ledger = emptyLedger();
      const result = await inject(endpoint.method, endpoint.url, {
        token: validToken,
        ...(endpoint.payload ? { payload: endpoint.payload } : {}),
      });

      /*
       * 503 = 全局熔断（`GLOBAL_TRADING_DISABLED`）在路由层就拦下 —— 那是**另一种**
       * 合理的"没触达"，此时必须**一次调用都没有**（否则说明拦在了错的层）。
       */
      if (result.statusCode === 503) {
        assert.deepEqual(
          ledger.calls,
          [],
          `${endpoint.method} ${endpoint.route} 回 503 却仍触达了 manager：${ledger.calls.join('、')}`,
        );
        continue;
      }

      assert.ok(
        ledger.calls.includes(endpoint.expectsManagerCall!),
        `${endpoint.method} ${endpoint.route} 带有效令牌时没有调用 ` +
          `manager.${endpoint.expectsManagerCall}（实际记账：${ledger.calls.join('、') || '空'}）` +
          ` —— 登记表与真实接线不符：要么登记写错了，要么这个端点根本没接上`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  3) 登记表完整性：新的写端点不能悄悄游离在覆盖之外                            */
/* -------------------------------------------------------------------------- */

/**
 * 从 `server.ts` 源码里扫出所有 `/api/**` 路由（与 `routeAuthGuard.test.ts` 同一手法）。
 *
 * ⚠️ **必须读源码而不是 `app.printRoutes()`**：后者只给运行时真正注册上的路由，
 * 而本文件要防的恰恰是"源码里有、心里以为有"的漂移。两者一起看才有意义：
 * 源码列表用来对账"有没有漏登记"，`app.inject()` 用来证明"运行时到底怎么回"。
 */
function serverRoutes(): Set<string> {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const routes = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(line);
    if (!match) continue;
    routes.add(`${match[1]!.toUpperCase()} ${match[2]!}`);
  }
  return routes;
}

/** 写在 `server.ts` 里的写端点（GET 不在其中 —— 它不该有副作用）。 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

describe('登记表完整性：`server.ts` 的每个写端点要么被本文件覆盖，要么写明理由', () => {
  it('扫描到的路由数必须 ≥ 40（否则这条判据在空转）', () => {
    const routes = serverRoutes();
    assert.ok(routes.size >= 40, `只扫到 ${routes.size} 条路由 —— 扫描可能失效了`);
  });

  it('每条写端点都在 `SENSITIVE_ENDPOINTS` 或 `INTENTIONALLY_EXCLUDED` 里', () => {
    const covered = new Set(sensitiveEndpoints().map((e) => `${e.method} ${e.route}`));
    const unregistered: string[] = [];

    for (const route of serverRoutes()) {
      const [method, url] = [route.slice(0, route.indexOf(' ')), route.slice(route.indexOf(' ') + 1)];
      if (!WRITE_METHODS.has(method!)) continue;
      if (covered.has(route) || INTENTIONALLY_EXCLUDED.has(route)) continue;
      unregistered.push(route);
    }

    assert.deepEqual(
      unregistered,
      [],
      '★★★ 这些写端点既没有被本文件覆盖，也没有在 `INTENTIONALLY_EXCLUDED` 里写明理由：\n' +
        unregistered.map((u) => `      · ${u}`).join('\n') +
        '\n    ⚠️ 新端点**不会自动进覆盖**（本仓的"接线类"缺陷形态）。\n' +
        '       若它会影响资金/交易/凭据：加进 `SENSITIVE_ENDPOINTS`；\n' +
        '       若确实不需要：加进 `INTENTIONALLY_EXCLUDED` **并写明理由**。',
    );
  });

  it('反向：登记表里的每条路由都必须真实存在于 `server.ts`', () => {
    const routes = serverRoutes();
    for (const endpoint of sensitiveEndpoints()) {
      assert.ok(
        routes.has(`${endpoint.method} ${endpoint.route}`),
        `登记表里的 ${endpoint.method} ${endpoint.route} 在 server.ts 里不存在 —— ` +
          '路由被改名/删除后，这条覆盖会静默失效（还剩一条永远 401 的断言）',
      );
    }
    for (const key of INTENTIONALLY_EXCLUDED.keys()) {
      assert.ok(routes.has(key), `豁免名单里的 ${key} 已经不存在了 —— 请移除它`);
    }
  });

  it('登记表必须覆盖台账点名的 5 条端点', () => {
    // 台账 SEC-03 的证据行点名：start / delete / close-all / close / 改策略。
    const covered = new Set(sensitiveEndpoints().map((e) => `${e.method} ${e.route}`));
    for (const route of [
      'POST /api/traders/:id/start',
      'DELETE /api/traders/:id',
      'POST /api/traders/:id/positions/close-all',
      'POST /api/traders/:id/positions/:symbol/close',
      'PATCH /api/strategies/:id',
    ]) {
      assert.ok(covered.has(route), `台账点名的 ${route} 没有被覆盖`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  4) 探针自检：记账机制本身必须能报出一次调用                                  */
/* -------------------------------------------------------------------------- */

describe('探针自检（否则"零副作用"可能只是因为探针根本没在工作）', () => {
  it('一次已认证的敏感请求会在记账里留下痕迹（正对照）', async () => {
    const before = ledger.calls.length;
    await inject('POST', `/api/traders/${traderId}/stop`, { token: validToken });
    assert.ok(
      ledger.calls.length > before,
      '带有效令牌的 stop 没有在记账里留下任何痕迹 —— 探针失效了，' +
        '"零副作用"那组断言会变成恒真',
    );
  });

  it('默认令牌（`start` 不传 dryRun）仍然是可被未认证者利用的路径 —— 断言它同样 401', async () => {
    const result = await inject('POST', `/api/traders/${traderId}/start`, { token: null });
    assert.equal(result.statusCode, 401);
    assertNoManagerCalls('不带 body 的 start');
  });
});
