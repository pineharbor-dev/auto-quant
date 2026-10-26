/**
 * 模拟钱包的回归测试（用户 2026-10-27 需求）。
 *
 * 用户原话：
 * > 「创建模拟盘的时候，不应该只需要绑定钱包。还有，模拟盘不应该根据真实钱包的
 * >  余额，而应该可以自定义模拟盘的余额。也就是说，无需真实账户就能开启模拟盘机器人。」
 *
 * 这个模块是那条需求的核心：它让模拟盘的账户读数**完全不碰交易所**。
 * 所以测试要钉住的不只是算式，还有"它不会被真实余额污染"这件事。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { paperAccountState, validateStartingBalance } from './paperWallet.js';

test('★★★ 起始余额就是钱包余额，与任何真实账户无关', () => {
  const state = paperAccountState({
    startingBalance: 5000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    marginUsed: 0,
  });

  assert.equal(state.walletBalance, 5000, '★ 操作员填多少就是多少');
  assert.equal(state.equity, 5000);
  assert.equal(state.availableBalance, 5000);
});

test('★★★ 已实现净盈亏直接进钱包余额（不是"百分比"或估算）', () => {
  const state = paperAccountState({
    startingBalance: 1000,
    realizedPnl: 250.5,
    unrealizedPnl: 0,
    marginUsed: 0,
  });

  assert.equal(state.walletBalance, 1250.5, '★ 1000 + 250.5');
  assert.equal(state.equity, 1250.5);
});

test('★★★ 亏损同样如实反映（不夹到 0 以上）', () => {
  const state = paperAccountState({
    startingBalance: 1000,
    realizedPnl: -300,
    unrealizedPnl: 0,
    marginUsed: 0,
  });

  assert.equal(state.walletBalance, 700, '★ 亏了就是 700，不能被"保护"成 1000');
});

test('★★★ 权益 = 钱包 + 浮盈；可用 = 权益 − 保证金', () => {
  const state = paperAccountState({
    startingBalance: 1000,
    realizedPnl: 100,
    unrealizedPnl: 50,
    marginUsed: 200,
  });

  assert.equal(state.walletBalance, 1100);
  assert.equal(state.equity, 1150, '★ 1100 + 50');
  assert.equal(state.availableBalance, 950, '★ 1150 − 200');
  assert.equal(state.marginUsed, 200);
  assert.equal(state.unrealizedPnl, 50);
});

test('★ 可用余额不出现负数（穿仓时按交易所口径夹到 0）', () => {
  const state = paperAccountState({
    startingBalance: 100,
    realizedPnl: -90,
    unrealizedPnl: -50,
    marginUsed: 80,
  });

  assert.ok(state.availableBalance >= 0, `可用余额不能为负（实际 ${state.availableBalance}）`);
  assert.equal(state.availableBalance, 0);
  /* 但权益本身**必须**如实为负 —— 那是"亏了多少"的事实，不能藏。 */
  assert.equal(state.equity, -40, '权益如实反映穿仓，不夹零');
});

test('★ 脏输入（NaN / Infinity）退化为 0，而不是让整个账户读数变成 NaN', () => {
  const state = paperAccountState({
    startingBalance: Number.NaN,
    realizedPnl: Number.POSITIVE_INFINITY,
    unrealizedPnl: Number.NaN,
    marginUsed: Number.NEGATIVE_INFINITY,
  });

  for (const [key, value] of Object.entries(state)) {
    assert.ok(
      Number.isFinite(value),
      `★ ${key} 必须是有限数（实际 ${value}）—— NaN 会让界面显示成空白或 "NaN"`,
    );
  }
});

test('★ 模拟盘没有"挂单占用保证金"这一层', () => {
  const state = paperAccountState({
    startingBalance: 1000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    marginUsed: 0,
  });

  assert.equal(state.openOrderMargin, 0);
});

/* -------------------------------------------------------------------------- */
/*  起始余额校验                                                               */
/* -------------------------------------------------------------------------- */

test('★ 合法余额通过校验', () => {
  for (const value of [10, 100, 1000, 5000, 1_000_000]) {
    assert.equal(validateStartingBalance(value), null, `${value} 应当合法`);
  }
});

test('★ 非法余额给出面向操作员的原因（而不是静默接受）', () => {
  assert.ok(validateStartingBalance(0), '0 必须被拒 —— 0 余额会让每一笔开仓都被拒');
  assert.ok(validateStartingBalance(-100), '负数必须被拒');
  assert.ok(validateStartingBalance(Number.NaN), 'NaN 必须被拒');
  assert.ok(validateStartingBalance(5), '太小必须被拒（低于最小下单量）');
  assert.ok(validateStartingBalance(2_000_000_000), '过大必须被拒（防手滑多按 0）');
});

test('★ 拒绝时给出的原因里带具体数字（便于操作员判断该怎么改）', () => {
  const tooSmall = validateStartingBalance(5);
  assert.ok(tooSmall && /10/.test(tooSmall), `原因里应写明下限（实际：${tooSmall}）`);

  const tooBig = validateStartingBalance(2_000_000_000);
  assert.ok(tooBig && /10 亿|1000000000/.test(tooBig), `原因里应写明上限（实际：${tooBig}）`);
});
