// The OpenAI API's request and response shapes: requests are checked and
// turned into runtime calls here, and runtime results into OpenAI JSON and
// server-sent events. Pure functions, so they're tested without a model.
import { randomBytes } from 'node:crypto';
import type { ChatMessageIn, ChatRun, CompleteRun, Output, ToolSpec } from './llama.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = 'invalid_request_error',
    readonly param: string | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
  }
}

const bad = (message: string, param: string | null = null, code: string | null = null) => new ApiError(400, message, 'invalid_request_error', param, code);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** chatcmpl-…, cmpl-…, call_…: random letters and digits, like OpenAI's. */
export const newId = (prefix: string) => `${prefix}${prefix === 'call' ? '_' : '-'}${randomBytes(12).toString('hex')}`;

export interface Defaults {
  /** max_tokens when a request doesn't say. */
  maxTokens: number;
}

export interface ChatRequest {
  model: string;
  run: Omit<ChatRun, 'signal' | 'onText'>;
  stream: boolean;
  includeUsage: boolean;
}

export interface CompletionRequest {
  model: string;
  run: Omit<CompleteRun, 'signal' | 'onText'>;
  stream: boolean;
  includeUsage: boolean;
}

/** Text of a message's content: a string, or the text parts of a list. */
function textOf(content: unknown, at: string): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw bad(`${at}: content must be a string or a list of parts`, at);
  return content
    .map((part, i) => {
      if (!isObject(part)) throw bad(`${at}[${i}]: expected a content part`, at);
      if (part.type === 'text' || part.type === 'input_text') return typeof part.text === 'string' ? part.text : '';
      if (part.type === 'refusal') return typeof part.refusal === 'string' ? part.refusal : '';
      throw bad(`${at}[${i}]: these models read text only (got a ${String(part.type)} part)`, at, 'unsupported_content');
    })
    .join('');
}

function messagesOf(raw: unknown): ChatMessageIn[] {
  if (!Array.isArray(raw) || !raw.length) throw bad('messages: expected a non-empty list', 'messages');
  return raw.map((m, i): ChatMessageIn => {
    const at = `messages[${i}]`;
    if (!isObject(m)) throw bad(`${at}: expected an object`, at);
    const content = textOf(m.content, `${at}.content`);
    switch (m.role) {
      case 'system':
      case 'developer':
        return { role: 'system', content };
      case 'user':
        return { role: 'user', content };
      case 'assistant': {
        const calls = m.tool_calls;
        if (calls !== undefined && calls !== null && !Array.isArray(calls)) throw bad(`${at}.tool_calls: expected a list`, at);
        const toolCalls = (calls ?? []).map((c: unknown, j: number) => {
          const fn = isObject(c) && isObject(c.function) ? c.function : null;
          if (!fn || typeof fn.name !== 'string') throw bad(`${at}.tool_calls[${j}]: expected {id, type: "function", function: {name, arguments}}`, at);
          return { id: isObject(c) && typeof c.id === 'string' ? c.id : `call_${i}_${j}`, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
        });
        return { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) };
      }
      case 'tool':
      case 'function':
        return { role: 'tool', content, ...(typeof m.tool_call_id === 'string' ? { toolCallId: m.tool_call_id } : {}) };
      default:
        throw bad(`${at}.role: expected system, developer, user, assistant or tool`, `${at}.role`);
    }
  });
}

function toolsOf(body: Json): { tools?: ToolSpec[]; parallelToolCalls?: boolean } {
  const choice = body.tool_choice;
  if (choice === 'none' || !Array.isArray(body.tools) || !body.tools.length) return {};
  let tools: ToolSpec[] = body.tools
    .filter((t): t is Json => isObject(t) && (t.type === 'function' || t.type === undefined) && isObject(t.function))
    .map((t) => {
      const fn = t.function as Json;
      if (typeof fn.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(fn.name)) throw bad('tools: each function needs a name of letters, digits, _ . : or -', 'tools');
      return { name: fn.name, ...(typeof fn.description === 'string' ? { description: fn.description } : {}), ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}) };
    });
  // A named function: only that one is offered (the model may still answer in text).
  if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === 'string') tools = tools.filter((t) => t.name === (choice.function as Json).name);
  return { ...(tools.length ? { tools } : {}), ...(typeof body.parallel_tool_calls === 'boolean' ? { parallelToolCalls: body.parallel_tool_calls } : {}) };
}

function number(body: Json, key: string, min: number, max: number, integer = false): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw bad(`${key}: expected ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`, key);
  return v;
}

function sampling(body: Json, defaults: Defaults) {
  const maxTokens = number(body, 'max_completion_tokens', 1, 1 << 20, true) ?? number(body, 'max_tokens', 1, 1 << 20, true) ?? defaults.maxTokens;
  const n = number(body, 'n', 1, 128, true);
  if (n !== undefined && n !== 1) throw bad('n: only 1 choice per request is supported', 'n');
  const stop = body.stop;
  if (stop !== undefined && stop !== null && typeof stop !== 'string' && !(Array.isArray(stop) && stop.every((s) => typeof s === 'string'))) throw bad('stop: expected a string or a list of strings', 'stop');
  const opt = (key: string, value: number | undefined) => (value === undefined ? {} : { [key]: value });
  return {
    maxTokens,
    ...opt('temperature', number(body, 'temperature', 0, 2)),
    ...opt('topP', number(body, 'top_p', 0, 1)),
    ...opt('topK', number(body, 'top_k', 0, 1000, true)),
    ...opt('minP', number(body, 'min_p', 0, 1)),
    ...opt('seed', number(body, 'seed', -(2 ** 53), 2 ** 53, true)),
    ...opt('frequencyPenalty', number(body, 'frequency_penalty', -2, 2)),
    ...opt('presencePenalty', number(body, 'presence_penalty', -2, 2)),
    ...(typeof stop === 'string' ? { stop: [stop] } : Array.isArray(stop) && stop.length ? { stop: stop.filter(Boolean) as string[] } : {}),
  };
}

function streamOf(body: Json): { stream: boolean; includeUsage: boolean } {
  const stream = body.stream === true;
  const options = isObject(body.stream_options) ? body.stream_options : {};
  return { stream, includeUsage: stream && options.include_usage === true };
}

function modelOf(body: Json): string {
  if (typeof body.model !== 'string' || !body.model.trim()) throw bad('model: required', 'model');
  return body.model.trim();
}

export function parseChatRequest(body: unknown, defaults: Defaults): ChatRequest {
  if (!isObject(body)) throw bad('expected a JSON object');
  const format = isObject(body.response_format) ? body.response_format : null;
  let json: ChatRun['json'];
  if (format?.type === 'json_object') json = 'object';
  else if (format?.type === 'json_schema') {
    const spec = isObject(format.json_schema) ? format.json_schema : null;
    if (!spec || !isObject(spec.schema)) throw bad('response_format.json_schema.schema: expected a JSON Schema object', 'response_format');
    json = { schema: spec.schema };
  } else if (format && format.type !== 'text') throw bad('response_format.type: expected text, json_object or json_schema', 'response_format');
  return {
    model: modelOf(body),
    run: { messages: messagesOf(body.messages), ...toolsOf(body), ...sampling(body, defaults), ...(json ? { json } : {}) },
    ...streamOf(body),
  };
}

export function parseCompletionRequest(body: unknown, defaults: Defaults): CompletionRequest {
  if (!isObject(body)) throw bad('expected a JSON object');
  let prompt = body.prompt;
  if (Array.isArray(prompt)) {
    if (prompt.length !== 1 || typeof prompt[0] !== 'string') throw bad('prompt: one string per request is supported', 'prompt');
    prompt = prompt[0];
  }
  if (typeof prompt !== 'string') throw bad('prompt: expected a string', 'prompt');
  if (body.suffix) throw bad('suffix: not supported', 'suffix');
  if (body.echo === true) throw bad('echo: not supported', 'echo');
  return { model: modelOf(body), run: { prompt, ...sampling(body, defaults) }, ...streamOf(body) };
}

const usage = (o: Pick<Output, 'promptTokens' | 'completionTokens'>) => ({ prompt_tokens: o.promptTokens, completion_tokens: o.completionTokens, total_tokens: o.promptTokens + o.completionTokens });

export const toolCallsOf = (o: Pick<Output, 'toolCalls'>, ids: string[]) =>
  o.toolCalls.map((c, i) => ({ id: ids[i] ?? `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }));

export function chatCompletion(id: string, model: string, created: number, o: Output, extra: Json = {}) {
  const ids = o.toolCalls.map(() => newId('call'));
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: o.text || (o.toolCalls.length ? null : ''), ...(o.toolCalls.length ? { tool_calls: toolCallsOf(o, ids) } : {}), refusal: null },
        logprobs: null,
        finish_reason: o.finishReason,
      },
    ],
    usage: usage(o),
    ...extra,
  };
}

export function chatChunk(id: string, model: string, created: number, delta: Json, finish: string | null = null, extra: Json = {}) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra };
}

export function usageChunk(id: string, model: string, created: number, o: Output, object = 'chat.completion.chunk') {
  return { id, object, created, model, choices: [], usage: usage(o) };
}

export function textCompletion(id: string, model: string, created: number, o: Output) {
  return { id, object: 'text_completion', created, model, choices: [{ text: o.text, index: 0, logprobs: null, finish_reason: o.finishReason }], usage: usage(o) };
}

export function textChunk(id: string, model: string, created: number, text: string, finish: string | null = null) {
  return { id, object: 'text_completion', created, model, choices: [{ text, index: 0, logprobs: null, finish_reason: finish }] };
}

/** One server-sent event. */
export const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
