/**
 * **删除交易所凭据不该被「已停止的机器人」挡住**（2026-10-23 用户实测）
 *
 * ## 事故
 *
 * 用户在「交易所」页面点删除，界面报：
 * ```
 *   ⚠️ 该凭据正被 3 个机器人使用，请先删除或改派它们。
 * ```
 * 而那 3 个机器人**全部是 stopped**（其中两个是几个月前建的测试机器人）。
 *
 * ⇒ **一个没人用的凭据删不掉**，而唯一的"解法"是先去把那 3 个机器人删了 ——
 * 用户想删的是凭据，不是机器人。
 *
 * ## 修法的判据
 *
 * ```
 *   还有 running 的机器人在用它 → 仍然挡住（真危险：删了它，
 *                                  正在跑的仓位会失去管理）
 *   只剩 stopped 的机器人在用   → 解绑它们，然后删掉凭据
 * ```
 *
 * ## 为什么这份测试读源码而不是起数据库
 *
 * 这个判据的核心是**一条 SQL 的 WHERE 条件**，而它唯一的失效方式是
 * "有人把 `AND status = 'running'` 删掉了" —— 那种改动连类型都不会变。
 * 起一套数据库来验证它，成本远高于直接钉住那句话的**语义**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const REPO = readFileSync(new URL('./repositories.ts', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../api/server.ts', import.meta.url), 'utf8');

/**
 * 取 `exchanges` 这个仓储对象的方法体。
 *
 * ⚠️ 不能全局 `indexOf('usageCount')` —— `strategies` 和 `exchanges` 都有
 * 同名方法，全局搜索会取到第一个（策略那个），于是**测试验的是一段
 * 跟被测对象无关的代码**。所以先定位 `const exchanges = {`，再往后找。
 */
function exchangesBody(): string {
  const start = REPO.indexOf('const exchanges');
  assert.ok(start > 0, '★ 应当能找到 exchanges 仓储的定义');
  // 下一个顶层 `};` 之前的内容就是它的方法体。
  const end = REPO.indexOf('\n};', start);
  assert.ok(end > start, '★ 应当能找到 exchanges 块的结束位置');
  return REPO.slice(start, end);
}

test('★★★ 凭据的占用判据必须只数「正在运行」的机器人', () => {
  /*
   * 这是整个修复的核心。少了 `AND status = 'running'`，界面就会继续
   * 被已停止的机器人挡住 —— 而那正是用户报的那个 BUG。
   */
  const body = exchangesBody();
  const usage = /usageCount\(id: number\)[\s\S]*?\n  \},/.exec(body);
  assert.ok(usage !== null, '★ 应当能找到 exchanges.usageCount');
  assert.ok(
    /status = 'running'/.test(usage![0]),
    '★ usageCount 必须限定 status = \'running\' —— 否则已停止的机器人会挡住删除',
  );
  assert.ok(
    /exchange_account_id = \?/.test(usage![0]),
    '★ 判据仍然要按凭据 id 关联',
  );
});

test('★★★ 删除凭据前必须解绑已停止的机器人（避免指向幽灵 id）', () => {
  /*
   * 停止的机器人仍然记着 `exchange_account_id`。直接 DELETE 那个凭据会让
   * 它们指向一个**不存在的账户 id** —— 下次启动时报"找不到账户"（不明所以），
   * 而不是"你需要先选一个账户"。
   */
  const body = exchangesBody();
  const detach = /detachAll\(id: number\)[\s\S]*?\n  \},/.exec(body);
  assert.ok(detach !== null, '★ 必须有 detachAll');
  assert.ok(
    /exchange_account_id = NULL/.test(detach![0]),
    '★ 解绑就是把 exchange_account_id 置 NULL',
  );
});

test('★★★ DELETE 端点：先判 running，再解绑，最后删除', () => {
  /*
   * 顺序很重要：先解绑再删除的话，`usageCount` 读到的就已经是 0 了 ——
   * 那条"还有机器人在跑"的保护会被绕过，正在交易的机器人会被静默解绑。
   */
  const start = SERVER.indexOf("app.delete('/api/exchange-accounts/:id'");
  assert.ok(start > 0, '★ 应当能找到 DELETE 端点');
  const end = SERVER.indexOf('app.post(', start);
  const body = SERVER.slice(start, end > start ? end : start + 2500);

  const usageAt = body.indexOf('usageCount(');
  const detachAt = body.indexOf('detachAll(');
  const removeAt = body.indexOf('exchanges.remove(');
  assert.ok(usageAt > 0, "★ 必须先调 usageCount 判定");
  assert.ok(detachAt > usageAt, '★ 解绑必须排在「判 running」之后');
  assert.ok(removeAt > detachAt, '★ 删除必须排在解绑之后');
});

test('★★ 提示文案必须说清「正在运行」，否则用户不知道该怎么办', () => {
  /*
   * 原来那句「该凭据正被 3 个机器人使用，请先删除或改派它们」的问题是：
   * 那 3 个机器人**已经停了**，用户根本不知道该去哪里"改派"。
   * 文案要明说这是"正在运行"的限制，以及为什么不能直接删。
   */
  const start = SERVER.indexOf("app.delete('/api/exchange-accounts/:id'");
  const end = SERVER.indexOf('app.post(', start);
  const body = SERVER.slice(start, end > start ? end : start + 2500);
  assert.ok(
    /正在运行/.test(body),
    '★ 409 文案必须点明"正在运行"—— 否则用户会以为停止的机器人也算',
  );
  assert.ok(
    /失去管理/.test(body),
    '★ 必须说明为什么不能删（仓位会失去管理），而不只是"不允许"',
  );
});

test('★★★ 策略仓储的同类修复不能被改回去（回归守卫）', () => {
  /*
   * `strategies.usageCount` 在 2026-10-19 修过同一个问题
   *（"删除被 409 挡住，而那个机器人根本没用它"）。
   * 两处是**同一条纪律**，所以放在一起钉住 —— 免得只修了一处。
   */
  const start = REPO.indexOf('const strategies');
  assert.ok(start > 0);
  const end = REPO.indexOf('\n};', start);
  const body = REPO.slice(start, end);
  const usage = /usageCount\(id: number\)[\s\S]*?\n  \},/.exec(body);
  assert.ok(usage !== null, '★ 应当能找到 strategies.usageCount');
  assert.ok(
    /mode <> 'ai_managed'/.test(usage![0]),
    "★ 策略的占用判据必须排除 ai_managed（AI 托管的参数在它自己那里，不吃策略）",
  );
});
