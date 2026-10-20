/**
 * **结清陈旧委托不能只挂在决策周期里**
 *（2026-10-14 线上实测抓到的 BUG：本地 36 条"已挂单"，交易所 0 条）
 *
 * ## 事故
 *
 * 线上 `#11`（团队模式）：
 * ```
 *   本地 orders status='NEW'       : 36 条
 *   交易所 /fapi/v1/openOrders     :  0 条
 *   交易所 /fapi/v1/openAlgoOrders :  0 条（9 个标的逐个查）
 * ```
 * 用户看到「当前委托 28 · 已挂单（待对账）」，而**交易所一张都没有**。
 *
 * ## 关键事实：逻辑是对的，只是从未被执行
 *
 * 我逐条复刻了 `settleStaleOrders()` 的判据：
 * ```
 *   ① candidates（够老 + 非终态）      : 36 条
 *   ② activeProtectionIds（open 持仓）:  0 个
 *   ③ 交易所挂着                       :  0 条 → 可结清 36
 * ```
 * 也就是说它**本来能全部结清** —— 只是它挂在决策周期的对账那一步里，
 * 而团队模式的决策又慢又长，那个路径经常走不到（实测 `#11` 的对账只跑过 2 次）。
 *
 * ## 修法：给它一个**独立于决策周期**的入口
 *
 * 由 `manager` 的**自检循环**（每 30 分钟，那条路径即使决策卡住也一定会跑）调用。
 *
 * ⚠️ 为什么这样是安全的：`settleStaleOrders()` 只改账（把交易所已不挂着的
 * 本地行写成终态），**不撤单、不下单**，唯一依据是交易所自己说那张单还在不在。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

test('★★★ AutoTrader 必须暴露一个公开的结清入口（供外部节奏调用）', () => {
  assert.ok(
    /async settleStaleOrderRecords\(\): Promise<number>/.test(AUTO),
    '★ 必须有公开方法 —— 否则 manager 无法在决策周期之外调用它',
  );
  assert.ok(
    /return this\.settleStaleOrders\(\)/.test(AUTO),
    '★ 它应该直接转发到私有的 settleStaleOrders（不要复制逻辑）',
  );
});

test('★★★ 自检循环必须调用它（那是"一定会跑"的那条路径）', () => {
  /*
   * ⚠️ 判据：`runSelfCheckSweep` 里必须出现 `settleStaleOrderRecords()`。
   * 它是独立于决策周期的 30 分钟节奏 —— 而这正是修复的关键。
   */
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER);
  assert.ok(sweep !== null, '★ 应当能找到 runSelfCheckSweep');
  assert.ok(
    /settleStaleOrderRecords\(\)/.test(sweep![0]),
    '★ 自检循环里必须调用结清 —— 决策周期不一定跑得到，这个循环一定会跑',
  );
});

test('★★★ 结清必须排在自检【之前】（否则自检读到的是陈旧的行）', () => {
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER)![0];
  const settleAt = sweep.indexOf('settleStaleOrderRecords()');
  const checkAt = sweep.indexOf('runSelfCheck(id');
  assert.ok(settleAt > 0 && checkAt > 0, '★ 两处都该在自检循环里');
  assert.ok(
    settleAt < checkAt,
    '★ 结清必须排在自检之前 —— 自检会读委托状态并据此报告异常',
  );
});

test('★★ 结清失败不能影响自检（它是记账修复，不是自检的输入）', () => {
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER)![0];
  /* 结清那一小段必须有 try/catch。 */
  const settleBlock = /try \{[\s\S]{0,700}?settleStaleOrderRecords\(\)[\s\S]{0,700}?catch/.exec(sweep);
  assert.ok(settleBlock !== null, '★ 结清必须包在 try/catch 里，失败不能拖垮自检');
});

test('★★ 决策周期里那条结清路径仍然保留（两个节奏都要有）', () => {
  /*
   * ⚠️ 不要因为加了自检循环就把周期里那条删掉 ——
   * 周期那条更及时（平仓后立刻结清，见 `settleStaleOrders(symbol)`），
   * 自检那条是兜底。**两个都要**。
   */
  assert.ok(
    /await this\.settleStaleOrders\(\)\.catch/.test(AUTO),
    '★ 周期里的结清路径必须保留',
  );
  assert.ok(
    /await this\.settleStaleOrders\(symbol\)\.catch/.test(AUTO),
    '★ 平仓后立刻结清那条路径也必须保留',
  );
});

test('★★★ 自检循环必须【启动时立即跑一次】（`setInterval` 要等一整个间隔）', () => {
  /*
   * ⚠️ 实测（2026-10-14）：部署后 14 分钟查，`#11` 的 `NEW` 从 36 涨到 **40**，
   * 而结清日志一条都没有 —— 因为 `setInterval` 还没触发第一次。
   *
   * 而"启动时"恰好是最该跑一次的时刻：
   * ```
   *   · 重启前可能留下一批未结清的委托行（进程被杀时正跑到一半）
   *   · 重启本身就是"决策周期中断"的最大来源
   * ```
   */
  /*
   * ⚠️ 判据必须用**唯一的锚点**：`timer.unref()` 之后那句。
   *
   * ⚠️⚠️ 而且不能靠"函数体正则"提取 —— 我第一版写 `/startSelfCheckLoop[\s\S]*?\n  \}/`
   * 只匹配到 **25 个字符**（方法体第一个 `\n  }` 就收尾了），于是它永远找不到
   * `timer.unref()`。**一个错的提取方式会让判据永远失败**（或者更糟：永远通过）。
   * 这里改成"在全文里从 `startSelfCheckLoop` 的位置往后取一段"。
   */
  const start = MANAGER.indexOf('startSelfCheckLoop');
  assert.ok(start > 0, '★ 应当能找到自检循环的注册处');
  /*
   * ⚠️ 窗口必须够大：`startSelfCheckLoop` 与 `timer.unref()` 之间隔着我写的
   * 一大段注释（1500+ 字符），3000 字符的窗口**不够**。
   * 判据失败的原因会是"找不到 unref"，而真因是窗口太小 ——
   * 那正是"一个错的提取方式让判据永远失败"的又一次实例。
   */
  const body = MANAGER.slice(start, start + 6000);
  const unrefAt = body.indexOf('timer.unref()');
  assert.ok(unrefAt > 0, '★ 应当能找到 timer.unref()');
  assert.ok(
    /void this\.runSelfCheckSweep\(\)/.test(body.slice(unrefAt)),
    '★ 必须在注册定时器之后【立即】触发一次 sweep（否则要等一整个间隔）',
  );
});

/* -------------------------------------------------------------------------- */
/*  手工平仓必须同时结清本地挂单记录（2026-10-21 用户报告的 BUG）                  */
/* -------------------------------------------------------------------------- */

test('★★★ 手工平仓必须结清本地挂单记录（否则界面留幽灵委托）', () => {
  /*
   * ## 用户原话
   *
   * > 「JEV实盘我停了，然后手动点了全部平仓，仓位好像平了，
   * >  但是当前委托里面为什么还有」
   *
   * ## 实测
   *
   * 那 6 张单在交易所侧**全是 `CANCELED`**（它们是 `closePosition` 条件单，
   * 仓位一平交易所就自动撤销），而本地 `orders` 表仍然停在 `NEW`。
   *
   * ## 为什么上一版的 `settleStaleOrders` 没救到它
   *
   * 那条清理挂在**决策周期/自检循环**里 —— 而这次是
   * 「先停机器人、再手工平仓」，两个循环都没机会跑。
   * ⇒ 平仓路径必须**自己**立即清账。
   */
  const closeManually = /async closeManually\(symbol: string\)[\s\S]*?\n  \}/.exec(AUTO);
  assert.ok(closeManually !== null, '★ 应当能找到 closeManually');
  assert.ok(
    /orderStore\.cancelOpenBySymbol\(traderId, symbol\)/.test(closeManually![0]),
    '★ 手工平仓里必须结清本地挂单 —— 不能只撤交易所侧（那样界面会留幽灵委托）',
  );

  /*
   * ⚠️ **必须只在撤单成功时清**。
   *
   * 撤单失败意味着挂单可能还在交易所侧，那时清掉本地记录会让操作员
   * 以为"没有挂单了" —— 比留着更危险。所以判据是"有一个 cancelFailed
   * 标记，且清账被它守住"。
   */
  assert.ok(
    /let cancelFailed = false/.test(closeManually![0]),
    '★ 必须记录撤单是否失败',
  );
  assert.ok(
    /if \(!cancelFailed\) \{[\s\S]*?cancelOpenBySymbol/.test(closeManually![0]),
    '★ 清账必须被 `if (!cancelFailed)` 守住（撤单失败时不能清）',
  );
});

test('★★★ cancelOpenBySymbol 只动 NEW，不改写历史状态', () => {
  /*
   * 已成交（`FILLED`）与早已撤销的行是**历史事实**，不能改写。
   * 判据：SQL 里必须有 `status = 'NEW'` 这个条件。
   */
  const REPO = readFileSync(new URL('../store/repositories.ts', import.meta.url), 'utf8');
  const fn = /cancelOpenBySymbol\(traderId: number, symbol: string\)[\s\S]*?\n  \},/.exec(REPO);
  assert.ok(fn !== null, '★ 应当能找到 cancelOpenBySymbol');
  assert.ok(
    /status = 'NEW'/.test(fn![0]),
    '★ UPDATE 必须限定 `status = \'NEW\'` —— 否则会改写已成交的历史行',
  );
  assert.ok(
    /status = 'CANCELED'/.test(fn![0]),
    '★ 应当写成 CANCELED（与交易所侧一致）',
  );
});

/* -------------------------------------------------------------------------- */
/*  停止后不能再开仓 / 模拟盘平仓不能碰交易所（2026-10-21 用户报告）              */
/* -------------------------------------------------------------------------- */

test('★★★ 停止请求必须在【下单前】拦住（停止后还在开仓的 BUG）', () => {
  /*
   * ## 用户原话
   *
   * > 「我停止了机器人，不光不平仓，好像还在开仓」
   *
   * ## 实测（#11，ai_team 模式）
   *
   * ```
   *   16:32:36  机器人已停止（操作员手动停止）
   *   16:32:36  ⚠️ 停止时上一轮决策未在时限内结束
   *   16:35:28  已开仓 DOGEUSDT 空头 63 @ 0.081     ← 停止后 3 分钟还在开仓
   *   16:35:29  已开仓 HYPEUSDT 空头 0.07 @ 79.63
   * ```
   *
   * ## 根因
   *
   * `stop()` 只做了 `abortCurrentCycle.abort()` —— 那中断的是**在途 HTTP 请求**，
   * 而 `ai_team` 的一轮决策要跑 2-5 分钟，循环会接着跑完剩下步骤。
   *
   * ⇒ 必须有一个**流程级**的标志，并在下单前检查。
   */
  assert.ok(
    /private stopRequestedAt: number \| null = null/.test(AUTO),
    '★ 必须记录停止请求的时刻（时间戳，不是布尔 —— 见下）',
  );
  assert.ok(
    /this\.stopRequestedAt = Date\.now\(\)/.test(AUTO),
    '★ stop() 里必须记下时刻',
  );

  /*
   * ⚠️ **判据用的是「这一轮的开始时刻 vs 停止时刻」，不是布尔标志。**
   *
   * 我第一版写成布尔 + "本轮是否已执行过决策"，结果撞上了既有契约：
   * `start()` 后立刻 `stop()` 时，那一轮已经在 `await complete()` 里
   * 但还没到执行循环 —— 布尔判据会把它整轮跳过，于是
   * "stopping a trader waits for the cycle already in flight" 立刻变红
   *（那意味着已成交的仓位会裸奔，§2.6）。
   *
   * 时间戳判据能精确区分：
   * ```
   *   cycleStartedAt <  stopRequestedAt  ⇒ 停止前就在跑 ⇒ 放行（挂完保护单）
   *   cycleStartedAt >= stopRequestedAt  ⇒ 停止后才开始 ⇒ 跳过（不开新仓）
   * ```
   */
  assert.ok(
    /private cycleStartedAt = 0/.test(AUTO),
    '★ 必须记录本轮开始时刻',
  );
  assert.ok(
    /this\.cycleStartedAt = Date\.now\(\)/.test(AUTO),
    '★ runCycle 开头必须写它',
  );
  assert.ok(
    /cycleStartedBeforeStop/.test(AUTO),
    '★ 必须有「停止前就在跑」的判据',
  );

  const guardAt = AUTO.indexOf('cycleStartedBeforeStop');
  const loopAt = AUTO.indexOf('for (const decision of verdict.approved)');
  assert.ok(guardAt > 0, '★ 必须有停止判据');
  assert.ok(
    AUTO.indexOf('cycleStartedBeforeStop', loopAt) > loopAt,
    '★ 判据必须在下单循环【内部】—— 放在循环前会破坏"停止要等保护单"的契约',
  );
});

test('★★★ 模拟盘的手工平仓不能调用交易所', () => {
  /*
   * ## 用户原话
   *
   * > 「[团队测试] 多智能体，我把它停止了，然后点全部平仓失败了」
   *
   * 界面报「0 个已平，2 个平仓失败。失败的标的仍未平掉，敞口还在，请立即处理」，
   * 而那两个持仓是**模拟盘的本地记录** —— 交易所上根本没有对应仓位
   *（币安返回 `-2022 ReduceOnly Order is rejected`）。
   *
   * **那句「敞口还在」是在吓唬操作员**：一分钱真实风险都没有。
   */
  const closeManually = /async closeManually\(symbol: string\)[\s\S]*?\n  \}/.exec(AUTO);
  assert.ok(closeManually !== null, '★ 应当能找到 closeManually');
  assert.ok(
    /if \(this\.isDryRun\) \{[\s\S]*?getMarkPrice/.test(closeManually![0]),
    '★ 模拟盘分支必须用标记价结算（模拟盘没有真实成交价）',
  );
  assert.ok(
    /不会编造价格/.test(closeManually![0]),
    '★ 标记价读不到时必须明确失败，不能编一个价格污染账本',
  );
});

test('★★★ 模拟盘的连接不能硬编码成实盘（effectiveDryRun）', () => {
  /*
   * 手工平仓/全部平仓/对账这三条路径会为「已停止的机器人」建一次性实例，
   * 那时 `dryRunOf()` 返回 null。原来那三处把 `false` 硬编码进
   * `connectionFor()` ⇒ 模拟盘的虚拟持仓被拿去真实交易所平仓。
   *
   * ⚠️ 那次没造成损失是**运气**：如果账户上恰巧有同名仓位（别的机器人
   * 或手工开的），模拟盘会把它平掉。
   */
  const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');
  assert.ok(
    /private effectiveDryRun\(/.test(MANAGER),
    '★ 必须有 effectiveDryRun（运行实例 → 数据库 → env 三级回落）',
  );
  const hardcoded = (MANAGER.match(/connectionFor\(traderId, trader\.exchangeAccountId, false\)/g) ?? [])
    .length;
  assert.equal(
    hardcoded,
    0,
    '★ 不能再有硬编码 false 的 connectionFor —— 那会让模拟盘碰真实交易所',
  );
});