/**
 * **权益曲线必须和「账户余额」对得上**（2026-10-13，用户两次反馈后定稿）。
 *
 * ## 用户的两次反馈
 *
 * **第一次**：
 * > 「图表上显示和实际账号对不上」
 *
 * 我查到：曲线画 `equity`（归属口径 = `initial_equity + Σ本机器人已平仓净额`），
 * 而指标卡「账户余额」显示 `accountEquity`（共享钱包真实权益）。
 * 实测 `#10`：`108.47` vs `97.80`，差 `10.67` = 同钱包上 `#9`/`#11` 的亏损。
 *
 * **我第一版的修法是错的** —— 我把两个口径并排显示 + 解释差额来源：
 * ```
 *   本段变化  +$8.58 USDT (+8.57%)  本机器人归属
 *   同期账户  −$2.10 USDT (−2.09%)  同一钱包含其他机器人（…多 +$10.67）
 * ```
 *
 * **第二次反馈（原话）**：
 * > 「图标完全乱套了，上面叫归属权益、同期账户、本段变化，一大堆莫名其妙的，
 * >  搞这么多没用的画蛇添足，无端增加BUG？图标不就是最真实准确简单的，
 * >  **账号余额、总盈亏能对上的吗**？」
 *
 * **他是对的。** 那个修法把"数字对不上"换成了"要读两行解释才懂" ——
 * 而问题有更简单的解：**让曲线画账户口径**。
 *
 * ## 定稿方案
 *
 * ```
 *   曲线 / 缩略条 / 「本段变化」  →  accountEquity（与「账户余额」同源）
 *   「交易盈亏」指标卡            →  仍走它的口径（那回答的是另一个问题）
 * ```
 * 于是屏幕上**只有一个权益数字**，不存在"对不上"这件事。
 *
 * ⚠️ 这个测试扫的是源码文本（注释里的同名字串会命中）——
 * 所以只断言"存在"，不断言"不存在"（见 `testUtils/sourceText.ts` 的教训）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const PAGE = readFileSync(new URL('./TraderPage.tsx', import.meta.url), 'utf8');
const CHARTS = readFileSync(new URL('../components/DashboardCharts.tsx', import.meta.url), 'utf8');

test('★★★ 图表组件必须支持 `metric`，且默认是【账户口径】', () => {
  assert.ok(
    /metric\s*=\s*'account'/.test(CHARTS),
    '★ `DashboardEquityChart` 的 `metric` 默认值必须是 `account`（曲线要与指标卡对上）',
  );
  assert.ok(
    /snapshot\.accountEquity/.test(CHARTS),
    '★ 必须真的去读 `accountEquity`（不是只加了个参数）',
  );
});

test('★★★ 账户口径为 0 时必须回落到归属口径（否则曲线会砸到地板）', () => {
  /*
   * ⚠️ 迁移前的旧行 `account_equity` 是回填的，而**完全没有值时它是 `0`**
   *（见 `db/schema.ts` 的 M4 取舍说明）。直接用 0 会把曲线砸到地板，
   * 而那条曲线**看起来完全正常** —— 只是数字全错。
   */
  assert.ok(
    /accountEquity\s*>\s*0/.test(CHARTS),
    '★ 必须有 `accountEquity > 0` 的回落判据',
  );
});

test('★★★ 「本段变化」必须与曲线同口径（按模式选）', () => {
  assert.ok(
    /windowFirst\s*=/.test(PAGE) && /windowAccountFirst/.test(PAGE),
    '★ `windowFirst` 必须优先取账户口径',
  );
  assert.ok(
    /windowLast\s*=/.test(PAGE),
    '★ 必须有 `windowLast`（末端用实时账户权益，与指标卡严格相等）',
  );
  assert.ok(
    /liveAccountEquityForCurve/.test(PAGE),
    '★ 末端必须优先用实时账户权益（与「账户余额」同源）',
  );
  /*
   * ⚠️ 2026-10-15：首末端都要**跟着 `curveMetric` 走** —— 否则模拟盘上
   * "本段变化"算的是账户口径（恒 0），而线画的是归属口径（在变），两者对不上。
   */
  assert.ok(
    /curveMetric === 'attributed'/.test(PAGE),
    '★ 首末端必须按 `curveMetric` 分支（模拟盘走归属口径）',
  );
});

test('★★★ 缩略条必须与展开态【同一个口径】（2026-10-15 改成按模式选）', () => {
  /*
   * ## 原来这条钉的是"一律账户口径"
   *
   * 2026-10-13 用户要求曲线与「账户余额」指标卡对上，所以统一走 `accountEquity`。
   * 那对**实盘**是对的。
   *
   * ## 但模拟盘上它必然是一条平线（用户实测报过）
   *
   * `#11`（模拟盘）的成交是本地模拟的、**从不触碰真实钱包**：
   * ```
   *   45 条快照：equity（归属）23 种值 · account_equity（账户）【1 种值】
   * ```
   * 所以口径必须按模式选，而**收起态与展开态必须选同一个** ——
   * 否则同一个东西在两种视图下画的是两条不同的线。
   */
  assert.ok(
    /curveMetric === 'attributed'/.test(PAGE),
    '★ 缩略条必须按 `curveMetric` 取口径',
  );
  assert.ok(
    /const curveMetric: 'account' \| 'attributed' = isDryRun \? 'attributed' : 'account'/.test(PAGE),
    '★ 口径的选择规则：模拟盘 → 归属，实盘 → 账户',
  );
  /*
   * ⚠️ 展开态那个组件也要收到同一个 `metric`（不能写死 `"account"`）。
   */
  assert.ok(
    /metric=\{curveMetric\}/.test(PAGE),
    '★ `DashboardEquityChart` 必须收到 `metric={curveMetric}`（不能写死）',
  );
});

test('★★★ 那一行必须只有【一行】（对照行已按用户要求删除）', () => {
  /*
   * ⚠️ 用户的原话是「一大堆莫名其妙的，搞这么多没用的画蛇添足」。
   * 所以这里钉住"那一行的渲染里只有一个 flex 容器" ——
   * 如果谁再加回第二行解释，这条会红，而人会回来看这段注释。
   */
  const i = PAGE.indexOf('function EquityWindowLine');
  assert.ok(i >= 0, '★ 找不到 `EquityWindowLine`');
  const body = PAGE.slice(i, i + 2600);
  const divCount = (body.match(/<div className="mb-2/g) ?? []).length;
  assert.equal(divCount, 1, `★ 那一行只能有一个容器（实际 ${divCount} 个）`);
  assert.ok(
    !/account:\s*\{/.test(body),
    '★ 不该再有 `account` 这个 prop（对照行已删除）',
  );
});


/* -------------------------------------------------------------------------- */
/*  模拟盘的「账户余额」必须与列表页「归属权益」一致（2026-10-15 用户实测）      */
/* -------------------------------------------------------------------------- */

test('★★★ 模拟盘必须显示模拟权益，不能显示没动过的真实钱包', () => {
  /*
   * ## 用户的原话
   * > 「详情的账户余额还是显示不对，但是详情页面似乎是对的」
   *
   * ## 他看到的事实（`#11`，模拟盘）
   * ```
   *   详情页「账户余额」  20.75     ← 真实钱包，一分没动
   *   详情页「交易盈亏」  +$0.09    ← 它赚了 0.09
   *   列表页「归属权益」  $20.84    ← 20.75 + 0.09（这里是对的）
   * ```
   * **"赚了钱、余额却不变"** —— 同一屏两个数互相矛盾。
   *
   * ## 根因（与卡片 $0.00、曲线平线完全同源）
   * 模拟盘的成交是本地模拟的，**从不触碰真实钱包**，
   * 所以交易所那个 `account.equity` 恒等于起始值
   *（实测 45 条快照里 `account_equity` 只有 **1 种值**，而 `equity` 有 23 种）。
   *
   * 所以模拟盘那一格必须显示 `calibratedEquity`（= 起始 + 已实现 + 浮盈），
   * 它与列表页的「归属权益」**逐字相等**。
   */
  const page = codeOnly(PAGE);
  assert.ok(
    /const useSimulatedBalance = isDryRun && stats !== undefined;/.test(page),
    '★ 必须有"模拟盘走模拟权益"的开关',
  );
  assert.ok(
    /useSimulatedBalance\s*\?\s*fmtNum\(calibratedEquity, 2\)/.test(page),
    '★ 模拟盘的账户余额必须是 `calibratedEquity`（与列表页「归属权益」同源）',
  );
  /*
   * ⚠️ 实盘那一支必须还在（不能为了修模拟盘把实盘也换掉 ——
   * 用户明确要求过"账户余额必须与交易所对得上"）。
   */
  assert.ok(
    /account\s*\?\s*fmtNum\(account\.equity, 2\)/.test(page),
    '★ 实盘仍必须显示交易所的真实账户权益',
  );
});

test('★★★ `calibratedEquity` 与列表页「归属权益」必须是同一个算法', () => {
  /*
   * ⚠️ 两页显示同一个概念时，**算法必须只有一份**。
   * 本项目为此吃过四次亏（用户原话：「你做事情只做一半？？」）。
   *
   * 服务端的 `attributedEquity()` 是：
   * ```
   *   initialEquity + netRealizedPnl + unrealizedPnl
   * ```
   * 而详情页的 `calibratedEquity` 是：
   * ```
   *   initialEquity + realized + unrealized
   * ```
   * 两者同构（`realized` 就是校准后的净额）。
   */
  const page = codeOnly(PAGE);
  assert.ok(
    /const calibratedEquity = initialEquity \+ realized \+ unrealized;/.test(page),
    '★ calibratedEquity 必须与 attributedEquity 同构',
  );
  const repo = readFileSync(
    new URL('../../../server/src/store/repositories.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    /return initialEquity \+ netRealizedPnl \+ unrealizedPnl;/.test(repo),
    '★ 服务端的 attributedEquity 仍是同一个公式',
  );
});

/* -------------------------------------------------------------------------- */
/*  曲线口径不能因为机器人停止而改变（2026-10-21 用户报告）                        */
/* -------------------------------------------------------------------------- */

test('★★★ 曲线口径必须用 isPaperView 的三级回落，不能只读 stats.dryRun', () => {
  /*
   * ## 用户原话
   *
   * > 「图表也和 JEV 一样有 BUG，停了就不显示了」
   *
   * ## 实测
   *
   * ```
   *   #11（模拟盘）运行中 → 曲线有形状 ✅
   *   点了「停止」       → 曲线变成一条平线 ❌
   *
   *   归属权益 20.18 ~ 21.84（极差 1.65，有波动）
   *   账户权益 20.7519 ~ 20.7519（极差 0.0，完全不变）
   * ```
   *
   * ## 根因
   *
   * `stats` 是**运行态摘要**：机器人停止后 `statsMap[traderId]` 为 `null`，
   * 于是 `isDryRun = (stats?.dryRun === true)` 变成 `false` ⇒
   * 曲线切到 `account` 口径（共享钱包真实权益，模拟盘从不触碰它）⇒ 一条平线。
   *
   * **「是不是模拟盘」是持久化属性，不该随运行状态翻转。**
   */
  const PAGE = readFileSync(new URL('./TraderPage.tsx', import.meta.url), 'utf8');

  /*
   * 判据一：`isDryRun` 必须由 `isPaperView(` 决定。
   * 用位置比较：找到 `const isDryRun =` 之后 200 字符内必须有 `isPaperView`。
   */
  const idx = PAGE.indexOf('const isDryRun =');
  assert.ok(idx > 0, '★ 应当能找到 `const isDryRun =`');
  const window = PAGE.slice(idx, idx + 200);
  assert.ok(
    /isPaperView\(/.test(window),
    '★ `isDryRun` 必须由 `isPaperView()` 决定 —— 只读 `stats.dryRun` 会让曲线在停止后切成账户口径（平线）',
  );

  /*
   * 判据二：三级回落必须都传了。
   * 少任何一级都会在某种状态下误判。
   */
  for (const key of ['runtimeDryRun', 'persistedDryRun', 'processDryRun']) {
    assert.ok(
      PAGE.includes(key),
      `★ 必须传 ${key}（三级回落少一级就会在某种状态下误判）`,
    );
  }

  /*
   * 判据三：`curveMetric` 那一行必须由 `isDryRun`（三级回落）决定，
   * **不能**直接看 `stats.dryRun`。
   *
   * ⚠️ 只查 `curveMetric` 附近，不全局禁止 `stats?.dryRun` ——
   * 页头那两个徽章（「模拟模式 —— 不会真的下单」）的语义**确实**是
   * "此刻在不在模拟模式下运行"，那是运行时事实，用 `stats.dryRun` 是对的。
   * 差别在于：**曲线口径**是持久化属性（不该随运行状态翻转），
   * 而**运行态徽章**恰恰要说运行状态。
   */
  const metricIdx = PAGE.indexOf('const curveMetric');
  assert.ok(metricIdx > 0, '★ 应当能找到 `const curveMetric`');
  const metricWindow = PAGE.slice(Math.max(0, metricIdx - 120), metricIdx + 120);
  assert.ok(
    /isDryRun \? 'attributed' : 'account'/.test(metricWindow),
    '★ 曲线口径必须按 `isDryRun`（三级回落）选，不能直接看 stats.dryRun',
  );
});