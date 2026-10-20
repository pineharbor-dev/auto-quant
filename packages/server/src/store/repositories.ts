import type {
  AiModelConfig,
  CloseReason,
  DecisionRecord,
  EquitySnapshot,
  ExchangeAccount,
  ExchangeId,
  ExecutionLogEntry,
  LlmProviderId,
  MarginMode,
  OrderRecord,
  PositionView,
  StrategyConfig,
  StrategyRecord,
  TradeRecord,
  Trader,
  TraderMode,
  TraderStats,
  TraderStatus,
  User,
} from '@aq/shared';
import { StrategyConfigSchema, beijingDayStartIso } from '@aq/shared';
/* 净盈亏的唯一算式 —— 见 `netPnlOf` 的注释（资金费的符号）。 */
import { netPnlOf } from '../binance/income.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('store');

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Users                                                                      */
/* -------------------------------------------------------------------------- */

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  credentials_changed_at: string;
}

export const users = {
  count(): number {
    return getDb().count('SELECT COUNT(*) AS n FROM users');
  },

  findByUsername(username: string): (User & { passwordHash: string }) | undefined {
    const row = getDb().get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role === 'owner' ? 'owner' : 'user',
      createdAt: row.created_at,
      passwordHash: row.password_hash,
    };
  },

  findById(id: number): User | undefined {
    const row = getDb().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role === 'owner' ? 'owner' : 'user',
      createdAt: row.created_at,
    };
  },

  create(username: string, passwordHash: string, role: 'owner' | 'user'): User {
    const { lastInsertRowid } = getDb().run(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      username,
      passwordHash,
      role,
      now(),
    );
    log.info(`created ${role} account "${username}"`);
    return { id: lastInsertRowid, username, role, createdAt: now() };
  },

  updatePassword(id: number, passwordHash: string): void {
    getDb().run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id);
  },

  /**
   * 改用户名。
   *
   * 调用方必须**先**自行检查新用户名未被占用。数据库上的 UNIQUE 约束虽然也会拦住，
   * 但抛出来的是一条 SQLite 错误，没法直接展示给用户。
   */
  updateUsername(id: number, username: string): void {
    getDb().run('UPDATE users SET username = ? WHERE id = ?', username, id);
    log.info(`账户 #${id} 已改名为「${username}」`);
  },

  /** 所有管理员账号，按创建时间升序。用于密码重置时找到要改的那个账号。 */
  listOwners(): User[] {
    return getDb()
      .all<UserRow>("SELECT * FROM users WHERE role = 'owner' ORDER BY id")
      .map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role === 'owner' ? 'owner' : 'user',
        createdAt: row.created_at,
      }));
  },

  /**
   * 该账户最后一次修改凭据的时间（epoch 毫秒），从未改过则为 `null`。
   *
   * 供 JWT 撤销使用：签发令牌时把这个值写进载荷，校验时与它等值比较，
   * 不等即说明令牌是在凭据变更之前签发的，必须拒绝。见 `api/auth.ts`。
   */
  credentialsChangedAt(id: number): number | null {
    const row = getDb().get<{ credentials_changed_at: string }>(
      'SELECT credentials_changed_at FROM users WHERE id = ?',
      id,
    );
    const raw = row?.credentials_changed_at;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  },

  /**
   * 记录一次凭据变更，作废该账户此前签发的全部令牌。
   *
   * 调用点必须在**重新签发**令牌之前调用它，否则新令牌会带着旧的时间戳，
   * 一签发就是失效的（用户会被立刻踢回登录页，且看不出原因）。
   */
  markCredentialsChanged(id: number): number {
    const timestamp = now();
    getDb().run('UPDATE users SET credentials_changed_at = ? WHERE id = ?', timestamp, id);
    log.info(`账户 #${id} 的凭据已变更 —— 之前签发的所有登录会话已作废`);
    return Date.parse(timestamp);
  },
};

/* -------------------------------------------------------------------------- */
/*  Exchange accounts                                                          */
/* -------------------------------------------------------------------------- */

interface ExchangeRow {
  id: number;
  exchange: string;
  label: string;
  api_key: string;
  api_secret_enc: string;
  passphrase_enc: string;
  testnet: number;
  can_trade: number;
  created_at: string;
  updated_at: string;
}

function toExchangeAccount(row: ExchangeRow): ExchangeAccount {
  return {
    id: row.id,
    exchange: row.exchange as ExchangeId,
    label: row.label,
    apiKey: row.api_key,
    hasSecret: row.api_secret_enc.length > 0,
    testnet: row.testnet === 1,
    canTrade: row.can_trade === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const exchanges = {
  list(): ExchangeAccount[] {
    return getDb().all<ExchangeRow>('SELECT * FROM exchange_accounts ORDER BY id').map(toExchangeAccount);
  },

  get(id: number): ExchangeAccount | undefined {
    const row = getDb().get<ExchangeRow>('SELECT * FROM exchange_accounts WHERE id = ?', id);
    return row ? toExchangeAccount(row) : undefined;
  },

  /** Full row including the encrypted secret — server-internal use only. */
  getWithSecret(id: number): ExchangeRow | undefined {
    return getDb().get<ExchangeRow>('SELECT * FROM exchange_accounts WHERE id = ?', id);
  },

  create(input: {
    exchange: ExchangeId;
    label: string;
    apiKey: string;
    apiSecretEnc: string;
    testnet: boolean;
    canTrade: boolean;
  }): ExchangeAccount {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO exchange_accounts (exchange, label, api_key, api_secret_enc, passphrase_enc, testnet, can_trade, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
      input.exchange,
      input.label,
      input.apiKey,
      input.apiSecretEnc,
      input.testnet,
      input.canTrade,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as ExchangeAccount;
  },

  update(
    id: number,
    input: Partial<{ label: string; apiKey: string; apiSecretEnc: string; testnet: boolean; canTrade: boolean }>,
  ): void {
    const current = this.getWithSecret(id);
    if (!current) return;
    getDb().run(
      `UPDATE exchange_accounts
         SET label = ?, api_key = ?, api_secret_enc = ?, testnet = ?, can_trade = ?, updated_at = ?
       WHERE id = ?`,
      input.label ?? current.label,
      input.apiKey ?? current.api_key,
      input.apiSecretEnc ?? current.api_secret_enc,
      (input.testnet ?? current.testnet === 1) ? 1 : 0,
      (input.canTrade ?? current.can_trade === 1) ? 1 : 0,
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM exchange_accounts WHERE id = ?', id);
  },

  /** Traders referencing this credential, used to block unsafe deletes. */
  usageCount(id: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM traders WHERE exchange_account_id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  AI models                                                                  */
/* -------------------------------------------------------------------------- */

interface AiModelRow {
  id: number;
  provider: string;
  label: string;
  model: string;
  base_url: string;
  api_key_enc: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  max_retries: number;
  /** 模型能吃多大的输入；`0` = 不知道（服务商没报、用户没填）。 */
  input_token_limit: number;
  created_at: string;
  updated_at: string;
}

function toAiModel(row: AiModelRow): AiModelConfig {
  return {
    id: row.id,
    provider: row.provider as LlmProviderId,
    label: row.label,
    model: row.model,
    baseUrl: row.base_url,
    apiKeyMasked: '',
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    timeoutSeconds: row.timeout_seconds,
    maxRetries: row.max_retries,
    inputTokenLimit: row.input_token_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const aiModels = {
  list(): AiModelConfig[] {
    return getDb().all<AiModelRow>('SELECT * FROM ai_models ORDER BY id').map(toAiModel);
  },

  get(id: number): AiModelConfig | undefined {
    const row = getDb().get<AiModelRow>('SELECT * FROM ai_models WHERE id = ?', id);
    return row ? toAiModel(row) : undefined;
  },

  getWithSecret(id: number): AiModelRow | undefined {
    return getDb().get<AiModelRow>('SELECT * FROM ai_models WHERE id = ?', id);
  },

  create(input: {
    provider: LlmProviderId;
    label: string;
    model: string;
    baseUrl: string;
    apiKeyEnc: string;
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    maxRetries: number;
    /** 可省。省略 = 不知道，提示词预算回落到保守值。 */
    inputTokenLimit?: number;
  }): AiModelConfig {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO ai_models (provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, input_token_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.provider,
      input.label,
      input.model,
      input.baseUrl,
      input.apiKeyEnc,
      input.temperature,
      input.maxTokens,
      input.timeoutSeconds,
      input.maxRetries,
      input.inputTokenLimit ?? 0,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as AiModelConfig;
  },

  update(
    id: number,
    input: Partial<{
      provider: LlmProviderId;
      label: string;
      model: string;
      baseUrl: string;
      apiKeyEnc: string;
      temperature: number;
      maxTokens: number;
      timeoutSeconds: number;
      maxRetries: number;
      inputTokenLimit: number;
    }>,
  ): void {
    const current = this.getWithSecret(id);
    if (!current) return;
    getDb().run(
      `UPDATE ai_models
         SET provider = ?, label = ?, model = ?, base_url = ?, api_key_enc = ?,
             temperature = ?, max_tokens = ?, timeout_seconds = ?, max_retries = ?,
             input_token_limit = ?, updated_at = ?
       WHERE id = ?`,
      input.provider ?? current.provider,
      input.label ?? current.label,
      input.model ?? current.model,
      input.baseUrl ?? current.base_url,
      input.apiKeyEnc ?? current.api_key_enc,
      input.temperature ?? current.temperature,
      input.maxTokens ?? current.max_tokens,
      input.timeoutSeconds ?? current.timeout_seconds,
      input.maxRetries ?? current.max_retries,
      input.inputTokenLimit ?? current.input_token_limit,
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM ai_models WHERE id = ?', id);
  },

  usageCount(id: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM traders WHERE ai_model_id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  Strategies                                                                 */
/* -------------------------------------------------------------------------- */

interface StrategyRow {
  id: number;
  name: string;
  description: string;
  config_json: string;
  preset_id: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function toStrategy(row: StrategyRow): StrategyRecord {
  let parsed: StrategyConfig;
  try {
    const raw = JSON.parse(row.config_json) as unknown;
    // Parsing through the schema fills in any field added since the row was
    // written, so an old strategy keeps working after an upgrade.
    const result = StrategyConfigSchema.safeParse(raw);
    parsed = result.success ? result.data : StrategyConfigSchema.parse({});
  } catch {
    log.warn(`策略 #${row.id} 的配置 JSON 无法解析，已回落到默认配置`);
    parsed = StrategyConfigSchema.parse({});
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: parsed,
    presetId: row.preset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const strategies = {
  list(): StrategyRecord[] {
    return getDb()
      .all<StrategyRow>('SELECT * FROM strategies ORDER BY is_default DESC, id')
      .map(toStrategy);
  },

  get(id: number): StrategyRecord | undefined {
    const row = getDb().get<StrategyRow>('SELECT * FROM strategies WHERE id = ?', id);
    return row ? toStrategy(row) : undefined;
  },

  create(input: {
    name: string;
    description: string;
    config: StrategyConfig;
    presetId: string | null;
    isDefault?: boolean;
  }): StrategyRecord {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO strategies (name, description, config_json, preset_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.description,
      JSON.stringify(input.config),
      input.presetId,
      input.isDefault ? 1 : 0,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as StrategyRecord;
  },

  update(
    id: number,
    input: Partial<{ name: string; description: string; config: StrategyConfig }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    getDb().run(
      `UPDATE strategies SET name = ?, description = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      input.name ?? current.name,
      input.description ?? current.description,
      JSON.stringify(input.config ?? current.config),
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM strategies WHERE id = ?', id);
  },

  /**
   * 有多少个机器人**真的在靠这个策略的参数运行**。
   *
   * ## ⚠️ 只数固定策略模式 —— AI 托管的机器人不算
   *
   * AI 托管的参数整份在它自己的 `agent_config_json` 里，**这个策略对它不生效**。
   * 把它算进来会造成两个具体的后果：
   *
   *   · 删除被 `409` 挡住（"该策略正被 N 个机器人使用"），而那个机器人
   *     根本没用它 —— 于是**一个没人用的策略删不掉**；
   *   · 界面上显示成"有机器人在引用它"，让人以为那台机器人在跑这个策略。
   *
   * 用户的原话：「就算策略工坊里面默认策略 — 稳健就算删除、没有任何策略，
   * 都不影响智能托管模式（做到完全独立）」。
   *
   * 加 `mode <> 'ai_managed'` 而不是只依赖"新数据里 AI 托管的 `strategy_id` 是
   * NULL"：**老数据里存在 `mode = 'ai_managed'` 却还指向某个策略的行**，
   * 只靠 NULL 判断就会漏掉它们。M12 会把那些行置空，但那之后的任何写入方
   * 也不该再制造出这种组合。
   */
  usageCount(id: number): number {
    return getDb().count(
      "SELECT COUNT(*) AS n FROM traders WHERE strategy_id = ? AND mode <> 'ai_managed'",
      id,
    );
  },

  /** The strategy a brand-new trader starts from. */
  getDefault(): StrategyRecord | undefined {
    const row = getDb().get<StrategyRow>('SELECT * FROM strategies ORDER BY is_default DESC, id LIMIT 1');
    return row ? toStrategy(row) : undefined;
  },
};

/* -------------------------------------------------------------------------- */
/*  Traders                                                                    */
/* -------------------------------------------------------------------------- */

interface TraderRow {
  id: number;
  name: string;
  exchange_account_id: number;
  ai_model_id: number;
  /** `null` = 这个机器人不依赖任何策略（AI 托管）。见 `Trader.strategyId`。 */
  strategy_id: number | null;
  cycle_interval_minutes: number;
  initial_equity: number;
  status: string;
  last_cycle_at: string | null;
  last_cycle_number: number;
  last_error: string | null;
  consecutive_failures: number;
  agent_config_json: string | null;
  mode: string;
  /**
   * 操作员启动时指定的"是否纸面模式"。
   *
   * `null` = **从未被显式指定过** → 回落到进程级 `env.dryRun`（不落库）。
   * 见 `M18_TRADER_DRY_RUN` 与 `setDryRun` 的说明 ——
   * 这一列是一条**安全修复**，不是便利性字段。
   */
  dry_run: number | null;
  created_at: string;
  updated_at: string;
}

function toTrader(row: TraderRow): Trader {
  return {
    id: row.id,
    name: row.name,
    exchangeAccountId: row.exchange_account_id,
    aiModelId: row.ai_model_id,
    strategyId: row.strategy_id,
    cycleIntervalMinutes: row.cycle_interval_minutes,
    initialEquity: row.initial_equity,
    status: row.status as TraderStatus,
    lastCycleAt: row.last_cycle_at,
    lastCycleNumber: row.last_cycle_number,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    agentConfigJson: row.agent_config_json,
    mode: row.mode as TraderMode,
    /*
     * ⚠️ `undefined` 与 `false` 必须分得开（见 `Trader.dryRun` 的说明）：
     * 这一列是 NULL 时**不能**转成 `false`，否则"从未指定过"会被当成
     * "操作员指定了实盘"，env 的回落路径就被悄悄删掉了。
     */
    dryRun: row.dry_run === null ? undefined : row.dry_run !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const traders = {
  list(): Trader[] {
    return getDb().all<TraderRow>('SELECT * FROM traders ORDER BY id').map(toTrader);
  },

  get(id: number): Trader | undefined {
    const row = getDb().get<TraderRow>('SELECT * FROM traders WHERE id = ?', id);
    return row ? toTrader(row) : undefined;
  },

  create(input: {
    name: string;
    exchangeAccountId: number;
    aiModelId: number;
    /**
     * 引用的策略。**AI 托管（`mode: 'ai_managed'`）传 `null`** ——
     * 它的参数在 `agent_config_json` 里，策略对它不生效。
     * 固定策略模式下必填，由调用方（API 层）保证。
     */
    strategyId: number | null;
    cycleIntervalMinutes: number;
    initialEquity: number;
    /**
     * 运行模式。默认 `'strategy'`。
     *
     * ⚠️ 这个字段**靠列上的 `DEFAULT 'strategy'` 兜底也能跑** ——
     * 既有调用点不传就落到默认值，所以"这里漏了它"不会有任何症状：
     * 类型检查过、测试全绿、机器人照常创建，只是**建出来的永远不会是 AI 模式**。
     * 只能靠读这行代码发现。
     */
    mode?: TraderMode;
  }): Trader {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes, mode, initial_equity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
      input.name,
      input.exchangeAccountId,
      input.aiModelId,
      input.strategyId,
      input.cycleIntervalMinutes,
      input.mode ?? 'strategy',
      input.initialEquity,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as Trader;
  },

  update(
    id: number,
    input: Partial<{
      name: string;
      aiModelId: number;
      strategyId: number | null;
      cycleIntervalMinutes: number;
      initialEquity: number;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    getDb().run(
      `UPDATE traders SET name = ?, ai_model_id = ?, strategy_id = ?, cycle_interval_minutes = ?, initial_equity = ?, updated_at = ? WHERE id = ?`,
      input.name ?? current.name,
      input.aiModelId ?? current.aiModelId,
      /*
       * ⚠️ **这里不能用 `??`。**
       *
       * `input.strategyId ?? current.strategyId` 会把显式传入的 `null` 当成
       * "没传"而回落到旧值 —— 于是"把机器人改成不依赖策略"这个操作**静默失败**，
       * 而它看起来完全正常（没有报错、字段也确实没变）。
       * 用 `in` 判断键是否存在，`null` 才能真的写进去。
       */
      'strategyId' in input ? (input.strategyId ?? null) : current.strategyId,
      input.cycleIntervalMinutes ?? current.cycleIntervalMinutes,
      input.initialEquity ?? current.initialEquity,
      now(),
      id,
    );
  },

  /**
   * 写入 AI 托管模式下的参数。**非空即代表这个机器人由 AI 托管。**
   *
   * 单独一个列而不是复用 `strategies.config`：一个策略可以被多个机器人共用，
   * 而 AI 模式下每个机器人的参数是各自演化的 —— 共用会让两个 AI 互相覆盖，
   * 且那种覆盖看起来完全正常（配置就是配置，看不出被谁改的）。
   *
   * 传 null 表示退出 AI 托管，回到策略里的固定参数。
   */
  setAgentConfig(id: number, configJson: string | null): void {
    getDb().run(
      'UPDATE traders SET agent_config_json = ?, updated_at = ? WHERE id = ?',
      configJson,
      now(),
      id,
    );
  },

  setStatus(id: number, status: TraderStatus, error: string | null = null): void {
    getDb().run(
      'UPDATE traders SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
      status,
      error,
      now(),
      id,
    );
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  **记下"操作员启动这一台时选的纸面模式"**（2026-10-13 实测安全修复）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：测试机器人被服务重启**静默恢复成实盘**
   *
   * 用户要求"测试必须 `dryRun: true`"，而 `#11` 也确实以模拟盘启动 ——
   * **直到下一次部署重启服务**：
   * ```
   *   resumePersisted(env.dryRun)    ← 一个进程级开关，恢复【所有】机器人
   *   → env.dryRun 来自服务器 .env（DRY_RUN=false）
   *   → #11 被用 dryRun=false 恢复 → 实盘 🚨
   * ```
   * 线上 `runtime_logs` 证据：`#11 …「机器人已启动（实盘）」`。
   * 它当时 `orders=0`（全 skip）才没造成损失 —— **那是运气，不是保护**。
   *
   * ## 为什么之前不落库（那个理由现在不成立了）
   *
   * `api/server.ts` 原文：
   * > 「`dryRun` 是**运行时**的事实（它是启动参数、不落库），仓储层算不出来。」
   *
   * 那个理由在"所有机器人共用一个开关"时自洽。但**测试机器人必须与实盘
   * 机器人用不同的值** —— 那个前提被打破了，所以它必须成为机器人自己的属性。
   *
   * @param id 机器人 id
   * @param dryRun 启动时用的值；`null` 表示"清除显式指定、回到 env 回落"
   */
  setDryRun(id: number, dryRun: boolean | null): void {
    getDb().run(
      'UPDATE traders SET dry_run = ?, updated_at = ? WHERE id = ?',
      dryRun === null ? null : dryRun ? 1 : 0,
      now(),
      id,
    );
  },

  recordCycle(id: number, cycleNumber: number, failures: number): void {
    getDb().run(
      'UPDATE traders SET last_cycle_at = ?, last_cycle_number = ?, consecutive_failures = ?, updated_at = ? WHERE id = ?',
      now(),
      cycleNumber,
      failures,
      now(),
      id,
    );
  },

  /**
   * 删除一个机器人，连带它所有的从属数据。
   *
   * ## ⚠️ 必须先清这三张表，否则 **AI 托管的机器人一定删不掉**
   *
   * `agent_experiments` / `agent_memory` / `agent_runs` 引用 `traders(id)` 时
   * **没有写 `ON DELETE CASCADE`**（见 `schema.ts` 的建表语句），而 `trades` /
   * `positions` / `orders` / `equity_snapshots` / `trade_events` /
   * `decision_records` 那六张都写了。
   *
   * 后果非常具体，而且从界面上完全猜不出来：**策略模式的机器人能删，AI 托管的
   * 一定删不掉** —— 只有 AI 托管才会往这三张表里写行。操作员看到的只是一句
   * `FOREIGN KEY constraint failed`，于是很容易往"是不是最后一个才删不掉"
   * 这个方向猜（那是个无法证伪的猜测：删掉别的之后它确实是最后一个）。
   *
   * 顺序也不能反：`agent_memory` 另有一列 `trade_id REFERENCES trades(id)`，
   * 而 `trades` 是随 `traders` 级联删的 —— 先删 `traders` 会让 `agent_memory`
   * 指向不存在的成交，同样报外键失败。
   *
   * 为什么不加一个迁移把那三张表改成 `ON DELETE CASCADE`：SQLite 不支持给已有表
   * 添加外键，只能整表重建；而 §4.5 禁止改动已发布的迁移。在这里显式清一遍效果
   * 相同，而且能把原因写在它该在的地方。
   */
  remove(id: number): void {
    const db = getDb();
    db.run('DELETE FROM agent_memory WHERE trader_id = ?', id);
    db.run('DELETE FROM agent_experiments WHERE trader_id = ?', id);
    db.run('DELETE FROM agent_runs WHERE trader_id = ?', id);
    db.run('DELETE FROM traders WHERE id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

interface PositionRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  leverage: number;
  liquidation_price: number | null;
  margin_used: number;
  peak_pnl_percent: number;
  stop_loss: number | null;
  take_profit: number | null;
  stop_order_id: string | null;
  tp_order_id: string | null;
  open_reasoning: string;
  opened_at: string;
  status: string;
  /** 限价入场的交易所单号（`status='pending'` 时有值）。见 `M11_PENDING_ENTRY`。 */
  entry_order_id: string | null;
  /** 模型为这一张挂单指定的耐心（分钟）；`null` = 用系统配置的基础时限。见 `M15_PENDING_WAIT_MINUTES`。 */
  wait_minutes: number | null;
  /**
   * **开仓决策依据的情报键**（JSON 数组字符串）。见 `M17_POSITION_INTEL_ATTRIBUTION`。
   *
   * ⚠️ 平仓时把它搬到 `trades.intel_keys` —— 那是 `signalHealth`
   * 失效检测的数据来源。**解析必须容错**（见 `autoTrader.parseIntelKeysOf`）：
   * 一个附属统计字段绝不该让平仓失败。
   */
  intel_keys: string;
}

/**
 * 一行「按平仓原因聚合的 峰值 vs 落袋」—— 见 `positions.peakVsRealised()`。
 *
 * 百分比都是**保证金口径**（`trades.pnl_percent` 与 `positions.peak_pnl_percent`
 * 同源），与提示词里"浮盈 X%"的说法一致。
 */
export interface PeakVsRealisedRow {
  closeReason: string;
  trades: number;
  /** 这一组的净盈亏合计（含手续费与资金费）。 */
  netPnl: number;
  /** 平均落袋（保证金口径 %）。 */
  avgNetPercent: number | null;
  /** 平均峰值浮盈（保证金口径 %）—— 接不到持仓行时为 `null`。 */
  avgPeakPercent: number | null;
  maxPeakPercent: number | null;
  /** 这一组里净盈亏为正的笔数。 */
  profitable: number;
}

export const positions = {
  /**
   * **峰值浮盈 → 实际落袋**的对照，**按平仓原因分组**。
   *
   * ## 为什么需要它（用户的原话：「我看到历史成交大多是提示：移动止损（保本离场）」）
   *
   * 实测那台机器人：**13 笔止损类平仓的平均峰值浮盈 2.84%、平均落袋只有 0.42%**
   * —— 回吐约 85%。而它自己的止盈目标是 3%。
   *
   * `trades.performanceSince()` 给的是"总净盈亏、胜率、平均盈亏"，**看不出这件事**：
   * 那些交易全都记成"盈利"，只是每笔只赚几分钱。要看出"**我在同一个地方把利润
   * 还回去**"，必须把**峰值**和**落袋**放在一起、按原因分组 ——
   * 而 `peak_pnl_percent` 只存在于**持仓行**，成交行里没有这一列。
   *
   * 与 `get_lessons` 的 `recurringTags`、`get_experiments` 的 `repeatedFields`
   * 是同一条思路：**单条说的是"这一次"，聚合说的是"我一直在同一个地方"。**
   * 而**数这件事该由程序做** —— 不该指望模型每次自己从一列散记录里翻。
   *
   * ## 关联键是 `symbol` + `opened_at`
   *
   * 两个仓储各写各的表，关联只能靠这两个字段（同一次开仓，两边的值同源）。
   * 用 `LEFT JOIN`：接不上的行（老记录、迁移前的手工数据）仍然计入成交那一侧，
   * 只是峰值为 `NULL` —— **宁可少一个数，也不要凭空丢掉一笔交易**。
   */
  peakVsRealised(traderId: number, sinceIso: string): PeakVsRealisedRow[] {
    return getDb().all<PeakVsRealisedRow>(
      `SELECT t.close_reason                                    AS closeReason,
              COUNT(*)                                          AS trades,
              ROUND(SUM(t.net_pnl), 4)                          AS netPnl,
              ROUND(AVG(t.pnl_percent), 2)                      AS avgNetPercent,
              ROUND(AVG(p.peak_pnl_percent), 2)                 AS avgPeakPercent,
              ROUND(MAX(p.peak_pnl_percent), 2)                 AS maxPeakPercent,
              SUM(CASE WHEN t.net_pnl > 0 THEN 1 ELSE 0 END)    AS profitable
         FROM trades t
         LEFT JOIN positions p
                ON p.trader_id = t.trader_id
               AND p.symbol = t.symbol
               AND p.opened_at = t.opened_at
        WHERE t.trader_id = ? AND t.closed_at >= ?
        GROUP BY t.close_reason
        ORDER BY trades DESC`,
      traderId,
      sinceIso,
    );
  },

  open(traderId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND status = 'open' ORDER BY opened_at",
      traderId,
    );
  },

  /**
   * **这个标的最近的一行持仓 —— 含已平掉的那些。**
   *
   * ## 为什么需要它（2026-10-05 实测：历史成交的百分比虚高约 40 倍）
   *
   * 用户看到「历史成交」里 `+$0.44 · +156.05%`、`-$1.70 · -428.62%` 这种数字，
   * 问对不对 —— **不对**。反推每一笔的隐含保证金，全都指向一个 `leverage = 125`：
   *
   * ```text
   * #214 SANDUSDT net -1.695 → -428.62%  ⇒ margin 0.3955 = 0.07446×664 / 【125】
   * #215 QNTUSDT  net -1.1908 → -278.75% ⇒ margin 0.4272 = 267×0.2    / 【125】
   * #217 SUIUSDT  net +0.4365 → +156.05% ⇒ margin 0.2797 = 1.1934×29.3 / 【125】
   * ```
   *
   * 而它们的真实杠杆是 2 / 3 / 3。**125 正是配置里的 `altcoinMaxLeverage`。**
   *
   * 根因在 `autoTrader.leverageFor()`：仓位**已经被平掉**时，它查不到 `open` 行，
   * 于是回落到"配置上限"。于是**所有由对账重建的成交**都按 125 倍算百分比。
   *
   * 而 `positions` 表**保留着已平的那些行、且带着当时的真实杠杆** ——
   * 所以正确的答案是查"最近一行，不论状态"。
   */
  lastBySymbol(traderId: number, symbol: string): PositionRow | undefined {
    return getDb().get<PositionRow>(
      'SELECT * FROM positions WHERE trader_id = ? AND symbol = ? ORDER BY id DESC LIMIT 1',
      traderId,
      symbol,
    );
  },

  /**
   * **账户级**：当前所有未平仓持仓的符号（不分机器人）。
   *
   * 与 `tradedSymbols` / `allTradedSymbols` 同一个理由：清点"账户上的外部活动"时，
   * 别的机器人正持有的符号也必须扫到 —— 那些仓位平掉时产生的外部成交同样在
   * 交易所流水里，漏掉就又是一笔假差额。
   */
  allOpenSymbols(): string[] {
    return getDb()
      .all<{ symbol: string }>(
        "SELECT DISTINCT symbol FROM positions WHERE status = 'open'",
      )
      .map((r) => r.symbol);
  },

  getOpenBySymbol(traderId: number, symbol: string): PositionRow | undefined {
    return getDb().get<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND symbol = ? AND status = 'open'",
      traderId,
      symbol,
    );
  },

  insert(input: {
    traderId: number;
    symbol: string;
    side: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    liquidationPrice: number | null;
    marginUsed: number;
    stopLoss: number | null;
    takeProfit: number | null;
    stopOrderId: string | null;
    tpOrderId: string | null;
    openReasoning: string;
    /**
     * `'open'`（默认，成交后的持仓）或 `'pending'`（**限价入场：单已挂出、
     * 还没成交**）。
     *
     * `pending` 的行**不是持仓**：`open()` 只返回 `'open'`，所以风控、UI、
     * 权益计算看不到它 —— 那正是要的，一个还没成交的单不该占仓位名额。
     * 它的作用只有一个：**让对账知道"有一张挂出去的单要盯着"**。
     */
    status?: 'open' | 'pending';
    /** 限价入场那笔单的交易所单号 —— 对账靠它去问"成交了吗"。 */
    entryOrderId?: string | null;
    /** 模型为这一张挂单指定的耐心（分钟）；不传 = 用配置的基础时限。 */
    waitMinutes?: number | null;
    /**
     * **这条开仓决策依据了哪几条情报**（`<域名>|<方向>|<标的>`）。
     *
     * 见 `db/schema.ts` 的 M17 —— 它是**归因链的中间一环**：
     * ```
     *   开仓 → 存在 positions 上（此时决策在手边）
     *   平仓 → 搬到 trades 上（signalHealth 的数据来源）
     * ```
     *
     * ⚠️ 不传 = `[]` = **纯技术面开仓**（与改动前行为一致）。
     * 这里存的是**已经过 `filterKnownIntelKeys` 校验**的键 ——
     * 编造的不该走到这一层。
     */
    intelKeys?: readonly string[];
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO positions (trader_id, symbol, side, quantity, entry_price, leverage, liquidation_price, margin_used, peak_pnl_percent, stop_loss, take_profit, stop_order_id, tp_order_id, open_reasoning, opened_at, status, entry_order_id, wait_minutes, intel_keys)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.leverage,
      input.liquidationPrice,
      input.marginUsed,
      input.stopLoss,
      input.takeProfit,
      input.stopOrderId,
      input.tpOrderId,
      input.openReasoning,
      now(),
      input.status ?? 'open',
      input.entryOrderId ?? null,
      input.waitMinutes ?? null,
      JSON.stringify(input.intelKeys ?? []),
    );
    return lastInsertRowid;
  },

  /**
   * 还挂着的**限价入场单**（`status='pending'`）。
   *
   * 对账每轮拿它们去问交易所："成交了吗" —— 见 `AutoTrader.settlePendingEntries`。
   * 之所以要单独一个方法而不是让调用方自己过滤 `open()`：`open()` 刻意不返回
   * `pending`（它不是持仓），而"哪些单在等"是一个独立的、必须被看见的集合。
   */
  pending(traderId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND status = 'pending' ORDER BY id",
      traderId,
    );
  },

  /**
   * 把一行 `pending` 转成真正的持仓 —— 限价单成交了。
   *
   * 用**交易所报的成交价与成交量**覆盖挂单时的意向值：挂单时填的是"我想在
   * 这个价位买这么多"，而成交时可能部分成交、也可能在更好的价位。
   * 本地账本只能记**实际发生的**（这条纪律这个项目里已经踩过三次）。
   *
   * `stop_order_id` / `tp_order_id` 由调用方在挂完保护单后用 `setProtection` 写。
   */
  promote(
    traderId: number,
    symbol: string,
    fill: { quantity: number; entryPrice: number; marginUsed: number },
  ): { mergedIntoExisting: boolean } {
    const db = getDb();

    /*
     * ⚠️ **该标的可能已经有一行 `open` 了 —— 那就不能再把它变成第二行。**
     *
     * 表上有一条**部分唯一索引**（`schema.ts`）：
     *
     *     CREATE UNIQUE INDEX idx_positions_open_symbol
     *       ON positions(trader_id, symbol) WHERE status = 'open';
     *
     * 而"限价单成交时已经有一行 open"是**真实会发生**的：对账的**收养路径**
     * 只检查了 `positionStore.open()`，**没有看 pending 行** —— 于是同一个标的
     * 可以同时存在「收养来的 open 行」和「还没成交的 pending 行」。这时下面那条
     * UPDATE 会把 pending 行改成 open → **撞唯一索引**：
     *
     *     UNIQUE constraint failed: positions.trader_id, positions.symbol
     *
     * 实测（2026-09-29 00:56 / 01:18 / 01:28，连续三轮）：这个异常被
     * `settlePendingEntries()` 的调用方接住、记成「待成交对账失败」，而**那行
     * pending 永远不会消失** —— 每轮重试、每轮失败，日志一直刷，而那一笔
     * 限价入场永远转不了正（只能靠收养兜底）。
     *
     * 所以这里**合并**：把那行 pending 关掉（它是同一笔的残留），把交易所报的
     * 成交数据写进**已有的 open 行** —— 账本上仍然只有一行，数量与均价用权威值。
     */
    const existingOpen = this.getOpenBySymbol(traderId, symbol);
    if (existingOpen) {
      db.run(
        `UPDATE positions SET status = 'closed' WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
        traderId,
        symbol,
      );
      db.run(
        `UPDATE positions SET quantity = ?, entry_price = ?, margin_used = ?, opened_at = ? WHERE id = ?`,
        fill.quantity,
        fill.entryPrice,
        fill.marginUsed,
        now(),
        existingOpen.id,
      );
      return { mergedIntoExisting: true };
    }

    db.run(
      `UPDATE positions
          SET status = 'open', quantity = ?, entry_price = ?, margin_used = ?, opened_at = ?
        WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
      fill.quantity,
      fill.entryPrice,
      fill.marginUsed,
      now(),
      traderId,
      symbol,
    );
    return { mergedIntoExisting: false };
  },

  updatePeak(traderId: number, symbol: string, peakPnlPercent: number): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    // Peak only ever ratchets upward.
    if (peakPnlPercent <= row.peak_pnl_percent) return;
    getDb().run('UPDATE positions SET peak_pnl_percent = ? WHERE id = ?', peakPnlPercent, row.id);
  },

  setProtection(
    traderId: number,
    symbol: string,
    stopLoss: number | null,
    takeProfit: number | null,
    stopOrderId?: string | null,
    tpOrderId?: string | null,
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      'UPDATE positions SET stop_loss = ?, take_profit = ?, stop_order_id = ?, tp_order_id = ? WHERE id = ?',
      stopLoss,
      takeProfit,
      stopOrderId === undefined ? row.stop_order_id : stopOrderId,
      tpOrderId === undefined ? row.tp_order_id : tpOrderId,
      row.id,
    );
  },


  /**
   * 支撑「加仓 / 减仓」的两个仓库方法。
   *
   * ## 为什么数量与均价要一起改
   *
   * 加仓改变的是**加权平均入场价**：`(旧均价×旧数量 + 新价×新数量) / 总数量`。
   * 只改数量、不改均价的话，平仓时算出来的盈亏是错的 ——
   * 而那个数字会一路传到 `trades`，成为永久的账面记录。
   *
   * **减仓反过来：均价不变。** 卖掉一部分不改变剩余部分当初的买入价
   * —— 这正是"加权平均"这个模型的含义。改它是记账错误。
   */
  resize(
    traderId: number,
    symbol: string,
    input: {
      /** 新的总数量（不是增量）。 */
      quantity: number;
      /** 新的加权均价；减仓时传原值。 */
      entryPrice: number;
      /** 保证金随之变化 —— 它由数量与杠杆决定。 */
      marginUsed: number;
      /**
       * 部分平仓累计已记的**毛**盈亏（只增不减）。
       *
       * ⚠️ **2026-10-03 起语义是"毛"**（此前是"净"）。列名保持
       * `realized_partial_pnl` 不变以免多一次迁移，但调用方要减的是
       * **`grossPnl` 而不是 `netPnl`** —— 拿毛减净会把那一部分的平仓手续费
       * 多扣一次。见 `partialBooked()` 与最终平仓处的说明。
       */
      addRealizedPartialPnl?: number;
      /** 部分平仓累计已记的数量（只增不减）。 */
      addBookedPartialQty?: number;
    },
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      `UPDATE positions
         SET quantity = ?, entry_price = ?, margin_used = ?,
             realized_partial_pnl = realized_partial_pnl + ?,
             booked_partial_qty = booked_partial_qty + ?
       WHERE id = ?`,
      input.quantity,
      input.entryPrice,
      input.marginUsed,
      input.addRealizedPartialPnl ?? 0,
      input.addBookedPartialQty ?? 0,
      row.id,
    );
  },

  /**
   * 部分平仓已经记了多少（**毛**盈亏 + 数量）。
   *
   * 最终平仓时要把它从交易所重建的整段往返里**减掉** —— 见迁移 M8 的说明：
   * 重复记账会让账面比账户好看，而那正是 §2.5 禁止的方向。
   *
   * ⚠️ **`gross` 是毛盈亏**（2026-10-03 起）。这个函数曾经叫 `.pnl` 并返回净额，
   * 而调用方拿它去减**毛** —— 口径不匹配，等于把已记那部分的平仓手续费多扣一次
   * （`G − (g − xf)` 而不是 `G − g`，毛被高估 `xf`）。改名成 `gross` 就是为了
   * 让调用点一眼看出它该配 `grossRaw`。
   */
  partialBooked(traderId: number, symbol: string): { gross: number; qty: number } {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return { gross: 0, qty: 0 };
    const r = getDb().get(
      'SELECT realized_partial_pnl AS gross, booked_partial_qty AS qty FROM positions WHERE id = ?',
      row.id,
    ) as { gross: number | null; qty: number | null } | undefined;
    return { gross: Number(r?.gross) || 0, qty: Number(r?.qty) || 0 };
  },
  close(id: number): void {
    getDb().run("UPDATE positions SET status = 'closed' WHERE id = ?", id);
  },

  closeAllForTrader(traderId: number): void {
    getDb().run(
      "UPDATE positions SET status = 'closed' WHERE trader_id = ? AND status = 'open'",
      traderId,
    );
  },
};

/**
 * 这个交易所单号是否落在给定的单号集合里 —— **兼容"被精度改写过的历史行"**。
 *
 * ## 为什么需要它（实测：账目告警每轮误报）
 *
 * 币安新版订单号是 **19 位**（超过 `Number.MAX_SAFE_INTEGER`），而 2026-09-28 之前
 * 这个项目在解析响应时用了 `Number(orderId)` —— 于是**写进 `orders` 表的是被精度
 * 改写过的值**：
 *
 * ```text
 * 交易所成交里的真实入口单号   8389766285736311569
 * 本地 orders 里存下来的        8389766285736312000   ← 末尾被改写
 * ```
 *
 * 而"这个回合属不属于本机器人"的判据就是拿这两边做**字符串相等**比较 →
 * **永远不相等** → 那一笔被判成「不属于本平台的成交」（`foreign`）→
 * 总账校验凭空多出一笔外部净额（实测 `foreignNet = -0.256743`，与那笔真实成交
 * **一字不差**），于是每轮都报「账目与交易所对不上」。
 *
 * 解析层已经修好（`preserveBigIds()`），但**已经写进库的历史行改不回来** ——
 * 所以这里再宽容一层：把两边都按旧精度归一化后比一次。
 * 16 位以内的单号 `Number()` 可精确表示，这一步是无损的，**不会放宽任何真实判定**。
 */
export function orderIdIn(id: string, ids: ReadonlySet<string>): boolean {
  if (id.length === 0) return false;
  if (ids.has(id)) return true;
  const loose = String(Number(id));
  return loose !== id && ids.has(loose);
}

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

interface OrderRow {
  id: number;
  trader_id: number;
  exchange_order_id: string | null;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  purpose: string;
  quantity: number;
  price: number | null;
  stop_price: number | null;
  status: string;
  avg_price: number | null;
  filled_qty: number;
  fee: number;
  error: string | null;
  raw_response: string | null;
  /** 这一行对应占用的保证金。**可空**：`NULL` = 算不出来，见 `M13_ORDER_MARGIN_USED`。 */
  margin_used: number | null;
  /** 下单时该标的的保证金模式。**可空**：`NULL` = 没有这个事实，见 `M14_ORDER_MARGIN_TYPE`。 */
  margin_type: string | null;
  created_at: string;
  updated_at: string;
}

function toOrder(row: OrderRow, leverages?: ReadonlyMap<string, number>): OrderRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    exchangeOrderId: row.exchange_order_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side as 'BUY' | 'SELL',
    type: row.type,
    purpose: row.purpose as OrderRecord['purpose'],
    quantity: row.quantity,
    price: row.price,
    stopPrice: row.stop_price,
    status: row.status,
    avgPrice: row.avg_price,
    filledQty: row.filled_qty,
    fee: row.fee,
    error: row.error,
    /*
     * ⚠️ 杠杆**不能**由界面按"标的的当前持仓"去读 —— 那份列表来自交易所的真实持仓，
     * 而挂单还没成交、交易所没有持仓，于是**开仓单永远读不到**（用户看到的"倒反天罡"：
     * 该显示的显示不出来、不该显示的保护单反而显示了）。
     *
     * 这里从本地 `positions`（**含 `pending` 行**）取，随订单一起发出去。
     */
    ...(leverages?.has(row.symbol) ? { leverage: leverages.get(row.symbol) } : {}),
    /*
     * ⚠️ `undefined`（界面显示 `—`）与 `0`（界面显示 `0.00`）在这里**必须是两件事**。
     *
     * `NULL` 是我们没有这个数；`0` 是"这笔没占保证金"。所以这里既不用 `?? 0`，
     * 也顺手把 0 归到"不知道"那一类：写入侧（`orders.insert()` 与
     * `resolveOrderMarginUsed()`）已经收过一次口，但这一列还可能被**绕过仓储**的行
     * 写进来（迁移前的旧行、直接写 SQL 的脚本），而"前端一定不会看到 0"这条契约
     * 值得在读出这一道再兜一次。
     */
    marginUsed: positiveOrNull(row.margin_used) ?? undefined,
    /*
     * 保证金模式：**读出这一道也收一次口**，与 `marginUsed` 同一个理由。
     *
     * ⚠️ `undefined`（界面显示 `—`）与 `'cross'`（界面显示「全仓」）在这里是
     * **两句相反的话**：前者是"我们不知道这张单当时是什么模式"，后者是"它就是全仓"。
     * 所以这里既不用 `?? 'cross'`，也把认不出的写法归到"不知道"那一类 ——
     * 历史行（`NULL`）、以及任何绕过 `orders.insert()` 的写入都从这里经过。
     */
    marginType: normalizeMarginMode(row.margin_type) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 把"也许是保证金"的输入收成 `number` 或 `null`。
 *
 * 保证金这一列只有两种合法取值：**一个正数**，或**不知道**（`NULL`）。
 * `0` 不属于"不知道"那一类 —— 它在界面上读作"这笔没占保证金"，与"我们不知道"
 * 是两句相反的话（见 `M13_ORDER_MARGIN_USED`）。而 `marginOf()` 在名义价值为 0 时
 * 恰好回 `0`，所以这个收口必须在写入与读出两处都做一遍。
 */
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 保证金模式的**唯一收口**：把三种写法收成 `'cross' | 'isolated'`，认不出的回 `null`。
 *
 * ## 为什么必须有它
 *
 * "全仓"这一个概念在这个系统里有**三个拼法**（全都是外部契约，改不动）：
 *
 * | 来源 | 写法 |
 * | --- | --- |
 * | 交易所 `positionRisk` / `symbolConfig`（读） | `cross` |
 * | `POST /fapi/v1/marginType`（写） | `CROSSED` |
 * | 本仓库 `StrategyConfigSchema.riskControl.marginMode` | `crossed` |
 *
 * 直接比较字符串会**静默失败**：`'cross' === 'crossed'` 是 `false`，而它不抛错、
 * 不报警，只会让一次"这个标的是全仓"的判断变成"不是全仓"（或反过来）。
 * 所以入库前、读库后都从这里过一道 —— 与 `positiveOrNull()` 对保证金做的是同一件事。
 *
 * ## 为什么认不出是 `null` 而不是报错 / 也不回落到 `'cross'`
 *
 * 这一列的合法取值只有"两个模式之一"或"不知道"。币安的**默认**确实是全仓，
 * 但"默认是"与"我们读到了"是两件事 —— 认不出的值（未来的新写法、脏数据）
 * 回落到 `'cross'` 会让界面**替交易所宣布一个我们没验证过的事实**，
 * 与 `M13_ORDER_MARGIN_USED` 里"0 不等于不知道"是同一条纪律。
 *
 * 大小写与空白一并容忍（`'CROSSED'` / `' isolated '` 都能收到），因为它们来自
 * 不同的外部接口，而"多一个空格就变成不知道"是最难查的那类字段映射 bug。
 */
export function normalizeMarginMode(value: unknown): MarginMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cross' || normalized === 'crossed') return 'cross';
  if (normalized === 'isolated') return 'isolated';
  return null;
}

/**
 * 一张订单行该写什么保证金 —— **这个判断只有这一份实现**。
 *
 * ## 取值顺序
 *
 *   ① `override`：调用方给的值。开仓 / 加仓单给的是**这一笔自己**的
 *      `|价 × 量| ÷ 杠杆`（`marginOf()`），也就是同时写进 `positions.margin_used`
 *      的同一个数；
 *   ② 否则取 `positionMargin`（该标的**当前持仓行**的 `positions.margin_used`，
 *      权威值，不重算）。平仓单与保护单都是为那张持仓下的单，它们落库时那张持仓
 *      一定还开着（`executeClose` 在 `bookClosedPosition` 之前记订单、保护单在
 *      持仓建好之后才挂）—— 所以这不是"按标的猜"，它就是那张持仓。
 *      保护单行上只有触发价、没有成交价，自己乘一遍只会得到与持仓页不一致的第二个数；
 *   ③ 都没有 → `null` → `OrderRecord.marginUsed` 是 `undefined` → 界面显示 `—`。
 *      被拒的开仓单走的就是这条路（那时还没有持仓，也确实什么都没占用）。
 *
 * ## ⚠️ 为什么开仓单**不许**回落到 ②
 *
 * 开仓单要的是"这一笔自己"的保证金，而那一刻它要建的持仓还不存在 ——
 * 若此时同标的上恰好还挂着一个别的持仓（重复开仓的守卫失效、或对账留下的行），
 * 回落会把**别人的仓位**压的本金记到这一行上。宁可显示 `—`。
 */
export function resolveOrderMarginUsed(input: {
  purpose: OrderRecord['purpose'];
  override?: number | null;
  positionMargin?: number | null;
}): number | null {
  const own = positiveOrNull(input.override);
  if (own !== null) return own;
  if (input.purpose === 'entry') return null;
  return positiveOrNull(input.positionMargin);
}

/* -------------------------------------------------------------------------- */
/*  Pagination caps                                                            */
/* -------------------------------------------------------------------------- */

/*
 * 历史表（订单 / 成交 / 决策）只回**一页**，三张表共用下面这一套钳制与游标。
 *
 * 为什么要共用一份实现：这三处各写一遍的话，迟早只改其中两处，而漏掉的那张表
 * 就是操作者说的"成千上万数据一次加载出来导致系统卡死"复发的地方
 * （`?limit=999999` 以前会被原样交给 SQL）。
 */

/**
 * 把调用方给的 `limit` 收进 `[1, max]`。**钳制而不是报错**。
 *
 * 翻页的控制台不该因为页大小写得大一点就收到 400，而一个手写的
 * `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到该表自己的默认页大小，
 * 等同于路由原来那半句 `Number.isFinite(limit) ? limit : 100`。
 *
 * 下界收到 1 而不是 0：`LIMIT 0` 返回的空数组和"这个机器人还没有记录"
 * 在响应里长得一模一样，会把一次参数错误伪装成一次空结果。
 */
function clampPageLimit(limit: number, max: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

/**
 * 把调用方给的游标收成一个可用的 `id`；`null` 表示"第一页"。
 *
 * 非有限值（没传 / `?before=abc`）一律按第一页处理：发不出正确游标的调用方
 * 应该拿到**最新的一页**，而不是一个 400 —— 与 `clampPageLimit` 同一个取舍。
 */
function cursorOf(before: number | null | undefined): number | null {
  return before === undefined || before === null || !Number.isFinite(before) ? null : Math.trunc(before);
}

/**
 * 一次最多回多少条订单记录。
 *
 * 卡住的是**响应体的字节数**：订单行带着状态、均价、成交数量、手续费与错误文案
 * （12 列），而这张表是随机器人运行**无限增长**的 —— 一个跑了半年的机器人有几千行，
 * `?limit=999999` 一次就能把整张表拼进 JSON 占住 event loop，浏览器那侧也要一次
 * 建出几千个 DOM 节点。
 *
 * 200 与操作者上一版控制台每次轮询要的条数一致（那时候每 15 秒无条件拉 200 条），
 * 而一页 25 条的翻页只需要它的一小部分 —— 上限是给手写请求用的兜底，
 * 不是给界面用的页大小。
 */
export const ORDER_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100，`docs/API.md` 照旧）。 */
export const ORDER_PAGE_DEFAULT = 100;

/** `orders.list()` 的页大小：见 `clampPageLimit`。 */
export function clampOrderLimit(limit: number): number {
  return clampPageLimit(limit, ORDER_PAGE_MAX, ORDER_PAGE_DEFAULT);
}

/**
 * 「终态」委托状态：不会再变的状态码，其余任何值都还可能与交易所不一致（§2.2）。
 *
 * 覆盖两套词汇，因为 `orders.status` 里两套都会出现：
 *  · 普通订单 —— `binance/types.ts` 的 `BinanceOrderStatus`；
 *  · Algo 条件单 —— 同文件的 `BinanceAlgoStatus`（`NEW` / `FINISHED` / `TRIGGERED` / …）。
 *    两者只有 `NEW` 重合，所以 `FINISHED` 必须在这里列出来：漏掉它，一张已经触发成交的
 *    条件单就会被当成"还在挂"。
 *
 * 判据写成**否定**形式（`status NOT IN 终态`）而不是 `status IN (NEW, PARTIALLY_FILLED)`：
 * 交易所会新增状态码（`EXPIRED_IN_FUTURES` 就是后来补的），用肯定判据的话一个没见过的
 * 状态码会被当成"已经结清"，于是一张真的还挂着的单在本地被判成终态 —— 那正是这次要修的
 * 那类错误的方向。反过来，多结清一行是无害的：结清之前一定先问过交易所
 * （见 `AutoTrader.settleStaleOrders()`）。
 *
 * `TRIGGERED` 刻意**不在**终态里：条件单触发之后，它产生的那张市价单还要成交
 * （理由同 `binance/broker.ts` 的 `TERMINAL_ALGO_STATUSES`）。
 *
 * 控制台的 `TraderTables.tsx` 有一份等价实现（前端不能 import 服务端），两处要一起改。
 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = [
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
];

export const orders = {
  /**
   * Exchange order ids this trader has placed, newest first.
   *
   * Reconciliation needs this to answer "did *this* trader open that
   * round-trip?" — two traders can share one exchange account, in which case
   * every fill in the account is visible to both and only the order history says
   * which one actually traded it.
   */
  exchangeOrderIds(traderId: number, limit = 2000): Set<string> {
    return new Set(
      getDb()
        .all<{ exchange_order_id: string | null }>(
          'SELECT exchange_order_id FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL ORDER BY id DESC LIMIT ?',
          traderId,
          limit,
        )
        .map((r) => String(r.exchange_order_id)),
    );
  },

  /**
   * **全部**机器人挂过的交易所订单号 —— 用来把「别人的机器人」和「外部活动」分开。
   *
   * ## 为什么不能复用 `exchangeOrderIds(traderId)`
   *
   * 那个函数默认只取最新 2000 条，而且按机器人过滤。它的上限是**归属判断**的
   * 保守设计（宁可跳过也不冒认一笔），但用在"这笔成交是不是平台的"上会
   * 反过来：订单超过 2000 条之后，**本平台自己的早期成交会被误报成外部活动**。
   *
   * 所以这里**不设上限**，也不过滤机器人。
   */
  allExchangeOrderIds(): Set<string> {
    return new Set(
      getDb()
        .all<{ exchange_order_id: string | null }>(
          'SELECT DISTINCT exchange_order_id FROM orders WHERE exchange_order_id IS NOT NULL',
        )
        .map((r) => String(r.exchange_order_id)),
    );
  },

  /**
   * 本机器人的「交易所单号 → 用途」映射（`entry` / `exit` / `stop_loss` / …）。
   *
   * ## 它存在的理由：校验**重建出来的回合有没有把方向搞反**
   *
   * `reconstructRoundTrips()` 用的是**净头寸法** —— 按持仓数量的变化判断哪一笔
   * 是开仓、哪一笔是平仓。而它的输入是 `getUserTrades(symbol, 500)`（最近 500 笔）
   * 且**没有"起始持仓"这个信息**：如果窗口起点落在一个持仓的中间，第一笔
   * （其实是平仓）会被当成开仓，**整个 leg 的 open/close 就此反向**。
   *
   * 实测（2026-09-29）：6 笔 `reconciled` 回合的 `entry_order_id` 在 `orders` 里
   * 记的用途是 `exit`、而 `exit_order_id` 记的是 `entry`，两者甚至相隔 2 天 ——
   * 合计 `-0.125559`，**正好等于账目校验的全部缺口**。也就是说：**账本没错，
   * 是重建凭空造出了这 6 笔反向的回合**，还顺带让 `findDuplicate()` 的
   * 单号去重判据失效。
   *
   * 运行期记下的 `purpose` 是我们**下单时的真实意图**，用它反查一次即可辨认。
   */
  purposeByExchangeOrderId(traderId: number): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of getDb().all<{ exchange_order_id: string | null; purpose: string }>(
      'SELECT exchange_order_id, purpose FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL',
      traderId,
    )) {
      if (row.exchange_order_id === null) continue;
      map.set(String(row.exchange_order_id), String(row.purpose));
    }
    return map;
  },

  /**
   * **每个标的最近一次被交易所确认过的保证金模式**（`symbol → 'isolated' | 'cross'`）。
   *
   * ## 为什么需要它（2026-10-18 · 用户实测）
   *
   * 用户看到订单记录里「保证金模式」这一列**有一部分是空的**：
   * ```
   *   entry      103 笔 → 0 笔缺 ✓
   *   exit        37 笔 → 21 笔缺
   *   stop_loss  132 笔 → 12 笔缺
   * ```
   *
   * 根因不是写库漏了，而是 `AutoTrader.marginSet` 是**进程内内存**：
   * 每次部署重启后就清空，于是"本进程没为这个标的设过" ⇒ `recordOrder` 如实写 `NULL`。
   * 实测同一标的（`TIAUSDT`）19 笔有值、9 笔无值 —— 正是"重启前 / 重启后"的分界。
   *
   * ⇒ 启动时用这张表把内存填回来。**它只影响显示，不改变任何设置行为**
   *   （`executeOpen` 仍会照常 `setMarginType`，`marginSet` 依旧只记成功的那次）。
   *
   * ## 为什么取 `MAX(id)` 而不是"最后一次设置时间"
   *
   * `orders` 里没有"设置模式"这个动作的记录，只有下单记录。所以"该标的最新的那条
   * 带模式的订单"就是最接近事实的近似 —— 而且它**只会更保守**：
   * 如果之后有人在交易所手工改了模式，这里记的仍是旧值，界面那列的 `title`
   * 与 `/positions` 的实时读取会兜底（见 `recordOrder` 的说明）。
   */
  /**
   * **某标的下还在挂着的保护单类型**（`STOP*` / `TAKE_PROFIT*`）。
   *
   * ## 为什么需要它
   *
   * 界面要回答「这个持仓的保护单到底挂上了没有」。`positions` 表的
   * `stop_loss` / `take_profit` 只是**意向值**（决策时就算好了），
   * 而"挂上了"这件事只有 `orders` 表知道 —— 那里才有 `status = 'NEW'` 的行。
   *
   * 两者在开仓后的头两秒会不一致：
   * ```
   *   t+0s  持仓行已写，stop_loss 有值
   *   t+2s  保护单行才写进 orders
   * ```
   * 窗口内若只看 `positions`，界面会把"正在挂"说成"没有"。
   *
   * ⚠️ 只返回**保护单**类型（止损/止盈），不含入场单 ——
   * 调用方问的是"有没有保护"，入场单不是保护。
   */
  /**
   * **把某标的还挂着的单标记为已撤销**（2026-10-21 实盘抓到）。
   *
   * ## 为什么需要它
   *
   * 用户报告：「JEV实盘我停了，然后手动点了全部平仓，仓位好像平了，
   * 但是当前委托里面为什么还有」。
   *
   * 实测那 6 张单在交易所侧**全是 `CANCELED`**（条件单是
   * `closePosition` 类型，仓位一平交易所就自动撤销它们），
   * 而本地 `orders` 表仍然停在 `NEW` ⇒ 界面的「当前委托」显示幽灵单。
   *
   * ## 根因
   *
   * `closeManually()` 调了 `broker.cancelAllOrders(symbol)` 撤**交易所侧**，
   * 但没有任何一步回写本地 `orders` 表。而正常轮次里的对账
   * （`settleStaleOrders`）会清理这类残留 —— **可它只在机器人运行时跑**，
   * 而这次是「先停机器人、再手工平仓」，对账没有机会执行。
   *
   * ⇒ 平仓路径必须**立即**清账，而不是指望下一轮对账。
   *
   * ⚠️ 只动 `status='NEW'` 的行：已成交（`FILLED`）与早已撤销的行
   * 是历史事实，不能改写。
   */
  cancelOpenBySymbol(traderId: number, symbol: string): number {
    const result = getDb().run(
      `UPDATE orders SET status = 'CANCELED'
        WHERE trader_id = ? AND symbol = ? AND status = 'NEW'`,
      traderId,
      symbol,
    );
    return Number(result.changes ?? 0);
  },

  openProtectionTypes(traderId: number, symbol: string): string[] {
    const rows = getDb().all<{ type: string }>(
      `SELECT type FROM orders
        WHERE trader_id = ? AND symbol = ? AND status = 'NEW'
          AND (type LIKE 'STOP%' OR type LIKE 'TAKE_PROFIT%' OR type = 'TRAILING_STOP_MARKET')`,
      traderId,
      symbol,
    );
    return rows.map((row) => row.type);
  },

  latestMarginTypeBySymbol(traderId: number): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of getDb().all<{ symbol: string; margin_type: string }>(
      `SELECT o.symbol, o.margin_type
         FROM orders o
         JOIN (SELECT symbol, MAX(id) AS mid
                 FROM orders
                WHERE trader_id = ? AND margin_type IS NOT NULL AND margin_type <> ''
                GROUP BY symbol) latest
           ON o.id = latest.mid`,
      traderId,
    )) {
      map.set(String(row.symbol), String(row.margin_type));
    }
    return map;
  },

  /**
   * 某机器人的订单记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：机器人每下一单就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要第一页之后又落了一张新订单，整个窗口就往下挪一格 —— 第二页的第一条会和第一页的
   * 最后一条**重复**（同一张订单在表格里出现两次，看起来像下了两单）。游标锚在一条具体
   * 订单的 `id` 上：新订单的 `id` 一定更大、永远落在游标之上，页与页之间既不重也不漏。
   * `trades.list()` / `decisions.list()` 是同一套契约。
   *
   * ## 排序键必须就是游标键
   *
   * 翻页边界要成立，`ORDER BY` 与游标只能是同一列，所以这里按自增主键 `id`（写入顺序）
   * 倒序。它同时仍然是"最新的一单在最上面"：订单是**下出去那一刻**写进来的，
   * `id` 倒序与原来的 `created_at DESC` 是同一个顺序。
   * 索引 `idx_orders_trader` 建在 `created_at` 上，所以这条查询会在按 `trader_id`
   * 过滤之后再排序，代价可以忽略 —— 换来的是页边界不可能漏行或重复。
   *
   * 页大小由 `clampOrderLimit` 钳制：`?limit=999999` 最多只会拿到 `ORDER_PAGE_MAX` 条。
   */
  list(traderId: number, limit = ORDER_PAGE_DEFAULT, before?: number | null): OrderRecord[] {
    const pageSize = clampOrderLimit(limit);
    const cursor = cursorOf(before);

    /*
     * 各标的的杠杆读数（**含 `pending` 行**）—— 挂单在本地是有持仓行的，
     * 那张行上就记着杠杆。界面要靠它显示"开仓单的杠杆"：
     * 不能按交易所的真实持仓读（挂单还没成交，那里没有）。
     */
    const leverages = new Map<string, number>();
    for (const p of getDb().all<{ symbol: string; leverage: number }>(
      'SELECT symbol, leverage FROM positions WHERE trader_id = ? ORDER BY id ASC',
      traderId,
    )) {
      if (typeof p.leverage === 'number' && p.leverage > 0) leverages.set(p.symbol, p.leverage);
    }

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<OrderRow>(
          'SELECT * FROM orders WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map((row) => toOrder(row, leverages));
    }

    return getDb()
      .all<OrderRow>(
        'SELECT * FROM orders WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
      )
      .map((row) => toOrder(row, leverages));
  },

  /**
   * **还没平掉的那些仓位，已经付掉的入场成本合计**（手续费 + 资金费）。
   *
   * ## 为什么总账校验需要它
   *
   * 交易所的流水（`incomeEvents`）从**开仓那一刻**就有 `COMMISSION`，持仓期间还会
   * 有 `FUNDING_FEE`；而平台的 `trades` **只在平仓时**记一笔。于是只要有持仓，
   * 「平台净额」天然比「交易所流水」少一个"未平仓的持有成本"。
   *
   * 实测：两条告警的差额 `0.0119` / `0.0202` 正好等于当时那两个仓位的入场手续费
   * （ETH `0.0118539` + HYPE `0.00837404`）。而它被报成了
   * **「平台的账本可能有漏记或重复记账，请先核对再让机器人继续交易」** ——
   * 一个纯粹的口径差被说成了账目错误，而且每轮都报一次。
   *
   * 所以总账校验的两侧必须用**同一个口径**：把未平仓的持有成本加到平台侧。
   *
   * @param entryOrderIds **当前仍然持仓**的那些仓位各自的入场订单号
   *   （`positions.entry_order_id`）。
   *
   *   ⚠️ **必须是"这一笔持仓的入场单"，不能按 `symbol` 过滤。**
   *
   *   原来这里收的是 symbol 列表，于是**同一个标的历史上已平仓回合的入场手续费
   *   会被重复计入**（那些回合的盈亏早已通过 `trades` 记进 `platformSelf`，
   *   入场费再加一遍就是记两次）。函数自己的注释也写着"不传 symbols 会把已平仓的
   *   入场费算进来，反而造成反向误差 —— 所以要传"，**但传 symbol 根本没解决它**：
   *   同一标的反复开平是常态。
   *
   *   按入场订单号过滤之后，这一项才真的等于"手上这些仓位已经付掉的入场费"。
   *
   *   另：`orders` 表**没有资金费列**，持仓期间的资金费只存在于交易所流水
   *   （`income`）那一侧。**这一项只覆盖手续费** —— 所以调用方还要另外把
   *   未平仓仓位的资金费补上（`fundingSince()`）。
   *
   *   ✅ 2026-10-03：那条补充已经接上了（见 `reconcileTradeHistory` 里的 `openCosts`）。
   *   这里原来写的是「平台侧在跨过资金费结算点时仍会偏小一点，这是**已知且方向固定的
   *   残差，不要再靠猜口径去补**」—— 而它**不用猜**：资金费就在 `income` 流水里，
   *   按标的 + 开仓之后聚合即可。留着那条注释会让人以为这个偏差是设计上接受的。
   */
  openEntryCosts(traderId: number, entryOrderIds: readonly string[]): number {
    const ids = entryOrderIds.filter((id) => id.length > 0);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const row = getDb().get<{ total: number | null }>(
      `SELECT SUM(COALESCE(fee, 0)) AS total
         FROM orders
        WHERE trader_id = ?
          AND purpose = 'entry'
          AND status = 'FILLED'
          AND exchange_order_id IN (${placeholders})`,
      traderId,
      ...ids,
    );
    return Number(row?.total ?? 0);
  },

  insert(input: {
    traderId: number;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: string;
    purpose: OrderRecord['purpose'];
    quantity: number;
    price: number | null;
    stopPrice: number | null;
    status: string;
    /** Fill details. Omitted for orders that rest (stops, targets) or are rejected. */
    avgPrice?: number | null;
    filledQty?: number;
    fee?: number;
    error?: string | null;
    rawResponse?: unknown;
    /**
     * 这一行对应占用的保证金（USDT 本金）。
     *
     * **不传就是"不知道"**（落 `NULL`，读取时是 `undefined`）。
     * ⚠️ 不要用 0 表达"不知道" —— 0 会被读成"这笔没占保证金"，
     * 见 `M13_ORDER_MARGIN_USED` 与 `toOrder()`。
     */
    marginUsed?: number | null;
    /**
     * 下单时该标的的保证金模式（`cross` / `isolated`，也接受配置里那个 `crossed`）。
     *
     * **不传就是"不知道"**（落 `NULL`，读取时是 `undefined` → 界面 `—`）。
     * ⚠️ 不要用 `'cross'` 表达"不知道" —— 币安的默认是全仓，但"默认是"不是
     * "我们读到了"，见 `M14_ORDER_MARGIN_TYPE`。
     *
     * 收的是**原始拼法**（交易所读回来是 `cross`、策略配置里是 `crossed`），
     * 由 `normalizeMarginMode()` 归一后落库；**认不出的拼法落 `NULL` 而不是报错** ——
     * 好过让一个拼法差异悄悄变成"另一个模式"。
     */
    marginType?: MarginMode | string | null;
  }): number {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO orders (trader_id, exchange_order_id, client_order_id, symbol, side, type, purpose, quantity, price, stop_price, status, avg_price, filled_qty, fee, error, raw_response, margin_used, margin_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.exchangeOrderId,
      input.clientOrderId,
      input.symbol,
      input.side,
      input.type,
      input.purpose,
      input.quantity,
      input.price,
      input.stopPrice,
      input.status,
      input.avgPrice ?? null,
      input.filledQty ?? 0,
      input.fee ?? 0,
      input.error ?? null,
      input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse),
      /* 落库前再收一次：这一列的值只有"正数"或"不知道"两种，见 `positiveOrNull()`。 */
      positiveOrNull(input.marginUsed),
      /* 同上：只有 `cross` / `isolated` 或"不知道"，见 `normalizeMarginMode()`。 */
      normalizeMarginMode(input.marginType),
      ts,
      ts,
    );
    return lastInsertRowid;
  },

  /**
   * 按**交易所单号**找一行。
   *
   * ## 为什么需要它（而不是用本地 `orders.id`）
   *
   * 成交那一刻手上只有**持仓行**（`promotePendingEntry()`），而
   * `positions.entry_order_id` 存的是**交易所单号** —— 本地订单表的主键在那条路径上
   * 根本拿不到。加这个方法，是为了让"成交了"这件事能在**发生的地方**写回订单行，
   * 而不是指望以后有人来收拾（实测就是没人收拾：那张开仓单从成交起一直停在 `NEW`，
   * 界面上同时显示"持仓 12.7 @ 1.5600"和"开仓 限价 已挂单"）。
   */
  findByExchangeOrderId(traderId: number, exchangeOrderId: string): OrderRecord | null {
    const row = getDb().get<OrderRow>(
      'SELECT * FROM orders WHERE trader_id = ? AND exchange_order_id = ? ORDER BY id DESC LIMIT 1',
      traderId,
      exchangeOrderId,
    );
    return row ? toOrder(row) : null;
  },

  /**
   * 仍处于**非终态**、且早于 `createdBefore` 的委托行，最新在前。
   *
   * 这是"交易所已经不挂了、本地还停在 `NEW`"那些行的候选集。它只做筛选：
   * 这里**判断不了**哪一行真的已经不在交易所 —— 那只能问交易所，所以调用方
   * （`AutoTrader.settleStaleOrders()`）在改任何一行之前都会先去读挂单列表。
   *
   * `createdBefore` 是给刚下的单留的宽限窗口（窗口多长、为什么需要，见
   * `ORDER_SETTLE_GRACE_MS`）：挂单列表是一次**读**，而一张单从"我们记下它"到
   * "交易所的挂单列表里能看到它"之间可能有极短的时延，没有这个下界就会把刚挂上去的
   * 保护单结清掉 —— 那正好是 §2.6 最怕的事。
   */
  unsettled(traderId: number, createdBefore: string): OrderRecord[] {
    const placeholders = TERMINAL_ORDER_STATUSES.map(() => '?').join(', ');
    return getDb()
      .all<OrderRow>(
        `SELECT * FROM orders WHERE trader_id = ? AND created_at <= ? AND status NOT IN (${placeholders}) ORDER BY id DESC`,
        traderId,
        createdBefore,
        ...TERMINAL_ORDER_STATUSES,
      )
      .map((row) => toOrder(row));
  },

  /**
   * 就地修正一行订单。
   *
   * `undefined` **保持原值**（而不是写成 null）：调用方只想改状态时不必先把整行读出来，
   * 也不会顺手把它没打算碰的成交数量清掉。
   */
  update(
    id: number,
    input: Partial<{
      status: string;
      avgPrice: number | null;
      filledQty: number;
      fee: number;
      error: string | null;
      /**
       * 交易所对这张单的**最终**答复。结清一张条件单时写在这里，
       * 于是 `raw_response` 从头到尾都是交易所说过的话（§2.2），而不是只剩一个状态码。
       */
      rawResponse: unknown;
    }>,
  ): void {
    const row = getDb().get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
    if (!row) return;
    getDb().run(
      'UPDATE orders SET status = ?, avg_price = ?, filled_qty = ?, fee = ?, error = ?, raw_response = ?, updated_at = ? WHERE id = ?',
      input.status ?? row.status,
      input.avgPrice === undefined ? row.avg_price : input.avgPrice,
      input.filledQty ?? row.filled_qty,
      input.fee ?? row.fee,
      input.error === undefined ? row.error : input.error,
      input.rawResponse === undefined ? row.raw_response : JSON.stringify(input.rawResponse),
      now(),
      id,
    );
  },

  /** Fee total for a trader's trades, used in stats. */
  totalFees(traderId: number): number {
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(fee) AS total FROM orders WHERE trader_id = ?',
      traderId,
    );
    return row?.total ?? 0;
  },
};

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

interface TradeRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  leverage: number;
  pnl: number;
  pnl_percent: number;
  fee: number;
  close_reason: string;
  opened_at: string;
  closed_at: string;
  hold_minutes: number;
  entry_fee: number;
  funding_fee: number;
  net_pnl: number;
  source: string;
  entry_order_id: string | null;
  exit_order_id: string | null;
  /**
   * **JOIN 出来的列，不是 `trades` 自己的列** —— 见 `TradeRecord.marginType`。
   *
   * 查询里用 `LEFT JOIN orders`（按 `exchange_order_id = entry_order_id`）拿到
   * 入场那一单的保证金模式。补录的回合或 v14 之前的订单没有匹配行时是 `null`。
   */
  entry_margin_type?: string | null;
}

function toTrade(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    quantity: row.quantity,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    leverage: row.leverage,
    pnl: row.pnl,
    entryFee: row.entry_fee,
    exitFee: Math.max(0, row.fee - row.entry_fee),
    fee: row.fee,
    fundingFee: row.funding_fee,
    netPnl: row.net_pnl,
    pnlPercent: row.pnl_percent,
    closeReason: row.close_reason,
    source: (row.source === 'reconciled' ? 'reconciled' : 'bot') as 'bot' | 'reconciled',
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    holdMinutes: row.hold_minutes,
    /*
     * 保证金是**派生**的，不落库：这一行的三个输入都在，而且建仓时写进
     * `positions.margin_used` 用的就是同一个 `marginOf()`（`trades.insert()` 里
     * 算 `pnl_percent` 用的也是它）—— 三处必须是同一个数，否则"这笔占了多少本金"
     * 会随读它的地方而变。
     */
    marginUsed: marginUsedOrUndefined(row.entry_price, row.quantity, row.leverage),
    /*
     * 保证金模式来自**入场订单那一行**（SQL 里的 `LEFT JOIN orders`）。
     * 取不到就是 `undefined`（界面显示 `—`），绝不回落到 `'cross'` —— 见
     * `TradeRecord.marginType` 上的说明。
     */
    marginType: normalizeMarginMode(row.entry_margin_type) ?? undefined,
  };
}

/**
 * Margin committed by a round-trip, used to express net PnL as a percentage.
 *
 * 出口（`export`）是给 `AutoTrader` 用的：开仓 / 加仓那条路径要在**写订单行**时
 * 把同一个数写进 `orders.margin_used`，而"名义价值 ÷ 杠杆"这个算式**只能有一份** ——
 * 调用点各写一遍的话，两边迟早会分叉（仓库里已经有过"同一个算式五份副本"的教训）。
 */
export function marginOf(entryPrice: number, quantity: number, leverage: number): number {
  const notional = Math.abs(entryPrice * quantity);
  return notional > 0 ? notional / Math.max(leverage, 1) : 0;
}

/**
 * `marginOf()` 的**可缺失版本**：算不出来时回 `undefined`，绝不回 `0`。
 *
 * 为什么要多一个名字：`marginOf()` 在名义价值为 0、或杠杆缺失时都会回一个数字
 * （后者靠 `Math.max(leverage, 1)` 兜底，把 5x 的仓位算成 1x 的保证金，
 * 金额直接放大 5 倍）。而"保证金占用"是要印在界面上的：`0` 读作"这笔没占保证金"，
 * 那个 5 倍的数字读作一个具体金额 —— **两句都是编的**。所以这里在入口就把
 * "缺输入"挡住，让它变成 `undefined`（界面显示 `—`）。
 */
function marginUsedOrUndefined(
  entryPrice: number,
  quantity: number,
  leverage: number,
): number | undefined {
  if (!Number.isFinite(leverage) || leverage <= 0) return undefined;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity)) return undefined;
  if (entryPrice === 0 || quantity === 0) return undefined;
  return marginOf(entryPrice, quantity, leverage);
}

/**
 * How many round-trips the dashboard's trend window covers.
 *
 * 5000 is the same ceiling the console used to request, now applied **in SQL**
 * via `ORDER BY closed_at DESC LIMIT ?` instead of by loading every row and
 * slicing in JavaScript. For any trader under 5000 round-trips the numbers the
 * dashboard renders are byte-for-byte what they were before.
 */
export const TREND_WINDOW = 5000;

/**
 * 疑似重复行的**报告**窗口（毫秒）。
 *
 * 检测比写入守卫更宽：守卫要求 `closed_at` 毫秒精确相同（见 `findDuplicate()`），
 * 是因为它要**改账**；而这里只是把可疑的成对行报给人看，宁可多报也不能漏报 ——
 * 漏掉一对，操作者就永远不知道账上多了一份盈亏。所以窗口放到 1 秒。
 */
const DUPLICATE_REPORT_WINDOW_MS = 1000;

/**
 * 判定"这是同一个回合"时，数量与入场价允许的偏差（相对值）。
 *
 * ## 为什么数量不能当判据
 *
 * 同一回合的两条记账路径本来就按**不同口径**取数量：运行期记的是本地持仓行的
 * 数量（下单时按名义价值取整得到的），对账记的是交易所实际成交量（多笔成交加权后
 * 保留 12 位）。实盘上那三组重复行能被生成，正是因为这两个口径**不相等**时没有任何
 * 东西拦它；这次复现量到的偏差是 0.008823 对 0.008923（约 1.1%）。
 *
 * 所以容差不能按"浮点噪声"来定 —— 差 1.1% 完全正常，而 1e-6 这种要求浮点相等的
 * 判据正是这个 bug 钻过去的缝。20% 的用意是：数量只用来**排除明显不相干的同一标的
 * 其它回合**，真正的身份是 `closed_at`（同一个真实成交，两条路径拿到的时间戳一致，
 * 实测差 368ms）。单向持仓模式下同一标的同一毫秒不可能平掉两个仓位，所以
 * `closed_at` 命中就是同一个真实事件。
 */
const DUPLICATE_QUANTITY_TOLERANCE = 0.2;

/**
 * 入场价的相对容差。
 *
 * 两条路径的入场价都来自交易所，但一条是持仓行里的成交均价、另一条是多笔成交
 * 加权后保留 12 位的 VWAP，多笔分批成交时最后几位可以不同 —— 所以这里也是
 * 相对比较，而不是"浮点相等"。
 */
const DUPLICATE_PRICE_TOLERANCE = 1e-6;

/**
 * **出场价**的相对容差 —— 两条记账路径之间唯一同源的那个字段。
 *
 * 取得比入场价那条（1e-6）宽、比"完全相等"实际：同一个真实成交的出场均价
 * 在两条路径上可能因为分批成交的加权顺序差末位，但不可能差出千分之一。
 * 0.05% 对 2600 美元的 ETH 是 1.3 美元 —— 远小于任何两个**不同**回合之间的价差
 * （同标的、同方向、同数量、同一价位附近平掉两笔真实回合，中间还隔着再入场冷却）。
 *
 * 详见 `findDuplicate()` 里那段"为什么不能靠放宽平仓时间"的说明。
 */
const DUPLICATE_EXIT_PRICE_TOLERANCE = 5e-4;

/**
 * **入场时间**允许的偏差（毫秒）—— 判定"同一个回合"的主判据。
 *
 * ## 为什么是 `opened_at` 而不是 `closed_at`
 *
 * 实测一对真实的重复（同一笔 ETH 被记了两次）：
 *
 *     #90 bot          opened_at 17:14:51.381   closed_at 02:02:20.361
 *     #92 reconciled   opened_at 17:14:41.276   closed_at 01:51:35.036
 *
 * **入场时间只差 10 秒**（下单到成交的延迟），**平仓时间差了 11 分钟**。
 * 两个字段的差别在于**它们各自从哪来**：
 *
 *  · `opened_at` 两条路径都锚在**这笔仓位什么时候开的**，中间只隔下单延迟；
 *  · `closed_at` 一条是本地"察觉到仓位消失"的时刻（可能晚一整轮），
 *    另一条是交易所成交记录里的时刻 —— **两个不同的时钟**。
 *
 * 所以身份判据要挂在 `opened_at` 上，而不是 `closed_at`。
 *
 * ## 为什么 5 分钟既能覆盖又能区分
 *
 *  · **能覆盖**：同一回合的两条路径差的是下单延迟，实测 10 秒；
 *  · **能区分**：同一标的两笔**真实**回合之间至少隔着再入场冷却
 *    （`throttle.reentryCooldownMinutes`，配置里是 10 分钟）——
 *    而 `autoTrader.test.ts` 里那个 fixture 的两笔正好差 11 分钟。
 *
 * 5 分钟留了一半余量给"时钟漂移 + 下单延迟"，又远小于冷却时间。
 */
const DUPLICATE_OPEN_TOLERANCE_MS = 300_000;

/**
 * `closed_at` 允许的偏差（毫秒）—— **这是写入守卫的关键容差**。
 *
 * ## 为什么不能要求毫秒精确相等
 *
 * 这一处原来写的是
 * `strftime('%Y-%m-%dT%H:%M:%f', closed_at) = strftime('%Y-%m-%dT%H:%M:%f', ?)`，
 * 即**毫秒精确相等**。而同一回合的两条记账路径拿到的平仓时刻本来就不同：
 * 运行期用的是它在本地**察觉到仓位消失**的时刻，对账用的是交易所**成交记录**里的时刻。
 *
 * 上一条注释一边说这两者"一致、实测差 368ms"，一边把守卫写成精确相等 ——
 * **自相矛盾，于是守卫在它本该生效的那个场景里永远不会触发**。实盘后果实测到了：
 *
 *     #29 BULLAUSDT  closed_at 17:39:06.483  source=bot         费 0
 *     #30 BULLAUSDT  closed_at 17:39:06.033  source=reconciled  费 0.0249
 *
 * 同一个回合被记了两次，账面多算一笔 -0.156 的亏损。
 *
 * ## 为什么 2 秒是安全的
 *
 * 单向持仓模式下**同一标的同一时刻只能有一个仓位**；同一标的的两笔真实回合之间
 * 至少隔着再入场冷却（配置里是分钟级）。所以 2 秒远不足以把两笔真实回合并成一笔，
 * 而 450ms 这种路径差异又能被覆盖。
 */
const DUPLICATE_CLOSE_TOLERANCE_MS = 2000;

/**
 * How many equity snapshots the time-to-trough drawdown considers.
 *
 * Same number the console passed inline before (`equity.list(traderId, 5000)`),
 * hoisted to a named constant so the single read and any future caller agree on
 * it. With one snapshot per cycle, 5000 covers a 15-minute trader for ~52 days —
 * beyond that the dashboard's drawdown is "recent", and the *breaker* uses
 * `equity.realizedHighWaterMark()`, which is unaffected by this bound.
 */
export const EQUITY_CURVE_WINDOW = 5000;

/** One point of the PnL curve. Where the type says `snake_case`, SQL named it. */
export interface TradeCurvePoint {
  pnl: number;
  pnl_percent: number;
  net_pnl: number;
  fee: number;
  funding_fee: number;
  closedAt: string;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  best: number;
  worst: number;
  avgWin: number;
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Earliest close on the books, for "how long has this been running". */
  firstClosedAt: string | null;
}

/**
 * 一个**固定时间窗口**内的绩效聚合（`trades.performanceSince()`）。
 *
 * 与 `TradeStats` 的区别是"有没有界"：`TradeStats` 是终身口径（给控制台看的），
 * 这个结构是窗口口径（给模型看的）。它存在的全部理由是 §4 的 O(1) 性质 ——
 * 字段是固定的，所以提示词大小与 `trades` 的行数无关。
 */
export interface TradePerformance {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  /** 亏损单净额的绝对值之和（正数）。 */
  grossLoss: number;
  avgWin: number;
  /** 平均亏损额，**正数**；渲染成负数由调用方决定。 */
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Σ|入场价 × 数量|：窗口内回合的名义价值合计。 */
  notional: number;
  /** 往返手续费率（**小数比例**：0.001 = 0.10%）；窗口内没有成交时为 null。 */
  roundTripFeeRate: number | null;
}

/**
 * One pass over `trades`: aggregate in SQL, materialise only the trend window.
 *
 * Why: `computeTraderStats` used to pull every column of every round-trip into
 * JavaScript objects and reduce them there — twice per request, once for
 * `stats()` and once for the Sharpe input — and it is called every 5–12 s per
 * trader. `node:sqlite` is synchronous, so those object graphs were built on the
 * same event loop that places orders. SQLite counts and sums without leaving C,
 * so the JavaScript work drops from O(all round-trips) to O(window).
 *
 * `COUNT(*)` and `SUM(...)` deliberately still cover the **whole** table: the
 * headline totals (lifetime trades, net PnL, fees, funding) must stay lifetime
 * figures and must not silently follow the window.
 */
function aggregateTrades(traderId: number): { totals: TradeStats; curve: TradeCurvePoint[] } {
  const totals = getDb().get<{
    totalTrades: number;
    wins: number;
    losses: number;
    grossProfit: number | null;
    grossLoss: number | null;
    best: number | null;
    worst: number | null;
    grossPnl: number | null;
    totalFees: number | null;
    totalFunding: number | null;
    netPnl: number | null;
    firstClosedAt: string | null;
  }>(
    `SELECT
       COUNT(*)                                                   AS totalTrades,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END), 0) AS losses,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN net_pnl ELSE 0 END), 0) AS grossProfit,
       ABS(COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl ELSE 0 END), 0)) AS grossLoss,
       MAX(net_pnl) AS best,
       MIN(net_pnl) AS worst,
       COALESCE(SUM(pnl), 0)         AS grossPnl,
       COALESCE(SUM(fee), 0)         AS totalFees,
       COALESCE(SUM(funding_fee), 0) AS totalFunding,
       COALESCE(SUM(net_pnl), 0)     AS netPnl,
       MIN(closed_at) AS firstClosedAt
     FROM trades WHERE trader_id = ?`,
    traderId,
  );

  const totalTrades = totals?.totalTrades ?? 0;
  const wins = totals?.wins ?? 0;
  const losses = totals?.losses ?? 0;
  const grossProfit = totals?.grossProfit ?? 0;
  const grossLoss = totals?.grossLoss ?? 0;

  return {
    totals: {
      totalTrades,
      wins,
      losses,
      grossProfit,
      grossLoss,
      // `MAX(net_pnl)` is NULL only when there are no rows, which is reported as 0
      // rather than left as a null the console would have to special-case.
      best: totals?.best ?? 0,
      worst: totals?.worst ?? 0,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: totals?.grossPnl ?? 0,
      totalFees: totals?.totalFees ?? 0,
      totalFunding: totals?.totalFunding ?? 0,
      netPnl: totals?.netPnl ?? 0,
      firstClosedAt: totals?.firstClosedAt ?? null,
    },
    curve: getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        TREND_WINDOW,
      )
      // Reversed to chronological order: a drawdown walk is direction-sensitive,
      // so walking newest-first would silently report a different (smaller) one.
      .reverse(),
  };
}

/** One detected pair of rows that describe the same real round-trip. */
export interface TradeDuplicateSuspect {
  traderId: number;
  /** `reconciled` 那行与运行期那行的 id；顺序按 id 升序，与来源无关。 */
  idA: number;
  idB: number;
  symbol: string;
  quantity: number;
  closedAt: string;
  reasonA: string;
  reasonB: string;
  netA: number;
  netB: number;
}

/**
 * 一次最多回多少条成交记录。
 *
 * 与 `ORDER_PAGE_MAX` 同一个理由：成交行是最宽的一张（毛盈亏、开/平两侧手续费、
 * 资金费、净盈亏、来源、两个订单号、平仓原因…），而这张表随着每次平仓无限增长。
 * 200 是操作者上一版控制台每次轮询要的条数，上限只为手写请求兜底。
 */
export const TRADE_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100）。 */
export const TRADE_PAGE_DEFAULT = 100;

/** `trades.list()` 的页大小：见 `clampPageLimit`。 */
export function clampTradeLimit(limit: number): number {
  return clampPageLimit(limit, TRADE_PAGE_MAX, TRADE_PAGE_DEFAULT);
}

/**
 * 重建出来的成交量**可信到可以覆盖本地**吗？
 *
 * ## 为什么要有这道判断（实测：账目凭空多出 0.0596）
 *
 * `reconstructRoundTrips()` 用**净头寸法**判断开/平，而它拿不到"窗口起点时的持仓"——
 * 一旦起点落在某个持仓的中间，整条成交序列就会错位。实测（2026-09-29，HYPEUSDT）：
 *
 * ```text
 * 真实成交： 13:17 SELL 0.20（是【平掉更早的空头】）→ 19:53 BUY 0.15（开新多头）→ …
 * 重建结果： 13:17 → 21:37  short qty=0.35 毛=0.000000   ← 把"平 0.20"当成了"开空"
 *            21:37 → 23:25  long  qty=0.01  毛=0.089040   ← 数量被带偏（真实 0.21）
 * ```
 *
 * 而 `applyExchangeFigures()` 会把这个错数量覆盖进本地，**按数量计价的手续费**跟着算小
 * → 净额偏大 → 本地合计比交易所多 **0.0596**（就是 `ledger_check` 上那个 gap）。
 *
 * 本地数量来自**运行期持仓行**（当时真实下单的数量），它**不经过重建**。
 * 所以当两者差到"不可能是同一个回合"时，保留本地。
 *
 * 阈值 1.5 倍：正常的部分成交/合并都在这个量级内（0.20 vs 0.21 ✓）；
 * 而错位那种是**几十倍**（0.01 vs 0.21 = 21 倍）。
 */
export function shouldTrustReconciledQuantity(localQuantity: number, reconciled: number): boolean {
  if (!(localQuantity > 0) || !(reconciled > 0)) return false;
  const ratio = Math.max(localQuantity, reconciled) / Math.min(localQuantity, reconciled);
  return ratio <= 1.5;
}

export const trades = {
  /** 某一笔的成交量 —— 供"重建数量是否可信"的判断使用（见 `shouldTrustReconciledQuantity`）。 */
  quantityOf(id: number): number | undefined {
    const row = getDb().get<{ quantity: number }>('SELECT quantity FROM trades WHERE id = ?', id);
    return row?.quantity;
  },

  /**
   * 某一笔**已存**的费用（开仓侧/平仓侧）。
   *
   * ⚠️ 用途：**流水取不到时不要把它抹掉**。`commissionsInWindow()` 在窗口不对或流水为空时
   * 返回 0，而 0 **不代表"这笔没有手续费"** —— 直接写 0 会把一个正确的数字（可能是运行期
   * 记下的、甚至交易所退费的负数）覆盖掉。实测被测试抓到过一次
   * （见 `autoTrader.test.ts` 的「对账重复执行是幂等的」）。
   *
   * ⚠️ **`exit_fee` 不是数据库列**（`schema.ts` 的迁移只加了 `entry_fee`），
   * 所以这里**必须派生**，与 `trades.list()` 的读出层同一个口径：
   * `exit_fee = fee − entry_fee`。
   *
   * 原实现写的是 `SELECT entry_fee, exit_fee FROM trades` —— 那个查询**必然抛**
   * `no such column: exit_fee`。它此前没有调用者，所以是一颗没被踩到的哑弹；
   * 一旦有人调用就会直接拿到 500（`server.ts` 把非 4xx 一律按 500 处理）。
   * 顺带一提：`schema.ts` 里 `net_pnl = gross − entry_fee − exit_fee − funding_fee`
   * 那一行只是注释，不是 DDL，别被它误导。
   */
  feesOf(id: number): { entryFee: number; exitFee: number } {
    const row = getDb().get<{ entry_fee: number | null; fee: number | null }>(
      'SELECT entry_fee, fee FROM trades WHERE id = ?',
      id,
    );
    const entryFee = Number(row?.entry_fee) || 0;
    const fee = Number(row?.fee) || 0;
    /* 夹到 0 以上：手续费有**退费**的负数情形，此时派生的平仓侧不该变成负成本。 */
    return { entryFee, exitFee: Math.max(0, fee - entryFee) };
  },
  /**
   * 某机器人的成交记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：每平一次仓就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要中间又平了一仓，窗口就整体下移一格 —— 第二页会重复第一页的最后一条
   * （同一笔成交在表格里出现两次，看起来像多平了一次仓，而这张表的数字是钱）。
   * 游标锚在具体一行的 `id` 上，新行的 `id` 一定更大、永远落在游标之上。
   *
   * ## 排序键必须就是游标键 —— 这里从 `closed_at DESC` 换成了 `id DESC`
   *
   * 页边界要成立，`ORDER BY` 与游标只能是同一列。`closed_at` 做不到：
   * 对账补录（`reconcileTradeHistory`）会把**进程未运行时**才平掉的回合现在写进来，
   * 这些行的 `closed_at` 比已经在库里的行更旧，于是"按 `closed_at` 排"与"按写入顺序排"
   * 是两种不同的顺序，用 `id` 当游标必然漏行或重复。
   *
   * `id` 倒序的实际含义是"最近记进来的在最上面"，运行期记账时它与 `closed_at` 完全同序
   * （平仓那一刻就写），只有对账补录的行会排到顶部 —— 那正好是该被看见的行
   * （表格里带 `对账补录` 徽章），也让"重复执行对账只修正、不重复插入"这件事一眼可查。
   * 代价是补录行不再按它的成交时间插回历史中间；页边界不重不漏优先于这一点。
   */
  /**
   * 历史成交列表。
   *
   * ## ⚠️ 排序必须按 `closed_at`，不能按 `id`
   *
   * 用户的原话：「**历史成交里面日期显示错乱（不是完全按时间排序）**」。
   *
   * 这是真 bug，而且根因很具体：`id` 是**插入顺序**，而**对账补录的行 id 更大、
   * 成交时刻却更早**。实测那台机器人的列表（按 id 倒序）：
   *
   *     #131  09-24 21:57:05
   *     #130  09-24 21:57:10   ← 更晚，却排在下一行
   *     #127  09-22 11:04:18   ← 跳回两天前
   *     #126  09-20 23:45:50   ← 又往前
   *     #113  09-23 11:09:03   ← 又跳回来
   *
   * 18 行里有 **4 处**乱序。按 `closed_at` 排则是 **0 处**。
   *
   * ## 为什么原来会选 id（以及那个权衡为什么是错的）
   *
   * 这段代码原来的注释写着：「代价是补录行不再按它的成交时间插回历史中间；
   * **页边界不重不漏优先于这一点**」。**分页正确性确实重要**，但那不是二选一：
   * 用 `(closed_at, id)` **复合游标**就能同时满足 —— 排序按时间，而游标带上
   * `closed_at` 之后，页边界仍然不重不漏。
   *
   * ## 游标
   *
   * `before` 仍是 id（老契约不破坏），但配合 `beforeClosedAt` 一起用：
   * **只给 id 时退回旧行为**（按 id 分页），两个都给时按时间排序 + 复合游标。
   * 控制台两个都传。
   */
  list(
    traderId: number,
    limit = TRADE_PAGE_DEFAULT,
    before?: number | null,
    beforeClosedAt?: string | null,
  ): TradeRecord[] {
    const pageSize = clampTradeLimit(limit);
    const cursor = cursorOf(before);

    if (cursor !== null && beforeClosedAt) {
      /*
       * 复合游标：`closed_at` 更早的排在后面；同一毫秒的用 id 破平。
       * 两个条件缺一不可 —— 只比 `closed_at` 会在同一毫秒上漏行，只比 id 就是
       * 原来那个会错乱的写法。
       */
      return getDb()
        .all<TradeRow>(
          `SELECT t.*, o.margin_type AS entry_margin_type
             FROM trades t
             LEFT JOIN orders o
               ON o.trader_id = t.trader_id AND o.exchange_order_id = t.entry_order_id
            WHERE t.trader_id = ? AND (t.closed_at < ? OR (t.closed_at = ? AND t.id < ?))
            ORDER BY t.closed_at DESC, t.id DESC LIMIT ?`,
          traderId,
          beforeClosedAt,
          beforeClosedAt,
          cursor,
          pageSize,
        )
        .map(toTrade);
    }

    // 老契约：只给了 id 游标时按 id 分页（行为与以前完全一致）。
    if (cursor === null) {
      return getDb()
        .all<TradeRow>(
          `SELECT t.*, o.margin_type AS entry_margin_type
             FROM trades t
             LEFT JOIN orders o
               ON o.trader_id = t.trader_id AND o.exchange_order_id = t.entry_order_id
            WHERE t.trader_id = ? ORDER BY t.closed_at DESC, t.id DESC LIMIT ?`,
          traderId,
          pageSize,
        )
        .map(toTrade);
    }

    return getDb()
      .all<TradeRow>(
        `SELECT t.*, o.margin_type AS entry_margin_type
           FROM trades t
           LEFT JOIN orders o
             ON o.trader_id = t.trader_id AND o.exchange_order_id = t.entry_order_id
          WHERE t.trader_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?`,
        traderId,
        cursor,
        pageSize,
      )
      .map(toTrade);
  },

  recent(traderId: number, limit = 10): TradeRecord[] {
    return this.list(traderId, limit);
  },

  /**
   * 一个时间窗口内的成交绩效，**全部在 SQL 里聚合**。
   *
   * ## 为什么必须有这个函数（提案 §4 的 O(1) 性质）
   *
   * 提示词要告诉模型"你最近在亏钱"，而 `trades` 是**随时间无限增长**的表。
   * 这个函数对外只回**固定几个字段**：无论窗口里有 3 笔还是 30000 笔，进提示词的
   * 字节数完全一样。没有这条保证，"7×24 跑一年"就只是一个说法 —— 跑一年之后
   * 提示词会随历史长度线性膨胀，直到撑爆上下文。
   *
   * 分类口径与 `aggregateTrades()` 严格一致：按**净**盈亏判胜负。一笔毛赚了
   * 一点点、但不够付手续费的钱实际是亏的，算成盈利会同时抬高胜率与盈亏比 ——
   * 那是这个产品最容易骗自己的地方。
   *
   * @param sinceIso 窗口起点（含）。调用方给固定长度的窗口（例如最近 24 小时），
   *   所以窗口内的行数由**交易频率**决定，而不是由历史长度决定。
   */
  performanceSince(traderId: number, sinceIso: string): TradePerformance {
    const row = getDb().get<{
      totalTrades: number;
      wins: number;
      losses: number;
      grossProfit: number | null;
      grossLoss: number | null;
      grossPnl: number | null;
      totalFees: number | null;
      totalFunding: number | null;
      netPnl: number | null;
      notional: number | null;
    }>(
      `SELECT
         COUNT(*)                                                   AS totalTrades,
         COALESCE(SUM(CASE WHEN net_pnl >  0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(CASE WHEN net_pnl >  0 THEN net_pnl ELSE 0 END), 0) AS grossProfit,
         ABS(COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl ELSE 0 END), 0)) AS grossLoss,
         COALESCE(SUM(pnl), 0)          AS grossPnl,
         COALESCE(SUM(fee), 0)          AS totalFees,
         COALESCE(SUM(funding_fee), 0)  AS totalFunding,
         COALESCE(SUM(net_pnl), 0)      AS netPnl,
         COALESCE(SUM(ABS(entry_price * quantity)), 0) AS notional
       FROM trades WHERE trader_id = ? AND closed_at >= ?`,
      traderId,
      sinceIso,
    );

    const wins = row?.wins ?? 0;
    const losses = row?.losses ?? 0;
    const grossProfit = row?.grossProfit ?? 0;
    const grossLoss = row?.grossLoss ?? 0;
    const totalFees = row?.totalFees ?? 0;
    const notional = row?.notional ?? 0;

    return {
      totalTrades: row?.totalTrades ?? 0,
      wins,
      losses,
      grossProfit,
      grossLoss,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: row?.grossPnl ?? 0,
      totalFees,
      totalFunding: row?.totalFunding ?? 0,
      netPnl: row?.netPnl ?? 0,
      notional,
      /*
       * 往返手续费率 = Σ手续费 / Σ名义价值。
       *
       * 为什么是"两个总和相除"而不是"逐笔成本率的平均"：一次往返在开、平两条腿上
       * 各付一次佣金，而两条腿的名义价值都约等于入场名义价值，所以这个比值就是
       * "每往返一次，成本占名义价值的百分之几"——实测 0.1000%。逐笔平均会让
       * 小额回合与小额手续费得到同等权重，一个 12 USDT 的回合和一个 1200 USDT 的
       * 回合会各算一票，得到的费率与本账户的真实成本无关。
       *
       * 读不到成交（窗口内没有行）时回 null —— 让调用方自己决定用什么兜底，
       * 而不是在这里编一个数出来（§5「不要假装算过」）。
       */
      roundTripFeeRate: notional > 0 ? totalFees / notional : null,
    };
  },

  /**
   * 最近若干笔平仓，附带**模型当时的入场理由**（提案 §2.2 的第二行）。
   *
   * 理由取自 `positions.open_reasoning` —— 模型下单时写进持仓行的原话。连接键是
   * `(trader_id, symbol, opened_at)`：运行期记账时 `trades.opened_at` 就是
   * `positions.opened_at` 那一行（`bookClosedPosition()` 直接把它抄过来），
   * 所以这是一次**身份匹配**，不是"看起来差不多"的猜测。
   *
   * 对账补录的行 `opened_at` 来自交易所成交时间，本来就匹配不到持仓行 ——
   * 那就回 null，让提示词如实写"未记录"，而不是猜一个理由出来。
   *
   * ⚠️ 这是提示词里唯一会出现的**逐笔**内容，所以调用方必须传固定的小数字
   * （`PROMPT_RECENT_CLOSE_COUNT`），否则 §4 的 O(1) 性质就没了。
   */
  recentWithReason(
    traderId: number,
    limit: number,
  ): Array<TradeRecord & { entryReason: string | null }> {
    return getDb()
      .all<TradeRow & { entry_reason: string | null }>(
        `SELECT t.*, (
           SELECT p.open_reasoning FROM positions p
            WHERE p.trader_id = t.trader_id
              AND p.symbol = t.symbol
              AND p.opened_at = t.opened_at
            LIMIT 1
         ) AS entry_reason
         FROM trades t WHERE t.trader_id = ? ORDER BY t.id DESC LIMIT ?`,
        traderId,
        Math.max(1, Math.trunc(limit)),
      )
      .map((row) => ({ ...toTrade(row), entryReason: row.entry_reason }));
  },

  /**
   * Record a closed round-trip.
   *
   * `grossPnl` is the exchange's own realised figure and the costs are passed
   * separately, so `net_pnl` — the number the console shows — is derived in one
   * place instead of each caller doing its own arithmetic and disagreeing.
   * `pnlPercent` is deliberately computed here rather than accepted, for the
   * same reason.
   *
   * ## 为什么幂等检查放在这一层（§2.5、§5.4「金额相关的算术只在一个地方算」）
   *
   * 平仓有两条记账路径：运行期（`executeClose` / `bookClosedPosition`，从本地持仓行）
   * 与对账（`reconcileTradeHistory`，从交易所成交历史重建）。它们对同一回合算出的
   * **数量口径可以不同**（本地持仓量 vs 交易所实际成交量），于是对账的严格键与描述
   * 回退键会同时落空，把同一回合插成两行 —— 详见 `findDuplicate()` 的说明。
   *
   * 身份判断只有一处实现（`findDuplicate()`），所以不可能出现"一条路径记得、
   * 另一条忘了"的分裂；调用方只要声明 `idempotent: true` 就拿到这个保证。
   *
   * 返回值带 `created`，让调用方能区分"我补录了一笔"和"这一笔本来就记过了"：
   * 对账靠它把 `recovered` 数准 —— 把重复回合也算成"补录"会让操作员以为账本有漏记，
   * 而实际上什么都没发生。
   */
  insert(input: {
    traderId: number;
    symbol: string;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    leverage: number;
    /** Gross, before costs. */
    grossPnl: number;
    entryFee?: number;
    exitFee?: number;
    fundingFee?: number;
    closeReason: CloseReason;
    openedAt: string;
    /** Exchange fill time. Defaults to now; reconciliation supplies the real one. */
    closedAt?: string;
    source?: 'bot' | 'reconciled';
    entryOrderId?: string | null;
    exitOrderId?: string | null;
    /**
     * 这一回合的**全部**出场成交单号（对账重建的腿会带多个）。
     * 只参与查重，不落库 —— 落库的是最后一个（`exit_order_id`）。
     * 见 `findDuplicate()` 里那段"两条路切法不同"的说明。
     */
    exitOrderIds?: readonly string[];
    /**
     * 这次写入代表**一笔真实平仓**，因此必须先查重（§2.5 的幂等）。
     *
     * 只有 `bookClosedPosition()` 与 `reconcileTradeHistory()` 会打开它。默认关闭，
     * 是因为判据以"平仓时刻"为身份，而测试 fixture 会连记多笔只差盈亏的假成交；
     * 见 `insert()` 内部的说明。
     */
    idempotent?: boolean;
    /**
     * **这笔成交的情报归因**（`<域名>|<方向>|<标的>`）。
     *
     * 见 `db/schema.ts` 的 M16 与 M17：
     * ```
     *   开仓 → 存在 positions.intel_keys（此时决策在手边）
     *   平仓 → 搬到 trades.intel_keys（signalHealth 的数据来源）
     * ```
     *
     * ⚠️ 不传 = `[]` = **纯技术面成交**（与改动前行为一致）。
     * 对账路径（`reconcileTradeHistory`）从交易所历史重建时**拿不到**它 ——
     * 那时为空是正确的（不是"丢了"，而是**那条路径本来就没有决策上下文**）。
     */
    intelKeys?: readonly string[];
  }): { id: number; created: boolean } {
    const closedAt = input.closedAt ?? now();

    /*
     * 幂等只在**真的在记一笔平仓**时生效：`bookClosedPosition()`（运行期）与
     * `reconcileTradeHistory()`（对账）都会显式打开 `idempotent`。
     *
     * 为什么做成显式开关而不是对每一次 `insert()` 都生效：判据依赖**平仓时刻**这个
     * 真实事件的身份，而测试与脚本会连记多笔"看起来一样"的 fixture（同一标的、
     * 同一数量与价位，只差盈亏）。那种行本来就不代表一个交易时刻，拿时间去做唯一性
     * 判定会把它们错误地合成一笔 —— 从而让 `totalTrades`、胜率、盈亏合计全部失真。
     * 两条真实记账路径打开它，才是这个不变量真正需要覆盖的范围。
     */
    const alreadyBooked = input.idempotent
      ? this.findDuplicate({
          traderId: input.traderId,
          symbol: input.symbol,
          quantity: input.quantity,
          entryPrice: input.entryPrice,
          /*
           * ⚠️ **出场价必须传。** 它是这两条记账路径之间**唯一真正同源的字段** ——
           * 两者都由交易所给出，而 `closed_at` 不同源（一条是本地察觉到仓位消失的
           * 时刻，一条是交易所成交记录里的时刻，实测差过 11 分钟）、`entry_price`
           * 也不同源（补录那条用的是快照价而不是成交均价）。见 `findDuplicate()`。
           */
          exitPrice: input.exitPrice,
          openedAt: input.openedAt,
          closedAt,
          entryOrderId: input.entryOrderId,
          /* 确定性键 —— 同一笔平仓只有一个交易所单号，见 `findDuplicate()`。 */
          exitOrderId: input.exitOrderId,
          /*
           * 一个腿可以有**多个**出场单号（部分平仓）。只看最后一个会漏掉
           * "运行期已按每次平仓分别记账"的情形 —— 那正是 2026-10-03 那笔
           * 凭空多出 1.5153 的成因。见 `findDuplicate()`。
           */
          exitOrderIds: input.exitOrderIds,
        })
      : null;
    if (alreadyBooked !== null) return { id: alreadyBooked, created: false };

    const holdMinutes = Math.max(
      0,
      (new Date(closedAt).getTime() - new Date(input.openedAt).getTime()) / 60_000,
    );
    const entryFee = input.entryFee ?? 0;
    const exitFee = input.exitFee ?? 0;
    const fee = entryFee + exitFee;
    const fundingFee = input.fundingFee ?? 0;
    /*
     * ⚠️ **用 `netPnlOf`，不要在这里重写算式** —— 见它的注释：
     * "净 = 毛 − 手续费 − 资金费"那个直觉写法把资金费的符号搞反了，
     * 而它在仓库里曾经有**五份副本**（同一个错误复制了五遍）。
     */
    const netPnl = netPnlOf({ grossPnl: input.grossPnl, fee, fundingFee });
    const margin = marginOf(input.entryPrice, input.quantity, input.leverage);
    const pnlPercent = margin > 0 ? (netPnl / margin) * 100 : 0;

    const { lastInsertRowid } = getDb().run(
      `INSERT INTO trades (
         trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
         pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes,
         entry_fee, funding_fee, net_pnl, source, entry_order_id, exit_order_id, intel_keys
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.exitPrice,
      input.leverage,
      input.grossPnl,
      pnlPercent,
      fee,
      input.closeReason,
      input.openedAt,
      closedAt,
      holdMinutes,
      entryFee,
      fundingFee,
      netPnl,
      input.source ?? 'bot',
      input.entryOrderId ?? null,
      input.exitOrderId ?? null,
      /*
       * **这笔成交的情报归因**（见 `db/schema.ts` 的 M16）。
       *
       * ⚠️ 不传 = `[]` = **纯技术面成交** —— 与改动前行为一致，
       * 也让 225 笔历史成交的语义保持一致（它们确实没有情报归因）。
       */
      JSON.stringify(input.intelKeys ?? []),
    );
    return { id: lastInsertRowid, created: true };
  },

  /**
   * 找出这条"回合"是不是已经记过账了，返回已有行的 id。
   *
   * ## 为什么需要它（这是 §2.5「对账幂等」缺的那一环）
   *
   * 同一个真实回合有两条记账路径：运行期从**本地持仓行**记（`bookClosedPosition`），
   * 对账从**交易所成交历史**重建后再记（`reconcileTradeHistory`）。两条路各自算出的
   * 描述可以不一致 —— 最典型的是数量：本地记的是下单时的请求量 / 持仓行的数量，
   * 交易所重建的是实际成交量（摊到多笔成交上做加权）。一旦不一致，
   * `reconcileTradeHistory` 的严格键（symbol+qty+入场价+入口订单号）和描述回退键
   * **同时**落空，于是它把同一回合又插了一行。实盘上量到的症状：
   *
   *   #17 reconciled / #18 take_profit   SYNUSDT  99  -0.047554650
   *   #11 reconciled / #12 stop_loss     SYNUSDT 169  -0.75613135
   *   #9  reconciled / #10 take_profit   LSKUSDT  35  +0.66674843
   *
   * 12 行里 4 行是 reconciled，其中只有 #4 POWERUSDT 是真的漏记。重复的那 6 行
   * 凭空造出 **+0.4954** 的净盈亏（毛 − 手续费 − 资金费全部被算了两遍），
   * 而对账本来只该"修正、不重复插入"。
   *
   * ## 为什么用这个身份，而不是浮点相等
   *
   * 唯一能同时被两条路拿到的身份是**交易所那一笔的成交时间**（`closed_at`）：
   * 运行期有成交记录时用 `findRoundTrip()` 给出的交易所时间，对账用重建出的
   * `trip.closedAt`，两者来自同一笔平仓成交，实测精确到毫秒相同（上面三组重复行
   * 的 `closed_at` 逐字节一致）。所以判定条件是：
   *
   *   · `closed_at` 的**毫秒精度字符串相同**（`strftime('%Y-%m-%dT%H:%M:%f')`，
   *     纯字符串比较，不是浮点比较），或
   *   · `entry_order_id` 相同（两条路都拿到了交易所的入口订单号，这是铁证）
   *
   * 再加上 symbol + quantity（相对 20%）+ entry_price + exit_price 收窄。容差取相对值
   * 是因为同一回合的两条路径本来就按不同口径取值（本地持仓量 vs 交易所成交量），
   * 要求浮点相等正是这个 bug 钻过去的缝。
   *
   * **出场价为什么必须参与**：`closed_at` 精确相同时，唯一还能区分"同一回合被记两次"
   * 和"同一毫秒内平掉的两笔真实成交"的就是成交价。`retention.test.ts` / `stats.test.ts`
   * 的 fixture 正是后者——同一个标的、同一个入场价、连记四笔不同盈亏的回合；
   * 少了出场价这一项，它们会被判成一笔，`totalTrades` 从 4 变 1、盈亏合计跟着错。
   * 而同一回合被记两次时，交易所的成交价是同一个数（实盘那三组的入场价、出场价都
   * 逐字节相同），所以这一项不会漏判。
   *
   * 找到就返回已有行，调用方**不插新行**：重复执行只修正、不重复插入。
   */
  findDuplicate(input: {
    traderId: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    /** 开仓时刻 —— **主判据**，见 `DUPLICATE_OPEN_TOLERANCE_MS`。 */
    openedAt: string;
    closedAt?: string;
    entryOrderId?: string | null;
    /**
     * **平仓单的交易所单号 —— 这一组判据里唯一确定性的那个。**
     *
     * 一笔平仓在交易所只有一个 `orderId`，而 `trades` 里 25 行**全都有**它
     * （`entry_order_id` 同样 100% 填充）。所以"两个回合的 `exit_order_id` 相同"
     * 不是概率判断，是**同一个回合**的定义。
     *
     * 它接进来之前，去重全靠启发式（数量容差 + 价格容差 + 时间窗），而那些窗口
     * 一定有边界 —— 实测漏网的一对（ZECUSDT `#107` / `#120`）共用一个
     * `exit_order_id`，却因为平仓时刻差 6 秒（超出 2 秒窗口）被判成两个回合，
     * 账上多出一笔。
     */
    exitOrderId?: string | null;
    /**
     * **这个回合的全部出场成交单号**（对账重建的腿会带多个：部分平仓各一笔）。
     *
     * ## 为什么单个 `exitOrderId` 不够（2026-10-03 实盘事故）
     *
     * 运行期与对账对同一段成交的"切法"不同：
     *
     *   · 运行期按**每次平仓**记一笔（本地持仓行消失一次记一次）；
     *   · `reconstructRoundTrips` 按**开仓到清仓**合成一个腿。
     *
     * 实测 `#10` 的 MANAUSDT：交易所是 `BUY 336 → SELL 168 → SELL 168`，
     * 运行期记了 `#191`（168）+ `#192`（168），对账又记了 `#193`（336，
     * `pnl` 恰好等于前两笔之和）—— **凭空多出 1.5153 USDT**。
     *
     * 而三条启发式判据全部落空：数量 `336 ≠ 168`、出场价不同（加权 vs 单笔）、
     * `closed_at` 差 5 秒（超窗口）；`#192` 的 `exit_order_id` 还是 null
     * （止损触发时没拿到），所以连"单号相同"那条确定性判据也查不到。
     *
     * **成交单号是唯一不受"切法"影响的身份**：336 的回合含两个出场单号，
     * 其中**任何一个**已出现在账本里，就说明这段成交已经被记过。
     * 这也正是对账该有的语义 —— **只修正、不重复插入**。
     */
    exitOrderIds?: readonly string[];
  }): number | null {
    /*
     * 只有带交易所身份的（ISO 毫秒时间戳）才参与判定。`closed_at` 缺省时
     * `insert()` 会填当前时间，那种行没有可与交易所对齐的身份，宁可不判定，
     * 也不能拿"看起来差不多"当依据去吞掉一笔真实成交。
     */
    if (!input.closedAt || !/^\d{4}-\d{2}-\d{2}T/.test(input.closedAt)) return null;

    /*
     * ── 确定性判据放在最前面：**平仓单号相同就是同一个回合** ──────────────
     *
     * 它不看数量、不看价格、不看时间窗 —— 因为交易所的单号本身就是身份。
     * 这一步存在与否，决定了"重复记账"是一个**有边界的启发式问题**，
     * 还是一个**可以彻底关掉的问题**：
     *
     *   · 运行期记账有 `authoritative.exitOrderId`（来自成交明细）；
     *   · 对账重建有 `trip.exitOrderId`（来自同一份成交明细）；
     *   两者是**同一笔平仓**，单号逐字相同。
     *
     * ⚠️ 仍然要求 `closedAt` 存在（上面那道门）—— 老记录、手工插入的行没有单号时，
     * 走下面的启发式，行为与以前完全一致。
     */
    if (input.exitOrderId && input.exitOrderId.length > 0) {
      const exact = getDb().get<{ id: number }>(
        'SELECT id FROM trades WHERE trader_id = ? AND symbol = ? AND exit_order_id = ? ORDER BY id ASC LIMIT 1',
        input.traderId,
        input.symbol,
        input.exitOrderId,
      );
      if (exact) return exact.id;
    }

    /*
     * ── 同一个"腿"的**任一**出场成交已记账 ⇒ 这段成交已经记过 ──────────────
     *
     * 这一条补的是"两条路切法不同"那个缝：一个 336 张的腿含两个出场单号
     * （168 + 168），而运行期已经按每次平仓各记了一笔。只看**最后一个**
     * 单号（`exitOrderId`）查不到那两笔 —— 因为记在账上的单号是**第一笔**的。
     *
     * 单号是交易所给的唯一身份，所以这里不做任何容差判断：命中就是命中。
     * 顺序无关、数量无关、价格无关 —— 这正是这个 bug 需要的东西。
     */
    if (input.exitOrderIds && input.exitOrderIds.length > 0) {
      const ids = input.exitOrderIds.filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) {
        const hit = getDb().get<{ id: number }>(
          `SELECT id FROM trades WHERE trader_id = ? AND symbol = ? AND exit_order_id IN (${ids
            .map(() => '?')
            .join(', ')}) ORDER BY id ASC LIMIT 1`,
          input.traderId,
          input.symbol,
          ...ids,
        );
        if (hit) return hit.id;
      }
    }

    const byOrder =
      input.entryOrderId && input.entryOrderId.length > 0
        ? 'OR entry_order_id = ?'
        : '';
    /*
     * ## ⚠️ 为什么还要一条按**出场价**的判据
     *
     * 下面那三条判据（入场价 1e-6、平仓时间 2 秒、入场订单号）是为一类场景写的：
     * **同一秒里两条路径几乎同时记账**。而实盘真正发生的重复是另一类 ——
     * 运行期记了一次，**几十分钟之后**对账又从成交历史补了一次：
     *
     *     #90 ETHUSDT  入场 2634.3164186  出场 2655.66  净 +0.1821  source=bot    closed_at 02:02:20
     *     #92 ETHUSDT  入场 2634.2        出场 2655.66  净 +0.1713  source=reconciled  closed_at 01:51:35
     *
     * 三个判据在这笔上**全部落空**：入场价差 0.116（容差 0.0026）、时间差 11 分钟
     * （窗口 2 秒）、补录那条又没有订单号。于是同一笔被算了两次，账面多出 0.17 ——
     * 而**钱包余额不会跟着多**，操作员看到的就是"界面说赚了 0.20、钱包只多了 0.03"。
     *
     * ### 为什么不能靠放宽上面那两条
     *
     * 平仓时间那一条**不能继续放宽**：同一标的两笔真实回合之间只隔着再入场冷却
     * （配置里是分钟级），而这两笔正好差 11 分钟 —— 窗口一放到十几分钟，
     * 就可能把两笔**真实**的回合并成一笔，那是比重复更严重的错（会凭空吃掉一笔交易）。
     *
     * ### 为什么出场价可以当身份
     *
     * 它是两条路径之间**唯一同源的字段**：都由交易所给出（成交均价 / 成交记录），
     * 而 `closed_at` 一条来自本地时钟、`entry_price` 补录时用的是快照价。
     * 实测这一对上完全相同（2655.66 = 2655.66）。
     *
     * 容差用相对值且取得很小（0.05%）：真实同一回合的出场价来自同一个成交，
     * 只可能有浮点末位差异。**单向持仓模式下，同一标的在同一价位平掉两笔真实回合，
     * 中间还要隔着再入场冷却** —— 所以"同标的 + 同数量 + 同出场价"落在冷却窗口里，
     * 就是同一个回合。数量容差沿用 20%（两条路径的数量口径本来就不同）。
     *
     * ## ⚠️ 但数量不能一票否决 —— 它才是最不可靠的那个维度
     *
     * 实测事故（用户的原话：「归属权益和收益，为什么和钱包实际余额对不上？」）：
     *
     *     平台记账净额 2.69503831
     *     交易所流水   1.18510038      ← 逐位一致于钱包变化
     *     ────────────────────────
     *     平台多算了   1.50993793
     *
     * 六组重复，全都是同一个形状 —— **同一个平仓时刻、同一个入场价、同一个出场价**，
     * 只是数量不同：
     *
     *     XRP 09-21 22:03  1.5038 → 1.5583   13.6 / 9.2 / 6.8    （虚增 +1.4579）
     *     XRP 09-22 19:37  1.56   → 1.5817   12.7 / 8.3 / 5.9    （虚增 +0.3576）
     *     XRP 09-22 08:34  1.513  → 1.5189   13   / 8.6 / 6.2    （虚增 +0.1337）
     *
     * 数量差 32%、50% —— **20% 的容差全部超出**，而它原来写在 WHERE 的**最外层**，
     * 于是一票否决了下面对的那些判据：同一个真实回合被判成三个不同的回合，
     * 运行期记一笔、对账重建又各插一笔，全留在账上。
     *
     * ### 修法：把数量收进各自的分支，并补一条**以平仓时刻 + 双侧价格为准**的判据
     *
     * 六组重复里 `closed_at` 是**毫秒级相同**的，入场价与出场价也完全相同 ——
     * 那三项才是真正同源的：同一个平仓时刻、同一个入场均价、同一个出场均价，
     * 在物理上就是**同一个回合**（单向持仓下不可能在毫秒级同时平掉两笔同价仓）。
     *
     * 所以：
     *
     *   ① 原有两条判据**各自**带上数量容差（行为与以前一致，只是不再跨分支否决）；
     *   ② 新增一条：**平仓时刻落在 2 秒窗口内 + 入场价相同 + 出场价相同** ——
     *      **不看数量**。
     *
     * 放宽的是"数量口径"这一个**本来就不同源**的维度，而判据的另一半
     * （毫秒级的平仓时刻 + 两个价格）比原来更严 —— 它要求三样东西同时对得上。
     */
    const sql = `SELECT id FROM trades
       WHERE trader_id = ? AND symbol = ? AND quantity > 0
         AND (
              (
                ABS(quantity - ?) <= MAX(1e-6, ABS(?) * ${DUPLICATE_QUANTITY_TOLERANCE})
            AND ABS(exit_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
            AND ABS(julianday(opened_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS}
              )
           OR (
                ABS(quantity - ?) <= MAX(1e-6, ABS(?) * ${DUPLICATE_QUANTITY_TOLERANCE})
            AND ABS(entry_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_PRICE_TOLERANCE})
            AND ABS(julianday(closed_at) - julianday(?)) * 86400000 <= ${DUPLICATE_CLOSE_TOLERANCE_MS}
              )
           OR (
                ABS(entry_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_PRICE_TOLERANCE})
            AND ABS(exit_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
            AND ABS(julianday(opened_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS}
              )
              ${byOrder}
         )
       ORDER BY id ASC
       LIMIT 1`;
    const params: unknown[] = [
      input.traderId,
      input.symbol,
      /* ① 出场价 + 开仓时刻（带数量） */
      input.quantity,
      input.quantity,
      input.exitPrice,
      input.exitPrice,
      input.openedAt,
      /* ② 入场价 + 平仓时刻（带数量） */
      input.quantity,
      input.quantity,
      input.entryPrice,
      input.entryPrice,
      input.closedAt,
      /*
       * ③ 双价 + **开仓时刻**（不带数量）—— 全表最强的一条。
       *
       * ⚠️ **这里原本挂的是 `closed_at`（2 秒窗口），那是个错误的选择。**
       *
       * 实盘漏网的那一对（用户报「我从未停止过机器人运行，为什么会提示机器人
       * 未运行时平仓」）：
       *
       *     #130 bot         HYPEUSDT 0.21  94.05 → 92.878  closed_at 21:57:10.512
       *     #131 reconciled  HYPEUSDT 0.14  94.05 → 92.878  closed_at 21:57:05.073
       *
       * **两个价格逐字节相同**、`opened_at` 只差 5.3 秒，但 `closed_at` 差了 **5.44 秒** ——
       * 刚好越过 2 秒的窗口，于是同一回合被记了两行，账上多出 -0.2638。
       *
       * 而这两条路径的 `closed_at` **本来就不同源**（本项目自己的注释在上一个常量
       * 那里写着：「一条是本地"察觉到仓位消失"的时刻（可能晚一整轮），另一条是
       * 交易所成交记录里的时刻 —— **两个不同的时钟**」）。拿一个已知会漂到十几分钟的
       * 字段去做 2 秒的判断，判据在它最该生效的场景里必然落空。
       *
       * `opened_at` 才是两条路径**同源**的那个（都锚在"这笔仓位什么时候开的",
       * 中间只隔下单延迟），它的 5 分钟容差也正是按这个理由定的。
       *
       * 所以：**判据的强度不变**（仍要求双侧价格都对上），只是把它挂到正确的字段上。
       */
      input.entryPrice,
      input.entryPrice,
      input.exitPrice,
      input.exitPrice,
      input.openedAt,
    ];
    if (byOrder) params.push(String(input.entryOrderId));

    const row = getDb().get<{ id: number }>(sql, ...params);
    return row?.id ?? null;
  },

  /**
   * 修正一条已入账的回合，用交易所的权威口径。
   *
   * Used by reconciliation for round-trips the runtime *did* record, but whose
   * costs it only partly captured: the live path records the exit commission at
   * the moment of closing, so the entry leg's commission was missing and every
   * historical fee was understated by roughly half.
   *
   * ## 返回值：**它到底改没改**（2026-10-17 修「修正 N 笔」虚报）
   *
   * 这个函数**有权拒绝整笔改动**（见下面 `keepLocalQuantity` 那段：重建出的"腿"
   * 边界不可信时，数量与金额一并不覆盖）。而调用方原来把它当"改过了"来计数，
   * 于是线上每次对账都报「修正 50 笔」，实际账本一个字都没变 ——
   * 操作员误以为对账在工作，也没动机去追"为什么每轮都要修正同样那 50 笔"。
   *
   * 所以它现在返回**观测到的结果**：
   *   · `applied: true`  → 这一行的金额/数量/价位确实按交易所口径覆盖了；
   *   · `applied: false` → 因为 `keepLocalQuantity`（边界存疑）整行没动，
   *     `keptLocalQuantity` 是保留下来的本地成交量，供调用方把 `K` 报清楚。
   *
   * ⚠️ 调用方只能拿它**计数**，不能把它当成"这笔回合已经处理完了"的信号 ——
   * 被拒的那一行下一轮还会再撞一次同样的判断（那正是它值得被上报的原因）。
   */
  applyExchangeFigures(input: {
    id: number;
    grossPnl: number;
    entryFee: number;
    exitFee: number;
    fundingFee: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    leverage: number;
    entryOrderId: string | null;
    exitOrderId: string | null;
  }): { applied: boolean; keptLocalQuantity: number } {
    const fee = input.entryFee + input.exitFee;
    const netPnl = netPnlOf({ grossPnl: input.grossPnl, fee, fundingFee: input.fundingFee });

    /*
     * ⚠️ **重建出来的"数量"不可信时，保留本地那一份。**
     *
     * 实测（2026-09-29，HYPEUSDT）：重建的**窗口起点落在持仓中间**时，整条成交序列会错位 ——
     * 一个「先平 0.20 再开 0.15」的序列被算成「开空 0.35」，后续每个回合的数量于是全错：
     *
     *     #110 / #111 / #112 / #130   重建 0.01   真实 0.21   ← 差 21 倍
     *
     * 而这里原来无条件把 `quantity` 覆盖成本地 —— 连**按数量计价的手续费**也跟着算小，
     * 净额于是偏大，账目凭空多出 **0.0596 USDT**（`ledger_check` 上就是那个 gap）。
     *
     * 本地数量来自**运行期持仓行**（就是当时真实下单的数量），它**不经过重建**；
     * 当两者差到"不可能是同一个回合"时，保留本地。
     *
     * ## ⚠️ 2026-10-03：金额也**必须**一起保留
     *
     * 旧结论写的是"**金额（毛盈亏 / 手续费 / 资金费）仍然一律采用交易所的值 ——
     * 那是权威的**"。**那条结论是错的**，实盘 `#10`（MANAUSDT）的现场：
     *
     * ```text
     * 交易所成交: BUY 336 → SELL 168 (+1.132320) → SELL 168 (+0.408240)
     * 运行期记账: #191 毛 1.132320（第一笔 168）
     *             #192 毛 0.408240（第二笔 168，止损触发，exit_order_id 为 null）
     * 对账重建:   把整段看成一个 336 的腿 ⇒ grossPnl = 1.540560 = 两笔之和
     * ```
     *
     * 旧逻辑下 `keepLocalQuantity` 为真（336 vs 168 差得太远），**数量保住了**，
     * 而金额被无条件覆盖成 `1.540560` —— 于是 `#191` 变成"两笔之和"，而 `#192` 还在，
     * 账目凭空多出 **0.408240**（实测 `#10` 的净额从 -0.08742 变成 +0.31188）。
     *
     * **真相**：一个"腿"的 `grossPnl` 是这个腿里**所有**平仓成交的 `realizedPnl` 之和。
     * 数量对不上就说明这个腿的**边界**是错的，它的金额自然不能写进任何一行。
     *
     * 而保留的本地金额**不是粗口径**：它来自运行期从**成交明细**取到的那一笔
     * （见 `findRoundTrip()`），本身也是交易所的值，只是属于**正确的**那一笔。
     *
     * 所以数量不可信时，**金额与价位一并不覆盖**。
     */
    const local = getDb().get<{ quantity: number }>('SELECT quantity FROM trades WHERE id = ?', input.id);
    const keepLocalQuantity =
      local !== undefined && !shouldTrustReconciledQuantity(local.quantity, input.quantity);
    const quantity = keepLocalQuantity ? local.quantity : input.quantity;
    if (keepLocalQuantity) {
      log.warn(
        `对账算出的成交量（${input.quantity}）与本地记录（${local.quantity}）差得太远 —— ` +
          '已保留本地数量**与本地金额**（重建那个腿的边界是错的，它的金额可能是多个回合的合计）。' +
          '这通常意味着成交历史的窗口起点落在持仓中间，重建把开/平判反了，整条序列因此错位。',
      );
    }

    /*
     * ⚠️ **`keepLocalQuantity` 为真时这一行什么都没改** —— 所以要把它**报出去**。
     *
     * 线上实测的形状（用户报「每次都是修正 50 笔」）：本函数内部把改动整个拒掉，
     * 而调用方仍然 `corrected += 1` —— 于是那条日志每次都说"修正了 50 笔"，
     * 而账本**一个字都没变**。计数虚报比不计更糟：它让操作员以为对账在工作，
     * 于是没有动机去查"为什么每轮都要修正同样 50 笔"。
     *
     * 返回值是**观测事实**（`applied` = 是否真的执行了覆盖），不是"调用与否"：
     * 调用方只能用它来计数，不能反过来把它当成成功标志。
     *
     * ## ⚠️⚠️ 边界存疑时也**必须**跑 UPDATE —— 那里还回填着两个单号（P0 回归的教训）
     *
     * 我第一版把"拒绝"写成**早退**（`if (keepLocalQuantity) return …;`），
     * 结果那段 UPDATE 里最后两行**永不可达**：
     *
     * ```sql
     *     entry_order_id = COALESCE(?, entry_order_id),
     *     exit_order_id  = COALESCE(?, exit_order_id)
     * ```
     *
     * 而 `exit_order_id` 是 `findDuplicate()` 里**唯一确定性的判重身份**
     * （见 `findDuplicate()` 的说明与 `dedup.test.ts:24-34`：「平台记的净额比交易所
     * 流水多出 1.51 USDT，六组重复」），也是 `trades.insert({ idempotent: true })`
     * 唯一的去重入口。**旧代码在这条路上仍然回填单号**；早退之后这一类行永久失去身份
     * ⇒ 去重失效 ⇒ 同一回合可能被记两次 —— 这正是 `exit_order_id` 当年被引入要关掉的东西。
     *
     * 所以"拒绝"只作用在**金额/数量/价位**这些列上（用 `keep` 开关），
     * 单号两列**照常回填**：`COALESCE` 本来就是"有值才覆盖"，回填永远是安全的。
     */

    const margin = marginOf(input.entryPrice, quantity, input.leverage);
    /*
     * `quantity` 与 `pnl_percent` 都由交易所在**同一笔成交记录**里给出，所以要一起写。
     *
     * 这里曾经漏掉 `quantity`：参数收了、SQL 里却没有这一列，于是对账算出来的
     * 权威成交量被**静默丢弃** —— 账本留下的仍是运行期那个较粗的口径（本地持仓量），
     * 与交易所的成交记录对不上，而 §2.5 要求的正是"平台记录能与交易所对得上"。
     * 本次修幂等时正是靠这一列才把同一回合的两条路径收敛到同一个数字上。
     *
     * ⚠️ **`keepLocalQuantity` 为真时金额/数量/价位不覆盖** ——
     * 那个"腿"的边界是错的，它的金额可能是多个回合的合计，写进来就是重复记账。
     * 见上面那段 2026-10-03 的说明。`CASE WHEN ?` 的写法避免在 JS 里拼两份语句。
     *
     * ⚠️ 但**两个单号列不在 `keep` 的控制范围内**（见方法头那段 P0 说明）：
     * 它们是判重身份，边界存疑时必须照常回填。
     */
    const keep = keepLocalQuantity ? 1 : 0;
    getDb().run(
      `UPDATE trades
          SET pnl = CASE WHEN ? THEN pnl ELSE ? END,
              entry_fee = CASE WHEN ? THEN entry_fee ELSE ? END,
              fee = CASE WHEN ? THEN fee ELSE ? END,
              funding_fee = CASE WHEN ? THEN funding_fee ELSE ? END,
              net_pnl = CASE WHEN ? THEN net_pnl ELSE ? END,
              pnl_percent = CASE WHEN ? THEN pnl_percent ELSE ? END,
              entry_price = CASE WHEN ? THEN entry_price ELSE ? END,
              exit_price = CASE WHEN ? THEN exit_price ELSE ? END,
              quantity = ?,
              entry_order_id = COALESCE(?, entry_order_id),
              exit_order_id = COALESCE(?, exit_order_id)
        WHERE id = ?`,
      /* pnl */
      keep, input.grossPnl,
      /* entry_fee */
      keep, input.entryFee,
      /* fee */
      keep, fee,
      /* funding_fee */
      keep, input.fundingFee,
      /* net_pnl */
      keep, netPnl,
      /* pnl_percent */
      keep, margin > 0 ? (netPnl / margin) * 100 : 0,
      /* entry_price */
      keep, input.entryPrice,
      /* exit_price */
      keep, input.exitPrice,
      /* ⚠️ 用上面判定过的那个值：重建数量与本地差得太远时保留本地。 */
      quantity,
      input.entryOrderId,
      input.exitOrderId,
      input.id,
    );

    /*
     * ⚠️ 这条返回语句**必须在 UPDATE 之后**（不能再写成早退）——
     * UPDATE 里除了金额/数量/价位，还回填着 `entry_order_id` / `exit_order_id`，
     * 而后者是 `findDuplicate()` 唯一的确定性判重身份。早退会让那两行永不可达，
     * 于是"边界存疑"的行永久失去身份 ⇒ 去重失效（见方法头那段 P0 回归的说明）。
     *
     * 计数语义：`applied` 回答的是"**这一轮有没有被拒掉**"，不是"字节有没有变" ——
     * 写进去的值刚好与原来逐字段相同时也算生效（账本确实被写成了交易所口径）。
     */
    if (keepLocalQuantity) return { applied: false, keptLocalQuantity: quantity };
    return { applied: true, keptLocalQuantity: 0 };
  },

  /**
   * There is deliberately **no** `setFundingFee()` here.
   *
   * Funding cannot be read at the instant a position closes, and a setter that
   * writes a figure without recomputing `net_pnl` is an invitation to record a
   * number that never reaches the balance. Every close path therefore passes
   * `fundingFee` into `insert()` (read from `/fapi/v1/income`, or 0 and logged
   * when unreadable), and the reconcile pass rewrites it through
   * `applyExchangeFigures()`. Both of those derive `net_pnl` in one place.
   */

  /**
   * Round-trips already on the books, for matching against the exchange.
   *
   * `sinceIso` bounds the read to closes at or after that instant, and exists so
   * the **routine** reconciliation pass does not reload the trader's entire
   * lifetime every cycle. This method used to have no bound at all: a trader that
   * had been running for months rebuilt a map of every round-trip it had ever
   * booked, once per cycle, and `node:sqlite` is synchronous — so the cost was
   * paid on the event loop that runs the trading loop. The boot pass and the
   * periodic deep pass still read everything (omit the argument), which is what
   * keeps a close this trader slept through recoverable.
   */
  ledger(
    traderId: number,
    sinceIso?: string,
  ): Array<{
    id: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    openedAt: string;
    entryOrderId: string | null;
  }> {
    const sql =
      'SELECT id, symbol, quantity, entry_price, opened_at, entry_order_id FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{
        id: number;
        symbol: string;
        quantity: number;
        entry_price: number;
        opened_at: string;
        entry_order_id: string | null;
      }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        quantity: r.quantity,
        entryPrice: r.entry_price,
        openedAt: r.opened_at,
        entryOrderId: r.entry_order_id,
      }));
  },

  /**
   * Distinct symbols this trader traded.
   *
   * `sinceIso` has the same purpose as on `ledger()`: reconciliation asks one
   * `userTrades` question per symbol, so an unbounded list keeps asking about
   * symbols that stopped trading months ago and spends weight every cycle on an
   * answer that cannot have changed.
   */
  tradedSymbols(traderId: number, sinceIso?: string): string[] {
    const sql =
      'SELECT DISTINCT symbol FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{ symbol: string }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => r.symbol);
  },

  /**
   * **账户级**：所有机器人交易过的符号。
   *
   * ## 为什么需要它，而不是复用 `tradedSymbols(traderId)`
   *
   * 对账要跑两件事，而它们的**范围不同**：
   *
   *   · **恢复本机器人的成交** —— 只看**本机器人**交易过的符号（`tradedSymbols`）。
   *   · **清点外部活动** —— 那是**账户级**的概念："不属于本平台任何机器人"的成交。
   *     它落在哪个符号上，与本机器人自己交易过什么**毫无关系**。
   *
   * 原来两件事共用一份"本机器人"的符号表。后果是：一个只交易过少数几个币种的
   * 机器人，**看不到账户在别的币种上的外部活动** —— 那部分盈亏记不进
   * `foreignNet`，而它确实在交易所流水里，于是总账校验报出假差额。
   *
   * 实测：共用账户的三个机器人里，两个只报 195 笔外部活动、另一个报 223 笔，
   * 差额 −0.20 与 −0.006 的区别就出在这里。
   */
  allTradedSymbols(sinceIso?: string): string[] {
    const sql = 'SELECT DISTINCT symbol FROM trades' + (sinceIso ? ' WHERE closed_at >= ?' : '');
    return getDb()
      .all<{ symbol: string }>(sql, ...(sinceIso ? [sinceIso] : []))
      .map((r) => r.symbol);
  },

  /**
   * Realised PnL since 00:00 UTC, for the daily circuit breaker.
   *
   * Net, not gross: fees are a real loss and a breaker that ignores them will
   * keep trading through a streak that is only breaking even on paper.
   */
  /**
   * **指定时间之后**的全部机器人已实现净额合计。
   *
   * ## 为什么必须能按时间窗取
   *
   * 总账校验的交易所侧来自 `income` 流水，而那个接口**必须给时间窗**
   * （币安限制窗口长度）。于是平台侧**也必须限定在同一个窗口**，
   * 否则差额里会混进"窗口之外的历史交易"—— 那会**永久误报**，
   * 而一个永久误报的校验会训练操作员忽略这条告警。
   *
   * 实测：不加窗口时这个账户会报出 −0.86 的假差额，
   * 而真实差值是 0.0057（窗口边界的浮点误差）。
   */
  /**
   * 某个**交易所账户**上、`since` 之后的已实现净额合计。
   *
   * ## 为什么按【账户】而不是按机器人（2026-10-03 抓到的真 BUG）
   *
   * 总账校验拿平台侧的净额去比**交易所流水** —— 而流水是**账户级**的：
   * 它不区分"是哪个机器人下的单"，但**严格区分是哪个账户**。
   *
   * 所以平台侧也必须是"**同一个账户上的所有机器人**"：
   *
   *   · 按**单个机器人**求和 → 一个账户上跑两个机器人时，各自只看到自己那一半账目，
   *     与整个账户的流水比 ⇒ 每个都报差额；
   *   · 按**全部机器人**求和（原来的写法）→ 主账户与子账户的账目被混在一起，
   *     却拿去比其中一个账户的流水 ⇒ 差额正好是**另一个账户的全部盈亏**。
   *
   * 实测（2026-10-03）：`#9` 跑在子账户 #2、`#10` 跑在主账户 #3，
   * `#9` 的校验报 `platformSelf = -0.9387`（= #9 的 -0.0382 + #10 的 -0.9004），
   * 而 `exchangeNet = -0.0298`（只有账户 #2 的流水）⇒ 假差额 **-0.9088**。
   * 而 `#9` 自己的账目与它自己的账户流水只差 **0.0084**。
   *
   * 这条告警是唯一能自动发现"账本真的错了"的地方，假响会训练操作员忽略它
   * （代码里那段注释自己就这么写着），所以口径必须与流水一致到账户这一级。
   *
   * @param exchangeAccountId 该机器人所用的交易所账户
   */
  netSinceForAccount(exchangeAccountId: number, sinceIso: string): number {
    const row = getDb().get<{ total: number | null }>(
      `SELECT SUM(t.net_pnl) AS total
         FROM trades t
         JOIN traders tr ON tr.id = t.trader_id
        WHERE tr.exchange_account_id = ? AND t.closed_at >= ?`,
      exchangeAccountId,
      sinceIso,
    );
    return row?.total ?? 0;
  },


  realizedPnlToday(traderId: number): number {
    /*
     * ⚠️ **日界是北京时间，不是 UTC。**
     *
     * 原来这里是 setUTCHours(0, 0, 0, 0) —— UTC 零点，
     * 也就是**北京时间早上 8 点**。于是北京时间 9-19 07:30 的一笔平仓
     * 会被算进「UTC 9-18」，操作员上午看到的「今日」实际覆盖
     * 9-18 08:00 → 9-19 08:00，与他的认知差 8 小时。
     *
     * 而这个数字正是熔断（maxDailyLossPercent）用来决定要不要停手的依据。
     *
     * 用 beijingDayStartIso() 而不是 setHours(0,0,0,0)：
     * 后者用的是**服务器**的时区，换一台 UTC 的机器就会静默变回 UTC 零点。
     */
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(net_pnl) AS total FROM trades WHERE trader_id = ? AND closed_at >= ?',
      traderId,
      beijingDayStartIso(),
    );
    return row?.total ?? 0;
  },

  /**
   * Aggregate performance.
   *
   * Classification is by **net** PnL: a trade that made a little on price but
   * less than it paid in commission lost money, and counting it as a win would
   * flatter the win rate and the profit factor.
   */
  /**
   * Aggregate performance.
   *
   * Classification is by **net** PnL: a trade that made a little on price but
   * less than it paid in commission lost money, and counting it as a win would
   * flatter the win rate and the profit factor. Kept as a repository method for
   * callers that only want the totals; the arithmetic itself lives in
   * `aggregateTrades()` so there is exactly one definition of every figure.
   */
  stats(traderId: number): TradeStats {
    return aggregateTrades(traderId).totals;
  },

  /**
   * The gross/net curve a Sharpe ratio and a drawdown are computed from.
   *
   * Time-ordered ascending and **bounded**, because `computeTraderStats` runs on
   * every dashboard refresh (every 5–12 s per trader) and `node:sqlite` is
   * synchronous — an unbounded `SELECT *` here is paid for with a blocked event
   * loop, i.e. with the trading loop. The bound is a display choice that is
   * stated in the code rather than hidden: beyond `TREND_WINDOW` round-trips the
   * dashboard's drawdown/Sharpe are "recent", not "lifetime".
   */
  curve(traderId: number, limit = TREND_WINDOW): TradeCurvePoint[] {
    return getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        limit,
      )
      .reverse();
  },

  /**
   * 疑似"同一回合记了两次"的成对行 —— **只报告，不删**。
   *
   * 为什么只报告：`data/` 里的账是历史，删一行等于改写历史，是人的决定。
   * 这次修复只保证**今后**不再产生重复（见 `findDuplicate()`），已经落库的三组
   * 重复行（SYNUSDT 99 / SYNUSDT 169 / LSKUSDT 35）要由操作者看过之后再决定。
   *
   * 判定条件与 `findDuplicate()` 同一个口径：`trader_id + symbol + quantity` 相同、
   * `closed_at` 相差 1 秒以内，且其中恰好一行是 `reconciled`。**`side` 不参与** ——
   * 重复行的 `side` 本来就一致，少一个条件只会让漏报更少。
   *
   * 注意 `close_reason`：运行期那行记的是"怎么平的"（`take_profit` / `stop_loss`），
   * 对账那行一律是 `reconciled`。所以**保留哪一行应当按信息量决定**，而不是简单地
   * "删掉 reconciled"：`#4 POWERUSDT 131` 是唯一一笔真正漏记的回合（没有运行期
   * 对应行），删掉它就把对账存在的意义一起删了。
   *
   * `traderId` 省略时扫描**所有**机器人：复核存量数据时不该要求操作者先知道
   * 是哪台机器人记的重复。
   */
  duplicateSuspects(traderId?: number): TradeDuplicateSuspect[] {
    const filter = traderId === undefined ? '' : 'WHERE a.trader_id = ?';
    /*
     * ⚠️ **两组判据并列，而不是一组放宽的判据。**
     *
     * 原来只有下面第一组（入场价 1e-6 + 平仓时间 1 秒）。它覆盖不了实盘真正
     * 发生的那类重复 —— 运行期记一次、几十分钟后对账又补一次（实测 `#90`/`#92`
     * 差 11 分钟、入场价差 0.116）。于是**那一对既没被写入守卫拦住、也没被这里
     * 报出来**，账上凭空多出 0.17，而钱包余额不会跟着多。
     *
     * 第二组用**出场价**（两条路径唯一同源的字段）做身份。**为什么不干脆把第一组的
     * 窗口和容差放大**：平仓时间那一条不能放 —— 同一标的两笔真实回合之间只隔着
     * 再入场冷却（分钟级），而实测那两笔正好差 11 分钟；窗口一放就可能把两笔
     * **真实**回合并成一笔，那比重复更严重（会凭空吃掉一笔交易）。
     *
     * 两组都要求 `source` 恰好一边是 `reconciled`：两行都是 `bot` 的重复属于
     * 另一类缺陷，不该混进这个报告里让人误判。
     *
     * ## ⚠️ 但两组都是启发式，而**单号是确定性的**
     *
     * 实测漏报（用户报的"归属权益和钱包对不上"）：ZECUSDT 的 `#107` 与 `#120`
     * **共用同一个 `exit_order_id`**（`807238763718`），却因为
     *   · 数量 0.009 vs 0.004 —— 差 0.005，超出 20% 容差（0.0018），**外层一票否决**；
     *   · 平仓时刻差 6 秒 —— 超出 2 秒窗口；
     * 而被这份报告整个漏掉。那一笔让归属权益比钱包高出 0.015。
     *
     * 所以：
     *
     *   ① 新增一条**最高优先**的判据 —— **两行的 `exit_order_id` 相同且非空**。
     *      它是交易所给的身份，不需要任何容差。
     *   ② 数量容差从外层收进启发式那一组里 —— 它不该跨分支否决单号判据
     *      （`findDuplicate()` 里是同一个毛病，一起改了）。
     */
    return getDb().all<TradeDuplicateSuspect>(
      `SELECT
         a.trader_id    AS traderId,
         a.id           AS idA,
         b.id           AS idB,
         a.symbol       AS symbol,
         a.quantity     AS quantity,
         a.closed_at    AS closedAt,
         a.close_reason AS reasonA,
         b.close_reason AS reasonB,
         a.net_pnl      AS netA,
         b.net_pnl      AS netB
       FROM trades a
       JOIN trades b
         ON a.trader_id = b.trader_id
        AND a.symbol = b.symbol
        AND a.id < b.id
        AND (
             (
               a.exit_order_id IS NOT NULL AND a.exit_order_id <> ''
           AND a.exit_order_id = b.exit_order_id
             )
          OR (
               ABS(a.quantity - b.quantity) <= MAX(1e-6, ABS(a.quantity) * ${DUPLICATE_QUANTITY_TOLERANCE})
           AND (
                (
                  ABS(a.exit_price - b.exit_price) <= MAX(1e-9, ABS(a.exit_price) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
              AND ABS((julianday(a.opened_at) - julianday(b.opened_at)) * 86400000.0) <= ${DUPLICATE_OPEN_TOLERANCE_MS}
                )
             OR (
                  ABS(a.entry_price - b.entry_price) <= MAX(1e-9, ABS(a.entry_price) * ${DUPLICATE_PRICE_TOLERANCE})
              AND ABS((julianday(a.closed_at) - julianday(b.closed_at)) * 86400000.0) <= ${DUPLICATE_REPORT_WINDOW_MS}
                )
             )
             )
        )
        AND (a.source = 'reconciled' OR b.source = 'reconciled')
        AND NOT (a.source = 'reconciled' AND b.source = 'reconciled')
       ${filter}
       ORDER BY ABS(a.net_pnl) DESC, a.closed_at DESC`,
      ...(traderId === undefined ? [] : [traderId]),
    );
  },
};

/* -------------------------------------------------------------------------- */
/*  Decision records                                                           */
/* -------------------------------------------------------------------------- */

interface DecisionRow {
  id: number;
  trader_id: number;
  cycle_number: number;
  timestamp: string;
  system_prompt: string;
  user_prompt: string;
  cot_trace: string;
  decisions_json: string;
  raw_response: string;
  execution_log_json: string;
  candidate_symbols_json: string;
  success: number;
  error: string | null;
  ai_latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /* 迁移 M9 加的；迁移之前的行是 NULL（= 当时没记，不是没命中）。 */
  cached_tokens: number | null;
  reasoning_tokens: number | null;
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    cycleNumber: row.cycle_number,
    timestamp: row.timestamp,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    cotTrace: row.cot_trace,
    decisions: safeJsonParse(row.decisions_json, []),
    rawResponse: row.raw_response,
    executionLog: safeJsonParse<ExecutionLogEntry[]>(row.execution_log_json ?? '[]', []),
    candidateSymbols: safeJsonParse<string[]>(row.candidate_symbols_json, []),
    success: row.success === 1,
    error: row.error,
    aiLatencyMs: row.ai_latency_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    /*
     * 缓存命中与思考 token。
     *
     * **`?? null` 而不是 `?? 0`**：迁移之前的历史行这两列是 NULL，
     * 而 NULL 的含义是"当时没记"、不是"没命中"。把它们读成 0
     * 会让所有历史记录看起来像缓存全没命中。
     */
    cachedTokens: row.cached_tokens ?? null,
    reasoningTokens: row.reasoning_tokens ?? null,
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 一次最多回多少条决策记录。
 *
 * 卡住的是**字节数**，不是行数：每条记录都带着完整提示词、思维链与原始响应
 * （单条几十 KB 很常见）。路由以前把 `?limit=999999` 原样交给 SQL，一次请求就能
 * 让服务端拼出几十 MB 的 JSON 占住 event loop，浏览器那侧也会直接卡死 ——
 * 这正是操作者说的"成千上万数据一次加载出来导致系统卡死"。
 * 200 条足够"全部记录"这类页面一次翻完一屏，也不至于把一次请求变成几 MB。
 */
export const DECISION_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史行为和 `docs/API.md` 一致。 */
export const DECISION_PAGE_DEFAULT = 50;

/**
 * 把调用方给的 `limit` 收进 `[1, DECISION_PAGE_MAX]`。
 *
 * **钳制而不是报错**：翻页的控制台不该因为页大小写得大一点就收到 400，
 * 而一个手写的 `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到默认值，等同于路由原来那半句
 * `Number.isFinite(limit) ? limit : 50`。
 *
 * 实现与订单 / 成交两张表共用同一个 `clampPageLimit`（见该函数的说明）：
 * 三张历史表只有上限与默认值不同，钳制规则必须一模一样。
 */
export function clampDecisionLimit(limit: number): number {
  return clampPageLimit(limit, DECISION_PAGE_MAX, DECISION_PAGE_DEFAULT);
}

/**
 * `decision_records` 的裁剪节流。
 *
 * ⚠️ **裁剪绝不能每写一行都做。** 这一段原来是"INSERT 之后立刻 DELETE 一次"，
 * 而那条 DELETE 是 `WHERE id NOT IN (SELECT id FROM decision_records … LIMIT 500)`
 * —— **一次全表扫描**，而 `decision_records` 的每一行都是几十 KB 的提示词全文。
 * `node:sqlite` 是同步 API：这次扫描直接压在**跑交易循环的那个事件循环**上。
 *
 * 这违反的是本项目自己立下的契约：`runtimeLogs`（同文件）与 `agentStore`
 * 早就改成了"每 N 次写裁剪一次"，只有这里漏了。
 *
 * 每 50 次写裁剪一次：表的上界变成 500 + 50 = 550 行，而任何读取路径都只要
 * 最近 500 行 —— 多留的那部分是纯缓冲，没有消费者依赖它。
 */
const DECISION_TRIM_EVERY_WRITES = 50;
/** 距离上次裁剪已写入的行数（裁剪是全局的，不区分 trader）。 */
let decisionWritesSinceTrim = 0;

/**
 * **提示词全文**只保留最近这么多条；更早的记录把提示词字段清空。
 *
 * ## 为什么要有这条（实测：一个字段占了这个库 90% 的体积）
 *
 * 2026-09-29 实测：`decision_records` 占 **88.77 MB**，其中
 * **`user_prompt` 一个字段就占 68.59 MB**（单条最大 **220,295 字符** ——
 * 它是 20 个候选 × 4 个周期 × 10 个指标序列的完整数组）。
 * 保留 500 条 = **稳态约 100 MB**，而且每轮都要往 SQLite 里写 ~200 KB。
 *
 * 而"当时给模型看了什么"**只在复盘最近几轮时有价值**。更早的决策里，
 * 真正有长期价值的是**决定了什么**（`decisions_json`）与**执行结果**
 * （`execution_log_json`）—— 这两样一个字都不动。
 *
 * 所以超期之后**只清空提示词字段、不删行**：决策与执行仍可完整回看，
 * 而体积回到每行不足 1 KB 的量级。
 *
 * 想回看更早的提示词时，值不值得付 100 MB 换，是个可以再讨论的取舍 ——
 * 但默认值不该是"一直存着"。
 */
const DECISION_PROMPT_KEEP = 100;

/**
 * 到点就裁剪 `decision_records`（每 `DECISION_TRIM_EVERY_WRITES` 次新增行一次）。
 *
 * 抽成函数而不是内联：2026-10-17 起**有两个插入点**（`begin()` 与 `log()`），
 * 而裁剪只该跟着"新增行"走 —— 两处复制一份逻辑迟早会漂移（本仓库为此吃过多次亏：
 * 同一个算式曾有五处副本，见 `binance/income.ts` 的 `netPnlOf` 注释）。
 */
function trimDecisionsIfDue(traderId: number): void {
  decisionWritesSinceTrim += 1;
  if (decisionWritesSinceTrim < DECISION_TRIM_EVERY_WRITES) return;
  decisionWritesSinceTrim = 0;
  getDb().run(
    `DELETE FROM decision_records
      WHERE trader_id = ?
        AND id NOT IN (SELECT id FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 500)`,
    traderId,
    traderId,
  );
  /*
   * ⚠️ **更早的记录只清提示词，不删行** —— 理由见 `DECISION_PROMPT_KEEP`。
   *
   * `LENGTH(user_prompt) > 0` 这个条件让重复执行几乎不花代价：
   * 已经清空过的行不会被再次扫描写入。它同时也是**幂等**的 ——
   * 这条 UPDATE 可以被安全地重复调用。
   */
  getDb().run(
    `UPDATE decision_records
        SET system_prompt = '', user_prompt = '', cot_trace = '', raw_response = ''
      WHERE trader_id = ?
        AND id NOT IN (SELECT id FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?)
        AND LENGTH(user_prompt) > 0`,
    traderId,
    traderId,
    DECISION_PROMPT_KEEP,
  );
}

export const decisions = {
  /**
   * **给某机器人最近一轮决策追加一条执行日志。**
   *
   * ## 为什么需要它（2026-10-08 用户实测）
   *
   * 用户的观察：
   *
   * > 「倒数第二轮有挂单开多，但是最新一轮没有提示撤单，但是挂单消失了？
   * >   是最新一轮决策取消了挂单？？（如果是的话**你得显示上去啊**）」
   *
   * 查下来是**系统**超时撤的单（日志原文「RAYSOLUSDT 的限价挂单已等满 43 分钟
   * （上限 15）仍未成交，已自动撤掉并释放该入场名额」），而它**只走了
   * `this.emit('info', …)`** —— 那是**实时事件流**，页面一刷新就没了，
   * 决策卡片的 `executionLog` 里一个字都没有。
   *
   * ## 这是同一个已知模式的第二个实例
   *
   * 本文件里 `autoTrader` 已经为**一模一样的事**写过注释：
   * "模型主动去要了数据"必须落进审计日志，否则它翻历史查不到 ——
   * 那之前也只走 `emit`。**当时的结论是"实时流 ≠ 审计日志"，而这次漏的是系统侧动作。**
   *
   * 所以补一个入口：把系统动作**追加到最新那一轮**的 `executionLog`，
   * 于是它在决策流里可见、刷新后仍在。追加到最新一轮而不是"发起该挂单的那一轮"，
   * 是因为**用户要回答的问题是"挂单去哪了"，而他是从最新一轮往下看的**。
   */
  appendExecutionLog(traderId: number, entry: ExecutionLogEntry): void {
    const row = getDb().get<{ id: number; execution_log_json: string | null }>(
      'SELECT id, execution_log_json FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1',
      traderId,
    );
    if (!row) return;
    const list = safeJsonParse<ExecutionLogEntry[]>(row.execution_log_json ?? '[]', []);
    list.push(entry);
    getDb().run(
      'UPDATE decision_records SET execution_log_json = ? WHERE id = ?',
      JSON.stringify(list),
      row.id,
    );
  },
  /**
   * 某机器人的决策记录，**最新在前**。`before` 是游标：只返回 `id < before` 的记录。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表是**在顶部持续插入**的：每跑完一轮就多一条新记录。用 `OFFSET 20` 取
   * "第二页"时，第一条新记录一插进来，整个窗口就往下挪一格 —— 第二页的第一条会
   * 和第一页的最后一条**重复**；反过来，如果两次请求之间旧记录被裁掉（见 `log()`），
   * 窗口往上挪一格，中间就会**漏掉**一行。游标锚在一条具体记录的 `id` 上，
   * 新记录拿到的 `id` 一定更大，永远落在游标之上，页与页之间既不重也不漏。
   *
   * ## 为什么排序键也换成 `id`
   *
   * 翻页边界要成立，排序键和游标键必须是同一列：这里用自增主键 `id`。
   * 它等于写入顺序，而 `log()` 每跑完一轮只写一行、周期号单调递增，
   * 所以 `id` 倒序与原来的 `cycle_number DESC` 是同一个顺序（最新的一轮在前）。
   * 索引 `idx_decisions_trader` 建在 `cycle_number` 上，因此这条查询会在按
   * `trader_id` 过滤之后再排序 —— 每个机器人最多留 500 行（见 `log()` 的保留上限），
   * 这点排序代价可以忽略，换来的是页边界不可能漏行或重复。
   */
  list(traderId: number, limit = DECISION_PAGE_DEFAULT, before?: number | null): DecisionRecord[] {
    const pageSize = clampDecisionLimit(limit);
    const cursor = cursorOf(before);

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<DecisionRow>(
          'SELECT * FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map(toDecisionRecord);
    }

    return getDb()
      .all<DecisionRow>(
        'SELECT * FROM decision_records WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
      )
      .map(toDecisionRecord);
  },

  get(id: number): DecisionRecord | undefined {
    const row = getDb().get<DecisionRow>('SELECT * FROM decision_records WHERE id = ?', id);
    return row ? toDecisionRecord(row) : undefined;
  },

  log(input: {
    traderId: number;
    cycleNumber: number;
    systemPrompt: string;
    userPrompt: string;
    cotTrace: string;
    decisions: unknown;
    rawResponse: string;
    executionLog: ExecutionLogEntry[];
    candidateSymbols: string[];
    success: boolean;
    error: string | null;
    aiLatencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    /** 命中缓存的输入 token，`null` 表示服务商没报。 */
    cachedTokens?: number | null;
    /** 花在思考上的输出 token（已计入 completion）。 */
    reasoningTokens?: number | null;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, system_prompt, user_prompt, cot_trace, decisions_json, raw_response, execution_log_json, candidate_symbols_json, success, error, ai_latency_ms, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.cycleNumber,
      now(),
      input.systemPrompt,
      input.userPrompt,
      input.cotTrace,
      JSON.stringify(input.decisions),
      input.rawResponse,
      JSON.stringify(input.executionLog),
      JSON.stringify(input.candidateSymbols),
      input.success,
      input.error,
      input.aiLatencyMs,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens ?? null,
      input.reasoningTokens ?? null,
    );
    // Keep the audit trail bounded so the database does not grow without limit.
    // 每 50 次写才裁剪一次 —— 理由见 `DECISION_TRIM_EVERY_WRITES`。
    // （与 `begin()` 共用同一个实现，见 `trimDecisionsIfDue`。）
    trimDecisionsIfDue(input.traderId);
    return lastInsertRowid;
  },

  count(traderId: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM decision_records WHERE trader_id = ?', traderId);
  },

  /**
   * **提前落一行"本轮已开始"的审计记录**，并返回它的 id。
   *
   * ## 为什么需要它（2026-10-17 线上实测：订单真实存在、审计记录不存在）
   *
   * `decisionStore.log()` 原来只在**轮次末尾**调用一次（`autoTrader.ts` 的
   * `runCycle()` 第 11 步）。而一轮的长度实测到 **1304 秒（21.7 分钟）**
   * （`decision_records.ai_latency_ms`），`SHUTDOWN_DRAIN_TIMEOUT_MS` 只有 **3 分钟** ——
   * 于是每次部署（SIGTERM）都等不到一轮跑完就退出：
   *
   * ```text
   *   05:49:16 SIGTERM  ← 部署；该轮已下 ZECUSDT SELL LIMIT（orders 2005, 05:46:47）
   *   06:04:02 SIGTERM  ← 部署；该轮已下 INJUSDT BUY LIMIT（orders 2012, 06:00:14）
   *   decision_records  ：停在 813（05:21:04）        ← 两个真实订单，零条审计记录
   * ```
   *
   * ⇒ **审计链断裂**：订单真实存在，事后无法解释"这笔单为什么下"。
   *
   * ## 契约
   *
   * 1. **一行一轮**：`(trader_id, cycle_number)` 上有唯一性语义 —— 见
   *    `findByCycle()`。调用方拿到 `recordId` 后，轮次末尾走 `finish()` 更新它，
   *    **不再插第二行**。
   * 2. **字段全部可后补**：这里只写"已经知道的东西"（周期号、开始时间、空占位），
   *    提示词/思维链/决策/执行日志由 `finish()` 补齐。所以提前落库**不会**
   *    让最终记录少任何字段。
   * 3. **`success` 先写 1**：语义是"目前没有失败"。真正的失败由 `finish()` 写 ——
   *    而**轮次被切断时它停在 1**，这恰好是诚实的：那一轮确实没抛错，
   *    它只是**没有跑完**。调用方另有 `pendingSinceMs` 判据（见 `health`
   *    与 `findUnfinished()`）来区分"完成"与"没跑完"。
   */
  begin(input: {
    traderId: number;
    cycleNumber: number;
    /**
     * 幂等键的载体：同一 `(traderId, cycleNumber)` 已经有一行时**不再插新行**，
     * 直接返回既有那一行的 id。
     *
     * ⚠️ 由调用方决定是否走这个判据：正常路径要靠它防"重试一轮 → 两行"，
     * 而测试/回放里可能刻意要造重复行（见 `log()` 的同族说明）。
     */
    idempotent?: boolean;
  }): { id: number; created: boolean } {
    if (input.idempotent !== false) {
      const existing = this.findByCycle(input.traderId, input.cycleNumber);
      if (existing !== undefined) {
        /*
         * ⚠️ **复用那一行时必须把它"重置成全新的 pending"**，不能原样留着。
         *
         * 复用的真实场景就是本任务要修的那个：上一轮被 SIGTERM 切断 ⇒
         * `traders.last_cycle_number` 没被推进（`recordCycle()` 只在跑完之后调）⇒
         * 重启后 `cycleNumber` 又走上同一个号 ⇒ 撞上那一行残留的 pending。
         *
         * 如果只返回它的 id 而不重置，最终记录会是**新一轮的数据配上一轮的
         * `timestamp`**（以及上一轮可能已经写进去的零散字段）—— 一张自相矛盾的行：
         * 时间是旧的、内容却是新的。重置之后语义干净：**这一行代表"第 N 轮最近一次尝试"**，
         * 而"曾经有过一次被切断的尝试"由下面那条 warn 与 `warnUnfinishedAudit` 记录。
         */
        getDb().run(
          `UPDATE decision_records
              SET timestamp = ?, system_prompt = '', user_prompt = '', cot_trace = '',
                  decisions_json = '[]', raw_response = '', execution_log_json = '[]',
                  candidate_symbols_json = '[]', success = 1, error = NULL,
                  ai_latency_ms = 0, prompt_tokens = NULL, completion_tokens = NULL,
                  cached_tokens = NULL, reasoning_tokens = NULL
            WHERE id = ?`,
          now(),
          existing,
        );
        return { id: existing, created: false };
      }
    }
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, success)
       VALUES (?, ?, ?, 1)`,
      input.traderId,
      input.cycleNumber,
      now(),
    );
    /*
     * ⚠️ **裁剪必须跟着"新增行"走，不能跟着"补完"走。**
     *
     * 保留策略（500 行 + 每 50 次写裁一次）原来写在 `log()` 里 —— 因为那时
     * `log()` 就是唯一的写入点。2026-10-17 改成"`begin()` 插入 + `finish()` 更新"之后，
     * **插入点变成了 `begin()`**：裁剪留在这里才是对的。
     *
     * 留在 `finish()` 里会有两个后果：
     *   · 行数只在"轮次跑完"时才被裁 —— 一个不断被打断的机器人（正是本任务要修的场景）
     *     会一直只增不裁；
     *   · 更糟的是**自相矛盾**：`finish()` 可能把刚插入、又被裁剪掉的那一行判成"更新失败"
     *     （`{ updated: false }`），于是每次收尾都报一条假 warn。
     */
    trimDecisionsIfDue(input.traderId);
    return { id: lastInsertRowid, created: true };
  },

  /**
   * 把 `begin()` 那一行补成终态。
   *
   * ⚠️ **这是"提前落库 + 后补"唯一允许的收尾入口** —— 不要在别处再写一次
   * `INSERT`，否则一轮两行又会回来（那正是 `runCycle()` 把落库点收敛到一处的理由）。
   *
   * 返回 `{ updated }`：`false` 表示**那一行已经不在了**（被裁剪，或调用方拿错了 id）。
   * 调用方必须把它当真 —— 静默吞掉会让"审计记录丢了"这件事无从发现，
   * 而那正是本任务要消灭的那类观测空洞（参见 `autoTrader.ts` 的 `warnUnfinishedAudit`）。
   */
  finish(input: {
    id: number;
    systemPrompt: string;
    userPrompt: string;
    cotTrace: string;
    decisions: unknown;
    rawResponse: string;
    executionLog: ExecutionLogEntry[];
    candidateSymbols: string[];
    success: boolean;
    error: string | null;
    aiLatencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
  }): { updated: boolean } {
    const { changes } = getDb().run(
      `UPDATE decision_records
          SET system_prompt = ?, user_prompt = ?, cot_trace = ?, decisions_json = ?,
              raw_response = ?, execution_log_json = ?, candidate_symbols_json = ?,
              success = ?, error = ?, ai_latency_ms = ?,
              prompt_tokens = ?, completion_tokens = ?, cached_tokens = ?, reasoning_tokens = ?
        WHERE id = ?`,
      input.systemPrompt,
      input.userPrompt,
      input.cotTrace,
      JSON.stringify(input.decisions),
      input.rawResponse,
      JSON.stringify(input.executionLog),
      JSON.stringify(input.candidateSymbols),
      input.success ? 1 : 0,
      input.error,
      input.aiLatencyMs,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens ?? null,
      input.reasoningTokens ?? null,
      input.id,
    );
    return { updated: changes > 0 };
  },

  /** 某机器人某一轮的那一行（幂等键的读取侧）。 */
  findByCycle(traderId: number, cycleNumber: number): number | undefined {
    const row = getDb().get<{ id: number }>(
      'SELECT id FROM decision_records WHERE trader_id = ? AND cycle_number = ? ORDER BY id DESC LIMIT 1',
      traderId,
      cycleNumber,
    );
    return row?.id;
  },

  /**
   * 某机器人**最新那一行**，连同"它是不是还没补完"。
   *
   * `pending` 的判据：`ai_latency_ms = 0` 且 `error IS NULL` 且 `decisions_json` 为空。
   * `begin()` 写的就是这个形状；`finish()` 之后至少会填上 `ai_latency_ms`
   * （最短的一轮也有几毫秒）或把 `decisions_json` 写成 `[]` 以外的内容 ——
   * 但**真正可靠的那条**是 `ai_latency_ms`：正常路径即使一轮 0 决策也会写实话时。
   *
   * ⚠️ 只用来回答"最近这一轮跑完了吗"，**不要**拿它去改 `traders.last_cycle_at`
   * 之外的任何状态（那是调度器的事，本任务明令不碰）。
   */
  latestWithPending(traderId: number): { id: number; cycleNumber: number; timestamp: string; pending: boolean } | undefined {
    const row = getDb().get<{
      id: number;
      cycle_number: number;
      timestamp: string;
      ai_latency_ms: number;
      error: string | null;
      decisions_json: string;
    }>(
      `SELECT id, cycle_number, timestamp, ai_latency_ms, error, decisions_json
         FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1`,
      traderId,
    );
    if (!row) return undefined;
    const pending =
      Number(row.ai_latency_ms) === 0 &&
      row.error === null &&
      (row.decisions_json === '' || row.decisions_json === '[]');
    return {
      id: row.id,
      cycleNumber: row.cycle_number,
      timestamp: row.timestamp,
      pending,
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  Equity snapshots                                                           */
/* -------------------------------------------------------------------------- */

interface EquityRow {
  id: number;
  trader_id: number;
  timestamp: string;
  equity: number;
  available_balance: number;
  unrealized_pnl: number;
  margin_used: number;
  open_positions: number;
  account_equity: number;
  account_unrealized_pnl: number;
}

/**
 * 本机器人**归属权益**。
 *
 * 一个机器人的权益是它自己的交易挣来的那部分，而不是共用的钱包余额：
 *
 *   initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈
 *
 * `net_pnl` 是净额的唯一来源（§2.5：毛 − 手续费 − 资金费），这里**只做求和**，
 * 不重算任何一笔的净额。
 *
 * 为什么必须这样算：同一个交易所账户下可以跑多个机器人，它们共用凭据与钱包，
 * `account.equity` 对它们全都是同一个数。直接用它，一个从未成交的机器人就会
 * 显示别的机器人挣来的收益率（实盘上量到过 +2.67%），而一个已停止的机器人的
 * 数字会随着邻居继续交易而变化。
 */
export function attributedEquity(
  initialEquity: number,
  netRealizedPnl: number,
  unrealizedPnl: number,
): number {
  return initialEquity + netRealizedPnl + unrealizedPnl;
}

/**
 * 本机器人自己持仓的浮动盈亏。
 *
 * 为什么需要它：`equity_snapshots.unrealized_pnl` 原来抄的是
 * `account.unrealizedPnl` —— 整个交易所账户的浮盈。共用账户时每个机器人记的都是
 * 同一个数，控制台的「浮动盈亏」于是显示成账户的总浮盈（谁都能看到一个和自己
 * 无关的数）。控制台里两个机器人显示同一个浮盈，就是从这里来的。
 *
 * 自己的浮盈只能用自己的持仓算：**自己的**开仓价、数量、方向，乘上**市场**的
 * 标记价。标记价是行情事实（对所有机器人相同），借用它不引入归属错误；开仓价与
 * 数量必须来自本机器人的 `positions` 行，因为交易所那一行可能是多个机器人合起来
 * 的净头寸。
 *
 * 读不到标记价的持仓按 0 计并**把标的返回给调用方**：悄悄按 0 算是把浮盈/浮亏
 * 藏起来，和写账户数字是同一类错误，必须有人能说出来。
 */
export function ownUnrealizedPnlOf(
  openPositions: ReadonlyArray<{ symbol: string; side: string; quantity: number; entry_price: number }>,
  markPriceOf: (symbol: string) => number | undefined,
): { unrealizedPnl: number; missingMarkPrice: string[] } {
  let unrealizedPnl = 0;
  const missingMarkPrice: string[] = [];

  for (const position of openPositions) {
    const markPrice = markPriceOf(position.symbol);
    if (typeof markPrice !== 'number' || !(markPrice > 0)) {
      missingMarkPrice.push(position.symbol);
      continue;
    }
    // 数量在 `positions` 里恒为正，方向由 `side` 承载（与交易所侧一致）。
    const direction = position.side === 'short' ? -1 : 1;
    unrealizedPnl += (markPrice - position.entry_price) * position.quantity * direction;
  }

  return { unrealizedPnl, missingMarkPrice };
}

export const equity = {
  list(traderId: number, limit = 500): EquitySnapshot[] {
    return getDb()
      .all<EquityRow>(
        /*
         * `id DESC` 是 `timestamp DESC` 的**决胜键**，不是装饰。
         *
         * 一个周期写一条快照，而两个周期完全可能落在**同一毫秒**里（实测：整个测试跑完
         * 只要 3.9ms）。只按 `timestamp` 排序时，同一毫秒内的行序是未定义的 —— 实测
         * SQLite 会先回**先插入**的那一行，于是 `latest()` 拿到的是上一轮的快照：
         * 控制台显示的浮盈晚一轮，而依赖它的归属权益会算错。这不是理论问题：它让
         * `stats.test.ts` 里"开仓 + 平仓后权益应为 1001"的断言间歇性地得到 1002
         * （浮盈取到了平仓前那一轮的 +1），大约每 10 次全量测试出现一次。
         *
         * 时间戳相同时，"最新"只能是**最后写入**的那一条，所以用自增主键决胜。
         */
        'SELECT * FROM equity_snapshots WHERE trader_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
        traderId,
        limit,
      )
      .reverse()
      .map((row) => ({
        traderId: row.trader_id,
        timestamp: row.timestamp,
        equity: row.equity,
        availableBalance: row.available_balance,
        unrealizedPnl: row.unrealized_pnl,
        marginUsed: row.margin_used,
        openPositions: row.open_positions,
        accountEquity: row.account_equity,
        accountUnrealizedPnl: row.account_unrealized_pnl,
      }));
  },

  insert(snapshot: EquitySnapshot): void {
    getDb().run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions, account_equity, account_unrealized_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.traderId,
      snapshot.timestamp,
      snapshot.equity,
      snapshot.availableBalance,
      snapshot.unrealizedPnl,
      snapshot.marginUsed,
      snapshot.openPositions,
      snapshot.accountEquity,
      snapshot.accountUnrealizedPnl,
    );
  },

  /**
   * Highest equity ever recorded — **on closed positions only**.
   *
   * Snapshot 的账户权益（`account_equity`）是保证金余额，含未实现盈亏。拿它当
   * 熔断器的高水位是一次真实的 bug：一次未实现浮盈的尖峰（开仓价格瞬间上插）
   * 把高水位永久抬高，价格回落后标记口径回到基线，于是之后每一轮都算出一个
   * 从未发生过的回撤，`maxTotalDrawdownPercent` 从此**永久且静默地**拒绝开新仓
   * —— 原因只写进日志，没有任何东西会清除它。
   *
   * `account_equity - account_unrealized_pnl` 是"开仓按开仓价计价"时账户的余额，
   * 也就是只有真正平仓时才会动的那个数。入金同样会推动它，这是对的：入金确实
   * 抬高了账户的基数。
   *
   * 这一列必须用 `account_*`：`equity` 自 M4 起是**本机器人归属**口径，拿它当
   * 账户高水位会让风控的输入跟着单个机器人的账本走（§4.2，风控输入不变）。
   */
  realizedHighWaterMark(traderId: number): number {
    const row = getDb().get<{ peak: number | null }>(
      'SELECT MAX(account_equity - account_unrealized_pnl) AS peak FROM equity_snapshots WHERE trader_id = ?',
      traderId,
    );
    return row?.peak ?? 0;
  },

  latest(traderId: number): EquitySnapshot | undefined {
    const rows = this.list(traderId, 1);
    return rows[rows.length - 1];
  },
};

/* -------------------------------------------------------------------------- */
/*  Trade events (throttling bookkeeping)                                      */
/* -------------------------------------------------------------------------- */

/**
 * `trade_events` 保留窗口。
 *
 * 这张表原来**没有任何保留策略**，而每个回合至少写两行（entry + exit），
 * 于是它随交易次数线性增长、永不收缩。
 *
 * 7 天是"安全富余"而不是"刚好够用"，理由是这张表的**每一个读取者**都只看最近一小段：
 *
 *  · `entriesThisHour()` 只看 1 小时；
 *  · `isInCooldown()` 只问「这个标的上一次 exit 是什么时候」，而 cooldown 的上限由
 *    `StrategyConfigSchema` 钉死在 1440 分钟（24 小时）—— 超过 24 小时的记录
 *    无论存在与否都不改变判断结果。
 *
 * 所以 7 天 = 最长 cooldown 的 7 倍，即使出现时钟跳变或手工改过配置也不会读到
 * 被裁掉的行。反向的取舍：裁早了会**放开**一个本该仍在冷却的标的（更激进），
 * 所以窗口宁可给足，不能贴着 1440 分钟设。
 *
 * 注意：账目正确性不依赖这张表 —— 净盈亏来自 `trades`，节流只是运行时约束。
 */
const TRADE_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 一次 count 结果的阈值，到了才顺手裁剪一次。
 *
 * 这个数字同时是"多久裁一次"的开关：`countSince()` 的返回值是有界窗口内的条数，
 * 正常情况下是个位到两位数，所以稳态下这条 DELETE 一次都不会执行。只有当窗口内
 * 真的积压了 200 条以上事件时才触发一次裁剪 —— 那时删掉 7 天前的行是纯收益。
 */
const TRADE_EVENT_TRIM_THRESHOLD = 200;

/**
 * 裁掉保留窗口之外的节流事件。
 *
 * 模块级函数而不是 `tradeEvents.trim`：`countSince` 内部要调它，而对象字面量
 * 在初始化期间引用自身（`tradeEvents.trim()`）会抛 TDZ 的 ReferenceError ——
 * 一个只在阈值被突破时才现形的隐藏炸弹。
 */
function trimTradeEvents(retentionMs = TRADE_EVENT_RETENTION_MS): void {
  getDb().run(
    'DELETE FROM trade_events WHERE created_at < ?',
    new Date(Date.now() - retentionMs).toISOString(),
  );
}

export const tradeEvents = {
  record(traderId: number, symbol: string, kind: 'entry' | 'exit'): void {
    getDb().run(
      'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
      traderId,
      symbol,
      kind,
      now(),
    );
  },

  /** 裁剪到保留窗口内。**按批次调用**（入口是 `countSince()`），不是每次写入都调。 */
  trim(retentionMs = TRADE_EVENT_RETENTION_MS): void {
    trimTradeEvents(retentionMs);
  },

  countSince(traderId: number, kind: 'entry' | 'exit', sinceIso: string): number {
    const count = getDb().count(
      'SELECT COUNT(*) AS n FROM trade_events WHERE trader_id = ? AND kind = ? AND created_at >= ?',
      traderId,
      kind,
      sinceIso,
    );
    if (count >= TRADE_EVENT_TRIM_THRESHOLD) trimTradeEvents();
    return count;
  },

  /** Most recent event of a kind for a symbol — drives the re-entry cooldown. */
  lastFor(traderId: number, symbol: string, kind: 'entry' | 'exit'): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND symbol = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      symbol,
      kind,
    );
    return row?.created_at;
  },

  /**
   * 这个机器人最后一次平仓是什么时候（任意标的）。
   *
   * 提示词的「本周期约束」区块要告诉模型它离再入场冷却还有多远。冷却本身是**按标的**
   * 计的（`isInCooldown(symbol)`），这里只回"最近一次平仓"，因为把每个仍在冷却的标的
   * 都列出来会让区块大小随标的数变化，破坏 §4 的 O(1) 要求。
   *
   * 这只是让模型**看见**约束；真正的判定仍然在 `AutoTrader.isInCooldown()` 与风控里，
   * 按标的执行。看不见的约束等于不存在 —— 但看得见的约束也不代替执行。
   */
  lastExit(traderId: number): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      'exit',
    );
    return row?.created_at;
  },

  entriesThisHour(traderId: number): number {
    return this.countSince(traderId, 'entry', new Date(Date.now() - 3_600_000).toISOString());
  },

  /**
   * 本周期已经开了几仓 —— 用「该轮决策落库的时刻」当起点数之后的开仓事件。
   *
   * ## ⚠️ 列名是 `timestamp`，不是 `created_at`（外部 issue #151）
   *
   * 这里原来查 `SELECT created_at FROM decision_records`，而
   * **`decision_records` 的时间列叫 `timestamp`**（`db/schema.ts:188`）——
   * `created_at` 在那一张表上**不存在**，于是这个方法一被调用就抛
   * `no such column: created_at`。
   *
   * 成因是照抄了相邻的 `lastExit()`：那个方法查的是 **`trade_events`** 表，
   * 而**那张表确实有 `created_at`**（`schema.ts:227`）。改了表名、没改列名。
   *
   * ## 它为什么至今没爆：没有调用点
   *
   * 全仓 grep 只有本方法的定义 —— 其余的 `entriesThisCycle` 命中全是
   * `RiskEnvironment` 的**同名字段**（`engine.ts` / `autoTrader.ts:3849` 里那个
   * `entriesThisCycle: 0` 是风控环境的局部计数，与本方法无关）。
   * 所以它是一颗**没人踩到的哑弹**。
   *
   * ⚠️ 这类"死方法里查了不存在的列"值得修而不是删：它的**语义是有效的**
   *（按 `cycle_number` 定位那一轮的起始时刻、再数之后的开仓事件），
   * 而 `risk/engine.ts` 的 `maxEntriesPerCycle` 判据正需要这类信息 ——
   * 现在那个值由调用点从一个变量 0 开始累加（见 `engine.ts:558-569` 的说明）。
   * 一旦有人把本院方法接上，就是线上 500。
   *
   * 同族的既有缺陷：`trades.feesOf()` 曾查不存在的 `exit_fee` 列（已修）。
   *
   * 查不到该轮次时**回落到"最近一分钟"**这个保守窗口，而不是抛 ——
   * 调用方可能在一轮决策刚落库、或对账补录的时序下问一次。
   */
  entriesThisCycle(traderId: number, cycleNumber: number): number {
    const row = getDb().get<{ timestamp: string }>(
      'SELECT timestamp FROM decision_records WHERE trader_id = ? AND cycle_number = ? LIMIT 1',
      traderId,
      cycleNumber,
    );
    const since = row?.timestamp ?? new Date(Date.now() - 60_000).toISOString();
    return this.countSince(traderId, 'entry', since);
  },
};

/* -------------------------------------------------------------------------- */
/*  Settings and logs                                                          */
/* -------------------------------------------------------------------------- */

export const settings = {
  get(key: string): string | undefined {
    return getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  },
  set(key: string, value: string): void {
    getDb().run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  },
};

/** 控制台日志保留的最新行数。表有界，但**不再每写一行就裁剪一次**。 */
export const RUNTIME_LOG_CAP = 500;

/**
 * `runtimeLogs.list()` 一次最多回多少行。
 *
 * 与 `RUNTIME_LOG_CAP` 一致：表里本来就只有这么多行，要更多也没有。
 */
export const RUNTIME_LOG_PAGE_MAX = RUNTIME_LOG_CAP;

/** 不传 `limit` 时返回多少行 —— 与历史契约一致（路由原先写死 200）。 */
export const RUNTIME_LOG_PAGE_DEFAULT = 200;
/**
 * 每写入这么多行才执行一次裁剪。
 *
 * 为什么不是每行一次：原实现的 DELETE 是
 * `DELETE … WHERE id NOT IN (SELECT id … LIMIT 500)`，每写一行扫一遍全表。
 * 而 `emit()` 会在**每个标的的循环里**调用它（对账补录、保护单挂不上、
 * 平仓失败……），一轮周期里能触发几十次；`node:sqlite` 是同步 API，
 * 这些全表扫描全部阻塞事件循环 —— 事件循环正是交易循环本身。
 *
 * 200 这个数字是"内存里多留 200 行"换"DELETE 次数降两个数量级"：
 * 表的上界变成 CAP + TRIM_EVERY = 700 行，而控制台只读最近 200 行，
 * 缓冲的那部分没有任何读取路径依赖它。
 */
const TRIM_EVERY_WRITES = 200;
/** 距离上次裁剪已写入的行数。模块级状态即可：裁剪是全局的，不区分 trader。 */
let writesSinceTrim = 0;

export const runtimeLogs = {
  write(traderId: number | null, level: string, scope: string, message: string): void {
    getDb().run(
      'INSERT INTO runtime_logs (trader_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)',
      traderId,
      level,
      scope,
      message,
      now(),
    );
    writesSinceTrim += 1;
    if (writesSinceTrim >= TRIM_EVERY_WRITES) {
      writesSinceTrim = 0;
      this.trim();
    }
  },

  /** 把表压回 `RUNTIME_LOG_CAP` 行。写路径按批次调用，不是每行调用。 */
  trim(): void {
    getDb().run(
      `DELETE FROM runtime_logs
        WHERE id NOT IN (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT ${RUNTIME_LOG_CAP})`,
    );
  },

  list(limit = RUNTIME_LOG_PAGE_DEFAULT): Array<{ id: number; traderId: number | null; level: string; scope: string; message: string; createdAt: string }> {
    /*
     * ⚠️ **钳制放在仓储层，不放在路由** —— 与 `orders` 的 `clampOrderLimit` 同一个取舍。
     *
     * 原来的路由只挡了非有限值（`Number.isFinite`），而 `1e21` **是有限数**：
     * 它顺利通过并直达 SQL 的 `LIMIT ?`，`node:sqlite` 随即抛
     * `datatype mismatch`（不是截断、不是空结果）→ 整个端点 500。
     * 实测触发条件是 **≥1e21 或非整数**（`1.5` 同样抛；而 `2**53` 虽然超出
     * 安全整数范围却仍然正常，所以"超安全整数"不是判据）。
     *
     * 放在这里而不是路由里的理由：表有界（`RUNTIME_LOG_CAP`），
     * 所以"要超过 500 行"本身就没有意义；在仓储层钳制能让**将来任何新调用点**
     * 自动受保护，不必记得在每个路由里各写一遍。
     *
     * 另外顺手挡住负数：SQLite 的 `LIMIT -5` 表示**无上限**，
     * 会把全表回给调用方 —— 与"只回一页"的契约相反。
     */
    const pageSize = clampPageLimit(limit, RUNTIME_LOG_PAGE_MAX, RUNTIME_LOG_PAGE_DEFAULT);
    return getDb()
      .all<{ id: number; trader_id: number | null; level: string; scope: string; message: string; created_at: string }>(
        'SELECT * FROM runtime_logs ORDER BY id DESC LIMIT ?',
        pageSize,
      )
      .reverse()
      .map((row) => ({
        id: row.id,
        traderId: row.trader_id,
        level: row.level,
        scope: row.scope,
        message: row.message,
        createdAt: row.created_at,
      }));
  },
};

/* -------------------------------------------------------------------------- */
/*  Aggregated statistics                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute a trader's headline statistics.
 *
 * Sharpe is annualised from per-trade returns using the trade count as the
 * sample size, which is crude but honest — it is labelled as such in the UI and
 * is only comparable between traders on the same cadence.
 */
export function computeTraderStats(traderId: number): TraderStats {
  const trader = traders.get(traderId);
  /*
   * One pass over `trades` for both the totals and the Sharpe input.
   *
   * This used to be **four** full scans per request: `trades.stats()`, a second
   * `SELECT pnl, pnl_percent FROM trades` for the Sharpe, and `equity.list(5000)`
   * called *twice* — once for the drawdown walk and once again just to read
   * `[0].timestamp`. The dashboard refreshes this every 5–12 s per trader, and
   * `node:sqlite` is synchronous, so every one of those scans ran on the event
   * loop that also drives the trading cycle. Two of them were also unbounded.
   */
  const { totals: tradeStats, curve: closed } = aggregateTrades(traderId);
  const latest = equity.latest(traderId);
  const openPositions = positions.open(traderId);

  /*
   * `realizedPnl` is the **net** figure — gross minus fees minus funding —
   * because that is what the account actually gained and what the console must
   * show. Reporting gross here is what let the platform claim −0.3136 on an
   * account that had made +0.2586.
   */
  const realizedPnl = tradeStats.netPnl;
  const initial = trader?.initialEquity ?? 0;
  /*
   * 归属权益：**每次按定义重算**，不读快照里存的存量值。
   *
   * 两个理由：
   *  1. 升级前落库的 `equity` 装的是共享钱包余额（M4 之前的 bug），照读会把
   *     那个数字原样带到新版本 —— 一个从未成交的机器人就继续显示别人的收益。
   *  2. 对账补录的成交会立刻反映到控制台，不必等下一个快照；反过来，一个已停止
   *     的机器人没有新快照，这个数就冻在那里不动 —— 这正是它该有的行为。
   *
   * 浮盈取最近一条快照里**本机器人自己的**那个数（标记价只有周期才会重新读到），
   * 不是账户的总浮盈。
   */
  const unrealizedPnl = latest?.unrealizedPnl ?? 0;
  const equityNow = attributedEquity(initial, realizedPnl, unrealizedPnl);

  // Sharpe over **net** returns, matching the headline number.
  const returns = closed.map((t) => t.pnl_percent / 100);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(Math.min(returns.length, 252)) : null;

  /*
   * Equity curve for the drawdown walk and for uptime.
   *
   * Read **once**. The previous code called `equity.list(traderId, 5000)` twice
   * with identical arguments — the second time purely to read element `[0]` — so
   * every dashboard refresh scanned and materialised the same 5000 snapshots
   * twice.
   */
  const equityCurve = equity.list(traderId, EQUITY_CURVE_WINDOW);

  // Max peak-to-trough drawdown across the equity curve.
  let peak = 0;
  let maxDrawdown = 0;
  for (const snapshot of equityCurve) {
    const value = snapshot.equity;
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = ((peak - value) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const firstSnapshot = equityCurve[0];
  const uptimeHours = firstSnapshot
    ? (Date.now() - new Date(firstSnapshot.timestamp).getTime()) / 3_600_000
    : 0;

  return {
    traderId,
    equity: equityNow,
    initialEquity: initial,
    totalReturnPercent: initial > 0 ? ((equityNow - initial) / initial) * 100 : 0,
    realizedPnl,
    grossRealizedPnl: tradeStats.grossPnl,
    totalFees: tradeStats.totalFees,
    totalFunding: tradeStats.totalFunding,
    unrealizedPnl,
    /*
     * 共享钱包单独给出：同一账户下的多个机器人读数是同一个数，混进 `equity`
     * 就没法分辨"这个机器人挣了多少"和"账户里有多少钱"。没有快照时为 0，
     * 界面据此显示"—"而不是假装账户是空的。
     */
    accountEquity: latest?.accountEquity ?? 0,
    totalTrades: tradeStats.totalTrades,
    // Percentage in 0–100. The field name states the unit so no caller has to
    // guess — an earlier `winRate` with no unit was multiplied by 100 again on
    // the client and rendered one win as 10000.0%.
    winRatePercent:
      tradeStats.totalTrades > 0 ? (tradeStats.wins / tradeStats.totalTrades) * 100 : 0,
    // Sent as real counts rather than left for the client to back out of the
    // percentage, which is lossy and produced "1 笔已平仓 / 100 盈".
    wins: tradeStats.wins,
    losses: tradeStats.losses,
    profitFactor:
      tradeStats.grossLoss > 0
        ? tradeStats.grossProfit / tradeStats.grossLoss
        : tradeStats.grossProfit > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    avgWin: tradeStats.avgWin,
    avgLoss: tradeStats.avgLoss,
    maxDrawdownPercent: maxDrawdown,
    sharpeRatio: sharpe,
    bestTrade: tradeStats.best,
    worstTrade: tradeStats.worst,
    openPositions: openPositions.length,
    cyclesRun: decisions.count(traderId),
    uptimeHours,
  };
}
