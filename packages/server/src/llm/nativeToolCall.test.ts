/**
 * **原生 function calling 的三家协议测试**（2026-10-23）
 *
 * ## 为什么有这份测试
 *
 * 实测 `#10`（智能托管）：`agent_runs` 里 **ok 85 / failed 74（成功率 53%）**，
 * 失败原因几乎全是同一句：
 * ```
 *   "JSON 解析成功，但里面没有 tool 字段 —— 你只写了 thought"
 * ```
 * 而提示词里已经用 5 处整段警告反复强调那个格式，**模型仍然不听** ——
 * 「在自由文本里遵守一个格式约定」本来就是模型的弱项，不是它不配合。
 *
 * 修法是把这件事从「模型自觉」换成「协议保证」：工具清单由 API 参数传下去，
 * 模型返回结构化 `tool_calls`。**"忘了写 tool 字段"这种失败形态在协议上就不存在了。**
 *
 * ## 这份测试钉的是什么
 *
 * 三家 provider 的 wire 格式**互不相同**，而错一处就会静默退化：
 * ```
 *   · OpenAI 工具结果用 role:'tool' + tool_call_id
 *   · Anthropic **没有 tool 角色**，用 role:'user' + {type:'tool_result'}
 *   · Gemini  **没有 tool 角色**，用 role:'user' + {functionResponse}
 *           而且它靠**工具名**关联结果，不是 id
 * ```
 * 照抄一家的形状到另一家，表现是"请求发出去了、模型回了个不相干的东西"——
 * 那是最难查的一类故障（没有报错）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as anthropic from '../llm/anthropic.js';
import * as gemini from '../llm/gemini.js';
import * as openai from '../llm/openaiCompatible.js';
import type { ChatMessage, ToolSpec } from '../llm/types.js';

const TOOLS: ToolSpec[] = [
  {
    name: 'get_performance',
    description: '读已实现绩效',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string' } },
      required: ['window'],
    },
  },
  {
    name: 'set_params',
    description: '改一个参数',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'number' } },
      required: ['key', 'value'],
    },
  },
];

/** 一轮典型的工具对话：用户问 → 助手调工具 → 工具回结果。 */
const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: 'you are a strategist' },
  { role: 'user', content: '看绩效' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_abc', name: 'get_performance', arguments: '{"window":"7d"}' }],
  },
  { role: 'tool', content: '{"netPnl":1.5}', toolCallId: 'call_abc', toolName: 'get_performance' },
];

/* -------------------------------------------------------------------------- */
/*  OpenAI 兼容                                                                */
/* -------------------------------------------------------------------------- */

test('★★★ OpenAI：tools 必须翻译成 {type:function,function:{…}}', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as unknown[];
  assert.ok(Array.isArray(tools), '★ 必须带 tools 数组');
  assert.equal(tools.length, 2);
  const first = tools[0] as { type: string; function: { name: string; parameters: unknown } };
  assert.equal(first.type, 'function', '★ OpenAI 要求外层 type:function');
  assert.equal(first.function.name, 'get_performance');
  assert.ok(first.function.parameters !== undefined, '★ schema 放在 function.parameters');
  assert.equal(body['tool_choice'], 'auto', '★ 不指定时要显式写 auto');
});

test('★★★ OpenAI：工具结果必须带 tool_call_id（否则模型认为没人问过）', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const toolMsg = messages.find((m) => m['role'] === 'tool');
  assert.ok(toolMsg !== undefined, '★ tool 角色要原样保留');
  assert.equal(toolMsg['tool_call_id'], 'call_abc', '★ 丢了它模型就对不上');
});

test('★★★ OpenAI：带工具调用的 assistant 消息 content 必须是 null 而非空串', () => {
  /*
   * OpenAI 要求带 `tool_calls` 的 assistant 消息 `content` 为 null 或省略；
   * 传空字符串在某些兼容网关上会被判 invalid_request。
   */
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const asst = messages.find((m) => m['role'] === 'assistant');
  assert.ok(asst !== undefined);
  assert.equal(asst['content'], null, '★ 空内容必须发 null');
  assert.ok(Array.isArray(asst['tool_calls']), '★ 要带 tool_calls 数组');
});

test('★★★ OpenAI：tools 与 response_format 互斥（同时发会让模型永远不调工具）', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, {
    tools: TOOLS,
    jsonMode: true,
    jsonSchema: { type: 'object', properties: {} },
  });
  assert.ok(body['tools'] !== undefined, '★ tools 要保留');
  assert.equal(
    body['response_format'],
    undefined,
    '★ response_format 必须被撤掉 —— 否则模型被约束成只能吐那个 schema',
  );
});

test('★★★ OpenAI：解析 response 里的 tool_calls（arguments 是字符串）', () => {
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'set_params', arguments: '{"key":"a","value":1}' },
              },
            ],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.id, 'call_1');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.isEmpty, false, '★ 只调工具不说话不是"空回复"');
});

test('★★ 网关把 finish_reason 错报成 stop 时，有 tool_calls 仍要判成 tool_calls', () => {
  /*
   * 上层用 `finishReason` 判断"这一轮是不是结束了"。若它看到 `stop` 就当成
   * 最终回答，那**工具调用永远不会被执行**，模型会一直等一个它以为已经
   * 发生的工具结果 —— 那正是"表面成功、实际空转"的形态。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{}' } }],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.finishReason, 'tool_calls', '★ 以 tool_calls 的实际存在为准');
});

test('★★ 网关把 arguments 发成对象时也要接住（不能静默丢掉那次调用）', () => {
  /*
   * 规范上 `arguments` 是字符串，但实测有网关直接发对象。拒掉的话那一次
   * 工具调用会**静默消失**，而模型会以为它调过了，于是不再重试。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'x', arguments: { a: 1 } } }],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1, '★ 对象形状也要接住');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"a":1}');
});

/* -------------------------------------------------------------------------- */
/*  Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ Anthropic：工具声明是 {name,description,input_schema}（没有 type:function 包装）', () => {
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools), '★ 必须带 tools');
  assert.equal(tools[0]?.['name'], 'get_performance');
  assert.ok(tools[0]?.['input_schema'] !== undefined, '★ 字段名是 input_schema 不是 parameters');
  assert.equal(tools[0]?.['type'], undefined, '★ Anthropic 没有 type:function 这层包装');
});

test('★★★ Anthropic：没有 tool 角色 —— 工具结果必须是 user + tool_result 块', () => {
  /*
   * 直接照抄 OpenAI 的 `role:'tool'` 会被拒（`role: tool is not supported`）。
   */
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  assert.ok(
    messages.every((m) => m['role'] !== 'tool'),
    '★ Anthropic 里不能出现 tool 角色',
  );
  const withResult = messages.find(
    (m) => Array.isArray(m['content']) && (m['content'] as Array<Record<string, unknown>>).some((b) => b['type'] === 'tool_result'),
  );
  assert.ok(withResult !== undefined, '★ 工具结果要以 tool_result 块回传');
  assert.equal(withResult['role'], 'user', '★ 用 user 身份');
  const block = (withResult['content'] as Array<Record<string, unknown>>)[0];
  assert.equal(block?.['tool_use_id'], 'call_abc', '★ 靠 tool_use_id 关联');
});

test('★★★ Anthropic：tool_choice 用 {type:any} 表示"必须调工具"（不是 required）', () => {
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, {
    tools: TOOLS,
    toolChoice: 'required',
  });
  const choice = body['tool_choice'] as { type: string };
  assert.equal(choice.type, 'any', '★ Anthropic 把 required 叫 any');
});

test('★★★ Anthropic：解析 content[] 里的 tool_use 块（input 是对象）', () => {
  const parsed = anthropic.parseResponse(
    {
      model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先看一下' },
        { type: 'tool_use', id: 'toolu_01', name: 'set_params', input: { key: 'a', value: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"key":"a","value":1}', '★ input 对象要归一化回字符串');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.text, '我先看一下', '★ 文字部分照常保留');
});

/* -------------------------------------------------------------------------- */
/*  Gemini                                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ Gemini：工具声明包在 functionDeclarations，且 schema 要过 toGeminiSchema', () => {
  const body = gemini.buildBody(CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools), '★ 必须带 tools');
  const decls = tools[0]?.['functionDeclarations'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(decls), '★ 要包在 functionDeclarations 里');
  assert.equal(decls[0]?.['name'], 'get_performance');
  /*
   * Gemini 只认大写的 type（STRING/OBJECT…），小写会被 400 拒。
   * `toGeminiSchema` 负责这件事 —— 这里钉住它确实被调用了。
   */
  const params = decls[0]?.['parameters'] as Record<string, unknown>;
  assert.equal(params['type'], 'OBJECT', '★ type 必须被翻成大写');
});

test('★★★ Gemini：没有 tool 角色 —— 工具结果用 user + functionResponse（靠 name 关联）', () => {
  const body = gemini.buildBody(CONVERSATION, { tools: TOOLS });
  const contents = body['contents'] as Array<Record<string, unknown>>;
  assert.ok(
    contents.every((c) => c['role'] !== 'tool'),
    '★ Gemini 只有 user / model 两种 role',
  );
  const withResponse = contents.find(
    (c) =>
      Array.isArray(c['parts']) &&
      (c['parts'] as Array<Record<string, unknown>>).some((p) => p['functionResponse'] !== undefined),
  );
  assert.ok(withResponse !== undefined, '★ 工具结果要以 functionResponse 回传');
  assert.equal(withResponse['role'], 'user', '★ 用 user 身份');
  const part = (withResponse['parts'] as Array<Record<string, unknown>>)[0];
  const fr = part?.['functionResponse'] as Record<string, unknown>;
  assert.equal(fr['name'], 'get_performance', '★ Gemini 靠工具名关联，不是 id');
});

test('★★★ Gemini：解析 parts 里的 functionCall（args 是对象）', () => {
  const parsed = gemini.parseResponse(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: '看一下' },
              { functionCall: { name: 'set_params', args: { key: 'a', value: 1 } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"key":"a","value":1}');
  assert.equal(parsed.finishReason, 'tool_calls');
});

/* -------------------------------------------------------------------------- */
/*  向后兼容                                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ 不传 tools 时三家都不该产生任何 tools 字段（老路径逐字节不变）', () => {
  /*
   * 这条很重要：改造**不能改变任何现有调用的行为**。
   * 老的 JSON 协议路径（模型自己写 `{"tool":"…"}`）还要继续工作。
   */
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
  ];
  assert.equal(openai.buildBody('deepseek', 'm', msgs)['tools'], undefined);
  assert.equal(anthropic.buildBody('claude-sonnet-5-5', msgs)['tools'], undefined);
  assert.equal(gemini.buildBody(msgs)['tools'], undefined);
});

test('★★★ 不传 tools 时解析结果没有 toolCalls（undefined 不是空数组）', () => {
  /*
   * `undefined` = 这次请求根本没带 tools；
   * `[]`       = 带了 tools 但模型选择不调。
   * 混成一个会让上层无法区分"该等工具结果"和"这是最终回答"。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    { model: 'm', choices: [{ finish_reason: 'stop', message: { content: '你好' } }] },
    'fallback',
  );
  assert.equal(parsed.toolCalls, undefined, '★ 没有工具调用时是 undefined');
});

test('★★★ 改造后三种 adapter 的响应形状一致（上游只需一套解析）', () => {
  /*
   * 这是整个改造的价值所在：`loop.ts` 只认 `result.toolCalls`，
   * 不需要知道背后是哪家 provider。
   */
  const o = openai.parseResponse(
    'deepseek',
    { model: 'm', choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'n', arguments: '{}' } }] } }] },
    'f',
  );
  const a = anthropic.parseResponse(
    { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'n', input: {} }] },
    'f',
  );
  const g = gemini.parseResponse(
    { candidates: [{ content: { parts: [{ functionCall: { name: 'n', args: {} } }] } }] },
    'f',
  );
  for (const [label, parsed] of [
    ['openai', o],
    ['anthropic', a],
    ['gemini', g],
  ] as const) {
    assert.equal(parsed.toolCalls?.length, 1, `★ ${label} 必须都归一化成 ToolCall[]`);
    assert.equal(parsed.toolCalls?.[0]?.name, 'n', `★ ${label} 的名称字段一致`);
    assert.equal(typeof parsed.toolCalls?.[0]?.id, 'string', `★ ${label} 都必须有 id`);
    assert.equal(typeof parsed.toolCalls?.[0]?.arguments, 'string', `★ ${label} 的参数都是字符串`);
    assert.equal(parsed.finishReason, 'tool_calls', `★ ${label} 的 finishReason 一致`);
  }
});
