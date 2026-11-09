// OpenAI requests in, runtime calls out, and back: the shapes agents and SDKs
// rely on. No model runs here; real-model checks are in docs/acceptance.md.
import { describe, expect, it } from 'vitest';
import { ApiError, chatChunk, chatCompletion, newId, parseChatRequest, parseCompletionRequest, usageChunk } from '../src/openai.ts';
import { toHistory } from '../src/llama.ts';
import { compose } from '../src/auto.ts';
import type { Step } from '@wexare/router';

const defaults = { maxTokens: 1024 };
const user = (content: unknown) => ({ role: 'user', content });

const fails = (body: unknown, param: string | null) => {
  try {
    parseChatRequest(body, defaults);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).param).toBe(param);
    return;
  }
  throw new Error('expected a 400');
};

describe('chat requests', () => {
  it('maps messages, sampling and streaming', () => {
    const r = parseChatRequest(
      {
        model: 'modelxare/auto',
        messages: [{ role: 'developer', content: 'Be brief.' }, user([{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }])],
        temperature: 0.2,
        max_completion_tokens: 50,
        stop: 'END',
        seed: 7,
        stream: true,
        stream_options: { include_usage: true },
        user: 'ignored',
        logprobs: false,
      },
      defaults,
    );
    expect(r.model).toBe('modelxare/auto');
    expect(r.run.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello there' },
    ]);
    expect(r.run).toMatchObject({ temperature: 0.2, maxTokens: 50, stop: ['END'], seed: 7 });
    expect(r).toMatchObject({ stream: true, includeUsage: true });
  });

  it('uses the default answer length and no usage chunk unless asked', () => {
    const r = parseChatRequest({ model: 'm', messages: [user('hi')], stream_options: { include_usage: true } }, defaults);
    expect(r.run.maxTokens).toBe(1024);
    expect(r).toMatchObject({ stream: false, includeUsage: false });
  });

  it('offers tools unless tool_choice is none, and narrows to a named one', () => {
    const tools = [
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'b' } },
      { type: 'web_search' },
    ];
    expect(parseChatRequest({ model: 'm', messages: [user('x')], tools }, defaults).run.tools?.map((t) => t.name)).toEqual(['a', 'b']);
    expect(parseChatRequest({ model: 'm', messages: [user('x')], tools, tool_choice: 'none' }, defaults).run.tools).toBeUndefined();
    const named = parseChatRequest({ model: 'm', messages: [user('x')], tools, tool_choice: { type: 'function', function: { name: 'b' } }, parallel_tool_calls: false }, defaults).run;
    expect(named.tools).toEqual([{ name: 'b' }]);
    expect(named.parallelToolCalls).toBe(false);
  });

  it('keeps tool calls and their results', () => {
    const r = parseChatRequest(
      {
        model: 'm',
        messages: [
          user('weather?'),
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'w', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"t":18}' },
        ],
      },
      defaults,
    );
    expect(r.run.messages.slice(1)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'w', arguments: '{"city":"Paris"}' }] },
      { role: 'tool', content: '{"t":18}', toolCallId: 'call_1' },
    ]);
  });

  it('turns response_format into JSON constraints', () => {
    expect(parseChatRequest({ model: 'm', messages: [user('x')], response_format: { type: 'json_object' } }, defaults).run.json).toBe('object');
    const schema = { type: 'object', properties: { title: { type: 'string' } } };
    expect(parseChatRequest({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema', json_schema: { name: 't', strict: true, schema } } }, defaults).run.json).toEqual({ schema });
    expect(parseChatRequest({ model: 'm', messages: [user('x')], response_format: { type: 'text' } }, defaults).run.json).toBeUndefined();
  });

  it('refuses what it cannot do, naming the parameter', () => {
    fails({ messages: [user('x')] }, 'model');
    fails({ model: 'm', messages: [] }, 'messages');
    fails({ model: 'm', messages: [{ role: 'robot', content: 'x' }] }, 'messages[0].role');
    fails({ model: 'm', messages: [user([{ type: 'image_url', image_url: { url: 'x' } }])] }, 'messages[0].content');
    fails({ model: 'm', messages: [user('x')], n: 2 }, 'n');
    fails({ model: 'm', messages: [user('x')], temperature: 3 }, 'temperature');
    fails({ model: 'm', messages: [user('x')], max_tokens: 0 }, 'max_tokens');
    fails({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema' } }, 'response_format');
  });
});

describe('completion requests', () => {
  it('takes one prompt', () => {
    expect(parseCompletionRequest({ model: 'm', prompt: ['Once'], max_tokens: 9 }, defaults).run).toMatchObject({ prompt: 'Once', maxTokens: 9 });
    expect(() => parseCompletionRequest({ model: 'm', prompt: ['a', 'b'] }, defaults)).toThrow(ApiError);
    expect(() => parseCompletionRequest({ model: 'm', prompt: 'a', echo: true }, defaults)).toThrow(ApiError);
  });
});

describe('responses', () => {
  const out = { text: '', toolCalls: [{ name: 'w', arguments: '{"city":"Paris"}' }], finishReason: 'tool_calls' as const, promptTokens: 10, completionTokens: 5, ms: 1 };

  it('a tool call answer has null content, typed calls and usage', () => {
    const c = chatCompletion('chatcmpl-1', 'm', 1, out);
    expect(c.object).toBe('chat.completion');
    expect(c.choices[0]!.message.content).toBeNull();
    expect(c.choices[0]!.message.tool_calls![0]).toMatchObject({ type: 'function', function: { name: 'w', arguments: '{"city":"Paris"}' } });
    expect(c.choices[0]!.message.tool_calls![0]!.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(c.choices[0]!.finish_reason).toBe('tool_calls');
    expect(c.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('stream chunks and the usage chunk have the shapes clients parse', () => {
    expect(chatChunk('id', 'm', 1, { content: 'hi' })).toMatchObject({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] });
    expect(usageChunk('id', 'm', 1, out)).toMatchObject({ choices: [], usage: { total_tokens: 15 } });
    expect(newId('chatcmpl')).toMatch(/^chatcmpl-[0-9a-f]{24}$/);
  });
});

describe('chat history for llama.cpp', () => {
  it('puts tool results inside the turn that called them, and lets the model continue it', () => {
    const h = toHistory([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'w', arguments: '{"city":"Paris"}' }] },
      { role: 'tool', content: '{"t":18}', toolCallId: 'c1' },
    ]);
    expect(h).toEqual([
      { type: 'system', text: 'S' },
      { type: 'user', text: 'weather?' },
      { type: 'model', response: [{ type: 'functionCall', name: 'w', params: { city: 'Paris' }, result: { t: 18 } }] },
    ]);
  });

  it('opens a new model turn after a user message, and keeps unmatched tool results as text', () => {
    const h = toHistory([{ role: 'user', content: 'hi' }, { role: 'tool', content: 'orphan', toolCallId: 'nope' }]);
    expect(h).toEqual([
      { type: 'user', text: 'hi' },
      { type: 'user', text: 'Tool result:\norphan' },
      { type: 'model', response: [] },
    ]);
  });
});

describe('auto answers', () => {
  const step = (id: string, output: Step['output'], status: Step['status'] = 'done') => ({ intent: { id }, output, status }) as unknown as Step;
  it('one step is its answer; several are labeled', () => {
    expect(compose([step('summarize', { text: ' Short. ' })])).toBe('Short.');
    expect(compose([step('sort', { topic: 'Security' }), step('summarize', { text: 'Door open.' })])).toBe('Topic: Security\nSummary: Door open.');
  });
});
