import { getProvider, type LlmProviderId, type LlmProviderDescriptor } from '@aq/shared';
import { createLogger } from '../logger.js';
import { maskSecret } from '../crypto/vault.js';
import { LlmError, emptyCompletionError, isRetryable, timeoutError } from './errors.js';
import { executeJsonRequest, executeStreamRequest } from './http.js';
import { nextReasoningEffort } from './effortFallback.js';
import * as openai from './openaiCompatible.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type ChatResult,
  type OutboundRequest,
  type ToolCall,
  type ToolSpec,
} from './types.js';
import { checkOutboundUrl, parseHostAllowlist } from './urlGuard.js';
import { env } from '../env.js';

const log = createLogger('llm');

/**
 * 默认的单次请求超时（秒）。
 *
 * ⚠️ **120 秒对"大提示词 + 推理模型"是不够的（2026-10-01 实测）。**
 *
 * 这个机器人的一轮请求是 **约 190K prompt tokens + 20K 推理 tokens**，
 * 实测单次耗时在 45s–332s 之间波动。原来的 240 秒上限会被正常的大请求撞到，
 * 而**超时被归类成"AI 服务不可用"**（`#1621` 的原始错误是
 * `commandcode request exceeded 240000ms`）—— 于是：
 *
 *   · 操作员看到"上游故障"，而**他单独用 API 测上游时它是好的**；
 *   · 系统在那一轮白白失败，等一整个周期才再试。
 *
 * 更大的超时不解决问题（真正的病根是提示词太大，见 `CANDIDATE_HARD_CAP`），
 * 但它**避免把"我们跑得慢"误报成"上游挂了"** —— 那是两条完全不同的诊断路径。
 */
const DEFAULT_TIMEOUT_SECONDS = 300;
/*
 * ⚠️ **默认重试从 3 提到 10（2026-10-10，用户实测）。**
 *
 * 用户的原话：「那些不稳定的提供商（偶发连接失败）……**只要重试\等待基本能正常使用**……
 * 偶发失败（重连大概 20 次以内）都是正常情况，系统应当正常运行下去」。
 *
 * 原来的 3 只有 3 次尝试、退避合计约 1.5 秒 —— 对偶发断连的第三方几乎等于不重试，
 * 于是"能靠重试救回来"的一轮被直接判成失败。退避是 `min(30s, 0.5s·2^n)`，
 * 10 次的总等待仍然远小于一轮的硬超时（60 分钟）。
 *
 * **这不是"掩盖故障"**：真失败（401/402/模型不存在）仍然是不可重试的，
 * 一次就结束；这里放宽的只有"网络抖动/限流/超时"那一类。
 */
const DEFAULT_MAX_RETRIES = 10;

/**
 * **一次 `chat()` 的总时长上界**，与"单次尝试超时"是两件事。
 *
 * ## 为什么必须有它（2026-10-14 线上实测抓到的真问题）
 *
 * `timeoutSeconds` 只作用于**单次 HTTP 请求**（它被传给
 * `executeJsonRequest({ timeoutMs })`），而 `chat()` 会按 `maxRetries` 重试。
 * 于是**总时长完全不受那个配置约束**：
 * ```
 *   配置 timeout=600s、maxRetries=2
 *   → 总时长上界 ≈ 600 + 退避 + 600 + 退避 + 600 ≈ 1830s（30 分钟）
 * ```
 * 线上实测到了这个后果：
 * ```
 *   >600s 的调用 39 次，最慢 900068ms（15 分钟）
 *   而交易周期本身就是 15 分钟
 *   → 【一次调用吃掉整个周期】，那一轮没有任何产出
 * ```
 * 而配置里写的是 600s —— 也就是说**运维看到的数字与他实际得到的行为不一致**，
 * 那是比"慢"更糟的事（`docs/AGENTS.md` §3.2：不要把推测当成已验证，
 * 反过来也一样：不要把一个**看起来**生效的配置当成真的生效）。
 *
 * ## 取值：单次超时的 `maxRetries + 1` 倍不够，改用一个**显式上界**
 *
 * ```
 *   totalBudgetMs = timeoutMs × (maxRetries + 1)，但**封顶 20 分钟**
 * ```
 * ⚠️ 为什么不是严格"每次都能跑完"：重试的价值在于"上游偶发失败时能救回来"
 *（见 `DEFAULT_MAX_RETRIES` 那段用户原话）。所以上界必须**容得下几次重试**，
 * 但它也得**小于一个周期**，否则一轮永远跑不完。
 *
 * ⚠️ 20 分钟这个封顶与"周期 15 分钟"并不矛盾：周期到点会**先看这一轮跑完没有**
 *（`cycleInFlight` 守卫），而这里保证的是"它不会无限拖下去"。
 * 真正要防的是"配置 600s、实际 30 分钟"这种**失控**，不是"偶尔慢一点"。
 *
 * ⚠️ 触发时抛**可重试的超时错误**吗？不是 —— 到达总预算说明已经重试过了，
 * 再重试只会更晚返回。所以它抛一个明确的错误**让上层换模型**（`ModelRouter`
 * 有候选链降级），那比在这里继续等有价值。
 */
const MAX_TOTAL_CHAT_MS = 20 * 60_000;
/** Full-jitter backoff bounds from B.14 (`base ≈ 500ms`, cap ≈ 30s). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/**
 * The probe must be cheap but not *this* cheap: a 1-token cap leaves reasoning
 * models with empty visible content at `finish_reason: length`, which the
 * empty-answer guard would report as a connectivity failure.
 */
/**
 * Output budget for the connectivity probe.
 *
 * Deliberately not tiny. A reasoning model burns output tokens on its thinking
 * before emitting any text, so a 16-token probe comes back empty with
 * `finish_reason: length` — which looks like a broken key to the operator when
 * nothing is wrong. 256 is still negligible in cost and gives such a model room
 * to think and then answer.
 */
const PROBE_MAX_TOKENS = 256;

export interface LlmClientOptions {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
  /**
   * 思考等级。默认 `high` —— 见 `ChatRequest.reasoningEffort` 上的说明。
   *
   * 设成 `undefined` 就完全不发这个参数（给"确认不支持"的 provider 用）。
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * **这条客户端属于哪个机器人**（`traders.id`）—— **只用于日志归属**。
   *
   * ## 为什么需要它（2026-10-17 队长线上回读）
   *
   * `runtime_logs` 里 17 条「空内容（finish_reason=length）」警告，**14 条
   * `trader_id` 是 `null`** —— 于是"是哪个机器人在空转"这个问题**无法回答**。
   * 而当时正需要它：看到"重启后仍有 6 条空内容"时，第一反应是"修复没生效"，
   * 直到去查归属才发现**那 14 条根本不能归因 ⇒ 那个样本支撑不了任何结论**。
   *
   * 而 `llm` 这一域的所有日志都缺它：`log.warn(…)` 的 meta 里只有
   * `provider` / `model`，而落库的 sink（`api/server.ts` 的 `setLogSink`）
   * **只认 `meta.traderId`** —— 没有它，`runtime_logs.trader_id` 就是 `null`。
   *
   * ## ⚠️ 语义边界：这是"归属"，不是"行为"
   *
   * 它**不参与任何请求构造**（不改 body、不改超时、不改重试、不改路由），
   * 只被拼进日志的 meta。加它前后，同一个输入发出的 HTTP 请求**逐字节相同**。
   *
   * ## ⚠️ 共享实例不要用它
   *
   * 如果一个客户端实例会被**多个机器人**共用（实测：`buildSelfCheckAsk()` 造的
   * 那个 magpie 工厂被整个自检 sweep 复用、跨所有在跑的机器人），那**不要**传
   * 构造级 `traderId` —— 那会把 A 机器人的空内容记到 B 头上，比 `null` 更糟。
   * 那种情形用 `chat()` 的**按调用**覆盖（`options.context.traderId`）。
   */
  traderId?: number;
  /**
   * 这个客户端"是谁在用"的**稳定短标签**（调用点自报，例如 `decision`、`team:bull`）。
   *
   * 与 `traderId` 同一条纪律：**只进日志 meta**，不改任何请求内容。
   * 作用是把"同一个机器人的哪条链路在空转"也答出来 —— 团队模式下同一个机器人
   * 会同时跑多个角色，只有 `traderId` 仍然分不清是哪一个。
   */
  callSite?: string;
}

export interface ConnectionProbe {
  ok: boolean;
  message: string;
  latencyMs: number;
  modelEcho?: string;
}

/**
 * `chat()` 的**按调用**选项。
 *
 * ⚠️ 抽成具名类型（而不是两处各写一遍内联字面量）是因为 `chat()` 与 `attempt()`
 * **必须接受同一份形状** —— 2026-10-17 加 `context` 时就因为 `attempt()` 那份
 * 没同步而 `tsc` 报了两处 `Property 'context' does not exist`（这里记一笔）。
 */
export interface ChatCallOptions {
  probe?: boolean;
  signal?: AbortSignal;
  /**
   * **本次调用**的输出预算覆盖（不传则用构造时的 `maxTokens`）。
   *
   * ## 为什么需要它（2026-10-12，多智能体路由的必需能力）
   *
   * 实测：思维链模型（如 `gpt-6-astra`）的 `reasoning_content` 与正文**共享**
   * `max_tokens`，预算太小会返回 `content: null` + `finish_reason: length`：
   *
   *     mt=16  → content=null · reasoning=435
   *     mt=128 → content=null · reasoning=475
   *     mt=512 → content="…"            ← 够用了
   *
   * 而 `maxTokens` 原来是**构造时定死的实例字段**，于是"这一轮预算不够、
   * 加大重试"在结构上做不到 —— 只能整轮失败或换模型，而**换模型会白白丢掉
   * 最强的那一个**（它只是这次说得多了一点）。
   *
   * 所以加这个可选的 per-call 覆盖：**默认行为完全不变**（不传就用实例值），
   * 只有需要它的调用方（模型路由器的"空内容重试"）才传。
   */
  maxTokens?: number;
  /**
   * **本次调用的日志归属**（可选，覆盖构造级）—— 见 `logOwner()` 的说明。
   *
   * ⚠️ **共享实例必须用它**：一个被多个机器人共用的客户端（实测：自检那个
   * magpie 工厂被整个 sweep 复用）如果只靠构造级 `traderId`，就会把 A 的空内容
   * 记到 B 头上 —— **错误归因比 `null` 更糟**。
   *
   * ⚠️ 与 `maxTokens` 一样：**不传就完全不影响任何行为**（它只进日志 meta）。
   */
  context?: { traderId?: number; callSite?: string };
  /**
   * **本次调用的原生工具清单**（2026-10-23）。
   *
   * ## 为什么是 per-call 而不是构造时固定
   *
   * 同一台机器人对不同角色要用不同工具：策略师有 `get_experiments` /
   * `set_params`，复盘员只有 `get_performance`。把它们放在构造参数上意味着
   * "一个实例一套工具"，而实际链路里同一个 provider 实例会被多个角色复用。
   *
   * ## 不传 = 完全保持原行为
   *
   * 老的 JSON 协议路径（模型自己写 `{"tool":"…"}`）继续工作 ——
   * 这一层**不强制**任何调用方迁移。
   */
  tools?: ToolSpec[];
  /** 工具选择策略。不传 = `auto`。 */
  toolChoice?: 'auto' | 'none' | 'required';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full jitter, not a deterministic exponential delay: after a shared outage
 * every instance would otherwise retry at the same instants and re-trigger the
 * overload (B.14).
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Provider-agnostic chat client.
 *
 * Dispatches on the descriptor's `openAiCompatible` flag, then applies one
 * shared policy for timeouts, retries and logging so every provider behaves
 * the same way under failure.
 */
/**
 * 这个**模型**该不该走 Anthropic Messages 协议。
 *
 * ## 为什么要有这个判断（2026-10-08 用户实测）
 *
 * 用户报「OpenCode GO 选 claude 用不了」。查它的文档
 * （<https://opencode.ai/docs/zh-cn/go/>）有一张**端点表**：一个 baseUrl 下
 * 按模型分三种协议 ——
 *
 * | 端点 | 模型 |
 * | --- | --- |
 * | `/v1/chat/completions` | DeepSeek / GLM / Kimi / MiMo / LongCat / Hy3 / Space Bunny |
 * | **`/v1/messages`** | **Claude Haiku 5.5** / MiniMax M3 · M2.7 / Qwen3.8 Max · Flash / Qwen3.7 Plus |
 * | `/v1/responses` | Grok 4.6 · 4.7 / GPT 6 Luna · GPT 5.6 Luna / Muse Spark |
 *
 * 而原来的分发**只看供应商**（`descriptor.openAiCompatible`）——
 * `opencode` 是 OpenAI 兼容，于是**所有模型都被发到 `/chat/completions`**，
 * claude 被网关拒收并回 `Model does not support this protocol.`。
 * **端点表就在文档上，我们没照着实现。**（适配器 `llm/anthropic.ts` 早就写好了。）
 *
 * ## 为什么是纯函数
 *
 * 判定是"供应商 + 模型 id → 协议"的纯映射，与 `LlmClient` 实例无关。
 * 抽出来就能**直接断言**，不必去 mock 网络 —— 而网络 mock 出来的绿勾
 * 证明不了"真的发到了 `/messages`"（这一条正是被这个 bug 咬过的教训）。
 *
 * ## 尚未实现的一类
 *
 * `/v1/responses`（Grok / GPT Luna / Muse Spark）还没有适配器，
 * 它们仍会走 `/chat/completions` 并失败。**那是已知缺口，不是静默容忍** ——
 * 等有需求时在这里加第二条分支。
 */
export function usesAnthropicProtocol(provider: string, model: string): boolean {
  if (provider === 'anthropic') return true;
  /*
   * ⚠️ **这条"按模型名判协议"的规则只对 `opencode` 生效（2026-10-11 审查发现）。**
   *
   * 原来它对**任何** provider 都按模型名前缀判协议，于是：
   *
   *   · `commandcode`（OpenAI 兼容聚合网关）选 claude 系模型 → 被发到 `/messages`；
   *   · 任何自有部署的 MiniMax / qwen3.7 / qwen3.8 → 同样被改道。
   *
   * 而那些网关**只有 OpenAI 兼容端点**，改道等于把请求发到一个不存在的路径上。
   *
   * 判据是"**这个网关会不会按模型换协议**"，而不是"模型叫什么名字" ——
   * 只有 OpenCode Go 是后者（它的文档逐条列了模型与端点的对应）。
   * 所以这里显式限定供应商；以后接同类网关时**显式加进来**，不要放宽成通配。
   */
  if (provider !== 'opencode') return false;
  return /^(claude-|minimax-|qwen3\.7-|qwen3\.8-)/i.test(model);
}
export class LlmClient {
  readonly provider: LlmProviderId;
  readonly descriptor: LlmProviderDescriptor;
  readonly model: string;
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number;
  /**
   * 流式请求被网关拒绝后置位 —— 此后这一实例退回非流式。
   *
   * ⚠️ **不能让一个可选优化变成"每一轮都失败"。** 参数名是 `stream`，
   * 而 `OpenAI` 兼容网关的实现质量参差：有的不认 `stream_options`，
   * 有的把流式当成不同的端点。而 400 被正确归为"不可重试"，
   * 于是不降级就等于每轮都炸。
   */
  private streamDisabled = false;
  /**
   * 这一实例内已经发生过多少次"网关/请求超时"。
   *
   * ⚠️ 计入两类：我们自己的 `timeout`（`AbortSignal.timeout` 到期），
   * 以及 `HTTP 524` —— 那是 **Cloudflare 的"源站超时"**：网关等 100 秒
   * 没拿到响应头就放弃。实测一次 100K tokens 的请求要 220 秒、
   * 一轮 8 轮里 4 次这样失败（见 `effortFallback.ts`）。
   *
   * 这个计数只增不减：振荡（降了→成功→升回去→又超时）会让成功率
   * 取决于上一次的运气。
   */
  private timeoutCount = 0;
  private readonly maxRetries: number;
  private readonly jsonMode: boolean;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  /**
   * 思考等级。**不是 `readonly`** —— 被 provider 拒绝时要在运行中清掉它。
   */
  private reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  /** Never logged in full; kept only so an operator can tell which key is live. */
  private readonly keyHint: string;
  /**
   * 上一次**回显**的具体模型名（provider 实际服务的那个）。
   *
   * ## 为什么需要记住它（外部 issue #178）
   *
   * 服务商回显的模型名与请求的不一致**是预期情况**（OpenRouter 别名、
   * xAI `latest`）—— 见下面那条日志的注释。而它原来用 `info` 级别
   * **每次成功调用都打一行**：线上实测最近 300 行日志里 **93 行（31%）是同一句**，
   * 把「数据与日志」页里真正要看的决策/平仓/错误挤掉了 31% 的版面 ——
   * 而那一页正是这个项目的排障入口。
   *
   * 降级成 `debug` 能止住刷屏，但会**连信号一起丢掉**：
   * 真出现"服务商换了模型"时默认视图什么都看不到。
   *
   * 所以这里记住上一次的值，**只在它变化时打一行** ——
   * 同一件事重复 93 遍没有信息量，而"从 A 变成 B"有。
   */
  private lastServedModel: string | undefined;
  /** 日志归属：这条客户端属于哪个机器人（见 `LlmClientOptions.traderId`）。 */
  private readonly traderId: number | undefined;
  /** 日志归属：这条客户端"是谁在用"的短标签（见 `LlmClientOptions.callSite`）。 */
  private readonly callSite: string | undefined;

  constructor(options: LlmClientOptions) {
    this.descriptor = getProvider(options.provider);
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.jsonMode = options.jsonMode === true;
    this.jsonSchema = options.jsonSchema;
    this.reasoningEffort = options.reasoningEffort;
    this.traderId = options.traderId;
    this.callSite = options.callSite;
    this.keyHint = this.apiKey === '' ? '<empty>' : maskSecret(this.apiKey);

    if (this.baseUrl === '') {
      throw new LlmError(
        `Provider ${this.provider} requires an explicit baseUrl`,
        null,
        this.provider,
        false,
      );
    }

    /*
     * 出站地址白名单也放在构造函数里，因为这里是**所有**模型请求的必经之路：
     * 交易循环、连接探测、策略体检、模型列表发现全都从 `LlmClient` 出去。
     * 放在这里还有一层意义 —— 数据库里**已经存着**的旧地址（本次改动之前写入的）
     * 同样会被拦下，而只在 API 层校验做不到这一点。
     *
     * 不重试、直接失败：这不是网络抖动，重试只会把同一个内网请求再发一遍。
     */
    /*
     * 操作员显式声明的内网目标（`ALLOW_PRIVATE_LLM_HOSTS`）——
     * 自建网关/私有部署要连内网地址，而默认规则会挡掉它们。
     * 每次读 env 而不是模块级常量：测试可以按用例改环境。
     */
    const verdict = checkOutboundUrl(this.baseUrl, parseHostAllowlist(env.allowPrivateLlmHosts));
    if (!verdict.allowed) {
      throw new LlmError(
        `baseUrl 不被允许：${verdict.reason}`,
        null,
        this.provider,
        false,
        undefined,
        { kind: 'bad_request' },
      );
    }
  }

  /**
   * **所有 llm 域日志的归属字段**（2026-10-17 加）。
   *
   * ## 它解决的是"日志查不出是谁"
   *
   * 落库的 sink（`api/server.ts` 的 `setLogSink`）只从 meta 里读 `traderId`，
   * 其余字段（`provider` / `model` / …）**只进 stdout 的 JSON 尾巴，不进库**。
   * 所以"进库能不能归因"完全取决于这里有没有把 `traderId` 拼进去。
   *
   * ## 一层构造 + 一层按调用
   *
   * ```
   *   构造级（LlmClientOptions.traderId）  —— 这条客户端属于谁（每机器人一个实例时用）
   *   按调用（options.context.traderId）   —— 这一次调用是谁发起的（共享实例时必须用它）
   * ```
   * ⚠️ 按调用优先。共享实例（如自检那个跨机器人的 magpie 工厂）**必须**走按调用，
   * 否则会把 A 的失败记到 B 头上 —— **比 `null` 更糟**（`null` 只是查不到，
   * 记错会把人引向一个不存在的故障）。
   *
   * ⚠️ **它只影响日志**：返回值只被拼进 `log.*()` 的 meta，不参与请求构造。
   */
  private logOwner(override?: { traderId?: number; callSite?: string }): {
    traderId?: number;
    callSite?: string;
  } {
    const traderId = override?.traderId ?? this.traderId;
    const callSite = override?.callSite ?? this.callSite;
    return {
      ...(traderId === undefined ? {} : { traderId }),
      ...(callSite === undefined ? {} : { callSite }),
    };
  }

  /**
   * Cheap capability probe used by the launch preflight (B.16): one tiny
   * completion validates the key, the base URL, the model id and the auth
   * header together, turning a mid-session 401 into a startup failure.
   */
  async testConnection(): Promise<ConnectionProbe> {
    const startedAt = Date.now();
    try {
      const result = await this.chat([{ role: 'user', content: 'Reply with the word: pong' }], {
        probe: true,
      });

      const latencyMs = Date.now() - startedAt;

      // A reasoning model spends output budget on its thinking before it emits a
      // single character. A stingy probe budget therefore returns an *empty*
      // completion with `finish_reason: length` — which reads like a failure even
      // though the key, URL and model are all fine. Say so explicitly instead of
      // reporting a bare "(empty reply)".
      if (result.text.trim() === '') {
        const truncated = result.finishReason === 'length';
        return {
          ok: true,
          message: truncated
            ? `已连接 ${this.descriptor.label}（${result.model}）。探测请求的输出预算被推理过程耗尽而返回空内容 —— 这不影响正式调用，但请在高级设置中确认「最大输出 Token」足够大。`
            : `已连接 ${this.descriptor.label}（${result.model}），但模型返回了空内容。若用于正式决策请留意。`,
          latencyMs,
          modelEcho: result.model,
        };
      }

      return {
        ok: true,
        message: `已连接 ${this.descriptor.label}（${result.model}），响应正常。`,
        latencyMs,
        modelEcho: result.model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /* ⚠️ 探测也会打 llm 域日志 —— 归属走构造级（探测没有"按调用"的上下文）。 */
      log.warn(`${this.provider} 的连通性探测失败`, {
        ...this.logOwner(),
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        apiKey: this.keyHint,
        error: message,
      });
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  async chat(messages: ChatMessage[], options: ChatCallOptions = {}): Promise<ChatResult> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    let lastError: unknown;

    /*
     * **总时长预算**：`timeoutMs × (maxRetries + 1)`，但封顶 `MAX_TOTAL_CHAT_MS`。
     * 完整理由见该常量的说明 —— 核心是"配置的单次超时不该被理解成总时长"。
     */
    const totalBudgetMs = Math.min(this.timeoutMs * (this.maxRetries + 1), MAX_TOTAL_CHAT_MS);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      /*
       * ⚠️ **在发起下一次尝试【之前】检查预算**（而不是在失败之后）——
       * 前者省掉一次注定超时的请求与它的退避等待，后者会把总时长再撑长一整轮。
       */
      const elapsedMs = Date.now() - startedAt;
      if (attempt > 0 && elapsedMs >= totalBudgetMs) {
        log.warn(
          `模型调用已达本次总时长上界，不再重试：${this.provider} / ${this.model}`,
          {
            ...this.logOwner(options.context),
            provider: this.provider,
            model: this.model,
            elapsedMs,
            totalBudgetMs,
            attempts: attempt,
            maxRetries: this.maxRetries,
            perAttemptTimeoutMs: this.timeoutMs,
            /*
             * ⚠️ 这条日志存在的意义：**让"配置的 600s"与"实际花了 20 分钟"
             * 这件事在日志里对得上**。没有它，运维只会看到一堆"慢"。
             */
            hint: '单次超时 × 重试次数 = 实际总时长；这是刻意封顶的，不是失控。',
          },
        );
        throw timeoutError(this.provider, elapsedMs);
      }

      log.debug(`chat request → ${this.provider}`, {
        ...this.logOwner(options.context),
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        // Never the key itself, only enough to identify which one is in use.
        apiKey: this.keyHint,
        attempt,
        messages: messages.length,
        jsonMode: this.jsonMode,
        timeoutMs: this.timeoutMs,
      });

      try {
        /* options 原样透传 —— 含 per-call maxTokens 覆盖（见 chat() 的说明）。 */
        const result = await this.attempt(messages, startedAt, startedAtIso, options);
        log.info(`模型调用成功：${this.provider} / ${result.model}`, {
          ...this.logOwner(options.context),
          provider: this.provider,
          model: result.model,
          finishReason: result.finishReason,
          latencyMs: result.latencyMs,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        lastError = error;

        /*
         * ⚠️ **降级：`reasoning_effort` 被拒时，去掉它重来一次。**
         *
         * 这个参数不是所有 provider 都认。而 400 被正确地归为**不可重试**
         * （重试改变不了结果）—— 于是不支持的 provider 会让**每一轮决策都失败**。
         *
         * **这不是「重试同一个请求」，而是「换一个更保守的请求」**：
         * 去掉那个可能不被接受的参数。代价只是多一个往返，
         * 收益是「默认 high」这个要求不会变成一次全线故障。
         *
         * 只做一次（`effortDropped` 守住），而且**清掉之后就不再恢复** ——
         * 一个已经被拒的参数，下一轮再带上只会再被拒一次。
         * 这个判断活在客户端实例上，而实例是每个机器人一个、随进程存活。
         */
        if (
          this.reasoningEffort !== undefined &&
          error instanceof LlmError &&
          error.kind === 'bad_request'
        ) {
          const dropped = this.reasoningEffort;
          this.reasoningEffort = undefined;
          log.warn(
            `${this.provider} 拒绝了 reasoning_effort=${dropped}，已去掉该参数并立即重试 —— ` +
              '这次调用不会因为一个可选的思考等级而失败。',
            { ...this.logOwner(options.context), provider: this.provider, model: this.model, status: error.status },
          );
          /*
           * ⚠️ **`continue` 会消耗一次重试预算 —— 注释原来写反了。**
           *
           * 这里是 `for (let attempt = 0; attempt <= this.maxRetries; attempt += 1)`，
           * 而 `for` 里的 `continue` **会执行 `attempt += 1`**。原来那句注释说
           * "`attempt` 不递增 —— 这次降级不算一次重试"，描述的语义并没有发生。
           *
           * 后果有限但不为零：`maxRetries: 3` 时少一次重试预算。真正会出事的是
           * `maxRetries: 0`（API 允许这么配）—— 那种情况下 `attempt` 直接变 1、
           * 循环条件不再成立，**去掉 `reasoning_effort` 的降级重试永远不会发生**，
           * `bad_request` 会原样抛出去。
           *
           * 这条注释改成陈述事实。要不要把"降级不计入重试"真的实现出来是另一个决定
           * （改循环结构），但那属于行为变更，不该顺手做。
           */
          continue;
        }

        /*
         * ⚠️ **流式被网关拒绝 → 退回非流式重来一次。**
         *
         * 与上面 `reasoning_effort` 的降级同一类：`stream` 是一个**可选优化**
         * （它解决网关 100 秒的源站超时，见 `stream.ts`），而某些 OpenAI 兼容
         * 网关不认 `stream` 或 `stream_options`，会返回 400 ——
         * 而 400 被正确归为"不可重试"，于是不降级就等于**每一轮都失败**。
         *
         * 只做一次（`streamDisabled` 守住），且**关掉就不再打开** ——
         * 一个已经拒绝过流式的端点，下一轮再试只会再被拒一次。
         * 这个标记活在客户端实例上，而实例是每个机器人一个、随进程存活。
         *
         * 注意：这里的 `continue` **会消耗一次重试预算**（见上面那条注释），
         * 所以它只在 `maxRetries >= 1` 时才有第二次机会 —— 而这正是
         * 本项目所有 provider 的默认值（2–3）。
         */
        if (
          this.descriptor.openAiCompatible &&
          !this.streamDisabled &&
          error instanceof LlmError &&
          error.kind === 'bad_request'
        ) {
          this.streamDisabled = true;
          log.warn(
            `${this.provider} 拒绝了流式请求（HTTP ${error.status}），已退回非流式并立即重试 —— ` +
              '这次调用不会因为一个可选优化而失败。',
            { ...this.logOwner(options.context), provider: this.provider, model: this.model, status: error.status },
          );
          continue;
        }

        const retryable = isRetryable(error);
        const canRetry = retryable && attempt < this.maxRetries;

        const detail = {
          ...this.logOwner(options.context),
          provider: this.provider,
          model: this.model,
          attempt,
          status: error instanceof LlmError ? error.status : null,
          kind: error instanceof LlmError ? error.kind : 'unknown',
          retryable,
          willRetry: canRetry,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };

        if (!canRetry) {
          if (retryable) log.error(`${this.provider} 的模型调用失败 —— 重试次数已用尽`, detail);
          else log.error(`${this.provider} 的模型调用失败 —— 这类错误不会因重试而成功`, detail);
          throw error;
        }

        /*
         * ⚠️ **记下超时**：`524` 是 Cloudflare 的"源站超时"，`timeout` 是我们自己的
         * `AbortSignal` 到期 —— 两者都说明"这一次请求的生成耗时超过了链路的忍耐上限"。
         * 下一次请求会因此用更小的思考预算（见 `buildRequest` 与 `effortFallback.ts`）。
         */
        if (
          error instanceof LlmError &&
          (error.kind === 'timeout' || error.status === 524)
        ) {
          this.timeoutCount += 1;
        }

        // Prefer the server's Retry-After over our own backoff when present.
        const retryAfterMs = error instanceof LlmError ? error.retryAfterMs : null;
        const delayMs = retryAfterMs ?? backoffDelayMs(attempt);
        log.warn(`第 ${attempt + 1}/${this.maxRetries} 次重试 ${this.provider}，等待 ${delayMs}ms 后开始`, {
          ...detail,
          retryAfterMs,
        });
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error(`chat exhausted retries for ${this.provider}`);
  }

  /** Convenience wrapper matching how the strategy engine calls it. */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    return this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options,
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * 这个**模型**是否该走 Anthropic Messages 协议。
   *
   * ## 为什么按模型判而不是按供应商
   *
   * OpenCode Go 一个 baseUrl 下按模型分三种协议（见文档的端点表）。
   * 所以"供应商是不是 OpenAI 兼容"这个判断**粒度太粗** ——
   * `opencode` 既发 OpenAI 兼容的 deepseek，也发 Anthropic 协议的 claude。
   *
   * 判定依据是**模型 id**：`claude-*` 走 `/messages`。这是网关自己的命名，
   * 不是我们的猜测（文档的端点表逐条列了模型 ID 与端点的对应）。
   * 以后若要接 `/v1/responses`（grok / gpt-6-luna），在这里加第二条分支即可。
   */
  private usesAnthropicProtocol(): boolean {
    return usesAnthropicProtocol(this.provider, this.model);
  }

  private buildRequest(
    messages: ChatMessage[],
    probe: boolean,
    maxTokensOverride?: number,
    toolOverride?: { tools?: ToolSpec[]; toolChoice?: 'auto' | 'none' | 'required' },
  ): OutboundRequest {
    /*
     * **本次调用的输出预算**：per-call 覆盖优先，否则用实例值。
     * 见 `chat()` 的 `maxTokens` 参数说明（思维链吃光预算时要能加大重试）。
     */
    const effectiveMaxTokens = maxTokensOverride ?? this.maxTokens;
    // A probe must be as cheap as possible and must not request a schema. It
    // keeps the sampling temperature so it exercises the real request path.
    const bodyOptions: openai.OpenAiBodyOptions = probe
      ? {
          maxTokens: PROBE_MAX_TOKENS,
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        }
      : {
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
          ...(effectiveMaxTokens !== undefined ? { maxTokens: effectiveMaxTokens } : {}),
          jsonMode: this.jsonMode,
          ...(this.jsonSchema !== undefined ? { jsonSchema: this.jsonSchema } : {}),
          /*
           * **原生 function calling 的工具清单**（2026-10-23）。
           *
           * 由上层（`trader/agent/loop.ts`）通过 `chat()` 的 `tools` 参数传进来，
           * 这里原样透传给三家 adapter。探测请求（`probe`）刻意**不带** ——
           * 探测只回答"端点通不通、钥匙对不对"，让它带工具清单会改变
           * 那次请求的语义，而且白花 token。
           */
          ...(toolOverride?.tools !== undefined && toolOverride.tools.length > 0
            ? { tools: toolOverride.tools }
            : {}),
          ...(toolOverride?.toolChoice !== undefined
            ? { toolChoice: toolOverride.toolChoice }
            : {}),          /*
           * 思考等级。探测请求（`probe`）刻意**不带**它 ——
           * 探测只回答"这个端点通不通、这把钥匙对不对"，
           * 让一次连通性检查也去花思考预算是浪费。
           *
           * ⚠️ **超时过就把这一档降下来**（`effortFallback.ts`）。
           * 实测耗时几乎全在"想"上（一次 100K tokens 的请求 220 秒，
           * 其中推理占 2 万 tokens），而链路上的网关等 100 秒就发 `HTTP 524`。
           * 这不是"替模型决定想多深"，而是**把已经超时的那一轮救回来** ——
           * 判断内容一点没变。
           */
          ...(() => {
            const effort = nextReasoningEffort(this.reasoningEffort, this.timeoutCount);
            return effort !== undefined ? { reasoningEffort: effort } : {};
          })(),
        };

    /*
     * ⚠️ **同一个网关下，不同模型走不同协议 —— 必须按模型判，不能只看供应商。**
     *
     * 用户 2026-10-08 报「OpenCode GO 选 claude 用不了」。查它的文档
     * （<https://opencode.ai/docs/zh-cn/go/>）有一张端点表：
     *
     *   · `/v1/chat/completions` —— DeepSeek / GLM / Kimi / MiMo / LongCat…
     *   · `/v1/messages`         —— **Claude Haiku 5.5** / MiniMax / Qwen3.8
     *   · `/v1/responses`        —— Grok / GPT-6 Luna / Muse Spark
     *
     * 而原来这一行只看 `descriptor.openAiCompatible`（`opencode` 是 true），
     * 于是**所有模型都被发到 `/chat/completions`** —— claude 因此被网关拒收，
     * 报 `Model does not support this protocol.`。**端点表就在文档里，我们没照着实现。**
     *
     * 适配器本身**早就有了**（`llm/anthropic.ts`，`x-api-key` + `anthropic-version`
     * + `/messages`，与实测成功的请求完全一致）—— 缺的只是这一处分发。
     */
    if (this.usesAnthropicProtocol()) {
      return anthropic.buildRequest(
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
        /* 供应商自定义头必须跟着走 —— opencode 缺了 x-opencode-session 会被直接拒。 */
        this.descriptor.modelsHeaders ?? {},
      );
    }
    if (this.descriptor.openAiCompatible) {
      return openai.buildRequest(
        this.provider,
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
      );
    }
    if (this.provider === 'anthropic') {
      return anthropic.buildRequest(
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
      );
    }
    if (this.provider === 'gemini') {
      return gemini.buildRequest(this.apiKey, this.baseUrl, this.model, messages, bodyOptions);
    }
    throw new LlmError(`No adapter for provider ${this.provider}`, null, this.provider, false);
  }

  private async attempt(
    messages: ChatMessage[],
    startedAt: number,
    startedAtIso: string,
    options: ChatCallOptions = {},
  ): Promise<ChatResult> {
    const probe = options.probe === true;
    const request = this.buildRequest(messages, probe, options.maxTokens, {
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    });
    /*
     * ⚠️ **OpenAI 兼容的 provider 默认走流式**（探测请求除外）。
     *
     * 非流式要等整个响应生成完才返回响应头，而链路上的网关等 100 秒就发
     * `HTTP 524`；我们的请求实测 60–205 秒 —— **整轮决策作废**
     * （2026-10-01 实测：一轮 8 轮里 4 次）。见 `stream.ts`。
     *
     * `streamDisabled` 是一次性的自我降级：若某个网关**不接受**流式参数
     * （返回 400），这一实例此后就退回非流式 —— 不能让一个可选优化
     * 变成"每一轮都失败"。
     */
    /*
     * ⚠️ **Anthropic 路径必须排除在流式之外。**
     *
     * `executeStreamRequest(this.provider, …)` 是**按供应商**选解析器的 ——
     * `opencode` 会拿到 OpenAI 的 SSE 解析器，而 `/v1/messages` 返回的是
     * Anthropic 自己的事件格式（`content_block_delta` 等）。硬走流式会解析出空内容。
     *
     * 代价：claude 走非流式，而那条路要等整段生成完才回响应头 ——
     * 链路上的网关等 100 秒会发 `HTTP 524`。Haiku 是快模型（实测 1.8–4.6 秒），
     * 但**我们的提示词很大**，真撞上 524 时的正解是补 Anthropic 的 SSE 解析，
     * 而不是把它塞进 OpenAI 的解析器。**先把协议发对，再谈流式。**
     */
    const useStream =
      this.descriptor.openAiCompatible &&
      !probe &&
      !this.streamDisabled &&
      !this.usesAnthropicProtocol();
    /*
     * ⚠️ **两个取消源要合并：本客户端自己的超时 + 调用方传来的 signal。**
     *
     * 只有前者时，调用方（`AutoTrader.inCycle` 的硬超时）`abort()` 了也没用 ——
     * 请求会一直挂到 300 秒的单次上限。而那个硬超时正是为了把"卡住的轮次"
     * 收掉（2026-10-02：这类僵尸轮次累积到把服务器内存耗尽），
     * 所以它必须能真正打断网络等待。
     *
     * `AbortSignal.any` 是 Node 20.3+ 的能力，本项目要求 ≥22.5，可以用。
     * 任一信号触发都会中止这一跳；重试循环会照常进入下一次尝试，
     * 而那时 `signal.aborted` 仍为真 —— 上层会看到这一轮被判定为失败。
     */
    /*
     * ⚠️ **流式路径不能套"总时长超时"（2026-10-10，用户实测）。**
     *
     * 那条判据会误杀慢模型：≈30 tok/s 的模型回答长问题时，总时长必然比
     * 按 ≈300 tok/s 设计的阈值大得多 —— 于是它**一边正常吐字、一边被判失败**。
     * 流式自己按"多久没有数据"判定卡住（见 `http.ts` 的 `STREAM_IDLE_TIMEOUT_MS`），
     * 外层还有轮次硬超时兜底。
     */
    const signal = useStream
      ? /* 流式：只把调用方的取消信号交出去，"卡住"由 http 层判。 */
        (options.signal ?? new AbortController().signal)
      : options.signal === undefined
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), options.signal]);
    const response = useStream
      ? await executeStreamRequest(this.provider, request, {
          signal,
          timeoutMs: this.timeoutMs,
        })
      : await executeJsonRequest(this.provider, request, {
          signal,
          timeoutMs: this.timeoutMs,
          // MiniMax reports errors inside HTTP 200 bodies; every other provider
          // leaves this off so a `base_resp`-shaped field is never mis-read.
          failFastOnMinimaxBaseResp: this.provider === 'minimax',
        });

    const parsed = this.parse(response.body);
    const latencyMs = Date.now() - startedAt;

    // An empty answer is only acceptable when the provider says the output was
    // capped; otherwise it is a degenerate completion worth retrying.
    if (parsed.isEmpty && parsed.finishReason !== 'length') {
      throw emptyCompletionError(this.provider, response.body);
    }

    if (parsed.finishReason === 'length' && parsed.isEmpty) {
      log.warn(`${this.provider} 返回了空内容（finish_reason=length，输出被长度上限截断）`, {
        ...this.logOwner(options.context),
        provider: this.provider,
        model: parsed.model ?? this.model,
        startedAt: startedAtIso,
        hint: 'reasoning tokens likely consumed the whole output budget',
      });
    }

    /*
     * The concrete model the provider actually served. This differs from the
     * configured id on OpenRouter aliases and xAI `latest`, so it is logged.
     *
     * ⚠️ **只在它变化时打一次**（外部 issue #178）。
     *
     * 这个条件在别名 / `latest` 场景下**每次成功调用都成立**，所以原来
     * 用 `info` 级别打的话就是每次一行 —— 线上实测最近 300 行里 93 行（31%）
     * 是同一句，把排障页真正要看的决策/平仓/错误挤掉了近三分之一版面。
     *
     * 而它**不是无用信息**（"服务商真的换了模型"值得知道），所以不能简单删掉
     * 或降到 `debug`（那会让默认视图连信号一起丢）。正确的形态是**去重**：
     * 记住上一次的值，只在**变化**时打 —— 重复 93 遍没有信息量，"A → B"有。
     *
     * 首次出现仍然打一行（`lastServedModel` 初值为 `undefined`），
     * 这样"这台机器一直在用哪个具体模型"这件事在日志里始终有据可查。
     */
    if (parsed.model && parsed.model !== this.model && parsed.model !== this.lastServedModel) {
      log.info(`${this.provider} 回显的模型名与请求的不一致`, {
        ...this.logOwner(options.context),
        requested: this.model,
        served: parsed.model,
        previous: this.lastServedModel ?? null,
      });
    }
    /* 无论是否打日志都要记住 —— 否则"变化"永远检测不出来。 */
    if (parsed.model) this.lastServedModel = parsed.model;

    return {
      text: parsed.text,
      finishReason: parsed.finishReason,
      usage: parsed.usage ?? EMPTY_USAGE,
      model: parsed.model ?? this.model,
      latencyMs,
      raw: response.body,
      /* 原生 function calling 的产出（没有就不写这个字段 —— 见 `ChatResult.toolCalls`）。 */
      ...(parsed.toolCalls !== undefined ? { toolCalls: parsed.toolCalls } : {}),
    };
  }

  private parse(body: unknown): {
    text: string;
    finishReason: ChatResult['finishReason'];
    usage: ChatResult['usage'];
    model: string | null;
    isEmpty: boolean;
    toolCalls?: ToolCall[];
  } {
    /*
     * ⚠️ **顺序是契约：Anthropic 必须排在 `openAiCompatible` 之前。**
     *
     * `opencode` 的 `openAiCompatible` 是 true，所以只要那一行在前面，
     * 这个分支**永远不会被执行** —— 它的形状（用 `anthropic.parseResponse`）
     * 是真的，但永远不会被走到。**写了分支不等于接上了路径。**
     *
     * 2026-10-08 端到端实测就是这个症状：协议改对了、请求头也补齐了，
     * HTTP 已经 200，而报错是「No assistant text in opencode response」——
     * 因为响应用 OpenAI 的解析器去读 Anthropic 的
     * `{content:[{type:'text',text:…}]}`，自然一个字都读不出来。
     */
    if (this.usesAnthropicProtocol()) return anthropic.parseResponse(body, this.model);
    if (this.descriptor.openAiCompatible) {
      return openai.parseResponse(this.provider, body, this.model);
    }
    if (this.provider === 'gemini') return gemini.parseResponse(body, this.model);
    throw new LlmError(`No adapter for provider ${this.provider}`, null, this.provider, false);
  }
}

export type { ChatMessage, ChatResult } from './types.js';
