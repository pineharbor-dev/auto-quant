/**
 * Internal, provider-neutral contract for the LLM layer.
 *
 * Everything above this directory speaks these types only; each adapter is
 * responsible for translating them into one vendor's wire dialect and back.
 * See `docs/research/binance-ws-and-llm-apis.md` Part B for the per-provider
 * detail being absorbed here.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * `role === 'tool'` 时必填：这条消息回答的是哪个工具调用。
   *
   * ## 为什么需要它（原生 function calling 的协议要求）
   *
   * OpenAI 协议里工具结果必须回传成：
   * ```jsonc
   *   {"role":"assistant","tool_calls":[{"id":"call_abc","function":{…}}]}
   *   {"role":"tool","tool_call_id":"call_abc","content":"{\"ok\":true}"}
   * ```
   * `tool_call_id` 是**把结果与具体调用对上**的唯一凭据 —— 少了它，
   * 模型不知道这段结果是回答哪一问的（一次可以并行调多个工具）。
   */
  toolCallId?: string;
  /**
   * `role === 'tool'` 时填：这个结果回答的是**哪个工具**。
   *
   * ## 为什么既要有 id 又要有 name
   *
   * 两家协议关联方式不同：
   * ```
   *   OpenAI  → 靠 tool_call_id 关联
   *   Gemini  → 靠工具名（functionResponse.name）关联，它没有 id 这个概念
   * ```
   * 只存 id 的话，Gemini 那条路就必须回查历史消息才能反推工具名 ——
   * 而那是"在 adapter 里做本该由调用方记录的事"，很容易在裁剪上下文后失配。
   */
  toolName?: string;
  /** `role === 'assistant'` 且这一轮要调工具时填。 */
  toolCalls?: ToolCall[];
}

/** 模型发起的一次工具调用（各家 provider 归一化后的形状）。 */
export interface ToolCall {
  /** provider 给的调用 id；回传工具结果时必须带上。 */
  id: string;
  /** 工具名。 */
  name: string;
  /**
   * 参数字符串（**不是对象**）。
   *
   * ⚠️ 保留原文而不是提前 `JSON.parse`：模型偶尔会吐出不合法的 JSON，
   * 提前解析会让那一次调用直接变成"失败"，而原文至少能进审计日志、
   * 也能让上层决定是重试还是放弃。解析发生在真正要用它的地方。
   */
  arguments: string;
}

/** 工具声明（`tools` 参数里的一项）。 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（object 根）。 */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for machine-readable JSON when it supports it. */
  jsonMode?: boolean;
  /** Optional JSON schema, used only where the provider supports strict schemas (see B.15). */
  jsonSchema?: Record<string, unknown>;
  /**
   * **原生 function calling 的工具清单**（2026-10-23）。
   *
   * ## 为什么要有它（一次实测 47% 失败率的根因）
   *
   * 原来我们让模型自己在 JSON 里写
   * `{"thought":"…","tool":"get_performance","args":{…}}`，再由代码解析 `tool` 字段。
   * 实测 `#10`（智能托管）：
   * ```
   *   agent_runs: ok 85 / failed 74  → 成功率 53%
   *   失败原因几乎全是同一句：
   *     "模型连续两轮没有输出可解析的工具调用：
   *      JSON 解析成功，但里面没有 tool 字段 —— 你只写了 thought"
   * ```
   * 而提示词已经用整段篇幅反复强调这个格式（`loop.ts` 里 5 处警告），
   * **模型仍然不听** —— 「在自由文本里遵守一个格式约定」本来就是它的弱项。
   *
   * 原生 function calling 把这件事从「模型自觉」变成「协议保证」：
   * 工具清单由 API 参数传下去，模型返回结构化 `tool_calls`，
   * **不存在"忘了写 tool 字段"这种失败形态**。
   *
   * ⚠️ **三家 provider 都要实现**（OpenAI 兼容 / Anthropic / Gemini 的 wire 格式
   * 各不相同）—— 只做一家会在换模型时静默退化回旧的 JSON 解析路径。
   */
  tools?: ToolSpec[];
  /** 强制/建议如何选工具。不传 = 由模型决定。 */
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * 请求模型在回答前思考多久。
   *
   * ## 为什么这是一个交易参数，而不是一个技术开关
   *
   * 这个机器人的每一轮决策都是「看一遍行情、判断该不该动」——
   * 一次判断的代价可能是一笔真实的盈亏。**思考预算花在这里是值得的**：
   * 多花几秒和几百个 token，换一个更审慎的判断。
   *
   * ## 名字沿用各家 API 的叫法
   *
   * OpenAI 系把它叫 `reasoning_effort`。这里保留同一个词，
   * 免得又多一个「我们自己发明的名字」需要对照。
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /**
   * `promptTokens` 里有多少**命中了上下文缓存**。
   *
   * `null` = 服务商没报这个字段（**不知道**）；`0` = 报了，确实没命中。
   * 两者的结论完全相反，**绝不能合成一个数**。
   */
  cachedTokens: number | null;
  /** `completionTokens` 里有多少花在思考上。计入 completion。 */
  reasoningTokens: number | null;
}

/** Canonical stop reasons; every provider enum in B.12 collapses into these. */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'unknown';

export interface ChatResult {
  text: string;
  /** Normalised across providers — see B.12. */
  finishReason: FinishReason;
  usage: ChatUsage;
  model: string;
  latencyMs: number;
  /** Raw provider payload, kept for the audit trail. */
  raw: unknown;
  /**
   * 模型这一轮要调的工具（原生 function calling 的产出）。
   *
   * ## 与 `text` 的关系
   *
   * 两者**可以同时非空**：模型可能先说一句话、再调工具。
   * 也可能只有 `toolCalls`（`finishReason === 'tool_calls'`）或只有文字。
   *
   * ⚠️ **空数组和 `undefined` 不是一回事**：
   * - `undefined` = 这次请求根本没带 `tools`（老路径，或者 provider 不支持）
   * - `[]`       = 带了 `tools`，但模型这一轮选择不调
   *
   * 上层据此决定"该等工具结果"还是"该把它当最终回答"—— 混成一个会让
   * 一轮本该结束的对话卡在等一个永远不来的工具调用上。
   */
  toolCalls?: ToolCall[];
}

/** Usage as every provider eventually spells it, before normalisation. */
export interface WireUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Gemini reports `responseTokenCount`; older payloads use the snake_case twin. */
  candidatesTokenCount?: number | null;
  candidates_token_count?: number | null;
  /** The typedoc name for Gemini's output-token count; either name may arrive. */
  responseTokenCount?: number | null;
  promptTokenCount?: number | null;
  totalTokenCount?: number | null;
  /**
   * OpenAI 系把缓存命中与思考 token 放在**嵌套对象**里，
   * 而且这两个对象**只有部分服务商返回**。
   *
   * 所以它们是可选的，且读不到时归一化成 `null`（不知道）而不是 `0`。
   */
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  completion_tokens_details?: {
    reasoning_tokens?: number | null;
  } | null;
  /**
   * ⚠️ **DeepSeek 原生把缓存命中放在【顶层】，不在上面那个嵌套对象里。**
   *
   * 用户 2026-10-07 问「为什么缓存一直是 0%」，并让我去看官方文档。官方新闻页
   * （<https://api-docs.deepseek.com/zh-cn/news/news0802/>）写明：DeepSeek 的
   * 上下文硬盘缓存按 **`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`**
   * 报告，而**不是** OpenAI 的 `prompt_tokens_details.cached_tokens`。
   *
   * 这份代码原来只读后者，于是在 DeepSeek 系（含通过第三方网关跑的
   * `deepseek-v4.1-flash`）上**永远读到 0** —— 界面上就一直显示「缓存 0%」，
   * 即使服务商那边其实命中了。同类实现踩过一模一样的坑
   * （见 Hermes 的 issue「direct DeepSeek API cache-hit tokens never extracted」）。
   *
   * 读不到仍然归一化成 `null`（不知道），不冒充 0。
   */
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
}

/** A fully-formed HTTP call, ready for `fetch`. Produced by each adapter. */
export interface OutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Non-empty system prompt, if the caller supplied one. */
export interface ConversationParts {
  system?: string;
  messages: ChatMessage[];
}

export const EMPTY_USAGE: ChatUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
};

/** Split a canonical message list into its system prompt and turn list. */
export function splitSystem(messages: ChatMessage[]): ConversationParts {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();
  return {
    system: system.length > 0 ? system : undefined,
    messages: messages.filter((m) => m.role !== 'system'),
  };
}

/** Provider counters are optional and sometimes strings; keep `null` for "not reported". */
export function toTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Normalise the many usage spellings into the canonical triple. */
export function normalizeUsage(usage: WireUsage | null | undefined): ChatUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const prompt = toTokenCount(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? null,
  );
  const completion = toTokenCount(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount ??
      usage.candidates_token_count ??
      // Gemini's own docs disagree on this name, so both are accepted rather
      // than hard-coding one and silently reporting null.
      usage.responseTokenCount ??
      null,
  );
  const total = toTokenCount(usage.total_tokens ?? usage.totalTokenCount ?? null);

  /*
   * **缓存命中与思考 token。**
   *
   * ## `null` 和 `0` 是两件事，绝不能混
   *
   *   · `0`  —— 服务商报了，这一轮**确实一个 token 都没命中缓存**
   *   · `null` —— 服务商**根本没报这个字段**，我们不知道
   *
   * 把它们合成 `?? 0` 会让"不支持上报的 provider"看起来像"缓存全没命中"，
   * 而这两件事的结论完全相反：前者该换供应商，后者该查提示词。
   *
   * ## 为什么值得单独记
   *
   * 缓存命中价与未命中价**差 50 倍**（DeepSeek flash：$0.003 对 $0.15
   * 每百万 token）。少了这个字段，成本问题就只能靠猜 ——
   * 实测这个项目**命中率 99.6%**，而在此之前没有任何地方能看到这个数字。
   *
   * `reasoning_tokens` 同理：它会计入 `completion_tokens`，
   * 而输出价是缓存命中输入价的 **200 倍**，所以"钱花在思考上还是花在正文上"
   * 是一个必须能分开看的账。
   */
  /*
   * ⚠️ **两个口径都要读，顺序不能反。**
   *
   * OpenAI 系（以及多数网关）报告在 `prompt_tokens_details.cached_tokens`；
   * **DeepSeek 原生报告在顶层的 `prompt_cache_hit_tokens`**（见上面接口的注释）。
   * 只读前者的结果是：在 DeepSeek 上**永远显示缓存 0%**，而实际上服务商那边
   * 可能已经命中了 —— 那会让人以为"缓存没生效"，进而去查错的方向。
   *
   * 用 `??` 而不是相加：同一个数不该被两个口径各算一次。
   */
  const cached = toTokenCount(
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? null,
  );
  const reasoning = toTokenCount(usage.completion_tokens_details?.reasoning_tokens ?? null);

  return {
    promptTokens: prompt,
    completionTokens: completion,
    // Deriving the total is better than reporting `null` when both halves are known.
    totalTokens: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
    cachedTokens: cached,
    reasoningTokens: reasoning,
  };
}
