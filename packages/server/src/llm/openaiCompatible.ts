import { getProvider, type LlmProviderId } from '@aq/shared';
import { joinUrl } from './http.js';
import { LlmError, emptyCompletionError } from './errors.js';
import {
  normalizeUsage,
  splitSystem,
  type ChatMessage,
  type FinishReason,
  type OutboundRequest,
  type ToolCall,
  type ToolSpec,
  type WireUsage,
} from './types.js';

/**
 * One adapter for OpenAI and every provider whose descriptor sets
 * `openAiCompatible: true` (DeepSeek, Qwen, Grok, Kimi, MiniMax, OpenRouter,
 * custom). The dialect is shared; the deviations are not, so each one is
 * handled explicitly below rather than being "just forwarded".
 */

export interface OpenAiBodyOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
  /**
   * **原生 function calling 的工具清单**（2026-10-23）。
   *
   * 直接透传成 OpenAI 的 `tools` 数组。见 `types.ts` 里 `ChatRequest.tools`
   * 那段说明 —— 这是把"模型自己写 tool 字段"（实测 53% 成功率）
   * 换成"协议保证的 tool_calls"的关键一步。
   */
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * 思考等级，翻译成 OpenAI 的 `reasoning_effort`。
   *
   * ## 为什么默认只在"确认支持"时才发
   *
   * 这是**一个会让整条调用链失败的风险**：不支持的 provider 收到未知参数
   * 可能返回 400，而 400 被正确地归为"不可重试"（重试改变不了结果）——
   * 于是**每一轮决策都会失败**。
   *
   * 所以只对已知支持的 provider 发。`custom` 是"用户自填的 OpenAI 兼容端点"，
   * 能力未知，**由调用方用一个显式开关决定**（见 `LlmClient` 的降级逻辑：
   * 第一次带上，被拒就立刻去掉重来一次）。
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * ⚠️ **是否用 SSE 流式请求（默认 false 保持原行为）。**
   *
   * 见 `stream.ts` 的说明：非流式要等**整个响应生成完**才返回响应头，
   * 而链路上的网关（Cloudflare）等 **100 秒**没有响应头就发 `HTTP 524`。
   * 我们的请求实测 60–205 秒，于是**整轮决策作废**（实测一轮 8 轮里 4 次）。
   *
   * 流式让源站**一连上就返回响应头**，网关的计时不再是问题；
   * 而客户端仍然读到流结束才返回，对上层透明。
   */
  stream?: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/* -------------------------------------------------------------------------- */
/*  Per-provider capability flags                                              */
/* -------------------------------------------------------------------------- */

/**
 * Kimi documents `temperature`, `top_p`, `n` and both penalties as
 * unmodifiable on current models: "passing other values returns an error"
 * (B.7). `n` and the penalties are never sent by this layer, so only
 * temperature needs gating.
 */
export function rejectsSamplingParameters(provider: LlmProviderId): boolean {
  return provider === 'kimi';
}

/**
 * MiniMax's OpenAI-compatible endpoint has **no** `response_format` in its
 * schema (B.8), so sending one is at best ignored and at worst a 400. The
 * layer therefore never claims structured output for it.
 */
export function supportsResponseFormat(provider: LlmProviderId): boolean {
  return provider !== 'minimax';
}

/** Providers that accept `response_format: {type:'json_schema'}` (B.15). */
export function supportsStrictSchema(provider: LlmProviderId): boolean {
  switch (provider) {
    case 'openai':
    case 'grok':
    case 'kimi':
    case 'qwen':
      return true;
    // DeepSeek has no strict schema at all; MiniMax's only lives on the native
    // v2 endpoint; OpenRouter merely passes the schema through unenforced.
    case 'deepseek':
    case 'minimax':
    case 'openrouter':
    case 'custom':
    default:
      return false;
  }
}

/**
 * Token-cap parameter name.
 *
 * OpenAI, xAI, MiniMax and Kimi deprecate `max_tokens` in favour of
 * `max_completion_tokens`; OpenAI's variant is also the only one accepted by
 * the o-series. DeepSeek, Qwen and OpenRouter still document `max_tokens`, and
 * DeepSeek's range (1–393216) only exists there.
 */
export function maxTokensField(provider: LlmProviderId): 'max_completion_tokens' | 'max_tokens' {
  switch (provider) {
    case 'openai':
    case 'grok':
    case 'minimax':
    case 'kimi':
      return 'max_completion_tokens';
    default:
      return 'max_tokens';
  }
}

/* -------------------------------------------------------------------------- */
/*  Request building                                                           */
/* -------------------------------------------------------------------------- */

export function buildBody(
  provider: LlmProviderId,
  model: string,
  messages: ChatMessage[],
  options: OpenAiBodyOptions = {},
): JsonObject {
  const { system, messages: turns } = splitSystem(messages);

  // Qwen accepts the system role only at `messages[0]`, so the canonical
  // "system is separate" split maps onto it exactly.
  /*
   * ⚠️ **`tool` 角色与 `assistant.tool_calls` 必须原样映射**（2026-10-23）。
   *
   * 原生 function calling 的三条消息形状：
   * ```jsonc
   *   {"role":"assistant","content":null,"tool_calls":[…]}
   *   {"role":"tool","tool_call_id":"call_abc","content":"{\"ok\":true}"}
   *   {"role":"assistant","content":"最终回答"}
   * ```
   * 只写 `{role, content}` 会把 `tool_call_id` 丢掉 —— 而那是**把工具结果
   * 与具体调用对上**的唯一凭据，丢了以后模型会认为"这段结果没人问过"，
   * 表现是它反复调同一个工具、或者干脆回一句"我没有相关信息"。
   */
  const wireMessages: JsonObject[] = turns.map((m) => {
    const base: JsonObject = { role: m.role, content: m.content };
    if (m.role === 'tool' && m.toolCallId !== undefined) {
      base['tool_call_id'] = m.toolCallId;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      base['tool_calls'] = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
      /*
       * OpenAI 要求带工具调用的 assistant 消息 `content` 为 null 或省略；
       * 传空字符串在某些兼容网关上会被判成 invalid_request。
       */
      if (m.content.length === 0) base['content'] = null;
    }
    return base;
  });
  if (system !== undefined) wireMessages.unshift({ role: 'system', content: system });

  const body: JsonObject = {
    model,
    messages: wireMessages,
    stream: options.stream === true,
  };
  /*
   * 流式下 `usage` 默认**不返回**（OpenAI 的行为，多数兼容网关照抄）。
   * 而用量是计费与"缓存命中率"展示的唯一来源 —— 所以显式要它。
   */
  if (options.stream === true) {
    body['stream_options'] = { include_usage: true };
  }

  if (options.temperature !== undefined && !rejectsSamplingParameters(provider)) {
    body['temperature'] = options.temperature;
  }

  if (options.maxTokens !== undefined) {
    body[maxTokensField(provider)] = options.maxTokens;
  }

  /*
   * 思考等级。
   *
   * **这里不做 provider 能力判断** —— 判断留给调用方，理由是它需要
   * 一次失败才能知道答案（`custom` 是用户自填的端点，没有可查的能力表）。
   * 本函数只负责把调用方决定要发的值翻译成线上的字段名。
   */
  if (options.reasoningEffort !== undefined) {
    body['reasoning_effort'] = options.reasoningEffort;
  }

  if (supportsResponseFormat(provider)) {
    if (options.jsonMode === true) {
      // A strict schema supersedes loose JSON mode where both are requested.
      if (options.jsonSchema && supportsStrictSchema(provider)) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema: options.jsonSchema,
          },
        };
      } else {
        body['response_format'] = { type: 'json_object' };
      }
    }
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  原生 function calling（2026-10-23）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么加这一段
   *
   * 实测 `#10`（智能托管）：`agent_runs` 里 **ok 85 / failed 74（53% 成功率）**，
   * 失败原因几乎全是同一句：
   * ```
   *   "JSON 解析成功，但里面没有 tool 字段 —— 你只写了 thought"
   * ```
   * 而提示词里已经用 5 处整段警告反复强调那个格式，**模型仍然不听**。
   * 根本原因：「在自由文本里遵守一个格式约定」是模型的弱项，不是它不配合。
   *
   * 原生 function calling 由 API 参数把工具清单传下去，模型返回结构化的
   * `tool_calls` —— **"忘了写 tool 字段"这种失败形态在协议上就不存在了**。
   *
   * ## 与 `response_format` 的互斥
   *
   * 两者**不能同时发**：`tools` 要求模型在"调工具"和"直接回答"之间选，
   * 而 `response_format: json_object` 强制它必须吐一个 JSON 对象。
   * 同时发会让某些 provider 直接 400，另一些会让模型永远不调工具。
   * ⇒ 调用方给了 `tools` 就以 tools 为准（那说明它要的就是工具循环）。
   */
  if (options.tools !== undefined && options.tools.length > 0) {
    body['tools'] = options.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body['tool_choice'] = options.toolChoice ?? 'auto';
    /*
     * tools 模式下必须撤掉 response_format —— 见上面那段互斥说明。
     * 用 delete 而不是"不写"，因为上面可能已经按 jsonMode 写进去了。
     */
    delete body['response_format'];
  }

  return body;
}

export function buildRequest(
  provider: LlmProviderId,
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: OpenAiBodyOptions = {},
): OutboundRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  // OpenRouter attribution headers. Harmless but only documented there, so
  // they are scoped to it instead of being sent to every vendor.
  if (provider === 'openrouter') {
    headers['http-referer'] = 'https://github.com/auto-quant';
    headers['x-openrouter-title'] = 'auto-quant';
  }

  /*
   * OpenCode GO 要求 `x-opencode-session`。它的用途是**会话粘性路由** ——
   * 把同一个会话的请求送到同一个后端（所以值是"任意稳定、非空的字符串"，
   * 关键是每次请求都一样）。用一个固定串即可：单实例部署下所有请求本就是同一会话。
   *
   * ⚠️ 实测（2026-10-04）**不带这个头也能通**，但文档明确要求，而代价只是一个 header。
   * 这类"上游随时可能收紧"的隐性要求，等它真变成硬要求才发现，表现会是
   * "昨天还好好的" —— 而那时排查会从"我们的代码改了什么"开始，方向就是错的。
   *
   * 见 `packages/shared/src/llm.ts` 里 `opencode` 那段：用户上一次失败**其实**
   * 是因为基础 URL 多写了 `/chat/completions`（路径被拼了两次），
   * 而服务端回的却是那句关于 session 头的报错 —— **报错信息把人引向了错误的方向**。
   */
  if (provider === 'opencode') {
    headers['x-opencode-session'] = OPENCODE_SESSION;
  }

  return {
    url: joinUrl(baseUrl, 'chat/completions'),
    headers,
    body: buildBody(provider, model, messages, options),
  };
}

/**
 * OpenCode GO 的会话标识 —— 固定值，见 `buildRequest` 里的说明。
 *
 * 不用随机 UUID：随机值会让**每次请求都被路由到不同的后端**，
 * 那恰好是这个头要避免的事（会话粘性）。
 */
export const OPENCODE_SESSION = 'auto-quant';

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `content` may be a string, an array of content parts (Qwen-VL and others),
 * or `null` when a refusal or a reasoning-only finish consumed the output.
 * Reading it as a bare string is a real failure mode.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = asObject(part);
        if (!record) return '';
        const text = record['text'];
        if (typeof text === 'string') return text;
        const nested = asObject(text);
        return nested && typeof nested['value'] === 'string' ? String(nested['value']) : '';
      })
      .join('');
  }
  const record = asObject(content);
  if (record && typeof record['text'] === 'string') return String(record['text']);
  return '';
}

/**
 * MiniMax embeds thinking in `content` inside `<think>…</think>` unless
 * `reasoning_split` is set. Feeding that to a decision parser corrupts it, so
 * the tags are stripped and the reasoning is dropped (B.8).
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
}

/** Collapse each provider's `finish_reason` enum onto the canonical set (B.12). */
export function normalizeFinishReason(raw: unknown): FinishReason {
  const value = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'max_output_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
    case 'refusal':
    case 'safety':
    case 'prohibited_content':
    case 'blocklist':
    case 'recitation':
    case 'spii':
    case 'image_safety':
      return 'content_filter';
    // DeepSeek's two extras are abnormal terminations, not normal stops.
    case 'insufficient_system_resource':
    case 'aborted':
      return 'error';
    case 'error':
      return 'error';
    case '':
      return 'unknown';
    default:
      // Unknown values must not be silently dropped or crash the caller; they
      // map to `error` so a new provider enum surfaces loudly (B.12 trap 3).
      return 'error';
  }
}

export interface OpenAiParsedResponse {
  text: string;
  finishReason: FinishReason;
  usage: ReturnType<typeof normalizeUsage>;
  model: string | null;
  /** True when the provider returned HTTP 200 with no assistant text at all. */
  isEmpty: boolean;
  /**
   * 模型这一轮要调的工具（原生 function calling，2026-10-23）。
   *
   * `undefined` = 响应里没有 `tool_calls` 字段（老路径 / 模型选择直接回答）。
   * `[]` **不会出现** —— 空数组没有信息量，与"没有"合并成 `undefined`，
   * 免得上层要区分两种"没工具"的状态。
   */
  toolCalls?: ToolCall[];
}

/**
 * 从 OpenAI 响应的 `message.tool_calls` 里取出调用列表。
 *
 * ## 为什么要单独抽一个函数
 *
 * 形状校验有三处易错点，而它们在流式与非流式两条路径上**完全一样**：
 * ```jsonc
 *   ① `function.arguments` 是**字符串**不是对象（有的网关会错发成对象）
 *   ② 并行调多个工具时每一项都有独立 `id`
 *   ③ `id` 缺失时必须补一个稳定值 —— 否则回传工具结果时对不上
 * ```
 * 复制两份的话，流式那条最早会在"某家网关把 arguments 发成对象"时炸掉，
 * 而那种故障只在部分 provider 上出现，很难在测试里覆盖到。
 */
export function extractToolCalls(message: JsonObject | null): ToolCall[] | undefined {
  if (message === null) return undefined;
  const raw = message['tool_calls'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: ToolCall[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = asObject(item);
    if (!entry) continue;
    const fn = asObject(entry['function']);
    if (!fn) continue;
    const name = typeof fn['name'] === 'string' ? fn['name'] : '';
    if (name === '') continue;
    /*
     * `arguments` 规范上是字符串，但实测有网关直接发对象。
     * 两种都要接受 —— 拒掉的话那一次工具调用会**静默消失**，
     * 而模型会以为它调过了，于是不再重试。
     */
    const argsRaw = fn['arguments'];
    const argsText =
      typeof argsRaw === 'string'
        ? argsRaw
        : argsRaw === undefined || argsRaw === null
          ? '{}'
          : JSON.stringify(argsRaw);
    const id = typeof entry['id'] === 'string' && entry['id'] !== '' ? entry['id'] : `call_${index}`;
    out.push({ id, name, arguments: argsText });
  }
  return out.length > 0 ? out : undefined;
}

export function parseResponse(
  provider: LlmProviderId,
  body: unknown,
  fallbackModel: string,
): OpenAiParsedResponse {
  const root = asObject(body);
  if (!root) throw emptyCompletionError(provider, body);

  const choices = root['choices'];
  const first = Array.isArray(choices) ? asObject(choices[0]) : null;
  if (!first) throw emptyCompletionError(provider, body);

  const message = asObject(first['message']) ?? {};
  let text = extractText(message['content']);
  if (provider === 'minimax') text = stripThinkTags(text);

  const usage = normalizeUsage(asObject(root['usage']) as WireUsage | null);
  const model = typeof root['model'] === 'string' ? String(root['model']) : fallbackModel;
  let finishReason = normalizeFinishReason(first['finish_reason']);
  const toolCalls = extractToolCalls(message);

  /*
   * ⚠️ **有 tool_calls 时必须把 `finishReason` 归到 `tool_calls`**
   *（2026-10-23）。
   *
   * 有些兼容网关在带工具调用时仍报 `finish_reason: "stop"`。上层用
   * `finishReason` 判断"这一轮是不是结束了"—— 若它看到 `stop` 就当成
   * 最终回答，那**工具调用永远不会被执行**，模型会一直等着一个
   * 它以为已经发生的工具结果。那正是"表面成功、实际空转"的形态。
   */
  if (toolCalls !== undefined) finishReason = 'tool_calls';

  // MiniMax severe moderation yields empty content flagged by these fields.
  if (
    text.trim() === '' &&
    (root['output_sensitive'] === true || message['output_sensitive'] === true)
  ) {
    throw new LlmError('Output blocked by provider moderation', 200, provider, false, body, {
      kind: 'content_filter',
    });
  }

  // A refusal arrives as HTTP 200 with `finish_reason: "stop"` and empty
  // content (B.1) — a naive parser reads that as a successful empty answer.
  if (text.trim() === '') {
    const refusal = message['refusal'];
    if (typeof refusal === 'string' && refusal.trim() !== '') {
      text = refusal;
      finishReason = 'content_filter';
    }
  }

  /*
   * `isEmpty` 的判据要带上工具调用：一个**只发起工具调用、没有说话**的响应
   * 不是"空回复"，它是工具循环的正常一轮。判成空会让上层当成异常重试。
   */
  return {
    text,
    finishReason,
    usage,
    model,
    isEmpty: text.trim() === '' && toolCalls === undefined,
    toolCalls,
  };
}

/** Convenience for the client: the descriptor default base URL when none is given. */
export function defaultBaseUrl(provider: LlmProviderId): string {
  return getProvider(provider).baseUrl;
}
