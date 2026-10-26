/**
 * 认证链路的端到端回归测试（真实的 Fastify 应用 + 真实的数据库，`app.inject()` 不打网络）。
 *
 * 为什么必须有这一层：纯函数级的测试证明不了"路由确实接上了它"。
 * 这里钉住的是四个真实缺陷：
 *
 * 1. 用户名不存在时登录不做口令派生 → 401 快几十毫秒 → **用户名枚举预言机**；
 * 2. 登录**没有任何节流** → 已知用户名可以无限次在线爆破；
 * 3. 改密码之后旧令牌**依然有效**（JWT 不可撤销）→ 泄漏的令牌无法补救；
 * 4. `/api/auth/account` 的 body 没过校验 → 传个数字 currentPassword 就是 500。
 *
 * 另外顺带钉住 `/api/health` 不回显绝对路径、以及 HTTP 路由不接受 `?token=`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { env } from '../env.js';
import { checkOutboundUrl, parseHostAllowlist } from '../llm/urlGuard.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { buildServer, type ApiDependencies } from './server.js';

const OWNER = 'admin_abc123';
const PASSWORD = 'first-password-42';
const NEW_PASSWORD = 'second-password-43';
const JWT_SECRET = 'flow-test-secret-not-a-real-key';

let workDir: string;
let app: FastifyInstance;

/**
 * 只搭出被测路由真正会碰的那部分依赖。
 *
 * 用 `unknown` 显式收窄而不是 `any`：这些桩对象缺少大量成员，
 * 直接断言成接口类型会被 tsc 拒绝，而这里要的就是"我知道它们不全"。
 * 成员必须**真的实现**（而不是留空），否则测试会以一条 TypeError 的 500 失败，
 * 而不是以断言失败告诉你行为变了 —— `runningSince` 就是这样被 /api/health 用到的。
 */
function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: { runningSince: () => new Map<number, number>() } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {} as unknown as BalanceService,
  };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-auth-flow-'));
  initDb(path.join(workDir, 'test.sqlite'));
  app = await buildServer(stubDependencies());
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec('DELETE FROM users;');
  users.create(OWNER, hashPassword(PASSWORD), 'owner');
});

/* -------------------------------------------------------------------------- */
/*  辅助                                                                       */
/* -------------------------------------------------------------------------- */

interface LoginResult {
  statusCode: number;
  token: string;
  retryAfter: string | undefined;
  body: Record<string, unknown>;
}

async function login(username: string, password: string): Promise<LoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const body = response.json() as Record<string, unknown>;
  return {
    statusCode: response.statusCode,
    token: typeof body.token === 'string' ? body.token : '',
    retryAfter: response.headers['retry-after'] as string | undefined,
    body,
  };
}

async function me(token: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return response.statusCode;
}

/** 一次失败登录的耗时（毫秒）。顺带确认它确实是 401 而不是被节流成 429。 */
async function failedLoginMs(username: string): Promise<number> {
  const started = process.hrtime.bigint();
  const result = await login(username, 'definitely-the-wrong-password');
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.statusCode, 401, `期望 401，实际 ${result.statusCode}`);
  return elapsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/* -------------------------------------------------------------------------- */
/*  健康检查                                                                   */
/* -------------------------------------------------------------------------- */

test('/api/health 只回数据库文件名，不回显绝对路径', async () => {
  // 这个端点**无需认证**（容器健康检查必须能打它），所以不能借它公布
  // 部署目录布局 —— 操作系统、部署根目录、数据目录名都是攻击者的目标线索。
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);

  const body = response.json() as { db: string };
  assert.equal(body.db, 'autoquant.sqlite');
  assert.ok(!body.db.includes('/') && !body.db.includes('\\'), `health 泄漏了路径：${body.db}`);
});

/* -------------------------------------------------------------------------- */
/*  登录与节流                                                                 */
/* -------------------------------------------------------------------------- */

test('正确口令登录成功，令牌可用于已认证路由', async () => {
  const result = await login(OWNER, PASSWORD);
  assert.equal(result.statusCode, 200);
  assert.ok(result.token.length > 0);
  assert.equal(await me(result.token), 200);
});

test('HTTP 路由不接受查询参数里的令牌', async () => {
  const { token } = await login(OWNER, PASSWORD);

  // URL 会进反向代理日志、浏览器历史与 Referer。之前所有路由都接受 ?token=，
  // 等于把长期凭据抄送到多个操作员无法控制的地方。
  const response = await app.inject({ method: 'GET', url: `/api/auth/me?token=${token}` });
  assert.equal(response.statusCode, 401);
});

/* -------------------------------------------------------------------------- */
/*  WebSocket 事件流（唯一接受 ?token= 的通道）                                */
/* -------------------------------------------------------------------------- */

/**
 * 打开一次真实的 WebSocket 握手，观察它**是否被服务端关掉**。
 *
 * 注意这里的形态：`@fastify/websocket` 会先完成 HTTP 升级，再运行路由处理器，
 * 所以"拒绝"不是握手失败，而是升级之后立刻收到一个 close 帧（1008）。
 * 处理器里那句 `socket.close(1008, ...)` 就是为此存在的 —— 这个测试正好把
 * "令牌校验真的在跑"钉在它观察得到的那一面。
 */
function wsHandshake(url: string, idleMs = 250): Promise<{ survived: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (result: { survived: boolean; closeCode?: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // 在观察窗口内没有被关掉，就算它连上了。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close(1000, 'done');
      resolve({ survived: true });
    }, idleMs);
    socket.on('close', (code: number) => finish({ survived: false, closeCode: code }));
    socket.on('error', () => finish({ survived: false }));
  });
}

test('/api/events：查询参数令牌仍然可用，无效或已撤销的令牌被 1008 关闭', async () => {
  /*
   * 这个用例守的是 M3 修复的**边界**：把 `?token=` 从所有 HTTP 路由上摘掉之后，
   * WebSocket 这条通道必须照常工作 —— 浏览器的 WebSocket 构造函数无法设置
   * 请求头，摘错了就等于把控制台的实时事件流整条弄坏。
   *
   * 用一个独立账号做撤销部分，避免与后面「修改凭据节流」的用例抢同一把键。
   */
  users.create('admin_ws_target', hashPassword(PASSWORD), 'owner');
  const { token } = await login('admin_ws_target', PASSWORD);

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = new URL(address).port;
  const base = `ws://127.0.0.1:${port}/api/events`;

  const accepted = await wsHandshake(`${base}?token=${token}`);
  assert.equal(accepted.survived, true, 'WebSocket 事件流被切断了 —— 控制台会失去实时推送');

  const garbage = await wsHandshake(`${base}?token=not-a-real-token`);
  assert.equal(garbage.closeCode, 1008);

  // 撤销必须在 WS 这条通道上同样生效，否则改密码之后旧令牌还能订阅事件流
  const change = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(change.statusCode, 200, change.body);

  const revoked = await wsHandshake(`${base}?token=${token}`);
  assert.equal(revoked.survived, false, '改密码之后旧令牌仍然能订阅事件流');
  assert.equal(revoked.closeCode, 1008);
});

test('密码错误返回 401，且不透露用户是否存在', async () => {
  assert.equal((await login(OWNER, 'wrong-password-xx')).statusCode, 401);
  assert.equal((await login('admin_notexist', 'wrong-password-xx')).statusCode, 401);
});

test('用户名不存在时也跑完整的口令派生 —— 401 的耗时与密码错误一致', async () => {
  // 这个断言锁的是一个**时间侧信道**：`if (!record || !verifyPassword(...))` 的
  // `||` 短路让未知用户名跳过 scrypt，快几十毫秒。那足以把「哪些用户名存在」
  // 一个个试出来，而随机用户名（generateUsername）的全部价值就在于
  // 让攻击者必须先猜对用户名。
  //
  // 上限刻意放宽到 4 倍：scrypt 的成本很稳定，这里要抓的是"根本没跑 scrypt"
  // （那会是 20 倍以上的差距），而不是毫秒级抖动。
  const existing: number[] = [];
  const missing: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    existing.push(await failedLoginMs(OWNER));
    missing.push(await failedLoginMs('admin_nosuchuser'));
  }

  const existingMs = median(existing);
  const missingMs = median(missing);
  assert.ok(
    missingMs > existingMs / 4,
    `未知用户名的响应明显更快（${missingMs.toFixed(1)}ms vs ${existingMs.toFixed(1)}ms），用户名枚举侧信道又回来了`,
  );
});

test('连续失败触发节流：429 + Retry-After，之后即使口令正确也被拒', async () => {
  const victim = 'admin_bruteforce_target';

  let locked: LoginResult | undefined;
  for (let attempt = 0; attempt < 12 && !locked; attempt += 1) {
    const result = await login(victim, `guess-${attempt}-wrong`);
    if (result.statusCode === 429) locked = result;
  }

  assert.ok(locked, '12 次失败之后仍未触发节流 —— 已知用户名可以无限次在线爆破');
  assert.ok(Number(locked.retryAfter) >= 1, `Retry-After 必须是正整数秒，实际 ${locked.retryAfter}`);

  // 锁定期间即使拿到正确口令也不放行（对不存在的账号同样如此，
  // 响应形态不区分"用户名是否存在"）
  const stillLocked = await login(victim, PASSWORD);
  assert.equal(stillLocked.statusCode, 429);
});

/* -------------------------------------------------------------------------- */
/*  令牌撤销                                                                   */
/* -------------------------------------------------------------------------- */

test('改密码后，此前签发的令牌立即失效；重新签发的令牌有效', async () => {
  const { token: oldToken } = await login(OWNER, PASSWORD);
  assert.equal(await me(oldToken), 200);

  const change = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: { authorization: `Bearer ${oldToken}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(change.statusCode, 200, change.body);
  const newToken = (change.json() as { token: string }).token;

  // 关键断言：旧令牌即使签名有效、还没到期，也必须被拒。
  // 用 iat 比大小时这里会失败（两者在同一秒内签发），正是本用例要钉住的行为。
  assert.equal(await me(oldToken), 401, '改密码之后旧令牌仍然有效 —— 泄漏的会话无法补救');
  assert.equal(await me(newToken), 200, '重新签发的令牌被自己的撤销检查拒掉了');

  // 旧口令不再可用，新口令可以登录
  assert.equal((await login(OWNER, PASSWORD)).statusCode, 401);
  assert.equal((await login(OWNER, NEW_PASSWORD)).statusCode, 200);
});

test('改用户名同样作废其他会话', async () => {
  const { token: oldToken } = await login(OWNER, PASSWORD);

  const change = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: { authorization: `Bearer ${oldToken}` },
    payload: { currentPassword: PASSWORD, username: 'admin_renamed' },
  });
  assert.equal(change.statusCode, 200, change.body);

  // 令牌载荷里带着用户名：改名之后其他设备上的旧会话不该继续以旧身份通过校验
  assert.equal(await me(oldToken), 401);
});

/* -------------------------------------------------------------------------- */
/*  请求体校验                                                                 */
/* -------------------------------------------------------------------------- */

test('/api/auth/account 的 body 过 zod：非字符串口令是 400 而不是 500', async () => {
  const { token } = await login(OWNER, PASSWORD);

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: { authorization: `Bearer ${token}` },
    // 数字会让 scryptSync 抛 TypeError：没有绕过风险，但 500 会把一个纯粹的
    // 客户端错误伪装成服务端故障，还会回显内部栈信息。
    payload: { currentPassword: 12345, newPassword: NEW_PASSWORD },
  });

  assert.equal(response.statusCode, 400);
});

test('缺少 currentPassword 时是 400，且不修改任何东西', async () => {
  const { token } = await login(OWNER, PASSWORD);

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: { authorization: `Bearer ${token}` },
    payload: { newPassword: NEW_PASSWORD },
  });
  assert.equal(response.statusCode, 400);
  // 旧口令依然有效 —— 校验发生在任何写操作之前
  assert.equal((await login(OWNER, PASSWORD)).statusCode, 200);
});

/* -------------------------------------------------------------------------- */
/*  SSRF：自定义 baseUrl                                                       */
/* -------------------------------------------------------------------------- */

test('自定义模型的 baseUrl 指向内网时被 400 拒绝', async () => {
  const { token } = await login(OWNER, PASSWORD);

  /*
   * ## ⚠️ 为什么这几个地址要按**当前生效的白名单**筛一遍
   *
   * 这条用例断言的是"内网 baseUrl 被拒"。而 `env.allowPrivateLlmHosts` 来自
   * **运行环境的 `.env`** —— 本地开发者为了让自己的内网 LLM 网关能用，会在
   * `.env` 里写 `ALLOW_PRIVATE_LLM_HOSTS=127.0.0.1`（这正是本仓支持的功能，
   * 见 `docs/DEVELOPMENT.md`）。
   *
   * 于是同一条测试：干净 CI 上绿、**配了白名单的开发机上红** —— 而红的原因是
   * "用户自己的配置"，不是代码缺陷。那种假失败会训练人忽略红色。
   *
   * 修法：**按实际白名单筛选**。被显式放行的地址改用"同一网段但没登记"的
   * 邻居来验证规则本身仍然生效 —— 这比"假设白名单是空的"更准确：
   * 它同时证明了"登记的那个放行、没登记的那个仍然被拒"。
   */
  const allowlist = parseHostAllowlist(env.allowPrivateLlmHosts);
  const isAllowed = (url: string) => checkOutboundUrl(url, allowlist).allowed;

  const blockedTargets = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:11434/v1',
    'http://10.0.0.7/v1',
  ].filter((url) => !isAllowed(url));

  /*
   * 全部被白名单放行时（极端配置：`ALLOW_PRIVATE_LLM_HOSTS=0.0.0.0/0`），
   * 这条用例就没有可断言的样本了 —— 明确跳过，而不是让它空跑通过。
   */
  assert.ok(
    blockedTargets.length > 0,
    '★ 运行环境的 ALLOW_PRIVATE_LLM_HOSTS 放行了全部测试目标，这条用例无从验证 —— ' +
      '请用一个更窄的白名单（例如只写你自己的网关地址）',
  );

  for (const baseUrl of blockedTargets) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai-models',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'custom', label: 'ssrf', model: 'm', baseUrl, apiKey: '' },
    });

    assert.equal(response.statusCode, 400, `${baseUrl} 应当被拒绝，实际 ${response.statusCode}`);
    assert.match(
      String((response.json() as { error?: string }).error ?? ''),
      /baseUrl 不被允许/,
      '拒绝时必须说明原因',
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  凭据变更同样需要节流                                                       */
/* -------------------------------------------------------------------------- */

/*
 * 这个用例必须**放在最后**：它会把「修改凭据」这条路径在用户名维度上锁住，
 * 而后面的用例无论是用正确口令改密码还是改名都会被 429 挡掉。
 */
test('连错当前密码同样被节流：已登录的会话不能当在线口令预言机', async () => {
  const { token } = await login(OWNER, PASSWORD);
  let lockedAt = 0;
  let retryAfter = '';

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/account',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: `wrong-current-${attempt}`, newPassword: NEW_PASSWORD },
    });

    if (response.statusCode === 429) {
      lockedAt = attempt;
      retryAfter = String(response.headers['retry-after'] ?? '');
      break;
    }
    // 校验发生在任何写操作之前，所以连错只会得到 401，不会改掉任何东西
    assert.equal(response.statusCode, 401, `第 ${attempt + 1} 次错误口令应当返回 401`);
  }

  assert.ok(lockedAt > 0, '当前密码可以无限次在线猜测 —— 令牌泄漏就等于一个在线口令预言机');
  assert.ok(Number(retryAfter) >= 1, `Retry-After 必须是正整数秒，实际 ${retryAfter}`);
});
