import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProviderId } from '@aq/shared';

import * as openai from './openaiCompatible.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import {
  LlmError,
  classifyHttpError,
  classifyMinimaxBaseResp,
  isRetryable,
  isRetryableKind,
  kindForStatus,
} from './errors.js';
import { joinUrl, parseRetryAfter } from './http.js';
import { backoffDelayMs } from './client.js';
import { normalizeUsage, splitSystem, type ChatMessage } from './types.js';

type JsonObject = Record<string, unknown>;

function obj(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === 'object', 'expected an object');
  return value as JsonObject;
}

const conversation: ChatMessage[] = [
  { role: 'system', content: 'You are a terse trading assistant.' },
  { role: 'user', content: 'Summarize BTC funding.' },
];

/* -------------------------------------------------------------------------- */
/*  Request-body builders                                                      */
/* -------------------------------------------------------------------------- */

test('openai-compatible body: system prompt becomes messages[0] and max_tokens is set', () => {
  const body = openai.buildBody('deepseek', 'deepseek-flash', conversation, {
    temperature: 0.2,
    maxTokens: 4096,
  });
  const messages = body['messages'] as JsonObject[];
  assert.equal(messages[0]?.['role'], 'system');
  assert.equal(messages[0]?.['content'], 'You are a terse trading assistant.');
  assert.equal(messages[1]?.['role'], 'user');
  assert.equal(body['temperature'], 0.2);
  // DeepSeek documents `max_tokens` (1–393216); `max_completion_tokens` is not its field.
  assert.equal(body['max_tokens'], 4096);
  assert.equal(body['max_completion_tokens'], undefined);
  assert.equal(body['stream'], false);
});

test('openai-compatible body: Kimi rejects temperature, so it is omitted', () => {
  assert.equal(openai.rejectsSamplingParameters('kimi'), true);
  const body = openai.buildBody('kimi', 'kimi-k3', conversation, {
    temperature: 0.2,
    maxTokens: 2048,
  });
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
  // Kimi deprecated `max_tokens` in favour of `max_completion_tokens`.
  assert.equal(body['max_completion_tokens'], 2048);
});

test('openai-compatible body: OpenAI/grok/minimax use max_completion_tokens', () => {
  assert.equal(openai.maxTokensField('openai'), 'max_completion_tokens');
  assert.equal(openai.maxTokensField('grok'), 'max_completion_tokens');
  assert.equal(openai.maxTokensField('minimax'), 'max_completion_tokens');
  assert.equal(openai.maxTokensField('qwen'), 'max_tokens');

  const body = openai.buildBody('openai', 'gpt-6-astra', conversation, { maxTokens: 1024 });
  assert.equal(body['max_completion_tokens'], 1024);
  assert.equal(body['max_tokens'], undefined);
});

test('openai-compatible body: jsonMode maps to json_object where the provider supports it', () => {
  const body = openai.buildBody('deepseek', 'deepseek-flash', conversation, { jsonMode: true });
  assert.deepEqual(body['response_format'], { type: 'json_object' });
});

test('openai-compatible body: MiniMax omits response_format entirely', () => {
  assert.equal(openai.supportsResponseFormat('minimax'), false);
  const body = openai.buildBody('minimax', 'MiniMax-M3', conversation, {
    jsonMode: true,
    jsonSchema: { type: 'object', properties: { action: { type: 'string' } } },
  });
  assert.equal('response_format' in body, false);
});

test('openai-compatible body: strict json_schema only where the provider advertises it', () => {
  const schema = {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
    additionalProperties: false,
  };

  const openaiBody = openai.buildBody('openai', 'gpt-6-astra', conversation, {
    jsonMode: true,
    jsonSchema: schema,
  });
  const format = obj(openaiBody['response_format']);
  assert.equal(format['type'], 'json_schema');
  assert.equal(obj(format['json_schema'])['strict'], true);

  // DeepSeek supports only json_object: a schema must not be silently sent.
  assert.equal(openai.supportsStrictSchema('deepseek'), false);
  const deepseekBody = openai.buildBody('deepseek', 'deepseek-flash', conversation, {
    jsonMode: true,
    jsonSchema: schema,
  });
  assert.deepEqual(deepseekBody['response_format'], { type: 'json_object' });
});

test('openai-compatible request: OpenRouter gets attribution headers, others do not', () => {
  const openrouter = openai.buildRequest('openrouter', 'k', 'https://openrouter.ai/api/v1', 'm', conversation);
  assert.equal(obj(openrouter.headers)['http-referer'] !== undefined, true);
  assert.equal(obj(openrouter.headers)['x-openrouter-title'] !== undefined, true);
  assert.equal(openrouter.url, 'https://openrouter.ai/api/v1/chat/completions');

  const deepseek = openai.buildRequest('deepseek', 'k', 'https://api.deepseek.com', 'm', conversation);
  assert.equal('http-referer' in deepseek.headers, false);
  // DeepSeek's documented base URL has no `/v1` segment.
  assert.equal(deepseek.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(deepseek.headers['authorization'], 'Bearer k');
});

test('anthropic body: system prompt is top-level and max_tokens is always present', () => {
  const body = anthropic.buildBody('claude-opus-5', conversation, { maxTokens: 2048 });
  assert.equal(body['system'], 'You are a terse trading assistant.');
  const messages = body['messages'] as JsonObject[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.['role'], 'user');
  assert.equal(body['max_tokens'], 2048);
  // Only `x-api-key` + `anthropic-version` authenticate; a bearer token is wrong here.
  const request = anthropic.buildRequest('k', 'https://api.anthropic.com/v1', 'claude-opus-5', conversation);
  assert.equal(request.headers['x-api-key'], 'k');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal('authorization' in request.headers, false);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
});

test('anthropic body: max_tokens is required, so a default is supplied', () => {
  const body = anthropic.buildBody('claude-opus-5', conversation);
  assert.equal(typeof body['max_tokens'], 'number');
});

test('anthropic body: temperature omitted on models that reject it', () => {
  assert.equal(anthropic.rejectsSamplingParameters('claude-opus-5'), true);
  assert.equal(anthropic.rejectsSamplingParameters('claude-sonnet-5'), true);
  assert.equal(anthropic.rejectsSamplingParameters('claude-opus-4-7'), true);
  assert.equal(anthropic.rejectsSamplingParameters('claude-fable-5-1'), true);
  assert.equal(anthropic.rejectsSamplingParameters('claude-haiku-4-5'), false);
  assert.equal(anthropic.rejectsSamplingParameters('claude-opus-4-6'), false);

  const modern = anthropic.buildBody('claude-opus-5', conversation, { temperature: 0.2 });
  assert.equal('temperature' in modern, false);

  const legacy = anthropic.buildBody('claude-haiku-4-5', conversation, { temperature: 0.2 });
  assert.equal(legacy['temperature'], 0.2);
});

test('anthropic body: structured output uses output_config.format, not response_format', () => {
  const schema = { type: 'object', properties: { action: { type: 'string' } } };
  const body = anthropic.buildBody('claude-opus-5', conversation, {
    jsonMode: true,
    jsonSchema: schema,
  });
  assert.equal('response_format' in body, false);
  const format = obj(obj(body['output_config'])['format']);
  assert.equal(format['type'], 'json_schema');
  assert.deepEqual(format['schema'], schema);
});

test('gemini body: role is model, not assistant, and system is systemInstruction', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'explain funding' },
  ];
  const body = gemini.buildBody(messages, { temperature: 0.2, maxTokens: 2048 });

  const contents = body['contents'] as JsonObject[];
  assert.deepEqual(
    contents.map((c) => c['role']),
    ['user', 'model', 'user'],
  );
  assert.deepEqual(contents[1]?.['parts'], [{ text: 'hello' }]);
  assert.deepEqual(body['systemInstruction'], { parts: [{ text: 'Be terse.' }] });
  assert.equal('system' in body, false);
  assert.equal('messages' in body, false);

  const config = obj(body['generationConfig']);
  assert.equal(config['temperature'], 0.2);
  assert.equal(config['maxOutputTokens'], 2048);
});

test('gemini request: api key is a query parameter and the model is in the path', () => {
  const request = gemini.buildRequest(
    'AIza-key',
    'https://generativelanguage.googleapis.com/v1beta',
    'gemini-3.8-flash',
    conversation,
  );
  assert.equal(
    request.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AIza-key',
  );
  assert.equal(request.headers['authorization'], undefined);
});

test('gemini schema: types are SCREAMING-CASE and unsupported keys are dropped', () => {
  const schema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['BUY', 'SELL'] },
      confidence: { type: 'number' },
      nested: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false,
      },
      list: { type: 'array', items: { type: 'integer' } },
    },
    required: ['action'],
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  };

  const translated = obj(gemini.toGeminiSchema(schema));
  assert.equal(translated['type'], 'OBJECT');
  assert.equal('additionalProperties' in translated, false);
  assert.equal('$schema' in translated, false);

  const properties = obj(translated['properties']);
  assert.equal(obj(properties['action'])['type'], 'STRING');
  // An enum is only honoured with `format: 'enum'`.
  assert.equal(obj(properties['action'])['format'], 'enum');
  assert.equal(obj(properties['confidence'])['type'], 'NUMBER');

  const nested = obj(properties['nested']);
  assert.equal(nested['type'], 'OBJECT');
  assert.equal('additionalProperties' in nested, false);
  assert.equal(obj(obj(nested['properties'])['ok'])['type'], 'BOOLEAN');

  assert.equal(obj(properties['list'])['type'], 'ARRAY');
  assert.equal(obj(obj(properties['list'])['items'])['type'], 'INTEGER');
  assert.deepEqual(translated['propertyOrdering'], ['action', 'confidence', 'nested', 'list']);
});

/* -------------------------------------------------------------------------- */
/*  Response parsers                                                           */
/* -------------------------------------------------------------------------- */

test('openai parser: extracts choices[0].message.content and usage', () => {
  const payload = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Funding is positive.', refusal: null },
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 128, total_tokens: 170 },
  };

  const parsed = openai.parseResponse('deepseek', payload, 'deepseek-flash');
  assert.equal(parsed.text, 'Funding is positive.');
  assert.equal(parsed.finishReason, 'stop');
  assert.deepEqual(parsed.usage, {
    promptTokens: 42,
    completionTokens: 128,
    totalTokens: 170,
    /*
     * payload 里没有 `prompt_tokens_details` —— 所以是 **null（不知道）**
     * 而不是 **0（确实没命中）**。这两个结论完全相反：前者该换供应商，
     * 后者该查提示词。归一化把「字段缺失」和「值为零」混掉的话，
     * 就会把不支持上报的供应商显示成「缓存全没命中」。
     */
    cachedTokens: null,
    reasoningTokens: null,
  });
  assert.equal(parsed.isEmpty, false);
});

test('openai parser: content may be an array of parts instead of a string', () => {
  const payload = {
    model: 'qwen3.8-max',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
  const parsed = openai.parseResponse('qwen', payload, 'qwen3.8-max');
  assert.equal(parsed.text, 'part one part two');
});

test('openai parser: a refusal on HTTP 200 surfaces as content_filter, not an empty success', () => {
  const payload = {
    model: 'gpt-6-astra',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  };
  const parsed = openai.parseResponse('openai', payload, 'gpt-6-astra');
  assert.equal(parsed.text, 'I cannot help with that.');
  assert.equal(parsed.finishReason, 'content_filter');
  assert.equal(parsed.isEmpty, false);
});

test('openai parser: MiniMax <think> blocks are stripped from content', () => {
  const payload = {
    model: 'MiniMax-M3',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '<think>the user wants funding</think>Funding is positive.' },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    base_resp: { status_code: 0, status_msg: '' },
  };
  const parsed = openai.parseResponse('minimax', payload, 'MiniMax-M3');
  assert.equal(parsed.text, 'Funding is positive.');
});

test('minimax: HTTP 200 with a base_resp error becomes an LlmError, not a completion', () => {
  const payload = {
    base_resp: { status_code: 1002, status_msg: 'rate limit reached' },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
  };

  const error = classifyMinimaxBaseResp('minimax', payload, 200);
  assert.ok(error instanceof LlmError);
  assert.equal(error.kind, 'rate_limit');
  assert.equal(error.providerCode, 1002);
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'rate limit reached');

  // Success (status_code 0) must not be misclassified.
  assert.equal(
    classifyMinimaxBaseResp('minimax', { base_resp: { status_code: 0, status_msg: '' } }, 200),
    null,
  );
  // Auth and balance failures are permanent even though the HTTP status is 200.
  const auth = classifyMinimaxBaseResp('minimax', { base_resp: { status_code: 1004 } }, 200);
  assert.equal(auth?.kind, 'auth');
  assert.equal(auth?.retryable, false);
  const balance = classifyMinimaxBaseResp('minimax', { base_resp: { status_code: 1008 } }, 200);
  assert.equal(balance?.kind, 'quota_exhausted');
  assert.equal(balance?.retryable, false);
});

test('anthropic parser: only text blocks are joined, thinking blocks are skipped', () => {
  const payload = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'thinking', thinking: 'internal reasoning', signature: 'abc' },
      { type: 'text', text: 'Funding is positive on BTC.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_funding', input: { symbol: 'BTCUSDT' } },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1024, output_tokens: 256 },
  };

  const parsed = anthropic.parseResponse(payload, 'claude-opus-5');
  assert.equal(parsed.text, 'Funding is positive on BTC.');
  /*
   * ⚠️ **这个断言在 2026-10-23 改过**：原来期望 `'stop'`。
   *
   * 那时 `tool_use` 块被**完全忽略** —— 而 `stop_reason` 写的是 `end_turn`
   * （有的网关在带工具调用时就这么报）。结果是：上层看到 `finishReason: 'stop'`
   * 就把这一轮当成"最终回答"，**那个工具调用永远不会被执行**，
   * 模型会一直等一个它以为已经发生的结果。
   *
   * ⇒ 现在的判据是「**有没有 tool_use 块**」，而不是信 `stop_reason`。
   * 这是"表面成功、实际空转"那类故障的直接修复。
   */
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.toolCalls?.length, 1, 'tool_use 块必须被提取出来');
  assert.equal(parsed.toolCalls?.[0]?.name, 'get_funding');
  assert.deepEqual(parsed.usage, { promptTokens: 1024, completionTokens: 256, totalTokens: 1280, cachedTokens: null, reasoningTokens: null });
  assert.equal(parsed.model, 'claude-opus-5');
});

test('anthropic parser: multiple text blocks are concatenated in order', () => {
  const payload = {
    content: [
      { type: 'text', text: 'A' },
      { type: 'redacted_thinking', data: 'xxx' },
      { type: 'text', text: 'B' },
    ],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  const parsed = anthropic.parseResponse(payload, 'claude-sonnet-5');
  assert.equal(parsed.text, 'AB');
  assert.equal(parsed.finishReason, 'length');
});

test('gemini parser: text comes from candidates[0].content.parts[*].text', () => {
  const payload = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'Funding is positive.' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 22, totalTokenCount: 34 },
    modelVersion: 'gemini-3.8-flash',
  };

  const parsed = gemini.parseResponse(payload, 'gemini-3.8-flash');
  assert.equal(parsed.text, 'Funding is positive.');
  assert.equal(parsed.finishReason, 'stop');
  assert.deepEqual(parsed.usage, { promptTokens: 12, completionTokens: 22, totalTokens: 34, cachedTokens: null, reasoningTokens: null });
  assert.equal(parsed.model, 'gemini-3.8-flash');
});

test('gemini parser: a functionCall part normalises to tool_calls, which has no finishReason', () => {
  const payload = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_price', args: { symbol: 'BTCUSDT' } } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, totalTokenCount: 20 },
  };

  const parsed = gemini.parseResponse(payload, 'gemini-3.8-flash');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.text, '');
  /*
   * ⚠️ **断言在 2026-10-23 从 `true` 改成 `false`**。
   *
   * 原来"没有说话"就等于"空回复"，`isEmpty: true`。但**只发起工具调用、不说话的
   * 响应不是空回复 —— 它是工具循环的正常一轮**。判成空会让上层当成异常重试，
   * 而重试拿到的是同一个响应，于是**无限重试到预算耗尽**。
   */
  assert.equal(parsed.isEmpty, false);
  assert.equal(parsed.toolCalls?.length, 1, 'functionCall 必须被提取出来');
  assert.equal(parsed.toolCalls?.[0]?.name, 'get_price');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"symbol":"BTCUSDT"}');
});

test('gemini parser: thinking parts are not returned as the answer', () => {
  const payload = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'reasoning here', thought: true }, { text: 'Final answer.' }],
        },
        finishReason: 'STOP',
      },
    ],
  };
  const parsed = gemini.parseResponse(payload, 'gemini-3.8-flash');
  assert.equal(parsed.text, 'Final answer.');
});

test('gemini parser: promptFeedback.blockReason raises content_filter', () => {
  const payload = { promptFeedback: { blockReason: 'SAFETY' } };
  assert.throws(
    () => gemini.parseResponse(payload, 'gemini-3.8-flash'),
    (error: unknown) => error instanceof LlmError && error.kind === 'content_filter' && !error.retryable,
  );
});

/* -------------------------------------------------------------------------- */
/*  finishReason normalisation (B.12)                                          */
/* -------------------------------------------------------------------------- */

test('finishReason normalisation: OpenAI enum', () => {
  assert.equal(openai.normalizeFinishReason('stop'), 'stop');
  assert.equal(openai.normalizeFinishReason('length'), 'length');
  assert.equal(openai.normalizeFinishReason('tool_calls'), 'tool_calls');
  assert.equal(openai.normalizeFinishReason('content_filter'), 'content_filter');
  assert.equal(openai.normalizeFinishReason('function_call'), 'tool_calls');
});

test('finishReason normalisation: DeepSeek extras are abnormal terminations', () => {
  assert.equal(openai.normalizeFinishReason('insufficient_system_resource'), 'error');
  assert.equal(openai.normalizeFinishReason('aborted'), 'error');
});

test('finishReason normalisation: xAI end_turn maps to stop', () => {
  assert.equal(openai.normalizeFinishReason('end_turn'), 'stop');
});

test('finishReason normalisation: Kimi and MiniMax openai-compatible enums', () => {
  for (const value of ['stop', 'length', 'tool_calls']) {
    assert.notEqual(openai.normalizeFinishReason(value), 'error', value);
  }
});

test('finishReason normalisation: Anthropic stop_reason enum', () => {
  assert.equal(anthropic.normalizeStopReason('end_turn'), 'stop');
  assert.equal(anthropic.normalizeStopReason('stop_sequence'), 'stop');
  assert.equal(anthropic.normalizeStopReason('max_tokens'), 'length');
  assert.equal(anthropic.normalizeStopReason('model_context_window_exceeded'), 'length');
  assert.equal(anthropic.normalizeStopReason('tool_use'), 'tool_calls');
  assert.equal(anthropic.normalizeStopReason('refusal'), 'content_filter');
  assert.equal(anthropic.normalizeStopReason('pause_turn'), 'error');
  assert.equal(anthropic.normalizeStopReason(null), 'unknown');
});

test('finishReason normalisation: every Gemini enum value', () => {
  const expected: Record<string, string> = {
    FINISH_REASON_UNSPECIFIED: 'unknown',
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    LANGUAGE: 'error',
    OTHER: 'error',
    BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    SPII: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'error',
    IMAGE_SAFETY: 'content_filter',
    UNEXPECTED_TOOL_CALL: 'error',
    TOO_MANY_TOOL_CALLS: 'error',
    NO_IMAGE: 'error',
    IMAGE_PROHIBITED_CONTENT: 'content_filter',
    IMAGE_RECITATION: 'content_filter',
    IMAGE_OTHER: 'error',
  };
  for (const [raw, canonical] of Object.entries(expected)) {
    assert.equal(gemini.normalizeFinishReason(raw), canonical, raw);
  }
});

test('finishReason normalisation: unknown values become error, never a silent stop', () => {
  assert.equal(openai.normalizeFinishReason('brand_new_reason'), 'error');
  assert.equal(gemini.normalizeFinishReason('brand_new_reason'), 'error');
  assert.equal(anthropic.normalizeStopReason('brand_new_reason'), 'error');
  assert.equal(openai.normalizeFinishReason(undefined), 'unknown');
  assert.equal(gemini.normalizeFinishReason(null), 'unknown');
});

/* -------------------------------------------------------------------------- */
/*  Retryability classifier (B.14)                                             */
/* -------------------------------------------------------------------------- */

test('retryable: 429 and 5xx are retryable', () => {
  assert.equal(kindForStatus(429), 'rate_limit');
  assert.equal(isRetryableKind('rate_limit'), true);
  assert.equal(isRetryable(classifyHttpError('openai', 429, { error: { message: 'slow down' } })), true);

  for (const status of [500, 502, 503, 504]) {
    assert.equal(isRetryable(classifyHttpError('openai', status, null)), true, String(status));
  }
  // Anthropic's 529 has no OpenAI equivalent and must be retryable explicitly.
  assert.equal(isRetryable(classifyHttpError('anthropic', 529, null)), true);
  assert.equal(kindForStatus(529), 'overloaded');
});

test('retryable: 400/401/403/404/422 are fatal', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const error = classifyHttpError('openai', status, null);
    assert.equal(error.retryable, false, String(status));
    assert.equal(isRetryable(error), false, String(status));
  }
  // 501/505 are client/protocol problems, not transient server faults.
  assert.equal(isRetryable(classifyHttpError('openai', 501, null)), false);
  assert.equal(isRetryable(classifyHttpError('openai', 505, null)), false);
});

test('retryable: quota exhaustion on a 429 is permanent, unlike a plain rate limit', () => {
  const quota = classifyHttpError(
    'openai',
    429,
    { error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } },
  );
  assert.equal(quota.kind, 'quota_exhausted');
  assert.equal(quota.retryable, false);

  const kimiQuota = classifyHttpError(
    'kimi',
    429,
    { error: { type: 'exceeded_current_quota_error', message: 'insufficient balance' } },
  );
  assert.equal(kimiQuota.kind, 'quota_exhausted');
  assert.equal(kimiQuota.retryable, false);

  const kimiOverload = classifyHttpError(
    'kimi',
    429,
    { error: { type: 'engine_overloaded_error', message: 'overloaded' } },
  );
  assert.equal(kimiOverload.kind, 'rate_limit');
  assert.equal(kimiOverload.retryable, true);
});

test('classifyHttpError: parses each provider error envelope for its message', () => {
  assert.equal(
    classifyHttpError('openai', 400, { error: { message: 'bad param', type: 'invalid_request_error' } })
      .message,
    'bad param',
  );
  assert.equal(
    classifyHttpError('anthropic', 401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
      request_id: 'req_1',
    }).message,
    'invalid x-api-key',
  );
  assert.equal(
    classifyHttpError('gemini', 400, {
      error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' },
    }).message,
    'API key not valid.',
  );
  // Kimi's 504 can be an HTML page rather than JSON: fall back to the status.
  const htmlError = classifyHttpError('kimi', 504, '<html>Gateway Timeout</html>', '<html>Gateway Timeout</html>');
  assert.equal(htmlError.message, '<html>Gateway Timeout</html>');
  assert.equal(htmlError.retryable, true);
});

test('LlmError carries status, provider and a kind', () => {
  const error = new LlmError('boom', 500, 'openai', true, { error: 'x' });
  assert.equal(error.name, 'LlmError');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof LlmError);
  assert.equal(error.status, 500);
  assert.equal(error.provider, 'openai');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.body, { error: 'x' });
});

/* -------------------------------------------------------------------------- */
/*  Transport helpers                                                          */
/* -------------------------------------------------------------------------- */

test('parseRetryAfter: seconds and HTTP-date forms, clamped', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('nonsense'), null);
  // A hostile value must not stall the bot.
  assert.equal(parseRetryAfter('99999'), 60_000);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed !== null && parsed > 0 && parsed <= 5000);
});

/*
 * ★ 钉住 `-5` 被当成"等待提示"这条路径（真实缺陷，不是挑刺）。
 *
 * 旧实现 `Number.isFinite(seconds) && seconds >= 0` 在 `-5` 上是 false（负数），
 * 于是落进**日期**分支：`Date.parse('-5')` 把 `-5` 读成 2001 年，一个早已过去的时间，
 * `max(过去, 0) = 0`。`client.ts` 的 `retryAfterMs ?? backoffDelayMs(...)` 因此取到 **0**，
 * 退避形同不存在 —— 与"全抖动防 IP 封禁"的意图相反。
 *
 * 修法：非纯十进制（`1*DIGIT`，RFC 9110 的 delta-seconds）的、且 `Number` 出有限值的串，
 * 一律判非法返回 null，让调用点回落到全抖动退避。
 */
test('parseRetryAfter: 畸形的"秒数"绝不退化成 0 或误读成日期', () => {
  /* 这些都能被 Number() 解析出有限值，但都不是合法 delta-seconds。 */
  for (const bad of ['-5', '0x10', '1e3', '+7', '12.5', '-0', ' 1e3 ']) {
    assert.equal(
      parseRetryAfter(bad),
      null,
      `畸形值 ${JSON.stringify(bad)} 必须 null（→ 调用点用全抖动），不能是 0 或某个正数`,
    );
  }
  /* 纯十进制才是秒。 */
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0, 'Retry-After: 0 是合法的"立刻重试"');
  assert.equal(parseRetryAfter('007'), 7000, '前导零仍属 1*DIGIT');
});

test('joinUrl: no doubled or missing separators', () => {
  assert.equal(joinUrl('https://api.deepseek.com', 'chat/completions'), 'https://api.deepseek.com/chat/completions');
  assert.equal(joinUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
});

test('backoffDelayMs: bounded by the cap and decorrelated by full jitter', () => {
  assert.equal(backoffDelayMs(0, () => 0), 0);
  assert.equal(backoffDelayMs(0, () => 1), 500);
  assert.equal(backoffDelayMs(3, () => 1), 4000);
  // Full jitter caps the ceiling at 30s regardless of the attempt number.
  assert.equal(backoffDelayMs(20, () => 1), 30_000);
  assert.ok(backoffDelayMs(2, () => 0.5) < backoffDelayMs(2, () => 1));
});

test('normalizeUsage: handles the differing provider key names and missing usage', () => {
  assert.deepEqual(normalizeUsage(undefined), {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    /* 这两个 payload 都没报缓存/思考详情 ⇒ null（不知道），不是 0。 */
    cachedTokens: null,
    reasoningTokens: null,
  });
  // Gemini's wire name for completion tokens is not reliably one thing.
  assert.deepEqual(normalizeUsage({ promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    cachedTokens: null,
    reasoningTokens: null,
  });
  // Gemini's typedoc and prose disagree on the output-token key, so both work.
  assert.equal(normalizeUsage({ promptTokenCount: 3, responseTokenCount: 9 }).completionTokens, 9);
  assert.equal(normalizeUsage({ promptTokenCount: 3, candidates_token_count: 6 }).completionTokens, 6);
});

test('splitSystem: system turns are separated from the conversation', () => {
  const parts = splitSystem(conversation);
  assert.equal(parts.system, 'You are a terse trading assistant.');
  assert.equal(parts.messages.length, 1);
  assert.equal(parts.messages[0]?.role, 'user');
  assert.equal(splitSystem([{ role: 'user', content: 'hi' }]).system, undefined);
  // Multiple system turns are merged, since Anthropic and Gemini accept only one.
  assert.equal(
    splitSystem([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ]).system,
    'a\n\nb',
  );
});

test('adapters cover every provider id in the catalogue', () => {
  const ids: LlmProviderId[] = [
    'deepseek',
    'openai',
    'anthropic',
    'gemini',
    'qwen',
    'grok',
    'kimi',
    'minimax',
    'openrouter',
    'custom',
  ];
  for (const id of ids) {
    // Every provider has a deterministic structured-output decision.
    if (id === 'anthropic' || id === 'gemini') continue;
    assert.equal(typeof openai.supportsResponseFormat(id), 'boolean', id);
    assert.equal(typeof openai.supportsStrictSchema(id), 'boolean', id);
    assert.equal(typeof openai.maxTokensField(id), 'string', id);
  }
});

/* -------------------------------------------------------------------------- */
/*  Transient failures disguised as bad requests                               */
/* -------------------------------------------------------------------------- */

test('an availability phrase in a 400 body is retryable, unlike a normal 400', () => {
  // Verified live: a gateway answered HTTP 400 with the body
  // `模型不可用：deepseek-flash` ("model unavailable") for a transient blip — the
  // same call succeeded seconds later. A plain 400 is correctly permanent, so
  // without this exemption the request was abandoned and the operator saw a hard
  // failure for a condition one retry would have cleared.
  const transient = kindForStatus(400, '模型不可用：deepseek-flash');
  assert.equal(transient, 'overloaded');
  assert.equal(isRetryableKind(transient), true, 'an availability blip must be retried');

  // A genuinely malformed request must stay permanent, or it becomes a hot loop.
  const permanent = kindForStatus(400, '{"error":{"message":"invalid model parameter: temperature"}}');
  assert.equal(permanent, 'bad_request');
  assert.equal(isRetryableKind(permanent), false);

  // And an empty body gives no evidence either way, so it stays permanent.
  assert.equal(kindForStatus(400, ''), 'bad_request');
  assert.equal(kindForStatus(400, '无'), 'bad_request');
});

test('the availability exemption is case insensitive and covers common wordings', () => {
  for (const phrase of [
    'Model Unavailable',
    'model not available',
    'The service is temporarily unavailable',
    'no available upstream',
    'server overloaded, please retry',
    'Try Again later',
  ]) {
    assert.equal(kindForStatus(400, phrase), 'overloaded', phrase);
  }
});

/*
 * ⚠️ **DeepSeek 的原生缓存字段必须被读出来。**
 *
 * 用户 2026-10-07 问「为什么缓存一直是 0%」，并让我去看官方文档。官方写明
 * DeepSeek 报告的是 `prompt_cache_hit_tokens`（顶层），而**不是** OpenAI 的
 * `prompt_tokens_details.cached_tokens`。这份代码原来只读后者，于是在 DeepSeek
 * 系（含通过第三方网关跑的 `deepseek-v4.1-flash`）上永远读到 0 —— 界面一直显示
 * 「缓存 0%」，让人以为缓存没生效，进而去查错的方向。
 *
 * 这条用例把**两个口径**都钉住：谁被删掉都会红。
 */
test('★ 缓存 token：OpenAI 与 DeepSeek 两种口径都要读出来', () => {
  // OpenAI 格式（嵌套对象）
  assert.equal(
    normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 640 } })
      .cachedTokens,
    640,
    'OpenAI 口径：prompt_tokens_details.cached_tokens',
  );
  // DeepSeek 原生格式（顶层）
  assert.equal(
    normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 768 }).cachedTokens,
    768,
    '★ DeepSeek 口径：prompt_cache_hit_tokens —— 少了这一条，DeepSeek 上缓存永远显示 0%',
  );
  // 两个都没有 → null（不知道），而不是伪装成 0
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 1 }).cachedTokens, null);
});