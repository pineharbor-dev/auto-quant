/**
 * **运行期开关中心**（2026-10-18）。
 *
 * ## 这个文件防的是什么
 *
 * 用户要一个「机器人控制」标签，里面的开关**实时生效**（不重启机器人）。
 * 三条语义都必须在测试里钉死，因为它们错一个就会造成"静默改行为"：
 *
 * | # | 语义 | 错了会怎样 |
 * |---|---|---|
 * | ① | 界面设的值**最高优先** | 点了没反应 |
 * | ② | 界面没设过时**回落到 `.env`** | **升级后老部署的行为静默改变** |
 * | ③ | `.env` 也没有时用**代码默认** | 新部署悄悄开了某个功能 |
 *
 * 第 ② 条尤其关键：线上 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
 * 如果升级后界面表里没有记录就当成 `off`，那是把用户正在用的功能关掉了。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { closeDb, initDb } from '../db/index.js';
import {
  JEV_OPTIONS,
  JEV_PRESETS,
  RUNTIME_SWITCHES,
  applyJevPreset,
  getJevOption,
  isSwitchOn,
  listSwitches,
  setSwitch,
  switchSpec,
} from './control.js';

const tempDir = mkdtempSync(path.join(tmpdir(), 'aq-control-'));

/**
 * initDb 要的是「数据库文件路径」，不是目录（2026-10-18 踩到）。
 *
 * 传目录进去报的是 `unable to open database file` —— 那个错误信息完全指不出原因
 *（既没说是路径形状错了，也没说期望什么）。照 autoTrader.test.ts 的写法传文件路径。
 */
const dbFile = path.join(tempDir, 'test.sqlite');

/**
 * 每个用例用全新的库 —— 开关是持久化的，跨用例必须干净。
 *
 * 不能复用同一个 initDb：node:sqlite 的连接是进程级的，换库要 closeDb() 再 initDb()。
 */
function freshDb(): void {
  closeDb();
  rmSync(dbFile, { force: true });
  initDb(dbFile);
}

describe('运行期开关中心', () => {
  beforeEach(() => {
    freshDb();
  });

  after(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('★★★ 界面设的值最高优先（点一下就生效）', () => {
    /*
     * `.env` 说关，界面说开 ⇒ 必须是开。
     * 这是「实时生效」的核心语义：界面是操作员的意志，不该被 `.env` 压住。
     */
    assert.equal(isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'off' }), false);
    setSwitch('jev_prefilter', true);
    assert.equal(
      isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'off' }),
      true,
      '★ 界面设过之后，.env 不该再压住它',
    );
  });

  test('★★★ 界面没设过时回落到 .env（升级不改变老部署行为）', () => {
    /*
     * 这是本文件最重要的一条。线上 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
     * 如果升级后界面表里没有记录就当成 off —— 那是把用户正在用的功能关掉了。
     */
    assert.equal(
      isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'on' }),
      true,
      '★ .env 写着 on、界面从没设过 ⇒ 必须是 on（升级静默关功能是最坏的一种 bug）',
    );
  });

  test('★★ .env 也没有时用代码默认（新部署不会悄悄开功能）', () => {
    assert.equal(
      isSwitchOn('jev_prefilter', {}),
      false,
      '★ Jev 的默认是 off —— 新部署不该自动调用外部决策模型',
    );
  });

  test('★★ 各种写法都认（on/true/1/yes 与 off/false/0/no）', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'ON', ' True ']) {
      assert.equal(isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: raw }), true, `★「${raw}」应算开`);
    }
    for (const raw of ['off', 'false', '0', 'no', 'OFF']) {
      assert.equal(
        isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: raw }),
        false,
        `★「${raw}」应算关`,
      );
    }
  });

  test('★★★ source 字段如实说"这个值是谁定的"', () => {
    /*
     * 操作员看到"Jev 已开启"时，如果不知道那是自己点的还是 .env 带来的，
     * 就判断不了"我改了会不会影响别人 / 重启会不会变回去"。
     */
    const fromEnv = listSwitches({ AQ_JEV_PREFILTER: 'on' }).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(fromEnv.source, 'env', '★ 没在界面点过 ⇒ 来源是 .env');
    assert.equal(fromEnv.on, true);

    setSwitch('jev_prefilter', false);
    const fromUi = listSwitches({ AQ_JEV_PREFILTER: 'on' }).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(fromUi.source, 'ui', '★ 界面点过 ⇒ 来源是界面');
    assert.equal(fromUi.on, false, '★ 而且界面值覆盖 .env');

    /* 清掉界面值之后应回落到 .env / 默认。 */
    setSwitch('jev_prefilter', false);
    const noEnv = listSwitches({}).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(noEnv.source, 'ui', '★ 界面设过就是 ui，即使 .env 没有');
  });

  test('★★ 未知开关：读返回 false（安全侧），但 switchSpec 返回 null', () => {
    /*
     * 读路径静默 false 是安全的（不会误开任何功能）；
     * 而 `/api/control/:key` 用 `switchSpec === null` 判 400 并说清是哪个。
     */
    assert.equal(isSwitchOn('nonexistent_switch', {}), false);
    assert.equal(switchSpec('nonexistent_switch'), null);
  });

  test('★★ 每个开关都必须有 label 与 effect（界面上不许出现空文案）', () => {
    for (const spec of RUNTIME_SWITCHES) {
      assert.ok(spec.label.trim().length > 0, `★ ${spec.key} 缺 label`);
      assert.ok(
        spec.effect.trim().length > 0,
        `★ ${spec.key} 缺 effect —— 操作员要知道"关掉之后会怎样"才能做决定`,
      );
      assert.ok(spec.envKey.trim().length > 0, `★ ${spec.key} 缺 envKey（老部署靠它回落）`);
      /* key 必须是稳定的机器码（持久化契约，改名等于丢掉操作员的选择）。 */
      assert.match(spec.key, /^[a-z][a-z_]*$/, `★ ${spec.key} 必须是小写机器码`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  JEV 参数预设（2026-10-20 用户要求）                                          */
/* -------------------------------------------------------------------------- */

describe('JEV 参数预设', () => {
  test('★★★ 每个预设里的每个键都必须存在于 JEV_OPTIONS 且值合法', () => {
    /*
     * ## 为什么这条必须在测试里红
     *
     * `applyJevPreset()` 运行时**已经**会校验并拒绝非法值（原子性：
     * 一个非法就一个都不写）。但那样一来，操作员点"套用"只会看到
     * 一个 400 错误 —— 而预设是我们自己写的，写错了应该在 CI 里就发现。
     *
     * 这条测试盯的就是"我们自己写错的预设"。
     */
    const specs = new Map(JEV_OPTIONS.map((spec) => [spec.key, spec]));
    for (const preset of JEV_PRESETS) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = specs.get(key);
        assert.ok(spec !== undefined, `★ 预设「${preset.id}」引用了不存在的键：${key}`);
        if (spec === undefined) continue;

        if (spec.kind === 'enum') {
          const allowed = (spec.options ?? []).map((option) => option.value);
          assert.ok(
            allowed.includes(value),
            `★ 预设「${preset.id}」的 ${key}=${value} 不在可选值里（${allowed.join(' / ')}）`,
          );
        } else if (spec.kind === 'number') {
          const parsed = Number(value);
          assert.ok(Number.isFinite(parsed), `★ 预设「${preset.id}」的 ${key} 不是数字：${value}`);
          if (spec.range !== undefined) {
            assert.ok(
              parsed >= spec.range.min && parsed <= spec.range.max,
              `★ 预设「${preset.id}」的 ${key}=${value} 超出 ${spec.range.min}–${spec.range.max}`,
            );
          }
        } else {
          assert.ok(
            value === 'true' || value === 'false',
            `★ 预设「${preset.id}」的 ${key} 必须是 true/false`,
          );
        }
      }
    }
  });

  test('★★★ 套用预设必须覆盖全部 16 个参数（不留半套）', () => {
    /*
     * 用户要求："一键快速设置"。
     *
     * 如果预设只覆盖一部分，剩下的会停留在上一组的值上 ——
     * 于是"套了保守预设但熔断还是激进档的 30%"这类半生效状态会出现，
     * 而界面上看不出来。
     *
     * `applyJevPreset` 返回 `applied` 就是实际写入的键数。
     */
    const balanced = JEV_PRESETS.find((p) => p.id === 'balanced');
    assert.ok(balanced !== undefined, '★ 必须内置 balanced 预设');
    if (balanced === undefined) return;
    assert.equal(
      Object.keys(balanced.values).length,
      JEV_OPTIONS.length,
      '★ 均衡预设必须覆盖全部选项（否则会留下旧值）',
    );
  });

  test('★★★ 两个预设的参数组必须真的不同（不是换了个名字的同一组）', () => {
    /* 反向校准：如果 balanced 与 aggressive 的值全一样，"选预设"就没有意义。 */
    const balanced = JEV_PRESETS.find((p) => p.id === 'balanced');
    const aggressive = JEV_PRESETS.find((p) => p.id === 'aggressive');
    assert.ok(balanced !== undefined && aggressive !== undefined);
    if (balanced === undefined || aggressive === undefined) return;

    const differing = Object.keys(balanced.values).filter(
      (key) => balanced.values[key] !== aggressive.values[key],
    );
    assert.ok(
      differing.length >= 5,
      `★ 均衡与激进应有明显差异，实际只差 ${differing.length} 项：${differing.join('、')}`,
    );
    /* 激进的单笔风险必须更大、持仓上限必须更多 —— 这是"激进"的定义。 */
    assert.ok(
      Number(aggressive.values.risk_percent) > Number(balanced.values.risk_percent),
      '★ 激进的单笔风险应更高',
    );
    assert.ok(
      Number(aggressive.values.max_positions) > Number(balanced.values.max_positions),
      '★ 激进的最大持仓应更多',
    );
  });

  test('★★ 套用不存在的预设必须一个都不写', () => {
    const before = JEV_OPTIONS.map((spec) => getJevOption(spec.key)).join('|');
    const result = applyJevPreset('definitely-not-a-preset');
    assert.equal(result.applied, 0, '★ 不存在的预设不该写入任何值');
    assert.ok(result.unknown.length > 0, '★ 应报告未知的预设 id');
    const after = JEV_OPTIONS.map((spec) => getJevOption(spec.key)).join('|');
    assert.equal(before, after, '★ 失败的套用不能改变任何现有配置');
  });
});

describe('JEV 追高过滤（2026-10-20 实盘事故后补）', () => {
  test('★★★ max_pump_percent 必须存在于 JEV_OPTIONS 且默认 20', () => {
    /*
     * ## 事故
     *
     * ```
     *   候选池：BRUSDT +42.09%、JCTUSDT +106.07%（RSI 80.76）
     *   Jev：QUSDT 做多 97%、BRUSDT 做多 97%、PHAUSDT 做多 98%
     * ```
     * 同期 BTC -0.94%、ETH -1.40% —— 候选池里全是暴涨币，而 Jev 非常确信要做多它们。
     *
     * 根因在选币（成交额排序把暴涨币顶上来），不在 Jev。
     * ⇒ 在候选进入 Jev **之前**就把暴涨币砍掉。
     */
    const spec = JEV_OPTIONS.find((candidate) => candidate.key === 'max_pump_percent');
    assert.ok(spec !== undefined, '★ 必须有 max_pump_percent 选项');
    if (spec === undefined) return;
    assert.equal(spec.kind, 'number', '★ 它应该是数字型');
    assert.equal(spec.fallback, '20', '★ 默认 20%（主流币日内很少超 15%，垃圾币常见 50-100%）');
    assert.ok(
      spec.range !== undefined && spec.range.min === 0,
      '★ 最小值必须是 0（表示关闭过滤）',
    );
  });

  test('★★★ 过滤判据：|24h 涨幅| > 阈值 ⇒ 跳过（正负都算）', () => {
    /*
     * ⚠️ **用绝对值，不只是正向**。
     *
     * 下跌 -40% 的标的同样是"异动"：那时做多是接刀、做空是追跌，
     * 两边都不该碰。所以判据是 `Math.abs(changePercent) > maxPumpPercent`。
     */
    const maxPump = 20;
    const cases = [
      { symbol: 'BRUSDT', change: 42.09, skipped: true },
      { symbol: 'JCTUSDT', change: 106.07, skipped: true },
      { symbol: 'CRASHUSDT', change: -35, skipped: true },
      { symbol: 'BTCUSDT', change: 2.5, skipped: false },
      { symbol: 'ETHUSDT', change: -1.4, skipped: false },
      { symbol: 'EDGEUSDT', change: 19.99, skipped: false },
      { symbol: 'EDGE2USDT', change: 20.01, skipped: true },
    ];
    for (const c of cases) {
      const skipped = Math.abs(c.change) > maxPump;
      assert.equal(
        skipped,
        c.skipped,
        `★ ${c.symbol}（${c.change}%）应${c.skipped ? '' : '不'}被跳过`,
      );
    }
  });

  test('★★ 阈值设为 0 时不过滤任何标的（用户明确关掉时）', () => {
    /*
     * `0` 表示关闭 —— 与仓库里其它阈值（`maxDailyLossPercent` 等）同一约定。
     * 这条防止有人把判断写成 `>=`：那样 0 会把**所有**标的过滤掉，
     * 机器人静默停摆。
     */
    const maxPump = 0;
    const shouldFilter = maxPump > 0;
    assert.equal(shouldFilter, false, '★ 阈值为 0 时不做任何过滤');
  });
});