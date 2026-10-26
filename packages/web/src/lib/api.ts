/**
 * Thin typed client for the trading backend.
 *
 * Everything lives under `/api`; in development Vite proxies that prefix to the
 * Fastify server (see `vite.config.ts`), in production the bundle is served by
 * the same process so relative URLs just work.
 *
 * The client deliberately knows nothing about React — stores and components
 * consume it, which keeps polling/refresh logic out of the render tree.
 */
import type {
  AgentRunKind,
  AgentRunOutcome,
  AiModelConfig,
  Decision,
  DecisionRecord,
  EquitySnapshot,
  ExecutionLogEntry,
  ExchangeAccount,
  Kline,
  LlmProviderDescriptor,
  OrderRecord,
  PositionView,
  CircuitBreakerReading,
  StrategyConfig,
  StrategyPreset,
  StrategyRecord,
  TradeRecord,
  Trader,
  TraderMode,
  TraderStats,
  User,
  WakeTrigger,
} from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 智能体审计的响应（三张表合成一次返回）。
 *
 * ## 为什么一次返回三张表
 *
 * 界面上那一块面板要**同时**显示"这一轮做了什么 + 学到了什么 + 之前试过什么" ——
 * 分三个请求会让面板出现三次加载闪烁，而且它们天然属于同一件事（这个智能体在干什么）。
 *
 * ⚠️ 字段用**可选**（`?`）而不是必填：这三张表是后来才加进前端的，
 * 老服务端（或某张表为空）不该让整个面板崩掉 —— 与决策看板那个
 * "一条坏数据白屏"的教训一致。
 */
/**
 * 一个**运行期开关**的完整状态（`/traders/:id/control`）。
 *
 * `source` 是重点：它回答"这个值是谁定的"。
 */
/**
 * 一个 **JEV 模式选项**（`/traders/:id/jev-options`）。
 *
 * 与 `ControlSwitch` 的区别：那个是**布尔开关**（整个团队共享），
 * 这个有枚举/数字类型，且只影响 `mode === 'jev'` 的机器人。
 */
export interface JevOption {
  key: string;
  label: string;
  /** 一句话说明「它是什么、改了会怎样」—— 用户不懂 JEV，靠它做决定。 */
  why: string;
  kind: 'boolean' | 'enum' | 'number';
  options?: Array<{ value: string; label: string }>;
  range?: { min: number; max: number; step: number; unit: string };
  value: string;
  source: 'ui' | 'default';
  /** 改它要不要重启机器人才生效（界面上要如实标注）。 */
  requiresRestart: boolean;
}

export interface ControlSwitch {
  key: string;
  /** 给人看的标题（服务端 `RUNTIME_SWITCHES` 里定义，前端不重复一份）。 */
  label: string;
  /** **关掉之后会发生什么** —— 用户关心的是后果，不是实现。 */
  effect: string;
  on: boolean;
  source: 'ui' | 'env' | 'default';
}

export interface AgentAudit {
  /** 每次角色运行（字段与 `AgentRunRow` 一一对应）。 */
  runs?: Array<{
    id: number;
    /*
     * ⚠️ **三个字段都用 `@aq/shared` 的联合类型收窄，而不是裸 `string`**
     * （2026-10-17 · t53，队长裁定 3）。
     *
     * 理由：界面要**穷举**这三个码域并给出中文标签，而"裸 string"既不能穷举、
     * 也不能测试（`agentRunLabels.test.ts` 的穷尽断言必须有一个有限的取值集合
     * 可遍历）。收窄之后，标签表的 `Record<Union, string>` 才真的有约束力。
     *
     * ⚠️ **服务端仍然写 `string`**（`orchestrator.ts` 的 `recordRun` 端口签名），
     * 那半边的收口归另一个任务。所以这里的收窄是"**前端消费端的契约**"，
     * 不是"服务端保证只会发这几个值" —— 因此**运行时兜底（`?? 原码`）必须保留**：
     * 真收到联合之外的码时，界面显示原码而不是崩掉。
     */
    kind: AgentRunKind;
    trigger: WakeTrigger;
    intensity: string;
    steps: number;
    /** 这一步的结果分类。 */
    outcome: AgentRunOutcome;
    /** 给人看的说明。 */
    detail: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    createdAt: string;
  }>;
  /** 参数实验：改了什么 + 真实结果。**这是"自我迭代"的审计线索。** */
  experiments?: Array<{
    id: number;
    trigger: string;
    /** AI 给出的改参理由。 */
    reason: string;
    /** 改了什么（JSON 字符串）。 */
    patchJson: string;
    /** 实际生效的（可能被结构不变量夹过）。 */
    appliedJson: string;
    /** 回填前是 `null`。 */
    outcomeTrades: number | null;
    outcomeNetPnl: number | null;
    outcomeEvaluatedAt: string | null;
    createdAt: string;
  }>;
  /** 教训记忆（一笔平仓一条）。 */
  memory?: Array<{
    id: number;
    symbol: string;
    closeReason: string;
    netPnl: number;
    /** 复盘出的教训。 */
    lesson: string;
    createdAt: string;
  }>;
  pendingExperiments?: number;
  runCount?: number;
}
const TOKEN_KEY = 'aq.token';
const USER_KEY = 'aq.user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — the session then simply does not survive a reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

/** Raised for any non-2xx response so callers can show `error.message`. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * 服务端用来区分「**本次请求的口令填错了**」与「**你的会话结束了**」的机器可读码。
 *
 * ## 为什么需要它（外部 issue #148）
 *
 * 两件完全不同的事都用 401 表达：
 *
 * ```
 * auth.ts:169/174/178   需要登录 / 令牌过期 / 凭据变更   → 401   ← "会话结束了"
 * server.ts:872         改密码时"当前密码不正确"         → 401   ← "这次口令填错了"
 * ```
 *
 * 401 在 HTTP 语义上两者都沾边（都是"未通过认证"），所以**前端不能只靠状态码区分**。
 * 而前端原来的行为是"401 就登出" —— 于是在设置页把当前密码输错一次，
 * 就被清掉 token 踢到登录页。
 *
 * ## 为什么把判据放在服务端
 *
 * 另一个候选方案是"前端给 `request()` 加 `skipUnauthorized`，调用点带上"。
 * 那需要**每个**可能填错口令的调用点都记得带 —— 将来新增的调用点会漏
 *（本仓库吃过多次"两处各写一份、改动只覆盖一处"的亏）。
 *
 * 放在服务端则让前端只需"认码"：新增调用点自动正确，因为服务端会一直带着它。
 */
export const INVALID_CURRENT_PASSWORD = 'invalid_current_password';

/**
 * 这次 401 是"口令填错"而不是"会话失效"吗？
 *
 * ⚠️ **只认精确的码，不做模糊匹配。** 按错误文案里有没有"密码"两个字去猜会很危险：
 * 会话失效的提示里也可能出现"密码"字样（例如"凭据已变更，请重新登录"），
 * 那会让**真正需要登出**的情形被漏掉 —— 页面卡在一个永远失败的循环里。
 */
export function isInvalidCurrentPassword(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { code?: unknown }).code === INVALID_CURRENT_PASSWORD;
}

/**
 * 这次失败是否应当触发登出（清 token + 跳登录页）。
 *
 * ## 为什么抽成函数
 *
 * 缺陷就发生在原来那一行 `if (response.status === 401 && !anonymous) onUnauthorized?.()` 上。
 * 抽出来之后"该不该登出"这件事**可以被单测** ——
 * 而本仓库 web 侧没有 jsdom/RTL，`request()` 本身（依赖 `fetch` + `localStorage`）测不了。
 *
 * @param status     HTTP 状态码
 * @param payload    已解析的响应体（可能是 `undefined` / 字符串）
 * @param anonymous  这个请求是否匿名发出（登录接口自己回 401 时**不能**触发登出 ——
 *                   否则"登录失败"会表现成"被登出"）
 */
export function shouldSignOut(status: number, payload: unknown, anonymous = false): boolean {
  if (status !== 401) return false;
  if (anonymous) return false;
  /* 口令填错不是会话问题 —— 留在原地把错误显示在表单上。 */
  if (isInvalidCurrentPassword(payload)) return false;
  /*
   * 其余 401 一律按"会话失效"处理（**包括没有响应体的情况**）——
   * 保守方向必须偏向"登出"：令牌真的失效时若还留在页面上，
   * 每个请求都会失败，用户看不到任何可行动的提示。
   */
  return true;
}

/** Fired when the server rejects our token, so the shell can bounce to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * 单次 HTTP 请求的最长等待（12 秒）。
 *
 * 依据：最慢的接口（`/positions`，要问交易所）实测 P99 在 2-3 秒。
 * 12 秒足够宽松，而不会让一次卡住的请求长时间不结束 ——
 * 那正是"页面数据不更新、然后突然闪一条错误"的成因之一。
 */
const REQUEST_TIMEOUT_MS = 12_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Skip the Authorization header (login/register/health). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, anonymous = false, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  /*
   * ⚠️ **必须有超时**（2026-10-18 补）。
   *
   * 原来这里直接 `fetch(...)` 不设超时 —— 一个卡住的请求会**一直挂着**，
   * 而轮询的下一次又发出去。表现上就是"页面数据不更新，然后突然闪一条错误"：
   * 那次挂住的请求最终超时/断开时才报错，而那时界面可能已经好了。
   *
   * `AbortSignal.timeout` 让失败**及时且确定**：最多等 12 秒。
   * 配合 `hooks.ts` 的"单次失败静默"，抖动就不会再闪成红条。
   *
   * ⚠️ 12 秒的依据：这些接口里最慢的是 `/positions`（要问交易所），
   * 实测 P99 在 2-3 秒；12 秒足够宽松，而不会让人等太久。
   */
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const mergedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(withQuery(`/api${path}`, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: mergedSignal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    /*
     * ⚠️ **不要把端口号、内部实现写进给用户看的文案**（2026-10-18 修）。
     *
     * 原来这里写的是：
     * ```
     *   '无法连接后端。端口 27137 上的服务是否在运行？'
     * ```
     * 两个问题：
     * ① `27137` 是**开发端口**，线上不是它 —— 这句话在线上是错的，
     *    会让操作员去查一个不存在的东西；
     * ② 操作员不该关心端口号，他要知道的是"现在能不能看数、要不要等"。
     *
     * 这句会被 `hooks.ts` 的 `humanErrorText()` 识别并翻译成
     * 「暂时连不上服务（网络或服务正在重启）—— 页面会自动重试」。
     * 这里保留一句**技术上准确、但不含站点细节**的描述。
     */
    throw new ApiError(0, '无法连接后端', null);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  /*
   * ── 滑动续期 ─────────────────────────────────────────────────────────
   *
   * 服务端在令牌剩余不足一半寿命时，会把一张同身份的新令牌放进这个响应头
   * （见 `auth.ts` 的 `refreshIfStale`）。存回去，下次请求就用新的 ——
   * 于是**只要页面还在轮询，登录状态就不会掉**。
   *
   * 放在 `response.ok` 判断**之前**：续期与这次请求成功与否无关，
   * 一个 500 的响应也可能带着新令牌（它同样是"经过校验的请求"）。
   * 漏掉它，一次后端抖动就会顺带把会话寿命白扔一半。
   */
  const refreshed = response.headers.get('x-refreshed-token');
  if (refreshed && !anonymous) setToken(refreshed);

  if (!response.ok) {
    /*
     * ⚠️ **不能只看状态码**（外部 issue #148）：`shouldSignOut()` 会排除
     * "当前密码填错"这种**本次请求**的 401 —— 否则在设置页输错一次密码就被登出。
     * 判据与理由都写在那个函数上。
     */
    if (shouldSignOut(response.status, payload, anonymous)) onUnauthorized?.();
    const message =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? `请求失败：HTTP ${response.status}`;
    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

/* -------------------------------------------------------------------------- */
/*  Response shapes that go beyond the shared entities                         */
/* -------------------------------------------------------------------------- */

export interface Health {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  hasOwner: boolean;
  dryRun: boolean;
  tradingDisabled: boolean;
  environment: string;
  db: string;
  /**
   * **正在运行、但已经卡住的机器人**（2026-10-17 · t99 追加）。
   *
   * ## 为什么必须把它带到界面上
   *
   * `ok:false` 与这个数组**一直都在服务端算**（`api/server.ts` 的
   * `evaluateTraderHealth`，判据 = `周期 × 2` 与 `300 秒` 起步宽限取较大者），
   * 而它原来的消费者只有容器编排器 —— 于是 `#10`（`dry_run=0`，真实资金）
   * **停摆 5.5 小时**，队长是在做"部署后回读"时偶然发现的。
   *
   * ⇒ 这是 `t28` 那条「不存在任何主动告警机制」的现场印证：
   * **信号在没人看的地方**。字段补上之后，控制台顶部的常驻横幅才有数据可渲染。
   *
   * ⚠️ **可选**（`?`）而不是必填：老服务端（或某次部署的中间态）不发这个字段时，
   * 界面应当"什么都不显示"，而不是崩掉或误报。
   */
  staleTraders?: Array<{
    id: number;
    name: string;
    /** 距上一轮结束的毫秒数（从未跑完过一轮时是"已运行时长"）。 */
    staleForMs: number | null;
    /** 在跑但还没有任何一轮的完成记录（首轮仍在跑）。 */
    awaitingFirstCycle: boolean;
    /**
     * 这个机器人**这一次**用的停摆阈值（毫秒，2026-10-17 · t114）。
     *
     * 阈值不再是固定的"30 分钟"：它是 `max(周期 × 2, 300 秒, 实测轮次 P95 × 2)`，
     * 所以**因机器人而异**。横幅把它显示出来，读者才不用拿旧数字去对。
     */
    thresholdMs?: number;
    /**
     * 一轮**正在进行中**（存在足够新的 pending 行）。
     * ⚠️ 这类机器人**不会出现在 `staleTraders` 里** —— 字段只为将来展示"在跑"用。
     */
    cycleInProgress?: boolean;
  }>;
}

export interface AuthResult {
  token: string;
  user: User;
}

export interface Catalog {
  providers: LlmProviderDescriptor[];
  exchanges: Array<{ id: string; label: string; market: string; available: boolean }>;
  presets: StrategyPreset[];
  defaultStrategy: StrategyConfig;
  /**
   * 创建机器人时预选哪个模型。
   *
   * 原来是"列表第一个"，而列表按 id 排 —— 于是一个**已失效**的模型只要 id 最小
   * 就会成为默认，每次创建都要手动改回来。取不到时为 null，调用方回落到第一个。
   */
  defaultAiModelId: number | null;
}

/**
 * 部署版本 —— 线上跑的是哪一次构建。
 *
 * 服务器上没有 `.git`（部署是打包上传），所以这些值由构建机写进 `build-info.json`
 * 随包传过去。`null` 表示**这次部署没有写出版本信息**（部署脚本早于该功能，
 * 或用了别的部署方式）—— 界面必须把它显示成"未知"，不能回落到一个默认真值。
 */
export interface BuildInfo {
  commit: string;
  commitShort: string;
  branch: string;
  subject: string;
  committedAt: string;
  deployedAt: string;
  /** 打包时工作区有未提交改动 —— 服务器跑的东西不等于这个提交。 */
  dirty: boolean;
  repository: string;
}

export type UpdateState = 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'unknown';

/** `GET /api/system/update` —— 与远端仓库比对的结果（服务端缓存 10 分钟）。 */
export interface UpdateCheck {
  state: UpdateState;
  message: string;
  checkedAt: string;
  repository: string | null;
  branch: string | null;
  localCommit: string | null;
  latestCommit: string | null;
  latestCommitShort: string | null;
  latestSubject: string | null;
  latestCommittedAt: string | null;
  behindBy: number | null;
  /**
   * **GitHub 上最新 release 的 tag**（`v0.1.32`）—— "产品版本"的权威来源。
   *
   * 取不到（没发过 release / 网络不通）时为 `null`；那时界面回落到本地
   * `package.json` 的版本并**说明它是本地的**。见 `buildInfo.ts` 的实现注释：
   * 原来这一格读 `package.json`，而它从 `0.1.0` 起就没更新过。
   */
  latestRelease: string | null;
}

export interface SystemStatus {
  dryRun: boolean;
  tradingDisabled: boolean;
  environment: string;
  environmentLabel: string;
  clockOffsetMs: number;
  weightUsed: number;
  weightLimit: number;
  tradableSymbols: number;
  runningTraders: number[];
  /** 部署版本。`null` = 这次部署没写出版本信息。 */
  build: BuildInfo | null;
  /** 产品版本号（`package.json`）。与 `build` 是两件事。 */
  version: string;
}

export interface LogLine {
  id: number;
  traderId: number | null;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
}

export interface TraderRow extends Trader {
  isRunning: boolean;
  /*
   * ⚠️ 这里**曾经**有一个 `agentPaused: { at, reason } | null` 字段，已随
   * `2fb0881`「彻底剔除 pause/resume —— 全自动托管里暂停就是每轮的 skip」删掉。
   *
   * 它原先的用途是让界面显示"AI 已主动停手 + 恢复按钮"，对应 2026-10-04 的一次
   * 用户投诉：模型停了手，界面却同时显示「开多」和「本轮不开新仓」，自相矛盾。
   *
   * 今天**没有任何机制**支撑它：没有 `pause_trading` 工具、没有停手开关、
   * 服务端也不发这个字段。真正让机器人不开新仓的是**熔断**与 `safe_mode`
   * （见 `TraderPage` 的熔断提示），那两者都有现成的展示路径。
   *
   * 留这段是防止下一个人再"补"一个停手开关 —— 那个缺口是已做过的决定，不是遗漏。
   */
  /**
   * 最近一次**账目校验**的结论（交易循环每轮自己算的）。
   *
   * 用户 2026-10-07 报的「起始 100.05，现在 100.84，为什么显示 +$1.29」——
   * `platformNet` 是账本（可能错），`exchangeNet` 是交易所流水（真实），
   * 两者之差就是 `gap`。界面对着它显示，而不是拿账本值冒充事实。
   *
   * ⚠️ **`incomeReadFailed` 是 2026-10-14 补上的** —— 服务端
   * （`server.ts` 的 `readForeignActivityFor`）读不到交易所收入流水时
   * **不返回 `exchangeNet`**，前端类型原来漏了这个字段，于是 web 侧
   * 无法区分"真的没差额"和"这次没读到流水"。
   *
   * 那个区分至关重要：
   * ```
   *   exchangeNet 是【残缺读数】（少了几段流水）→ 拿它校准比坏账本更离谱
   *   所以判据必须排除 incomeReadFailed 的情形
   * ```
   * 见 `fleetTotals.ts` 的 `isLedgerSuspect()`。
   */
  ledger?: {
    platformNet: number;
    exchangeNet: number;
    gap: number;
    checkedAt: string;
    /** 读交易所收入流水失败时为 `true` —— 此时 `exchangeNet` 不可信。 */
    incomeReadFailed?: boolean;
  } | null;
  /**
   * **下一轮决策的预定触发时刻**（epoch 毫秒），没有排程时为 null。
   *
   * 用户 2026-10-07：「能在这里加入一个倒计时吗？让我明显知道下一轮决策剩余周期」。
   *
   * 由服务端给出（`AutoTrader.nextCycleAt`），它记的是**定时器真正被排到的那一刻**，
   * 已经把"模型自己要求的间隔"和"失败短重试"都算进去了 ——
   * **界面不要自己推算**，那会显示一个骗人的倒计时。
   */
  nextCycleAt?: number | null;
}

/**
 * A live balance reading from the exchange.
 *
 * `equity` is the margin balance (wallet + unrealised PnL) — the number the bot
 * actually trades with; `walletBalance` is the settled balance the operator
 * sees as 钱包余额 on the exchange's own app.
 */
export interface ExchangeBalance {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  openOrderMargin: number;
  /** Margin asset the figures are denominated in — `USDT` in practice. */
  asset: string;
  /** ISO timestamp of the exchange read. */
  readAt: string;
}

/**
 * 凭据的**对外**形状。
 *
 * `Omit<…, 'apiKey'>` 是刻意的：服务端只发掩码，不发原始 API Key
 * （见 `server.ts` 的 `publicAccount()`）。类型里若还留着 `apiKey`，
 * 等于在鼓励下一个人写 `row.apiKey` —— 而那个字段运行时是 `undefined`，
 * TypeScript 又不会拦你。去掉它，越界访问就会在编译期报错。
 */
export interface ExchangeAccountRow extends Omit<ExchangeAccount, 'apiKey'> {
  apiKeyMasked: string;
  /** `null` when the read failed — see `balanceError`. */
  balance: ExchangeBalance | null;
  balanceError: string | null;
}

/**
 * `GET /exchange-accounts/:id/balance` — note it answers **HTTP 200 even on
 * failure**, so callers must branch on `ok`, never on the status code.
 */
export type ExchangeBalanceResult =
  | { ok: true; balance: ExchangeBalance; cached: boolean }
  | { ok: false; error: string };

/** Where a new trader's starting equity came from. */
export type EquitySource = 'exchange' | 'manual' | 'unavailable';

/**
 * `POST /traders/:id/reconcile`.
 *
 * Rebuilds the ledger from the exchange's own fill history. Places no orders and
 * is deliberately allowed while the bot is stopped — that is exactly when the
 * books need correcting. Like the balance endpoint it can answer **HTTP 400
 * with `ok: false`**, so callers must branch on `ok`.
 *
 * ## ⚠️ `corrected` 是**生效**笔数，不是"尝试"笔数（2026-10-17 · 后端 `6a39c46`）
 *
 * 那一次改动把 `corrected` 的语义从"尝试修正几次"改成"**真的改成了几笔**"，
 * 并新增 `correctedAttempted` / `correctedKept`。三者满足
 * `correctedAttempted === corrected + correctedKept`（后端 `autoTrader.ts` 写明）。
 *
 * **前端类型当时没跟上**，于是 `actions.ts` 的 `reconcileSummary()` 看不到
 * "有 3 笔被保留"这个事实：`corrected` 为 0 ⇒ 它落到兜底句，对操作员说
 * 「账本与交易所一致，无需补录或修正」——而**后端同一场景说的是
 * 「尝试修正 3 笔，一笔都没真的生效」**。**两句相反**，属于本批反复出现的
 * 「报了一个没有发生的动作」那一族里更严重的一种：它报了相反的事。
 *
 * ⚠️ 所以这两个字段在这里是**必填**（不是可选）：它们是"能不能说'一致'"的
 * **必要输入**。做成可选会让下一个调用点顺手漏传、于是又退回"说反话"——
 * 而那正是本条缺陷的成因。服务端一直在发它们（路由是 `{ ok: true, ...result }`
 * 透传，见 `api/server.ts` 的 `/reconcile`）。
 */
export type ReconcileResult =
  | {
      ok: true;
      /** 补录进来的成交笔数。 */
      recovered: number;
      /** **生效**的修正笔数（不含被保留的那些）。 */
      corrected: number;
      /**
       * **尝试**修正的笔数 = `corrected + correctedKept`。
       *
       * 只报 `corrected` 时，"撞上已有行（于是必然尝试过）却一笔都没改成"
       * 会与"什么都没发生"长得一模一样 —— 那正是本条缺陷的形状。
       */
      correctedAttempted: number;
      /**
       * **因"重建腿边界存疑"而保留本地口径**的笔数（判不出来，不是失败）。
       *
       * ⚠️ 它 > 0 时**绝不能说"账本与交易所一致"** —— 差异还在，只是系统
       * 不敢擅自改。后端为此专门写了一条 warn（「一笔都没真的生效 … 不要当成
       * 已经修好了」）。
       */
      correctedKept: number;
      /** 资金费（金额，不是笔数）。 */
      funding: number;
    }
  | { ok: false; error: string };

export interface AiModelRow extends AiModelConfig {
  apiKeyMasked: string;
  hasKey: boolean;
  /**
   * 这个模型**最近一次调用**的结果（服务端记在 `settings` 里）。
   *
   * `null` = 还没调用过。它存在的理由：网关连着回「余额不足」时，
   * 界面上原本一个字都没有（见服务端 `LlmHealth` 的说明）。
   */
  health?: { ok: boolean; at: string; latencyMs?: number; error?: string } | null;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  /**
   * Display severity. A check can be "fine, but confirm this" — the
   * withdrawal-permission notice on a sub-account key is the motivating case —
   * which `ok: boolean` alone cannot express. Optional so an older server
   * payload still renders.
   */
  severity?: 'ok' | 'warn' | 'error';
}

export interface StartResult {
  ok: boolean;
  preflight: PreflightCheck[];
  error?: string;
}

export interface ExchangeTestResult {
  ok: boolean;
  checks: PreflightCheck[];
  error?: string;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  modelEcho?: string;
}

/** One entry returned by `POST /ai-models/discover`. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  /** Context window, when the provider reports one. */
  contextLength?: number;
  /** `false` means "built-in suggestion", not a live result. */
  discovered: boolean;
}

export interface DiscoverModelsResult {
  ok: boolean;
  models: DiscoveredModel[];
  source: 'live' | 'fallback';
  message: string;
}

/** One row of a strategy health check stage. */
export interface CheckStage {
  name: string;
  ok: boolean;
  detail: string;
  /** Wall-clock cost of this stage in milliseconds. */
  ms: number;
}

export interface StrategyCheckSample {
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  cotTrace: string;
  decisions: Decision[];
  rejected: Array<{ symbol: string; action: string; reason: string }>;
  approved: Decision[];
  riskRejected: Array<{ action: string; symbol: string; reason: string }>;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  /** Simulated account the review ran against — never a real order. */
  simulatedEquity: number;
}

export interface StrategyCheckResult {
  ok: boolean;
  verdict: string;
  stages: CheckStage[];
  sample: StrategyCheckSample | null;
  strategyName?: string;
  modelLabel?: string;
  model?: string;
}

export interface MarketSymbol {
  symbol: string;
  baseAsset: string;
  price: number;
  changePercent24h: number;
  quoteVolume24h: number;
  minNotional: number;
}

export interface ExchangeAccountInput {
  exchange: string;
  label: string;
  apiKey: string;
  apiSecret?: string;
  testnet: boolean;
  canTrade: boolean;
}

/**
 * Model payload.
 *
 * The inference knobs are optional on the wire: omitting one makes the server
 * fall back to the provider's own default, which is exactly what the collapsed
 * "advanced" disclosure in the add-model dialog relies on.
 */
export interface AiModelInput {
  provider: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /*
   * ⚠️ **不再有 temperature / maxTokens / timeoutSeconds / maxRetries。**
   *
   * 它们完全由服务端按厂商决定（见 `AiModelInputSchema`），控制台上的
   * 「高级设置」面板也已删除。**契约里继续留着它们，会让人以为传了有用。**
   */
}

export interface StrategyInput {
  name: string;
  description: string;
  presetId: string | null;
  config: StrategyConfig;
}

export interface TraderInput {
  name: string;
  /**
   * 绑定的交易所账户 —— **`null` = 纯模拟盘机器人**（用户 2026-10-27 需求）。
   *
   * 模拟盘不下真实订单、余额由本地台账折算（起始余额来自 `paperStartingBalance`），
   * 所以它**不需要**任何真实交易所账户。原先这里是 `number`，于是前端根本
   * 表达不出"我没有账户"这件事。
   */
  exchangeAccountId: number | null;
  aiModelId: number;
  /**
   * 这只机器人的策略；**AI 托管时必须传 `null`**。
   *
   * ## ⚠️ 这里曾经与「已知事实」相反（2026-10-03 修）
   *
   * 原来是 `strategyId: number`，下面 `mode` 的注释还写着**解耦之前**的说法：
   * 「`ai_managed` 时 `strategyId` 仍然要传（**服务端是 NOT NULL**），但不起作用」。
   *
   * **那句话早就过时了。** `d338b35`「智能托管与策略彻底解耦」把服务端的
   * `traders.strategy_id` 改成可空（迁移后 `ON DELETE SET NULL`），并在创建时
   * **主动拒绝**带策略的 AI 托管请求：
   *
   *   if (mode === 'ai_managed' && requestedStrategyId !== null)
   *     throw new Error('智能托管模式不引用任何策略 —— 请不要为它选择策略。');
   *
   * 而前端**一直在传数字**（下拉框里那个 `#9`）—— 于是 **AI 托管模式下创建机器人
   * 必定失败**，错误文字就是上面那句。用户 2026-10-03 撞上的正是它：
   * 他现有的机器人是解耦**之前**建的，而那是他第一次用界面创建 AI 托管机器人。
   *
   * 类型放宽成可空，**提交处按 `mode` 决定传什么**（见 `TraderModals.tsx` 的 `submit`）。
   */
  strategyId: number | null;
  cycleIntervalMinutes: number;
  /**
   * Optional on purpose: omitting it (or sending 0) makes the server read the
   * real wallet balance from the configured exchange. Only send it when the
   * operator explicitly chose to type the baseline themselves.
   */
  initialEquity?: number;
  /**
   * **模拟盘起始余额**（用户 2026-10-27 需求）。只有纯模拟盘机器人（
   * `exchangeAccountId === null`）会用它 —— 它是本地钱包的本金。
   *
   * 与 `initialEquity` **不是一回事**：后者是"收益率的分母"且会在首次启动时
   * 被真实钱包余额覆盖，而这个是模拟账户里有多少钱、永不被覆盖。
   */
  paperStartingBalance?: number;
  /**
   * 运行模式。
   *
   * `'ai_managed'` 时参数由 AI 智能体自己设定并持续调整，**策略参数被彻底忽略** ——
   * 此时 `strategyId` 必须传 `null`（见上面那条字段说明：服务端会拒绝带策略的请求）。
   * `'strategy'` 时 `strategyId` 必须是一个真实存在的策略 id。
   */
  mode?: TraderMode;
}

/* -------------------------------------------------------------------------- */
/*  Endpoint surface                                                           */
/* -------------------------------------------------------------------------- */

export const api = {
  /* --- auth --- */
  health: () => request<Health>('/health', { anonymous: true }),

  login: (username: string, password: string) =>
    request<AuthResult>('/auth/login', { method: 'POST', body: { username, password }, anonymous: true }),

  me: (signal?: AbortSignal) => request<{ user: User }>('/auth/me', { signal }),

  /**
   * 修改用户名与/或密码。
   *
   * 必须带上当前密码：只凭会话令牌就允许改凭据，意味着任何一次令牌泄露
   * 都能被升级成永久接管。
   */
  updateAccount: (input: { currentPassword: string; username?: string; newPassword?: string }) =>
    request<{ ok: boolean; token: string; user: User }>('/auth/account', {
      method: 'PATCH',
      body: input,
    }),

  /* --- catalogues + system --- */
  catalog: (signal?: AbortSignal) => request<Catalog>('/catalog', { signal }),
  system: (signal?: AbortSignal) => request<SystemStatus>('/system', { signal }),
  /**
   * 与远端仓库比对部署版本。
   *
   * 单独一次请求，因为它**要出网**（服务端打 GitHub，8 秒超时）—— 不能让它拖住
   * 整页的加载。服务端缓存 10 分钟，所以重复打开这一页不会重复打 GitHub。
   */
  updateCheck: (signal?: AbortSignal) => request<UpdateCheck>('/system/update', { signal }),
  logs: (limit = 200, signal?: AbortSignal) =>
    request<{ logs: LogLine[] }>('/logs', { query: { limit }, signal }),

  /* --- exchange accounts --- */
  exchangeAccounts: (signal?: AbortSignal) =>
    request<ExchangeAccountRow[]>('/exchange-accounts', { signal }),
  /**
   * Live balance for one credential. `refresh` bypasses the 20-second
   * server-side cache — an operator pressing refresh is asking for "now".
   */
  exchangeBalance: (id: number, refresh = false, signal?: AbortSignal) =>
    request<ExchangeBalanceResult>(`/exchange-accounts/${id}/balance`, {
      query: { refresh: refresh ? 1 : undefined },
      signal,
    }),
  /** Force a fresh read for several credentials at once. */
  refreshExchangeBalances: (ids: number[]) =>
    Promise.all(ids.map(async (id) => [id, await request<ExchangeBalanceResult>(`/exchange-accounts/${id}/balance`, { query: { refresh: 1 } })] as const)),
  createExchangeAccount: (input: ExchangeAccountInput) =>
    request<ExchangeAccountRow>('/exchange-accounts', { method: 'POST', body: input }),
  updateExchangeAccount: (id: number, input: Partial<ExchangeAccountInput>) =>
    request<{ ok: boolean }>(`/exchange-accounts/${id}`, { method: 'PATCH', body: input }),
  deleteExchangeAccount: (id: number) =>
    request<{ ok: boolean }>(`/exchange-accounts/${id}`, { method: 'DELETE' }),
  testExchangeAccount: (id: number) =>
    request<ExchangeTestResult>(`/exchange-accounts/${id}/test`, { method: 'POST', body: {} }),
  /** Probe credentials that have not been saved yet. */
  testExchangeDraft: (input: ExchangeAccountInput) =>
    request<ExchangeTestResult>('/exchange-accounts/test-draft', { method: 'POST', body: input }),

  /* --- AI models --- */
  aiModels: (signal?: AbortSignal) => request<AiModelRow[]>('/ai-models', { signal }),
  createAiModel: (input: AiModelInput) => request<AiModelConfig>('/ai-models', { method: 'POST', body: input }),
  updateAiModel: (id: number, input: Partial<AiModelInput>) =>
    request<{ ok: boolean }>(`/ai-models/${id}`, { method: 'PATCH', body: input }),
  deleteAiModel: (id: number) => request<{ ok: boolean }>(`/ai-models/${id}`, { method: 'DELETE' }),
  /**
   * 指定「新建机器人时预选哪个模型」。
   *
   * 服务端一直在读 `settings.default_ai_model_id` 并把结果交给
   * `catalog.defaultAiModelId`（创建机器人时用它预选），**但此前没有任何地方写它** ——
   * 于是"取不到就回落到列表第一个"成了唯一会发生的行为。
   */
  setDefaultAiModel: (id: number) =>
    request<{ ok: boolean; defaultAiModelId: number }>(`/ai-models/${id}/set-default`, {
      method: 'POST',
      body: {},
    }),
  testAiModel: (id: number) => request<ModelTestResult>(`/ai-models/${id}/test`, { method: 'POST', body: {} }),
  /**
   * Ask the provider which models this key can use.
   *
   * `modelId` 是"用这条记录已存储的密钥"的唯一表达方式：编辑已有模型时界面刻意不回显
   * 明文密钥、输入框留空，只发 `apiKey: ''` 会被服务端当成"没提供密钥"而直接失败。
   * 用户手动输入了密钥时不必传 `modelId`。
   */
  discoverModels: (input: { provider: string; baseUrl: string; apiKey: string; modelId?: number }) =>
    request<DiscoverModelsResult>('/ai-models/discover', { method: 'POST', body: input }),
  /**
   * Probe an unsaved model draft before committing it.
   *
   * `modelId` 与 `discoverModels` 同一个含义：**编辑已有模型时用那条记录的已存密钥**。
   * 界面刻意不回显明文密钥（输入框留空 = "不改它"），所以只发 `apiKey: ''`
   * 会被服务端当成"没提供密钥"而直接报 `Missing API key.`。
   */
  testAiModelDraft: (input: AiModelInput & { modelId?: number }) =>
    request<ModelTestResult>('/ai-models/test-draft', { method: 'POST', body: input }),

  /* --- strategies --- */
  strategies: (signal?: AbortSignal) => request<StrategyRecord[]>('/strategies', { signal }),
  strategy: (id: number, signal?: AbortSignal) => request<StrategyRecord>(`/strategies/${id}`, { signal }),
  createStrategy: (input: StrategyInput) => request<StrategyRecord>('/strategies', { method: 'POST', body: input }),
  updateStrategy: (id: number, input: Partial<StrategyInput>) =>
    request<StrategyRecord>(`/strategies/${id}`, { method: 'PATCH', body: input }),
  deleteStrategy: (id: number) => request<{ ok: boolean }>(`/strategies/${id}`, { method: 'DELETE' }),
  /**
   * Strategy health check — runs the whole pipeline against a simulated
   * account. Slow (10–60s) and never places an order.
   */
  checkStrategy: (id: number, input: { aiModelId: number; symbol?: string }) =>
    request<StrategyCheckResult>(`/strategies/${id}/check`, { method: 'POST', body: input }),

  /* --- traders --- */
  traders: (signal?: AbortSignal) => request<TraderRow[]>('/traders', { signal }),
  /** The response carries where the starting equity came from. */
  createTrader: (input: TraderInput) => request<Trader & { equitySource?: EquitySource }>('/traders', { method: 'POST', body: input }),
  updateTrader: (id: number, input: Partial<TraderInput>) =>
    request<Trader>(`/traders/${id}`, { method: 'PATCH', body: input }),
  deleteTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}`, { method: 'DELETE' }),
  startTrader: (id: number, dryRun: boolean) =>
    request<StartResult>(`/traders/${id}/start`, { method: 'POST', body: { dryRun } }),
  stopTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}/stop`, { method: 'POST', body: {} }),
  /*
   * ⚠️ 这里**曾经**有一个 `resumeTrader(id)`，它 POST `/traders/${id}/resume`
   * 去撤销 AI 主动设下的停手开关 —— 已随 `2fb0881` 删除。
   *
   * 它在被删之前**已经是坏的**：停手开关本身被移除后，后端从来没有注册过
   * `POST /api/traders/:id/resume`，所以任何一次调用都会 404。而前端也没有
   * 任何组件调它（恢复按钮在 2026-10-04 就已撤掉），它是一个点了必然失败、
   * 且没有入口能点到的方法。
   *
   * 今天想恢复一个不跑的机器人，正确的入口是 `startTrader` / `stopTrader`，
   * 熔断与 `safe_mode` 有各自的说明路径 —— 不存在"AI 停手"这一态需要恢复。
   */
  /** Force one decision cycle now instead of waiting for the interval. */
  runTraderOnce: (id: number) =>
    request<{ ok: boolean; summary: string }>(`/traders/${id}/run-once`, { method: 'POST', body: {} }),
  /**
   * 让 AI **现在**审视一次策略 —— 与 `runTraderOnce` 是两件事。
   *
   *   `runTraderOnce`  跑一个**决策周期**：机器人按当前参数决策一次
   *   这个             跑一次**策略审视**：AI 反思绩效与复盘，决定要不要改参数
   *
   * 它下不了单，但确实会改参数（受结构守卫约束）。返回的是"请求已发出"
   * 而不是结果 —— 审视异步执行，且仍可能被每小时预算挡下。
   */
  agentReview: (id: number) =>
    request<{ ok: boolean; accepted: boolean; note: string }>(`/traders/${id}/agent-review`, {
      method: 'POST',
      body: {},
    }),
  /** Rebuild the books from the exchange's fill history — never places an order. */
  reconcileTrader: (id: number) =>
    request<ReconcileResult>(`/traders/${id}/reconcile`, { method: 'POST', body: {} }),

  /**
   * 手工平掉一个持仓 —— **操作员的最高权限，随时可用**。
   *
   * 服务端不对它做任何"机器人是否在运行"的前置检查：那是"机器人要不要开仓"
   * 的范畴，而这是"人要退出"。**一个止不住手的操作员是被困住的。**
   */
  closePosition: (id: number, symbol: string) =>
    request<{ ok: boolean; avgPrice: number; fee: number; stillRunning: boolean }>(
      `/traders/${id}/positions/${symbol}/close`,
      { method: 'POST', body: {} },
    ),

  /**
   * 平掉**该机器人的全部持仓**。
   *
   * 服务端逐个平（每个都走 `closeManually` 的同一套顺序：先撤单、再市价平、再记账），
   * 并返回**实际平掉的币种列表** —— 界面靠这个列表说话，而不是靠一个哨兵值。
   *
   * ⚠️ **返回里必须带上 `failed`。**
   *
   * 服务端 `manager.closeAllPositions()` 明确返回
   * `failed: Array<{ symbol; error }>` —— 逐个平的过程中，任何一个标的失败
   * （触及交易所最小名义、网络瞬时错误…）都会被塞进这个数组。
   *
   * 这里原来**漏声明了 `failed`**，于是 `response.failed` 在 TS 下不可见，
   * 消费点（`TraderTables` 的 `setResult`）也顺手没拷它 —— 结果界面在
   * **部分标的根本没平掉**的情况下照样显示成功横幅，操作员以为清仓完成就离开，
   * 而**敞口仍在裸奔**。这是本项目最不能出错的操作之一（主动清仓 = 避险动作）。
   */
  closeAllPositions: (id: number) =>
    request<{
      ok: boolean;
      closed: string[];
      cancelledPending: number;
      /** 平仓失败的标的与原因。**非空时界面必须如实报出，不能说"已全部平仓"。** */
      failed: Array<{ symbol: string; error: string }>;
      stillRunning: boolean;
    }>(`/traders/${id}/positions/close-all`, { method: 'POST', body: {} }),

  /* --- per-trader data --- */
  /**
   * 统计 + **熔断器的当前读数** + **这个机器人自己在不在纸面模式**。
   *
   * `circuitBreaker` 与 `dryRun` 都不是 `TraderStats` 的一部分：那个类型是仓储层
   * 算的纯统计，而这两个数由服务端从**运行时**组装（见端点上的说明）。机器人在
   * **停止**时它们都是 `null` —— 那时没有内存里的配置/实例可用来判定，
   * **而不是"确认没有熔断"或"确认在花真钱"**。
   */
  traderStats: (id: number, signal?: AbortSignal) =>
    request<
      TraderStats & { circuitBreaker: CircuitBreakerReading | null; dryRun: boolean | null }
    >(`/traders/${id}/stats`, {
      signal,
    }),
  traderPositions: (id: number, signal?: AbortSignal) =>
    request<PositionView[]>(`/traders/${id}/positions`, { signal }),

  /**
   * **智能体审计**（运行轨迹 / 参数实验 / 教训记忆）。
   *
   * 用户 2026-10-12 要求团队看板显示「有哪些智能体、都是什么分工、都在做什么」，
   * 而这三张表此前**前端完全不可见**（仓储层有、API 没有）。
   */
  traderAgentAudit: (id: number, limit = 20, signal?: AbortSignal) =>
    request<AgentAudit>(`/traders/${id}/agent-audit?limit=${limit}`, { signal }),
  /**
   * **各岗位"最近一次露面"的时刻**（2026-10-17 · t111）。
   *
   * ## 为什么需要这个端点（用户实测报的问题）
   *
   * 用户原话：「很多岗位，似乎**从未真正运行过**，页面上也没有显示他们**最新运行时间**」。
   *
   * 界面原来只从 `decision_records.cot_trace` 抽角色时刻，而那里**只有进了
   * `<team>` 块的角色**（分析师 / bull / bear / judge）。`supervisor` /
   * `risk_officer` / `reporter` 的出勤记在 `runtime_logs`（`scope='team'`）——
   * 线上 supervisor 出现 31 次，界面上却写"待命"。
   *
   * ## 为什么不做成"每个角色一个请求"
   *
   * 编制表有 21 个岗位。21 个请求会把这个每次轮询都渲染的组件变成自我 DDoS。
   * 一次拿全表，前端在内存里按 role 查。
   */
  traderAgentLastSeen: (id: number, signal?: AbortSignal) =>
    request<{ roles: Array<{ role: string; at: string; source: 'log' | 'cot' }> }>(
      `/traders/${id}/agent/last-seen`,
      { signal },
    ),
  /**
   * **一个岗位的历史工作详情**（用户要的"可点击按钮 → 看他历史工作详情"）。
   *
   * `total` 是**未截断的总数** —— 界面据此如实说"还有 N 条更早的"，
   * 而不是把 `limit` 截断后的条数当成全部（那是微型的谎）。
   */
  /**
   * **机器人控制：实时生效的开关**（2026-10-18）。
   *
   * ## 与 `.env` 的区别（这是这个标签存在的全部理由）
   *
   * ```
   *   .env       → 改完要重启进程，而重启会打断正在跑的决策周期
   *   这个端点   → 点一下立刻生效（下一次读取就拿到新值）
   * ```
   *
   * `source` 字段告诉操作员这个值**是从哪来的**：
   * ```
   *   'ui'      → 界面上设的（重启也保持）
   *   'env'     → .env 里的初始值（界面上从没点过）
   *   'default' → 代码默认值
   * ```
   * 少了它，操作员无法判断"我改了会不会影响别人 / 重启后会不会变回去"。
   */
  traderControl: (id: number, signal?: AbortSignal) =>
    request<{ switches: ControlSwitch[] }>(`/traders/${id}/control`, { signal }),

  /**
   * 切换一个开关。返回**回读后的完整状态** —— 前端直接用它刷新，
   * 不必再发一次 GET（两次之间可能被别人改掉）。
   */
  setTraderControl: (id: number, key: string, on: boolean) =>
    request<{ switches: ControlSwitch[] }>(`/traders/${id}/control/${key}`, {
      method: 'POST',
      body: { on },
    }),

  /** 读 JEV 模式的全部可调选项。 */
  traderJevOptions: (id: number, signal?: AbortSignal) =>
    request<{ options: JevOption[] }>(`/traders/${id}/jev-options`, { signal }),

  /** 改一个 JEV 选项。返回回读后的全表。 */
  setTraderJevOption: (id: number, key: string, value: string) =>
    request<{ options: JevOption[] }>(`/traders/${id}/jev-options/${key}`, {
      method: 'POST',
      body: { value },
    }),

  traderAgentSteps: (id: number, role: string, limit = 50, signal?: AbortSignal) =>
    request<{
      role: string;
      total: number;
      steps: Array<{ at: string; phase: string | null; message: string; source: 'log' | 'cot' }>;
      lastSeenAt: string | null;
    }>(`/traders/${id}/agent/${encodeURIComponent(role)}/steps`, {
      query: { limit },
      signal,
    }),
  traderAccount: (id: number, signal?: AbortSignal) =>
    request<{
      live: boolean;
      account: Record<string, unknown> | null;
      /**
       * 交易所**实时**持仓（`liveExchangeView` 直接问交易所，不是本地镜像）。
       *
       * ⚠️ 类型原来写的是 `unknown[]` —— 那让调用方只能断言或者绕开，而"绕开"
       * 的结果是页面拿 WebSocket 推的本地镜像当持仓数：服务刚重启、镜像还没建
       * 起来时显示「持仓 0」，而**这个端点明明已经拿到了真实持仓**。
       * 类型松一档，正确的那条路就没人走。
       */
      positions: PositionView[];
      /**
       * **本机器人自己**的浮动盈亏（服务端按它的持仓 symbol 过滤后算出）。
       *
       * `positions` 是**整个账户**的持仓（共享钱包上所有机器人 + 手动仓），
       * 所以不能拿它求和当"我的浮盈" —— 独立验收 2026-10-07 指出的就是这一处。
       */
      ownUnrealizedPnl?: number;
      /**
       * **交易所口径**的挂单数量（实时读回，不是 WebSocket 镜像）。
       *
       * 用户 2026-10-08：「有 3 个挂单，为什么上面不显示保证金占用？」
       * 卡片原来用 `live?.orders`（镜像）去判断"是否空仓"，镜像在断线/重连时是空的，
       * 于是它以为没有挂单、把占用算成 0，而下方「挂单占用」还写着 26.74。
       */
      openOrderCount?: number;
      error?: string;
    }>(`/traders/${id}/account`, { signal }),
  /**
   * 账户上的**外部交易活动** —— 不属于本平台任何机器人的成交。
   *
   * ## 为什么它值得单独一个端点
   *
   * 这些交易的盈亏**直接从交易所余额进出**，却不计入任何机器人的绩效。
   * 于是会出现一个看起来自相矛盾、而两者都正确的情形：
   *
   *     机器人绩效 +0.32      账户余额 −1.56
   *
   * 在加这个端点之前，平台对此**一个字都不说**（归属闸门在跳过时写的是
   * `log.debug`，而那个级别不显示）。操作员只能自己猜，AI 也只能自己猜。
   *
   * 结论来自**最近一次对账**，所以机器人在停止状态下仍然可读 ——
   * 那正是最需要它的时刻。
   *
   * `detectedAt` 为 `null` 表示**从未检测过**，与「检测过、没有外部活动」
   * （`rounds = 0`）是两件事，界面必须分开说。
   */
  foreignActivity: (id: number, signal?: AbortSignal) =>
    request<{
      rounds: number;
      net: number;
      symbols: string[];
      firstAt: string | null;
      lastAt: string | null;
      detectedAt: string | null;
      /**
       * **平台账本与交易所流水的差额**（`undefined` = 没读到，不代表 0）。
       *
       * ⚠️ 它是"列表页盈亏与详情页账户余额对不上"的量化答案 ——
       * 两个数字口径不同（本地记账 vs 交易所真实值），而这个差是它们的距离。
       */
      ledgerGap?: number;
      /** 对账检查的时刻（`undefined` = 从没跑过对账）。 */
      ledgerCheckedAt?: string;
    }>(`/traders/${id}/foreign-activity`, { signal }),
  /**
   * 一页订单记录（服务端按 `id` 倒序，即最新的一单在前）。
   *
   * `before` 是**游标**，不是偏移量：它要求服务端只返回 `id` 比它更小的订单。
   * 之所以不用 `offset`：订单是**在顶部持续插入**的（每下一单就多一行），用偏移量
   * 翻页时"第 2 页"的起点会因为新订单插进来而整体后移 —— 第二页的第一条会和第一页
   * 的最后一条重复，同一张订单在表格里出现两次。游标锚在一条具体记录上，
   * 插入多少条都不影响它。
   *
   * `limit` 由服务端钳制（上限 `ORDER_PAGE_MAX`），所以这里照原样传即可。
   * 调用方（`TraderTables`）一次多要一条来做"还有没有更早的"的判断，
   * 所以这个参数不叫"页大小"。
   */
  traderOrders: (
    id: number,
    options: { limit?: number; before?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<OrderRecord[]>(`/traders/${id}/orders`, {
      query: { limit: options.limit ?? 100, before: options.before ?? undefined },
      signal: options.signal,
    }),
  /**
   * 一页成交记录。
   *
   * ⚠️ **游标是复合的**（`before` + `beforeClosedAt`）——
   * 与 `traderOrders` **不一样**，别照抄。
   *
   * 成交行的 `id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早**：
   * 按 id 排序会让界面上的日期看起来错乱（用户的原话：「历史成交里面日期显示
   * 错乱（不是完全按时间排序）」）。服务端因此改成按 `closed_at` 排序，
   * 而按时间排序之后只用 id 做游标会漏行 —— 所以翻页要同时给
   * **那一行的 `closedAt`**。两个都给时服务端走新路径；只给 `before` 时
   * 退回旧行为。
   */
  traderTrades: (
    id: number,
    options: {
      limit?: number;
      before?: number | null;
      beforeClosedAt?: string | null;
      signal?: AbortSignal;
    } = {},
  ) =>
    request<TradeRecord[]>(`/traders/${id}/trades`, {
      query: {
        limit: options.limit ?? 100,
        before: options.before ?? undefined,
        beforeClosedAt: options.beforeClosedAt ?? undefined,
      },
      signal: options.signal,
    }),
  /**
   * 一页决策记录（服务端按 `id` 倒序，即最新的一轮在前）。
   *
   * `before` 是**游标**，不是偏移量：它要求服务端只返回 `id` 比它更小的记录。
   * 之所以不用 `offset`：决策记录是**在顶部持续插入**的（每跑完一轮就多一条），
   * 用偏移量翻页时，"第 2 页"的起点会因为新记录插进来而整体后移 ——
   * 于是第二页的第一条会和第一页的最后一条重复，反过来（记录被裁掉时）则会漏掉。
   * 游标锚在一条具体记录上，插入多少条都不影响它。
   *
   * 调用方（`DecisionFeed`）一次多要一条来做"还有没有更早的"的判断，
   * 所以这里不把 `limit` 设成"页大小"的名字。
   */
  traderDecisions: (
    id: number,
    options: { limit?: number; before?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<DecisionRecord[]>(`/traders/${id}/decisions`, {
      query: { limit: options.limit ?? 50, before: options.before ?? undefined },
      signal: options.signal,
    }),
  traderDecision: (id: number, recordId: number, signal?: AbortSignal) =>
    request<DecisionRecord>(`/traders/${id}/decisions/${recordId}`, { signal }),
  traderEquity: (id: number, limit = 500, signal?: AbortSignal) =>
    request<EquitySnapshot[]>(`/traders/${id}/equity`, { query: { limit }, signal }),

  /* --- market --- */
  marketSymbols: (signal?: AbortSignal) => request<MarketSymbol[]>('/market/symbols', { signal }),
  marketKlines: (symbol: string, interval: string, limit = 300, signal?: AbortSignal) =>
    request<Kline[]>('/market/klines', { query: { symbol, interval, limit }, signal }),
};

/** Absolute WebSocket URL for the live event stream. */
export function eventStreamUrl(): string {
  const token = getToken() ?? '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/events?token=${encodeURIComponent(token)}`;
}
