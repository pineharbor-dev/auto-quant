import { useEffect, useRef, useState } from 'react';
import { api, type AiModelRow, type ExchangeAccountRow, type TraderRow } from '../lib/api';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';

/**
 * Edit a stopped trader. The API refuses configuration changes while the loop is
 * running, so the caller disables the entry point instead of failing here.
 */
export function TraderConfigModal({
  trader,
  open,
  onClose,
  onSaved,
}: {
  trader: TraderRow | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<ExchangeAccountRow[] | null>(null);
  const [models, setModels] = useState<AiModelRow[] | null>(null);
  const [strategies, setStrategies] = useState<Array<{ id: number; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [exchangeAccountId, setExchangeAccountId] = useState<number | ''>(0);
  const [aiModelId, setAiModelId] = useState(0);
  /*
   * `null` = 这个机器人不引用任何策略（AI 托管）。见 `Trader.strategyId` ——
   * 那种情况下下面根本不渲染这个控件，但状态本身要能装下这个值：
   * 编辑一台 AI 托管机器人时 `trader.strategyId` 就是 `null`。
   */
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  /** Set when the save left the trader with a 0 baseline. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  /**
   * 已经回填过表单的机器人 id —— 见下面那个 `useEffect` 里
   * 「轮询刷新不该重填表单」的说明（用户 2026-10-04 报的那个 BUG）。
   */
  const prefilledFor = useRef<string | null>(null);

  const selectedAccount = accounts?.find((row) => row.id === exchangeAccountId) ?? null;
  const equity = useExchangeEquity({
    open,
    /* `''` = 不绑账户（纯模拟盘）；`useExchangeEquity` 只在有账户时才读交易所。 */
    exchangeAccountId: exchangeAccountId === '' ? 0 : exchangeAccountId,
    // Editing starts from what the trader was created with; the read replaces
    // it as soon as the credential answers.
    prefill: trader?.initialEquity ?? 0,
    fallbackError: selectedAccount?.balanceError ?? null,
  });

  useEffect(() => {
    if (!open || !trader) return;
    /*
     * ⚠️ **回填只能在"刚打开 / 换了另一台机器人"时做一次。**
     *
     * 用户 2026-10-04 报的原话：
     *
     * > 「我修改赚大钱机器人的 AI 模型为 OPENCODE GO，**我什么都没做**，
     * >  页面上选择框会自动变成 command code」
     * > （补充）「**我还没点保存，页面上就自动变成 command code**」
     *
     * 根因就在这个 effect 的依赖：`[open, trader]` 里的 `trader` 是一个**对象**，
     * 而父组件那份来自**每几秒一次的轮询** —— 每次刷新都是新对象、引用变化，
     * 于是 effect 重跑，`setAiModelId(trader.aiModelId)` 把操作员刚选的模型**改回去**。
     *
     * 他选中 OpenCode GO 之后什么也没做，几秒后轮询到达，选择就自己变回了
     * 数据库里那个值（Command Code）—— 看起来像"这个控件不听话"。
     *
     * **这个 BUG 比"界面跳一下"更危险**：若不注意而直接点保存，
     * 会把机器人真的改回旧模型，而他以为自己改成功了。表单回填与"后台数据刷新"
     * 是两件事，前者只该在**打开那一刻**发生。
     *
     * 用 `trader.id` 当标记：轮询刷新（同一个 id）不再重填，换机器人（id 变了）才重填。
     * 依赖数组保持 `[open, trader]` 不动 —— 这样 `exhaustive-deps` 仍然满意，
     * 而"什么时候真的重填"由这里显式决定，不靠引用相等这种偶然性质。
     */
    const fillKey = String(trader.id);
    if (prefilledFor.current === fillKey) return;
    prefilledFor.current = fillKey;

    setName(trader.name);
    /* 纯模拟盘机器人没有账户（`null`）—— 编辑态下用 `''` 表示"不绑账户"。 */
    setExchangeAccountId(trader.exchangeAccountId ?? '');
    setAiModelId(trader.aiModelId);
    setStrategyId(trader.strategyId);
    setCycleIntervalMinutes(trader.cycleIntervalMinutes);
    setError(null);
    setBaselineWarning(null);

    let alive = true;
    void Promise.all([api.exchangeAccounts(), api.aiModels(), api.strategies()])
      .then(([a, m, s]) => {
        if (!alive) return;
        setAccounts(a);
        setModels(m);
        setStrategies(s.map((row) => ({ id: row.id, name: row.name })));
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [open, trader]);

  /* 关闭时清掉标记：下次打开（哪怕还是同一台）必须重新回填。 */
  useEffect(() => {
    if (!open) prefilledFor.current = null;
  }, [open]);

  if (!trader) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    setBaselineWarning(null);
    try {
      // Re-read only when the operator took the baseline over; otherwise the
      // stored value (or the server's own exchange read) stays authoritative.
      const manualEquity = equityPayload(equity);
      const updated = await api.updateTrader(trader.id, {
        name: name.trim(),
        /* `''` → `null`：允许把机器人改成"不绑账户"（纯模拟盘）。 */
        exchangeAccountId: exchangeAccountId === '' ? null : exchangeAccountId,
        aiModelId,
        /*
         * AI 托管时 `strategyId` 是 `null` —— 传 `undefined` 让服务端**不动这个字段**
         * （它本来就是空的）。绝不能传一个数字：那等于又把机器人绑回一个策略，
         * 而用户要的正是"完全独立"。
         */
        strategyId: strategyId ?? undefined,
        cycleIntervalMinutes,
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
      });

      if (updated.initialEquity <= 0) {
        setBaselineWarning(
          '已保存，但未能从交易所读取钱包余额，该机器人的起始权益为 0。在凭证可用之前，收益率等业绩指标都没有意义。',
        );
        return;
      }

      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = accounts && models && strategies;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`配置“${trader.name}”`}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!ready}>
            保存修改
          </Button>
        </>
      }
    >
      {!ready ? (
        <Spinner3 label="正在加载可选项" />
      ) : (
        <div className="space-y-3">
          <Field label="名称">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="交易所凭证" hint="测试网凭证无法下主网订单。">
            <Select value={exchangeAccountId} onChange={(e) => setExchangeAccountId(Number(e.target.value))}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} · {account.testnet ? '测试网' : '主网'} · {account.canTrade ? '可交易' : '只读'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="AI 模型">
            <Select value={aiModelId} onChange={(e) => setAiModelId(Number(e.target.value))}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.model}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            AI 托管机器人**不显示策略选择器**。

            理由与机器人页头那个「策略 #8」链接相同：对 AI 托管机器人来说，
            `strategies` 表里那一行**不生效**（生效的是 `agent_config_json`）。
            在这里给一个能改的下拉框，用户改完发现没有任何变化 ——
            **一个能操作但无效果的控件，比一个不存在的控件更糟**：
            它会让人怀疑是自己操作错了，而不是这个控件本来就没用。
          */}
          {trader.mode === 'ai_managed' ? (
            <Field
              label="策略"
              hint="AI 托管机器人不使用策略 —— 参数与交易提示词由 AI 自己设定并持续调整。"
            >
              <div className="text-base text-ink-faint">智能托管（不使用策略参数）</div>
            </Field>
          ) : (
            <Field label="策略">
              <Select value={strategyId ?? ''} onChange={(e) => setStrategyId(Number(e.target.value))}>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="周期间隔（分钟）">
            <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
          </Field>

          {/* 起始权益 is read from the selected credential, not typed -------- */}
          <EquitySourceField state={equity} editing />

          {baselineWarning && (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
              <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-md border border-base-800 bg-base-850/50 px-3 py-2">
            <Badge tone="muted" className="mt-px">
              不可变更
            </Badge>
            <span className="text-xs leading-relaxed text-ink-lo">
              模拟与实盘在每次启动时选择，不在此处保存。最近周期 #{trader.lastCycleNumber}。
              停止中的机器人保存后会立即生效，但不会自动重新启动。
            </span>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
