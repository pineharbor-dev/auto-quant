import { joinUrl } from './http.js';
import { emptyCompletionError } from './errors.js';
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
 * Native Anthropic Messages API (`POST /v1/messages`).
 *
 * Three structural differences from the OpenAI dialect drive this file: auth is
 * `x-api-key` + `anthropic-version` with no bearer, the system prompt is a
 * top-level field rather than a message, and the response body is an array of
 * typed content blocks.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

/** `max_tokens` is required by the API, so a caller that omits it still gets a valid body. */
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicBodyOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
  /** 原生 function calling 的工具清单（2026-10-23，见 `types.ts` 的 `ChatRequest.tools`）。 */
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/* -------------------------------------------------------------------------- */
/*  Model capability                                                           */
/* -------------------------------------------------------------------------- */

/** Single-digit major version from an id like `claude-opus-5` or `claude-sonnet-4-5-20250929`. */
function generationOf(model: string): { major: number; minor: number } | null {
  const match = /claude-[a-z]+-(\d+)(?:[.-](\d+))?/i.exec(model);
  if (!match || match[1] === undefined) return null;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return Number.isFinite(major) ? { major, minor } : null;
}

/**
 * Models after Opus 4.6 deprecate `temperature`/`top_p`/`top_k`: `temperature`
 * accepts only `1.0` and `top_p` only ≥ 0.99, everything else is a 400 (B.3).
 * A provider-agnostic layer that forwards the user's temperature breaks on
 * current Claude models, so sampling knobs are dropped for these.
 */
export function rejectsSamplingParameters(model: string): boolean {
  if (/fable|mythos/i.test(model)) return true;
  const generation = generationOf(model);
  if (!generation) return false;
  if (generation.major >= 5) return true;
  if (generation.major === 4) return generation.minor >= 7;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Request building                                                           */
/* -------------------------------------------------------------------------- */

export function buildBody(
  model: string,
  messages: ChatMessage[],
  options: AnthropicBodyOptions = {},
): JsonObject {
  const { system, messages: turns } = splitSystem(messages);

  // Consecutive same-role turns are merged server-side; the first message must
  // be `user`, which the strategy engine's prompt construction already ensures.
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **Anthropic 的工具消息形状与 OpenAI 完全不同**（2026-10-23）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * | | OpenAI | Anthropic |
   * |---|---|---|
   * | 模型发起调用 | `message.tool_calls[]` | `content[]` 里一个 `{type:'tool_use'}` 块 |
   * | 回传结果 | `role:'tool'` + `tool_call_id` | `role:'user'`，content 里 `{type:'tool_result', tool_use_id}` |
   * | 工具声明 | `tools:[{type:'function',function:{…}}]` | `tools:[{name,description,input_schema}]` |
   *
   * ⚠️ **Anthropic 根本没有 `tool` 角色** —— 工具结果要以 `user` 身份、
   * 以 `tool_result` 内容块的形式回传。直接照抄 OpenAI 的 `role:'tool'`
   * 会被拒（`role: tool is not supported`）。
   */
  const wireMessages: JsonObject[] = turns.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      /*
       * 助手消息：文字块 + 若干个 tool_use 块（同一轮可以并行调多个）。
       * 文字为空时只放 tool_use 块 —— 塞一个空 text 块会被判 invalid。
       */
      const blocks: JsonObject[] = [];
      if (m.content !== '') blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments);
        } catch {
          /* 参数不是合法 JSON：留空对象，让模型在下一轮看到"工具没收到参数"而不是整轮炸掉。 */
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      return { role: 'assistant', content: blocks };
    }
    return { role: m.role, content: m.content };
  });

  const body: JsonObject = {
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: wireMessages,
    stream: false,
  };

  // `system` is top-level. There is no `system` role in `messages` at all.
  if (system !== undefined) body['system'] = system;

  if (options.temperature !== undefined && !rejectsSamplingParameters(model)) {
    body['temperature'] = options.temperature;
  }

  // Anthropic's native structured output. Note it takes the schema directly,
  // unlike OpenAI's `json_schema: {name, strict, schema}` wrapper. With no
  // schema there is no native JSON mode at all — JSON has to be requested in
  // the prompt — so nothing is emitted rather than a degenerate empty schema
  // that would force `{}` as the answer.
  if (options.jsonMode === true && options.jsonSchema) {
    body['output_config'] = {
      format: { type: 'json_schema', schema: options.jsonSchema },
    };
  }

  /*
   * 原生 function calling（2026-10-23）。
   *
   * Anthropic 的声明形状：`{name, description, input_schema}` —— 没有
   * OpenAI 那层 `{type:'function', function:{…}}` 包装，且 schema 字段叫
   * `input_schema` 而不是 `parameters`。照抄 OpenAI 的形状会被网关拒收。
   *
   * ⚠️ 与 `output_config` 的 `json_schema` **互斥**：要求"必须吐某个 schema
   * 的 JSON"和"你可以选择调工具"是两条相反的指令，同时发会让模型永远
   * 不调工具（它被约束成只能输出那个 schema）。
   */
  if (options.tools !== undefined && options.tools.length > 0) {
    body['tools'] = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    /*
     * Anthropic 的 `tool_choice` 形状也与 OpenAI 不同：
     *   auto     → {type:'auto'}
     *     required → {type:'any'}          ← 名字完全不一样
     *   none     → 省略（没有 'none' 这个 type）
     */
    const choice = options.toolChoice;
    if (choice === 'required') body['tool_choice'] = { type: 'any' };
    else if (choice === 'auto') body['tool_choice'] = { type: 'auto' };
    delete body['output_config'];
  }

  return body;
}

export function buildRequest(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: AnthropicBodyOptions = {},
  /**
   * 供应商自己要求的额外请求头（见 `LlmProviderDescriptor.modelsHeaders`）。
   *
   * ## 为什么必须有这个参数（2026-10-08 端到端实测）
   *
   * OpenCode Go 对**所有**端点都强制要求 `x-opencode-session`：缺了它回
   * `400 MissingSessionID`（「Request is missing x-opencode-session and cannot be
   * routed efficiently」）。而 OpenAI 兼容那条路一直带着它（走 `modelsHeaders`），
   * **Anthropic 这条路没带** —— 于是 `claude-haiku-5-5` 改道到 `/v1/messages` 之后
   * 仍然失败，报的还是一样的缺头错误。
   *
   * 换句话说：**协议改对了，但请求头没跟着搬过去。** 端到端实测（用应用自己的
   * LlmClient 真发一次）才暴露出来 —— 单测和编译都不会。
   */
  extraHeaders: Record<string, string> = {},
): OutboundRequest {
  return {
    url: joinUrl(baseUrl, 'messages'),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      /* 放在默认头之后：供应商要覆盖什么就覆盖什么（例如它自己的 anthropic-version）。 */
      ...extraHeaders,
    },
    body: buildBody(model, messages, options),
  };
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Join only the blocks whose `type === 'text'`.
 *
 * `content` is an array of typed blocks and a `thinking` or `redacted_thinking`
 * block can come first, so `content[0].text` is not the assistant answer
 * (Anthropic's own docs use `next(b.text for b in content if b.type == 'text')`).
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asObject(block);
      if (!record || record['type'] !== 'text') return '';
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .join('');
}

/** Collapse `stop_reason` onto the canonical set (B.12). */
export function normalizeStopReason(raw: unknown): FinishReason {
  switch (typeof raw === 'string' ? raw.toLowerCase().trim() : '') {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      // A server-tool pause is not a completed answer.
      return 'error';
    case '':
      return 'unknown';
    default:
      return 'error';
  }
}

export interface AnthropicParsedResponse {
  text: string;
  finishReason: FinishReason;
  usage: ReturnType<typeof normalizeUsage>;
  model: string | null;
  isEmpty: boolean;
  /** 原生 function calling 的产出（2026-10-23）。`undefined` = 这一轮没调工具。 */
  toolCalls?: ToolCall[];
}

/**
 * 从 Anthropic 的 `content[]` 里取出 `tool_use` 块（2026-10-23）。
 *
 * Anthropic 把工具调用放在**内容块数组**里，与文字块并列：
 * ```jsonc
 *   {"content":[
 *     {"type":"text","text":"我先看一下…"},
 *     {"type":"tool_use","id":"toolu_01","name":"get_performance","input":{"window":"7d"}}
 *   ]}
 * ```
 * ⇒ `input` 是**对象**（OpenAI 是字符串），归一化时要 `JSON.stringify` 回去 ——
 * 否则上游（`loop.ts`）拿到的是一个形状不定的东西，解析路径要分两家写。
 */
export function extractToolCalls(content: unknown): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ToolCall[] = [];
  for (const [index, block] of content.entries()) {
    const item = asObject(block);
    if (!item || item['type'] !== 'tool_use') continue;
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    if (name === '') continue;
    const id = typeof item['id'] === 'string' && item['id'] !== '' ? item['id'] : `toolu_${index}`;
    const input = item['input'];
    const argsText =
      typeof input === 'string'
        ? input
        : input === undefined || input === null
          ? '{}'
          : JSON.stringify(input);
    out.push({ id, name, arguments: argsText });
  }
  return out.length > 0 ? out : undefined;
}

export function parseResponse(
  body: unknown,
  fallbackModel: string,
): AnthropicParsedResponse {
  const root = asObject(body);
  if (!root) throw emptyCompletionError('anthropic', body);

  const usage = normalizeUsage(asObject(root['usage']) as WireUsage | null);
  const model = typeof root['model'] === 'string' ? String(root['model']) : fallbackModel;
  const text = extractText(root['content']);
  const toolCalls = extractToolCalls(root['content']);

  /*
   * ⚠️ 有 tool_use 块时 `finishReason` 必须是 `tool_calls`。
   * Anthropic 通常自己报 `stop_reason: "tool_use"`，但也有网关把它写成
   * `end_turn` —— 那时上层会以为"这是最终回答"，**工具永远不会被执行**。
   */
  const finishReason = toolCalls !== undefined ? 'tool_calls' : normalizeStopReason(root['stop_reason']);

  return {
    text,
    finishReason,
    usage,
    model,
    /* 只发起工具调用、没有说话，是工具循环的正常一轮 —— 不是空回复。 */
    isEmpty: text.trim() === '' && toolCalls === undefined,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}
