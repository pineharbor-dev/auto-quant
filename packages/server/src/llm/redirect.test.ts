/**
 * `fetchGuarded` 的回归测试：重定向的每一跳都必须重跑 `urlGuard`。
 *
 * ## 这个测试存在的理由（真实缺陷）
 *
 * `checkOutboundUrl()` 过去只校验我们拼出来的**第一个** URL，而 `fetch` 默认
 * `redirect: 'follow'`。于是 `baseUrl` 填一个**合法的公网地址**（校验通过），
 * 它回一个 `302 Location: http://169.254.169.254/latest/meta-data/...`，
 * 服务端就会带着真实 API Key 打到云元数据服务 —— `urlGuard.ts` 文件头写明了
 * 要防的正是这条升级路径（「一个能登录控制台的人」升级成「拿到云主机凭据的人」）。
 *
 * 修复方式是手动跟随重定向、每一跳重跑校验，并且**跨主机跳转时剥掉全部请求头**
 * （undici 只剥 Authorization，`x-api-key` / `api-key` / `x-goog-api-key` 会被原样
 * 转发到跳转目标 —— 已实测确认）。
 *
 * 全程不打真实网络：`globalThis.fetch` 被替换成一台内存"路由器"。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { fetchGuarded } from './http.js';
import { env } from '../env.js';
import { checkOutboundUrl, parseHostAllowlist } from './urlGuard.js';

/** 路由器编程好的响应序列，以及每一跳实际观测到的请求。 */
interface Hop {
  url: string;
  headers: Record<string, string | undefined>;
}
/** route() 返回的"这一跳该回什么"：状态码 + 可选的 Location。 */
interface RoutePlan {
  status: number;
  location?: string;
}
let hops: Hop[] = [];
let route: () => RoutePlan;
let originalFetch: typeof globalThis.fetch;

/** 把 fetch 换成"永远按 route() 回答"的记录器，并把 Location 解析成绝对地址。 */
function installRouter() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    hops.push({ url, headers });
    const plan = route();
    if (plan.location) {
      return new Response(null, { status: plan.status, headers: { location: new URL(plan.location, url).toString() } });
    }
    return new Response('{"ok":true}', { status: plan.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

before(() => {
  installRouter();
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  hops = [];
});

/* -------------------------------------------------------------------------- */

test('★ 公网 → 公网的同主机跳转照常跟随，鉴权头保留', async () => {
  let n = 0;
  route = () =>
    ++n === 1
      ? { status: 301, location: 'https://gateway.example.com/v2/chat' }
      : { status: 200 };
  const response = await fetchGuarded('https://gateway.example.com/v1/chat', {
    method: 'POST',
    headers: { 'x-api-key': 'SECRET-KEY-1' },
  });
  assert.equal(response.status, 200);
  assert.equal(hops.length, 2, '跟随了一跳');
  assert.equal(hops[1]!.url, 'https://gateway.example.com/v2/chat');
  /* 同主机：头必须留着，否则那一跳会直接 401，合法网关被我们自己弄坏。 */
  assert.equal(hops[1]!.headers['x-api-key'], 'SECRET-KEY-1');
});

test('★ 跳转到云元数据地址被拒绝，而不是发出去（urlGuard 只挡了第一跳的回归）', async () => {
  route = () => ({ status: 302, location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
  await assert.rejects(
    () =>
      fetchGuarded('https://gateway.example.com/v1/chat', {
        method: 'POST',
        headers: { 'x-api-key': 'SECRET-KEY-1' },
      }),
    /不被允许|拒绝|rejected/i,
    '跳转目标命中链路本地段时必须抛出，而不是让 undici 跟着走',
  );
  /* 决定性断言：**对元数据地址的请求从未发出**。hops 里只有第一跳。 */
  assert.equal(hops.length, 1, '第二跳（内网地址）绝不能出现在观测记录里');
  assert.ok(!hops.some((h) => h.url.includes('169.254')), '云元数据地址没有被实际连接');
});

test('★ 跨主机跳转剥掉全部鉴权头（undici 只剥 Authorization，其余会原样转发）', async () => {
  let n = 0;
  route = () => (++n === 1 ? { status: 302, location: 'https://other-host.example.net/s' } : { status: 200 });
  const response = await fetchGuarded('https://gateway.example.com/v1/chat', {
    method: 'POST',
    headers: { 'x-api-key': 'SECRET-KEY-1', 'api-key': 'SECRET-KEY-2', authorization: 'Bearer X' },
  });
  assert.equal(response.status, 200);
  assert.equal(hops.length, 2);
  assert.equal(hops[1]!.headers['x-api-key'], undefined, '跨主机不得带 x-api-key');
  assert.equal(hops[1]!.headers['api-key'], undefined, '跨主机不得带 api-key');
  assert.equal(hops[1]!.headers['authorization'], undefined, '跨主机不得带 authorization');
});

test('★ 重定向循环有上限：不会无限跟随', async () => {
  route = () => ({ status: 302, location: 'https://gateway.example.com/loop' });
  await assert.rejects(
    () => fetchGuarded('https://gateway.example.com/v1/chat', { method: 'POST' }),
    /超过|放弃|too many/i,
  );
  assert.ok(hops.length <= 7, `跳数必须有界（实际 ${hops.length}）`);
});

test('★ 一开始就填内网地址：第一跳就被拒（不依赖 fetch 被调用）', async () => {
  route = () => ({ status: 200 });

  /*
   * ## ⚠️ 目标地址要按**当前生效的白名单**挑
   *
   * 这条用例断言"内网地址在第一跳就被拒"。而白名单
   *（`ALLOW_PRIVATE_LLM_HOSTS`）是**受支持的配置** —— 本地开发者为了让自己的
   * 内网 LLM 网关能用，会在 `.env` 里写 `ALLOW_PRIVATE_LLM_HOSTS=127.0.0.1`。
   *
   * 于是 `http://127.0.0.1:8080` 在那台机器上是**合法目标**，
   * 这条用例就会红 —— 而红的原因是用户自己的配置，不是代码缺陷。
   *
   * 修法：挑一个**当前确实被拒**的地址来验证这条规则。
   * 下面按优先级找第一个不被白名单放行的候选。
   */
  const allowlist = parseHostAllowlist(env.allowPrivateLlmHosts);
  const candidate =
    [
      'http://127.0.0.1:8080/v1/chat',
      'http://10.255.255.1:8080/v1/chat',
      'http://169.254.169.254/latest/meta-data/',
    ].find((url) => !checkOutboundUrl(url, allowlist).allowed) ?? null;

  assert.ok(
    candidate,
    '★ 运行环境的 ALLOW_PRIVATE_LLM_HOSTS 放行了全部内网候选，这条用例无从验证 —— ' +
      '请用一个更窄的白名单（例如只写你自己的网关地址）',
  );

  await assert.rejects(
    () => fetchGuarded(candidate, { method: 'POST' }),
    /不被允许|拒绝|rejected/i,
  );
  assert.equal(hops.length, 0, '内网地址连一次都不该被拨出去');
});

test('★ 3xx 但没有 Location：原样返回，不抛（交给上层按状态码处理）', async () => {
  // 302 在 REDIRECT_STATUSES 里，但没有 Location 头 → fetchGuarded 必须把它原样返回，
  // 而不是循环或抛错。（304 在这里没法用：Response 构造函数禁止为 null-body 状态造实例，
  // 那是 undici 的规则，与本逻辑无关。）
  route = () => ({ status: 302 });
  const response = await fetchGuarded('https://gateway.example.com/v1/chat', { method: 'POST' });
  assert.equal(response.status, 302);
  assert.equal(hops.length, 1, '没有 Location 就停在第一跳');
});
