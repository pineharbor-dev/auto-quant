/**
 * SQLite schema. Applied as a sequence of numbered migrations tracked in
 * `PRAGMA user_version`, so upgrading an existing database is safe.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * 这个迁移会 `DROP` 一张**被别的表引用**的表并重建它。
   *
   * ## 为什么必须显式标出来
   *
   * 连接打开时是 `PRAGMA foreign_keys = ON`（见 `db/index.ts`），而迁移跑在
   * `BEGIN...COMMIT` 里 —— **`PRAGMA foreign_keys` 在事务内是 no-op**。
   * 所以一个重建表的迁移如果照常执行，`DROP TABLE traders` 会**级联删掉
   * 所有持仓、成交、订单与决策记录**（它们都是 `ON DELETE CASCADE`）。
   *
   * 标上它之后，执行器会在 `BEGIN` **之前**关外键、`COMMIT` **之后**恢复，
   * 并跑一次 `PRAGMA foreign_key_check` 确认重建没有留下悬空引用。
   */
  detachForeignKeys?: boolean;
}

const M1_INITIAL = /* sql */ `
-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  created_at    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Exchange credentials (secrets encrypted with AES-256-GCM)
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange       TEXT    NOT NULL DEFAULT 'binance',
  label          TEXT    NOT NULL,
  api_key        TEXT    NOT NULL,
  api_secret_enc TEXT    NOT NULL,
  passphrase_enc TEXT    NOT NULL DEFAULT '',
  testnet        INTEGER NOT NULL DEFAULT 1,
  can_trade      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- LLM endpoints
-- ---------------------------------------------------------------------------
CREATE TABLE ai_models (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  base_url        TEXT    NOT NULL DEFAULT '',
  api_key_enc     TEXT    NOT NULL DEFAULT '',
  temperature     REAL    NOT NULL DEFAULT 0.2,
  max_tokens      INTEGER NOT NULL DEFAULT 4096,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Strategies — the full StrategyConfig blob plus display metadata
-- ---------------------------------------------------------------------------
CREATE TABLE strategies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  config_json TEXT    NOT NULL,
  preset_id   TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Traders — a (credential, model, strategy) triple wired to a live loop
-- ---------------------------------------------------------------------------
CREATE TABLE traders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  exchange_account_id    INTEGER NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  ai_model_id            INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  strategy_id            INTEGER NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
  cycle_interval_minutes INTEGER NOT NULL DEFAULT 15,
  initial_equity         REAL    NOT NULL DEFAULT 0,
  status                 TEXT    NOT NULL DEFAULT 'stopped',
  last_cycle_at          TEXT,
  last_cycle_number      INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);
CREATE INDEX idx_traders_status ON traders(status);

-- ---------------------------------------------------------------------------
-- Open positions (mirrored from the exchange, enriched with our own state)
-- ---------------------------------------------------------------------------
CREATE TABLE positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id        INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  quantity         REAL    NOT NULL,
  entry_price      REAL    NOT NULL,
  leverage         INTEGER NOT NULL,
  liquidation_price REAL,
  margin_used      REAL    NOT NULL DEFAULT 0,
  peak_pnl_percent REAL    NOT NULL DEFAULT 0,
  stop_loss        REAL,
  take_profit      REAL,
  stop_order_id    TEXT,
  tp_order_id      TEXT,
  open_reasoning   TEXT    NOT NULL DEFAULT '',
  opened_at        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open'
);
CREATE INDEX idx_positions_trader_status ON positions(trader_id, status);
CREATE UNIQUE INDEX idx_positions_open_symbol ON positions(trader_id, symbol) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Every order we ever sent, including rejects
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id         INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  exchange_order_id TEXT,
  client_order_id   TEXT    NOT NULL,
  symbol            TEXT    NOT NULL,
  side              TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  purpose           TEXT    NOT NULL,
  quantity          REAL    NOT NULL DEFAULT 0,
  price             REAL,
  stop_price        REAL,
  status            TEXT    NOT NULL,
  avg_price         REAL,
  filled_qty        REAL    NOT NULL DEFAULT 0,
  fee               REAL    NOT NULL DEFAULT 0,
  error             TEXT,
  raw_response      TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX idx_orders_trader ON orders(trader_id, created_at DESC);
CREATE INDEX idx_orders_symbol ON orders(trader_id, symbol);

-- ---------------------------------------------------------------------------
-- Closed round-trips
-- ---------------------------------------------------------------------------
CREATE TABLE trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id    INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol       TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  quantity     REAL    NOT NULL,
  entry_price  REAL    NOT NULL,
  exit_price   REAL    NOT NULL,
  leverage     INTEGER NOT NULL,
  pnl          REAL    NOT NULL,
  pnl_percent  REAL    NOT NULL,
  fee          REAL    NOT NULL DEFAULT 0,
  close_reason TEXT    NOT NULL DEFAULT '',
  opened_at    TEXT    NOT NULL,
  closed_at    TEXT    NOT NULL,
  hold_minutes REAL    NOT NULL DEFAULT 0
);
CREATE INDEX idx_trades_trader ON trades(trader_id, closed_at DESC);

-- ---------------------------------------------------------------------------
-- Full audit trail of every decision cycle
-- ---------------------------------------------------------------------------
CREATE TABLE decision_records (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id            INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  cycle_number         INTEGER NOT NULL,
  timestamp            TEXT    NOT NULL,
  system_prompt        TEXT    NOT NULL DEFAULT '',
  user_prompt          TEXT    NOT NULL DEFAULT '',
  cot_trace            TEXT    NOT NULL DEFAULT '',
  decisions_json       TEXT    NOT NULL DEFAULT '[]',
  raw_response         TEXT    NOT NULL DEFAULT '',
  execution_log_json   TEXT    NOT NULL DEFAULT '[]',
  candidate_symbols_json TEXT  NOT NULL DEFAULT '[]',
  success              INTEGER NOT NULL DEFAULT 1,
  error                TEXT,
  ai_latency_ms        INTEGER NOT NULL DEFAULT 0,
  prompt_tokens        INTEGER,
  completion_tokens    INTEGER
);
CREATE INDEX idx_decisions_trader ON decision_records(trader_id, cycle_number DESC);

-- ---------------------------------------------------------------------------
-- Equity curve
-- ---------------------------------------------------------------------------
CREATE TABLE equity_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id         INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  timestamp         TEXT    NOT NULL,
  equity            REAL    NOT NULL,
  available_balance REAL    NOT NULL DEFAULT 0,
  unrealized_pnl    REAL    NOT NULL DEFAULT 0,
  margin_used       REAL    NOT NULL DEFAULT 0,
  open_positions    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_equity_trader ON equity_snapshots(trader_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- Throttling bookkeeping so limits survive restarts
-- ---------------------------------------------------------------------------
CREATE TABLE trade_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id  INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_trade_events ON trade_events(trader_id, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Key/value instance settings
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rolling live log for the console's log pane
-- ---------------------------------------------------------------------------
CREATE TABLE runtime_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id  INTEGER,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'server',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runtime_logs ON runtime_logs(id DESC);
`;

/**
 * Accounting columns on `trades`.
 *
 * Why this exists: the platform used to record `pnl` as **gross** and `fee` as
 * only the **exit** side's commission, and it only learned about a close if it
 * happened to be running a cycle at that moment. A position whose exchange-side
 * take profit fired while the bot was stopped was never recorded at all — a live
 * account showed +0.2586 net while the console reported −0.3136, a sign-flipped
 * error of 0.57 USDT on a 10 USDT account.
 *
 * So `pnl` keeps its meaning (gross, straight from the exchange's realizedPnl),
 * and the costs become explicit columns so the displayed figure can be **net**
 * and can be shown broken down:
 *
 *   net_pnl = gross_pnl − entry_fee − exit_fee − funding_fee
 *
 * `source` records provenance: `bot` for trades the runtime booked live,
 * `reconciled` for round-trips recovered from the exchange's fill history. Both
 * are legitimate; knowing which is which is what makes a discrepancy debuggable.
 */
const M2_TRADE_ACCOUNTING = /* sql */ `
ALTER TABLE trades ADD COLUMN entry_fee   REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN funding_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN net_pnl     REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN source      TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE trades ADD COLUMN entry_order_id TEXT;
ALTER TABLE trades ADD COLUMN exit_order_id  TEXT;

-- Backfill: for rows written before this migration, pnl is gross and fee holds
-- whatever commission the runtime managed to capture (the exit side only).
-- Copying it across keeps the arithmetic consistent for historical rows; a
-- reconciliation pass corrects the fee to the exchange's true total.
UPDATE trades SET net_pnl = pnl - fee;

CREATE INDEX idx_trades_exit_order ON trades(trader_id, exit_order_id);
`;

/**
 * 可撤销的会话。
 *
 * 为什么需要：JWT 是无状态的，签发之后服务端没有任何办法让它失效。
 * 于是「修改密码」这个唯一的补救动作在最需要它的时候是**无效的** ——
 * 令牌一旦泄漏（浏览器残留、代理日志、旧设备），攻击者可以在剩下的
 * 有效期内继续下单，而所有者改密码、甚至改用户名都不会把它踢下线。
 *
 * 做法：在 `users` 上记一个「凭据变更时间」。签发令牌时把这个时间写进载荷
 * （`credAt`），校验时与数据库里的当前值等值比较；改密码或改用户名会刷新它，
 * 于是所有更早签发的令牌立即失配。为什么不是「iat 早于变更时间」的比大小：
 * 见 `api/auth.ts` 的 `isTokenRevoked()`。
 *
 * 默认空串 = 「从未改过」，因此**升级不会把现有会话全部踢下线**：
 * 只有真正发生凭据变更时才作废旧令牌。这是刻意的 —— 升级本身不该让操作员
 * 在一个正在跑真实订单的系统上失去控制台访问。
 */
const M3_SESSION_REVOCATION = /* sql */ `
ALTER TABLE users ADD COLUMN credentials_changed_at TEXT NOT NULL DEFAULT '';
`;

/**
 * 权益归属：把「账户权益」与「本机器人归属权益」分开存。
 *
 * 为什么需要这次迁移：`equity_snapshots.equity` 一直写的是
 * `broker.getAccountState().equity` —— **共享钱包**的保证金余额。同一个交易所
 * 账户下跑多个机器人时它们共用一份凭据，于是每个机器人每一行记的都是同一个数。
 * 实盘上量到的后果（三个机器人共用一个账户）：
 *
 *   #4 测试机器人1   0 笔平仓、净 0.000000 → 显示 +2.67%
 *   #5 测试2         4 笔平仓、净 +0.272133 → 显示 +2.67%（和 #4 一模一样）
 *   #6 实盘3小时验证  0 笔平仓、净 0.000000 → 显示 −0.06%
 *
 * 也就是说一个**从未交易**的机器人显示了别的机器人挣的钱，而两个机器人的收益率
 * 完全相同 —— 因为它们读的是同一个钱包。
 *
 * 迁移之后：
 *   · `equity` / `unrealized_pnl` 改记**本机器人**的归属口径；
 *   · `account_equity` / `account_unrealized_pnl` 记账户（共享钱包）的口径，
 *     风控的回撤高水位与「账户权益」展示读这两列（见 `realizedHighWaterMark`）。
 *
 * 回填的取舍（历史行无法精确重建，这里选**最不撒谎**的那种）：
 *   · 旧行的 `equity` 就是账户权益，先原样搬到 `account_equity` —— 高水位的历史
 *     因此不失真（`MAX` 是单调的，少一个点只会低估峰值）。
 *   · 本机器人当年的浮盈从没被记录过（那一列当时装的是账户的总浮盈，不是它的），
 *     无法反推，所以旧行 `unrealized_pnl` 置 0，`equity` 用
 *     `initial_equity + Σ(该时刻之前已平仓的 net_pnl)` 重建 —— 这是一条只有已实现
 *     盈亏的曲线，形状正确、数字有出处。
 *   · `open_positions` 旧行记的是账户的持仓数，同样无法按机器人重建，因此不动它
 *     （它只用于曲线 tooltip，不参与任何金额计算）。
 *
 * 注意 `net_pnl` 在这里只被**求和**，不重算：净额的唯一计算点仍然是
 * `trades.insert()` / `applyExchangeFigures()`（§2.5）。
 */
const M4_ATTRIBUTED_EQUITY = /* sql */ `
ALTER TABLE equity_snapshots ADD COLUMN account_equity         REAL NOT NULL DEFAULT 0;
ALTER TABLE equity_snapshots ADD COLUMN account_unrealized_pnl  REAL NOT NULL DEFAULT 0;

UPDATE equity_snapshots
   SET account_equity = equity,
       account_unrealized_pnl = unrealized_pnl;

UPDATE equity_snapshots
   SET equity = COALESCE(
         (SELECT t.initial_equity FROM traders t WHERE t.id = equity_snapshots.trader_id), 0)
       + COALESCE(
         (SELECT SUM(tr.net_pnl) FROM trades tr
           WHERE tr.trader_id = equity_snapshots.trader_id
             AND tr.closed_at <= equity_snapshots.timestamp), 0),
       unrealized_pnl = 0;
`;

const M5_AI_AGENT_MEMORY = /* sql */ `
-- ---------------------------------------------------------------------------
-- 全自动智能托管（AI Agent 模式）—— 三张表
--
-- 这个模式与之前所有策略的**本质区别**在于：模型的每一次决策不再孤立。
-- 它有自己的历史、自己的改动记录、以及**这些改动之后真实发生了什么**。
--
-- 所以「越跑越厉害」不靠一句"请反思"，而靠这三张表：
--   · agent_experiments —— 我改了什么 + 之后真实结果（学习的**事实**来源）
--   · agent_memory      —— 这个形态/这个失败原因，上次是怎么亏的（**前车之鉴**）
--   · agent_runs        —— 每次循环的完整轨迹（**可审计**，也是排查依据）
--
-- 没有这三张表，"AI 自我迭代"只是一段听起来很专业的文字。
-- ---------------------------------------------------------------------------

-- 每一次参数调整，以及之后真实发生了什么。
--
-- ⚠️ patch_json（AI 想改什么）与 applied_json（守卫之后实际生效什么）
-- 必须**分开存**：两者不同时要能一眼看出来。否则守卫钳制了、而 AI 以为自己改成了，
-- 下一轮它会基于一个错误的前提继续推理。
CREATE TABLE agent_experiments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id             INTEGER NOT NULL REFERENCES traders(id),
  created_at            TEXT    NOT NULL,

  -- 为什么被唤醒：new_result / drawdown / losing_streak / timeout / rejections / manual
  trigger               TEXT    NOT NULL,
  -- 唤醒时它看到的绩效快照（JSON）。留着是为了回答"它当时凭什么这么改"。
  observed_json         TEXT    NOT NULL,
  patch_json            TEXT    NOT NULL,
  applied_json          TEXT    NOT NULL,
  -- 被守卫钳制的项及原因（[{"field","asked","allowed","why"}]）。空数组表示原样通过。
  clamps_json           TEXT    NOT NULL DEFAULT '[]',
  -- AI 自己写的判断。**必填** —— 一次没有理由的调参无法被审查。
  reason                TEXT    NOT NULL,
  -- 它查了什么（工具调用序列）。用来还原它的推理依据。
  tool_calls_json       TEXT    NOT NULL DEFAULT '[]',

  -- ↓ 由后续周期回填：这次调整之后真实发生了什么。**这是"学习"的落地处。**
  outcome_trades        INTEGER,
  outcome_net_pnl       REAL,
  outcome_evaluated_at  TEXT
);

CREATE INDEX idx_agent_experiments_trader ON agent_experiments(trader_id, created_at DESC);
-- 回填扫描用：只找还没结算的那些。
CREATE INDEX idx_agent_experiments_pending ON agent_experiments(trader_id, outcome_evaluated_at);

-- 复盘员在每笔平仓后写的因果结论。**这是"前车之鉴"的来源。**
--
-- 与 agent_experiments 的分工：那个记"我改了什么参数"，
-- 这个记"这笔为什么赚/亏" —— 前者是策略层的记忆，后者是执行层的记忆。
CREATE TABLE agent_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id     INTEGER NOT NULL REFERENCES traders(id),
  -- 一笔平仓对应一条。UNIQUE 保证重复对账不会写出两条互相矛盾的经验。
  trade_id      INTEGER NOT NULL UNIQUE REFERENCES trades(id),
  created_at    TEXT    NOT NULL,

  symbol        TEXT    NOT NULL,
  close_reason  TEXT    NOT NULL,
  net_pnl       REAL    NOT NULL,
  -- 因果结论：这笔为什么赚/亏。面向模型，所以是散文。
  lesson        TEXT    NOT NULL,
  -- 可检索的标签（["追高","逆势","费用吃掉利润"]）。检索靠它，不靠全文匹配。
  tags_json     TEXT    NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_agent_memory_trader ON agent_memory(trader_id, created_at DESC);
CREATE INDEX idx_agent_memory_symbol ON agent_memory(trader_id, symbol, created_at DESC);

-- 每次智能体循环的完整轨迹。可审计，也是"这一步为什么花这么多 token"的依据。
CREATE TABLE agent_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id     INTEGER NOT NULL REFERENCES traders(id),
  created_at    TEXT    NOT NULL,

  -- decision（每轮交易台）/ strategy（低频调参）/ review（复盘）
  kind          TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  -- single（单次调用）/ panel（多角色并行）。**由程序决定用哪档，不让 AI 自己选。**
  intensity     TEXT    NOT NULL,
  steps         INTEGER NOT NULL DEFAULT 0,
  -- 各角色返回的结构化结论（JSON 数组）。
  agents_json   TEXT    NOT NULL DEFAULT '[]',
  -- ok / degraded（超预算降级）/ failed
  outcome       TEXT    NOT NULL,
  detail        TEXT    NOT NULL DEFAULT '',

  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_runs_trader ON agent_runs(trader_id, created_at DESC);
`;

const M6_AGENT_CONFIG = /* sql */ `
-- ---------------------------------------------------------------------------
-- AI 智能托管：每个机器人自己的一份参数
--
-- 为什么不能复用 strategies.config：**一个策略可以被多个机器人共用**，
-- 而 AI 模式下的参数是**每个机器人各自演化**的。共用一个位置会让两个 AI
-- 机器人互相覆盖对方的参数，而且那种覆盖看起来完全正常（配置就是配置）。
--
-- agent_config_json 非空即代表这个机器人处于 AI 托管模式 ——
-- 一个显式、可查询的判据，而不是靠 strategy_id 或某个标志位去猜。
--
-- 为 NULL 时机器人按 strategy.config 跑，行为与以前完全一致（老机器人不受影响）。
-- ---------------------------------------------------------------------------
ALTER TABLE traders ADD COLUMN agent_config_json TEXT;
`;

const M7_TRADER_MODE = /* sql */ `
-- ---------------------------------------------------------------------------
-- 机器人的运行模式：由固定策略参数驱动，还是由 AI 智能体托管
--
-- ## 为什么这是一个"机器人的属性"而不是"一个策略"
--
-- AI 托管最初被做成了一个策略预设（presetId = 'ai_managed'）。那是错的：
--
--   · **策略是"一组固定参数"，而 AI 模式的意思是"没有固定参数"** ——
--     后者根本不能是前者的一种。
--   · 挂在策略上意味着它会出现在策略列表里，**任何既有机器人都能选中它**，
--     包括那些本该按固定参数跑的。
--   · AI 模式的参数存在 traders.agent_config_json（按机器人隔离），
--     概念上它**从来不需要一个策略**。
--
-- 所以模式是机器人自己的属性。strategy_id 保留 NOT NULL（策略模式下用得上，
-- AI 模式下被忽略）—— 不动外键是为了不牵动既有数据的完整性约束。
--
-- 默认 'strategy'，所以所有既有机器人行为完全不变。
-- ---------------------------------------------------------------------------
ALTER TABLE traders ADD COLUMN mode TEXT NOT NULL DEFAULT 'strategy';
`;

/*
 * 部分平仓的记账去重。
 *
 * ## 为什么需要这两列
 *
 * 「减仓」是一个部分出场：仓位还开着，但已经卖掉了一部分。
 * 那一部分必须**当场记账** —— 交易所已经实现了盈亏，不记的话账面就落后于账户。
 *
 * 而仓位最终平掉时，`findRoundTrip()` 会从成交历史里重建**整段往返**：
 * 它的 grossPnl、entryFee、exitFee 覆盖的是**全部**入场与出场。
 *
 * 于是同一笔利润会被记两次 —— 一次在减仓时、一次在最终平仓时。
 * **重复记账比漏记更糟**：漏记让账面比实际差，而重复记账让账面比实际好，
 * 后者正是 §2.5 明令禁止的方向（它会让一个亏损账户看起来是赚的）。
 *
 * ## 两列分别是什么
 *
 *   · `realized_partial_pnl` —— 减仓时已经记过的**净**盈亏累计
 *   · `booked_partial_qty` —— 已经记过账的出场数量累计
 *
 * 最终平仓时把重建结果**减去**这两项，剩下的才是这一次该记的。
 *
 * ## 为什么"减仓时直接改 quantity"不够
 *
 * 改 quantity 只解决"还剩多少"，不解决"已经记了多少"。
 * 重建函数按 (symbol, 数量, 均价) 去匹配整段往返，它不知道我们已经提前记过一部分
 * —— 所以必须有一处显式记下来。
 */
const M8_PARTIAL_CLOSE = /* sql */ `
ALTER TABLE positions ADD COLUMN realized_partial_pnl REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN booked_partial_qty REAL NOT NULL DEFAULT 0;
`;


/*
 * 决策记录里补上**缓存命中**与**思考 token**。
 *
 * ## 为什么这两列值钱
 *
 * 缓存命中价与未命中价差 50 倍，而输出价是缓存命中输入价的 200 倍。
 * 少了这两个数，"这个机器人为什么烧钱"就只能靠猜。
 *
 * ## 为什么允许 NULL
 *
 * `NULL` = 服务商没报这个字段（**不知道**）；
 * `0` = 报了，确实一个都没命中。**两者的结论完全相反**，
 * 所以不设默认值 —— 一个默认的 0 会把"不知道"永久伪装成"没命中"。
 */
const M9_USAGE_DETAIL = /* sql */ `
ALTER TABLE decision_records ADD COLUMN cached_tokens INTEGER;
ALTER TABLE decision_records ADD COLUMN reasoning_tokens INTEGER;
`;

/**
 * 模型能吃多大的输入 —— 让提示词预算跟着它走，而不是写死 6 万。
 *
 * ## 为什么需要这一列
 *
 * `PROMPT_TOKEN_BUDGET` 原来硬编码 `60_000`，而候选池的大小是
 * **预算 ÷ 每个候选的字符成本**（`candidateBudget()`）—— 于是一个 4 周期、
 * 每周期 30 个点的策略只能看到 **7 个标的**。实测：某机器人连续 15 轮候选池
 * 都只有 7 个、15 轮 0 决策，而它挂的模型能吃 100 万。
 *
 * `0` = **不知道**（服务商没报、用户没填）→ 回落到原来那个保守的 6 万。
 * 用 `0` 而不是 `NULL`：这一列是"能力上限"，0 与"不知道"在这里的处置**相同**
 * （都走保守回落），不像 `cached_tokens` 那样两者结论相反，所以不需要三态。
 *
 * 上限不写进这一列 —— 那是"允许花多少"的策略，属于 `PROMPT_TOKEN_CEILING`。
 */
const M10_INPUT_TOKEN_LIMIT = /* sql */ `
ALTER TABLE ai_models ADD COLUMN input_token_limit INTEGER NOT NULL DEFAULT 0;
`;

/**
 * 限价入场的待成交持仓。
 *
 * ## 为什么需要这一列
 *
 * 「挂限价单等成交」是真实交易员的标准做法（预测一个区间、在那儿等着）。
 * 而它要求系统能回答一个问题：**那张挂出去的单，成交了吗？**
 *
 * 在此之前 `positions` 表回答不了 —— 它没有存入场单的交易所单号，而
 * `entry_price` 是"成交均价"，挂单时根本还没有。于是系统只能把限价单
 * 当成"已经成交"来处理，那会把一个还没发生的持仓记进账本。
 *
 * ## 与 `status` 的配合
 *
 * 挂上限价单时插一行 `status='pending'`：`entry_order_id` 是那张单，
 * `quantity` / `entry_price` 是**打算**要的量与价。对账拿这个单号去问交易所：
 *
 *   · 成交 → 改 `status='open'`、用真实成交价与成交量覆盖，**并立刻挂保护单**；
 *   · 撤单/过期 → 改 `status='closed'`，它从未成为过持仓；
 *   · 还没成交 → 原样留着，下一轮再问。
 *
 * `positionStore.open()` 只返回 `status='open'`，所以 `pending` 的行
 * **不会污染任何现有的持仓读取** —— 风控、UI、权益计算看到的仍然是真实持仓。
 *
 * 用 `status` 而不是新建一张表：持仓的单一事实源只能有一个，而这张表
 * 已经是它了。第二张表意味着两处都要维护"一个标的只有一个仓位"这条不变量。
 */
const M11_PENDING_ENTRY = /* sql */ `
ALTER TABLE positions ADD COLUMN entry_order_id TEXT;
`;

/**
 * **成交的情报归因**（2026-10-12）—— `intel/signalHealth.ts` 的数据来源。
 *
 * ## 为什么需要它
 *
 * 消息面失效检测（胜率崩塌 / 连续亏损 / **反应衰减**）需要
 * "**由某个信号驱动的成交**"。而实测核查发现这条信息**系统从未记录过**：
 *
 * ```
 *   trades.source     → 只有 bot / reconciled（不是"哪个信号"）
 *   open_reasoning    → 技术面理由
 *   Decision          → 之前没有任何情报来源字段
 * ```
 *
 * 所以 `signalHealth` 一直是**空转**（永远 `insufficient_data`）。
 *
 * ## 为什么存在 `trades` 上（而不是新建一张表）
 *
 * 归因是**成交的属性**：一笔成交对应"开仓时那条决策依据了哪些信号"。
 * 新建表会带来"两处都要维护一笔成交"的问题（本项目在别处踩过：
 * `positions` 与 `trade_events` 的一致性）。
 *
 * ## 格式
 *
 * JSON 数组，元素是 `signalKeyOf()` 的产出：`<域名>|<方向>|<标的>`。
 * · **空数组 = 纯技术面成交**（没有情报依据）—— 与"列不存在"语义相同；
 * · 只写**通过 `filterKnownIntelKeys` 校验**的键（编造的被剔除）。
 *
 * ⚠️ `DEFAULT '[]'` 让既有 225 笔历史成交**自然落到"纯技术面"**，
 * 不需要 backfill —— 那也符合事实（它们确实没有情报归因）。
 */
/**
 * **成交的情报归因**（2026-10-12）—— `intel/signalHealth.ts` 的数据来源。
 *
 * ## 为什么需要它
 *
 * 消息面失效检测（胜率崩塌 / 连续亏损 / **反应衰减**）需要
 * "**由某个信号驱动的成交**"。而实测核查发现这条信息**系统从未记录过**：
 *
 * ```
 *   trades.source     → 只有 bot / reconciled（不是"哪个信号"）
 *   open_reasoning    → 技术面理由
 *   Decision          → 之前没有任何情报来源字段
 * ```
 *
 * 所以 `signalHealth` 一直是**空转**（永远 `insufficient_data`）。
 *
 * ## 格式
 *
 * JSON 数组，元素是 `signalKeyOf()` 的产出：`<域名>|<方向>|<标的>`。
 * · **空数组 = 纯技术面**（没有情报依据）；
 * · 只写**通过 `filterKnownIntelKeys` 校验**的键（编造的被剔除）。
 *
 * ⚠️ `DEFAULT '[]'` 让既有 225 笔历史成交**自然落到"纯技术面"**，
 * 不需要 backfill —— 那也符合事实。
 */
const M16_TRADE_INTEL_ATTRIBUTION = /* sql */ `
ALTER TABLE trades ADD COLUMN intel_keys TEXT NOT NULL DEFAULT '[]';
`;

/**
 * **持仓的情报归因**（2026-10-12）—— 归因链的中间一环。
 *
 * ## ⚠️ 为什么这是 M17 而不是并进 M16（我犯过这个错）
 *
 * 我第一版把 `positions` 的 `ADD COLUMN` 直接**加进了 M16** ——
 * 而 **M16 已经在线上跑过**（`user_version = 16`）。
 *
 * 而迁移的跳过判据是（`db/index.ts` L55）：
 * ```js
 * if (migration.version <= current) continue;
 * ```
 *
 * **所以改一个已发布的迁移 = 那段 SQL 永远不会再执行** ——
 * 我给 `positions` 加的列在线上**根本没生效**，而**没有任何报错**。
 *
 * > **已发布的迁移是只读的。要改就加新的一段。**
 * > （这条教训值得写在这里：它不报错，只是静默不生效。）
 *
 * ## 为什么 `positions` 需要它
 *
 * 归因链的形状是：
 * ```
 *   开仓 → positions 行（此时决策的 intelKeys 在手边）
 *   平仓 → trades 行（把上面那份带过来）
 * ```
 *
 * 若只在 `trades` 上有列，平仓时就**必须回查"当初那条决策"** ——
 * 而"哪条决策开的这个仓"要靠 `symbol + 时间` 去猜
 *（决策记录里没有仓位 id）。**那正是我拒绝过的"猜测式归因"。**
 *
 * 而 `positions.open_reasoning` 就是**现成的先例**：它存的就是
 * "开仓时那条决策的技术面理由"。`intel_keys` 是它的**兄弟字段**
 *（一个记技术面依据，一个记消息面依据）。
 */
const M17_POSITION_INTEL_ATTRIBUTION = /* sql */ `
ALTER TABLE positions ADD COLUMN intel_keys TEXT NOT NULL DEFAULT '[]';
`;

const M12_STRATEGY_OPTIONAL = /* sql */ `
-- ---------------------------------------------------------------------------
-- AI 托管与策略**彻底解耦**：strategy_id 允许为空，删策略时置空而不是阻止
--
-- ## 用户的原话
--
--   「智能托管模式完全独立出来，也就是说不依赖于任何策略（包括默认、内置策略），
--     就算策略工坊里面默认策略 — 稳健就算删除、没有任何策略，都不影响智能托管
--     模式（做到完全独立）」
--
-- ## 原先那两个约束合起来造成的局面
--
--   strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT
--
--   · **NOT NULL** → 建 AI 托管机器人时**必须**选一个策略，而那个策略对它
--     **完全不生效**（参数在 traders.agent_config_json 里，见 M6 的说明）；
--   · **RESTRICT** → 于是那个策略**永远删不掉**，哪怕没有任何固定策略机器人在用它，
--     而界面上那句「1 个机器人 · 1 运行中」还会让人以为它在跑那个策略。
--
-- 两者都是"AI 模式还需要一个策略"这个错误前提留下的。M7 已经把 mode 从策略
-- 提升成**机器人自己的属性**（那一段注释里写着"AI 模式的参数概念上从来不需要
-- 一个策略"），这一步把数据层最后一条腿锯掉。
--
-- ## 为什么是 SET NULL 而不是 CASCADE
--
-- 删掉一个**固定策略**机器人的策略时，不该把那台机器人一起删掉 ——
-- ON DELETE CASCADE 会连带删掉它的成交、持仓与决策记录，**而那是账本**。
-- 置空之后它启动时会因为"没有生效配置"而给出明确错误，让人去选一个；
-- 静默消失才是不可接受的。
--
-- ## 为什么只能重建整张表
--
-- SQLite 不支持 ALTER COLUMN。所以这里建新表、复制、改名 —— 而重建一张
-- **被引用的**表必须在事务外关外键（否则 DROP 会级联删掉子表数据），
-- 所以这个迁移带了 detachForeignKeys 标志，见 db/index.ts 的 migrate()。
--
-- ⚠️ 下面的列顺序必须与迁移前**逐字一致** —— INSERT ... SELECT 是按位置对应的。
-- 顺序取自实盘的 PRAGMA table_info(traders)。
-- ---------------------------------------------------------------------------
CREATE TABLE traders_new (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  exchange_account_id    INTEGER NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  ai_model_id            INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  -- ⚠️ 这两处是本次迁移的**唯一实质改动**：去掉 NOT NULL，RESTRICT 换成 SET NULL。
  strategy_id            INTEGER          REFERENCES strategies(id) ON DELETE SET NULL,
  cycle_interval_minutes INTEGER NOT NULL DEFAULT 15,
  initial_equity         REAL    NOT NULL DEFAULT 0,
  status                 TEXT    NOT NULL DEFAULT 'stopped',
  last_cycle_at          TEXT,
  last_cycle_number      INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  agent_config_json      TEXT,
  mode                   TEXT    NOT NULL DEFAULT 'strategy'
);
INSERT INTO traders_new SELECT * FROM traders;
-- ⚠️ 把**已有的** AI 托管机器人的引用真正置空。
-- 不置空的话它们会继续指向一个对自己不生效的策略：那个策略删不掉（拦截逻辑
-- 虽然按 mode 判断，但外键 RESTRICT 仍在数据层），而界面也会显示成"正在引用"。
UPDATE traders_new SET strategy_id = NULL WHERE mode = 'ai_managed';
DROP TABLE traders;
ALTER TABLE traders_new RENAME TO traders;
CREATE INDEX idx_traders_status ON traders(status);
`;

/*
 * 订单行上的「保证金占用」。
 *
 * ## 为什么需要这一列
 *
 * 操作者在「当前委托 / 订单记录」里看的是**每一张单**，而"这笔操作动了多大本金"
 * 只有保证金那一列能回答。成交表算得出来（`quantity` / `entry_price` / `leverage`
 * 三列都在，见 `toTrade`），**订单表算不出来**：这张表既没有杠杆，也没有对应持仓的
 * 入场价；止损/止盈行上更没有成交价（条件单只有触发价）。前端拿不到就只能写 `0`
 * 或者硬编一个分母 —— 两者都是编数。
 *
 * ## 为什么存金额，而不是存 leverage 让读取方自己乘
 *
 * 存 leverage 就必须在读取时挑一个价格去乘，而保护单行上只有**触发价**：用它算出来的
 * 数与 `positions.margin_used` 不是同一个，"保证金"这一个口径就有了第二种算法。
 * 而写入时那个数是**现成的** —— 开仓/加仓路径上它就是马上要写进 `positions.margin_used`
 * 的同一个数（同一个 `marginOf()`），平仓/保护单路径上直接从持仓行取权威值。
 *
 * ## 为什么可空、且**不设 DEFAULT**
 *
 * `NULL` = 这一行算不出来（被拒的开仓单、没有对应持仓的单）。
 * `0` 会被前端读成"这笔没占保证金" —— 与"不知道"的结论完全相反，
 * 与 `M9_USAGE_DETAIL` 的 `cached_tokens` / `reasoning_tokens` 是同一条纪律：
 * 两种相反的含义不能共用同一个默认值。
 */
const M13_ORDER_MARGIN_USED = /* sql */ `
ALTER TABLE orders ADD COLUMN margin_used REAL;
`;

/*
 * 订单行上的「保证金模式」= 全仓 / 逐仓。
 *
 * ## 为什么挂在 orders 上
 *
 * 用户的原话是「订单记录里面显示：全仓\逐仓」—— 主语是**每一条订单**。而保证金模式
 * 是**逐标的的账户配置**：同一张持仓上挂出的入场单、保护单、平仓单处在同一个模式下。
 * 快照挂在订单行上，回答的才是"这张单当时是什么模式"；只放在 positions 上回答不了
 * 平掉之后的历史行（而订单记录里绝大多数行恰恰是那些）。
 *
 * ## 为什么可空、且**不设 DEFAULT**
 *
 * `NULL` = 这一行没有这个事实（迁移之前的历史行、或这台进程从未为该标的设成功过）。
 * 币安的默认值确实是全仓（官方明文 "All contracts and positions are defaulted to the
 * Cross Margin mode"），但"交易所的默认是 X"与"我们读到了 X"是两件事 ——
 * 给旧行补一个 `'cross'` 等于**替交易所宣布一个我们没验证过的事实**。
 *
 * 这与 `M9_USAGE_DETAIL` 的 `cached_tokens` / `reasoning_tokens`、以及
 * `M13_ORDER_MARGIN_USED` 是同一条纪律：**两种相反的含义不能共用同一个默认值**。
 * 界面据 `NULL` 显示 `—`。
 *
 * ## 存的机器码只有两个：`cross` / `isolated`
 *
 * 交易所 `positionRisk` 就是这么写的。而策略配置里那个 `riskControl.marginMode`
 * 写的是 **`crossed`**、写接口要的是 **`CROSSED`** —— 三种写法在
 * `repositories.ts` 的 `normalizeMarginMode()` 里收口。
 * ⚠️ **不要把 `crossed` 直接写进这一列**：那样同一个模式会有两个机器码，
 * 而 `'cross' === 'crossed'` 是 `false` —— 比较失败不抛错，只会静默读成"不知道"。
 */
const M14_ORDER_MARGIN_TYPE = /* sql */ `
ALTER TABLE orders ADD COLUMN margin_type TEXT;
`;

/*
 * 模型可以为**这一张**挂单指定耐心（`wait_minutes`）。
 *
 * ## 为什么需要它（2026-10-08，用户定的迭代方向）
 *
 * 用户问：「开单大多都是限价单，很多都是超时/超越预期价位，导致错失机会，
 * 模型自己知道吗？如果知道他会改吗？」——**它知道**：提示词每轮都告诉它
 * 成交率 40%、被撤的单子 60% 后来又被价格碰到。而它**改不动**，
 * 因为它只有 `limit` / `market` 两个选项，**没有表达"这一单我愿意多等"的地方**。
 *
 * 它在 `reasoning` 里写的"等回踩位"，被系统的自适应时限接管 ——
 * **一个已经做出的判断，缺一个出口。**
 *
 * 存这一列而不是建新表：`positions` 已经是"挂出去的单"的单一事实源
 * （`status='pending'`，见 `M11_PENDING_ENTRY`），加一列最省。
 */
const M15_PENDING_WAIT_MINUTES = /* sql */ `
ALTER TABLE positions ADD COLUMN wait_minutes REAL;
`;

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️⚠️ **`dryRun` 落库**（2026-10-13 实测安全事件）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 事故：测试机器人被服务重启**静默恢复成实盘**
 *
 * 用户明确要求"测试只能用模拟盘、必须 `dryRun: true`"。而我这样启动了 `#11`，
 * 它也确实以模拟盘跑着 —— **直到下一次部署重启服务**：
 *
 * ```
 *   resumePersisted(env.dryRun)   ← 用【一个进程级的开关】恢复【所有】机器人
 *   → env.dryRun 来自服务器 .env（DRY_RUN=false）
 *   → #11 被用 dryRun=false 恢复 → 实盘 🚨
 * ```
 *
 * 线上 `runtime_logs` 的决定性证据：
 * ```
 *   #11 [团队测试] 多智能体 → 「机器人已启动（**实盘**）」
 *   #10 赚大钱             → 「机器人已启动（实盘）」   ← 这个是对的
 * ```
 * 而 `#11` 当时 `orders=0`（全 skip）才没造成损失 —— **那是运气，不是保护**。
 *
 * ## 为什么 `dryRun` 之前"不该落库"（原来的理由，现在不成立了）
 *
 * `api/server.ts` 里写着：
 * > 「`dryRun` 是**运行时**的事实（它是启动参数、不落库），仓储层算不出来。」
 *
 * 那个理由在"**所有机器人用同一个开关**"时是自洽的 —— 进程级一个值就够。
 * 但 `#11` 这类**测试机器人**必须与实盘 `#10` **用不同的值**，
 * 于是"进程级单一开关"这个前提被打破了。
 *
 * ## 修法：`dry_run` 成为机器人自己的属性
 *
 * ```
 *   NULL  —— 从未被显式指定过 → 回落到 env.dryRun（既有机器人行为完全不变）
 *   0/1   —— 操作员启动时指定的值 → 重启后【按它恢复】
 * ```
 * ⚠️ 用 NULL 而不是默认 0：默认 0 会让**所有既有机器人**在迁移后
 * 被当成"显式指定了实盘"，那就等于把 env 的回落路径悄悄删掉了。
 *
 * ⚠️ 这是**安全修复**，不是便利性改动：它保证"操作员说要模拟盘，
 * 那它一直是模拟盘"，不会因为一次部署而变成用真钱。
 */
const M18_TRADER_DRY_RUN = /* sql */ `
ALTER TABLE traders ADD COLUMN dry_run INTEGER;
`;

/*
 * 模拟盘机器人**不再需要真实交易所账户**（用户 2026-10-27 需求）。
 *
 * ## 用户的原话
 *
 *   「创建模拟盘的时候，不应该只需要绑定钱包。还有，模拟盘不应该根据真实钱包的
 *    余额，而应该可以自定义模拟盘的余额。也就是说，无需真实账户就能开启模拟盘机器人。」
 *
 * ## 原先的两个约束造成的局面
 *
 *   exchange_account_id INTEGER NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT
 *
 *   · **NOT NULL** → 建模拟盘机器人时**必须**先绑一个真实交易所账户，
 *     而模拟盘根本不会向那个账户下单（`BinanceBroker` 的 dryRun 分支全程本地模拟）；
 *   · 于是"想先拿模拟盘试试"这件本该零门槛的事，被卡在"先去币安注册、拿密钥、
 *     填进系统"这一步 —— 而绝大多数人在那一步就放弃了。
 *
 * ## 为什么改可空是安全的
 *
 * 模拟盘的**持仓、下单、保护单**本来就全部走本地台账 + `BinanceBroker` 的模拟分支，
 * 唯一真正读交易所的地方是 `getAccountState()`（账户余额），而它现在可以由
 * 本地台账折算（见 `binance/paperWallet.ts` 与 `BinanceBroker.paperAccount`）。
 *
 * 实盘路径**一个字节都没变**：`exchangeAccountId` 为空的机器人在启动时会被明确
 * 拒绝（它没有凭据可用），见 `manager.connectionFor` 的校验。
 *
 * ## 为什么是 SET NULL 而不是 CASCADE
 *
 * 删掉一个交易所账户时不该连带删掉机器人 —— CASCADE 会删掉它的成交、持仓与
 * 决策记录，**而那是账本**。置空之后实盘机器人启动会给出明确错误，模拟盘机器人
 * 则完全不受影响（它本来就不需要那个账户）。
 *
 * ## 新增列 `paper_starting_balance`
 *
 * 操作员填的模拟盘起始余额。`0` = 没填（回落到 `initial_equity`，再回落到默认值）。
 *
 * ⚠️ 为什么不直接复用 `initial_equity`：后者的语义是"收益率的分母"，而它
 * **会在首次启动时被真实钱包余额覆盖**（`manager.ts` 里那段 `initialEquity <= 0`
 * 的回落逻辑）。两个语义不同的东西共用一个字段，就会出现"我填了 5000，
 * 启动后变成 12.34"这种没人能解释的现象。分开存，各自只做一件事。
 */
const M19_PAPER_TRADING = /* sql */ `
-- ---------------------------------------------------------------------------
-- 重建 traders 表：exchange_account_id 允许为空 + 新增模拟盘起始余额
--
-- ⚠️ 下面的列顺序必须与迁移前**逐字一致** —— INSERT ... SELECT 是按位置对应的。
-- 顺序取自 M18 之后的 PRAGMA table_info(traders)：
--   id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
--   initial_equity, status, last_cycle_at, last_cycle_number, last_error,
--   consecutive_failures, created_at, updated_at, agent_config_json, mode, dry_run
-- ---------------------------------------------------------------------------
CREATE TABLE traders_new (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  -- ⚠️ 本次唯一的实质改动：去掉 NOT NULL，RESTRICT 换成 SET NULL。
  exchange_account_id    INTEGER          REFERENCES exchange_accounts(id) ON DELETE SET NULL,
  ai_model_id            INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  strategy_id            INTEGER          REFERENCES strategies(id) ON DELETE SET NULL,
  cycle_interval_minutes INTEGER NOT NULL DEFAULT 15,
  initial_equity         REAL    NOT NULL DEFAULT 0,
  status                 TEXT    NOT NULL DEFAULT 'stopped',
  last_cycle_at          TEXT,
  last_cycle_number      INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  agent_config_json      TEXT,
  mode                   TEXT    NOT NULL DEFAULT 'strategy',
  dry_run                INTEGER,
  -- 新增列放最后，避免影响上面按位置对应的 INSERT ... SELECT。
  paper_starting_balance REAL    NOT NULL DEFAULT 0
);
INSERT INTO traders_new (
  id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
  initial_equity, status, last_cycle_at, last_cycle_number, last_error,
  consecutive_failures, created_at, updated_at, agent_config_json, mode, dry_run
)
SELECT
  id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
  initial_equity, status, last_cycle_at, last_cycle_number, last_error,
  consecutive_failures, created_at, updated_at, agent_config_json, mode, dry_run
FROM traders;
DROP TABLE traders;
ALTER TABLE traders_new RENAME TO traders;
CREATE INDEX idx_traders_status ON traders(status);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: M1_INITIAL },
  { version: 2, name: 'trade-accounting', sql: M2_TRADE_ACCOUNTING },
  { version: 3, name: 'session-revocation', sql: M3_SESSION_REVOCATION },
  { version: 4, name: 'attributed-equity', sql: M4_ATTRIBUTED_EQUITY },
  { version: 5, name: 'ai-agent-memory', sql: M5_AI_AGENT_MEMORY },
  { version: 6, name: 'agent-config', sql: M6_AGENT_CONFIG },
  { version: 7, name: 'trader-mode', sql: M7_TRADER_MODE },
  { version: 8, name: 'partial-close', sql: M8_PARTIAL_CLOSE },
  { version: 9, name: 'usage-detail', sql: M9_USAGE_DETAIL },
  { version: 10, name: 'input-token-limit', sql: M10_INPUT_TOKEN_LIMIT },
  { version: 11, name: 'pending-entry', sql: M11_PENDING_ENTRY },
  {
    version: 12,
    name: 'strategy-optional',
    sql: M12_STRATEGY_OPTIONAL,
    /* 重建被引用的表 —— 必须在事务外关外键，否则 DROP 会级联删掉子表数据。 */
    detachForeignKeys: true,
  },
  { version: 13, name: 'order-margin-used', sql: M13_ORDER_MARGIN_USED },
  { version: 14, name: 'order-margin-type', sql: M14_ORDER_MARGIN_TYPE },
  { version: 15, name: 'pending-wait-minutes', sql: M15_PENDING_WAIT_MINUTES },
  { version: 16, name: 'trade-intel-attribution', sql: M16_TRADE_INTEL_ATTRIBUTION },
  { version: 17, name: 'position-intel-attribution', sql: M17_POSITION_INTEL_ATTRIBUTION },
  { version: 18, name: 'trader-dry-run', sql: M18_TRADER_DRY_RUN },
  {
    version: 19,
    name: 'paper-trading',
    sql: M19_PAPER_TRADING,
    /* 重建被引用的表 —— 必须在事务外关外键，否则 DROP 会级联删掉子表数据。 */
    detachForeignKeys: true,
  },
];
