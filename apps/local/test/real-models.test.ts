// The local runtime's OpenAI-compatible API with the real catalog models:
// native llama.cpp for System 2, native ONNX Runtime for the System 1 router.
// Opt-in, because it needs the models pulled into a data folder (about 1.9 GB)
// and about 4 GB of free memory:
//
//   pnpm modelxare --env infra/deploy/app.env.example --home <dir> pull auto
//   WEXARE_TEST_LOCAL=<dir> pnpm vitest run --project unit apps/local/test/real-models.test.ts
//
// Model outputs vary with hardware and versions, so the checks are on shape and
// routing, never on exact wording. Every answer is written to
// tests/results/LOCAL.json (ignored by Git) as evidence.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ROOT } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { createApi } from '../src/server.ts';

const HOME = process.env.WEXARE_TEST_LOCAL;
const evidence: Record<string, unknown> = {};
const MINUTES = 60_000;

describe.skipIf(!HOME)('local runtime with real models', () => {
  let engine: Engine;
  let base = '';
  let close = () => undefined as void;

  beforeAll(async () => {
    engine = new Engine({ home: HOME!, config: loadConfig(), llama: { gpu: 'auto', contextSize: 32768, maxLoaded: 3 } });
    const server = createApi(engine, { host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    close = () => void server.close();
    evidence.backend = await engine.llama.backend();
  });

  afterAll(async () => {
    close();
    await engine?.close();
    mkdirSync(join(ROOT, 'tests/results'), { recursive: true });
    writeFileSync(join(ROOT, 'tests/results/LOCAL.json'), JSON.stringify({ at: new Date().toISOString(), ...evidence }, null, 2));
  });

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };

  it('lists auto and the downloaded models, with their context', async () => {
    const models = (await (await fetch(`${base}/models`)).json()) as { data: { id: string; context_length?: number }[] };
    evidence.models = models.data.map((m) => [m.id, m.context_length]);
    expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(['auto', 'community-assistant', 'tiny-summarizer']));
    expect(models.data.find((m) => m.id === 'tiny-summarizer')?.context_length).toBe(8192);
  });

  it('answers a chat request', async () => {
    const r = await post('/chat/completions', { model: 'tiny-summarizer', temperature: 0, max_tokens: 60, messages: [{ role: 'system', content: 'Summarize the message in one short sentence.' }, { role: 'user', content: 'The elevator in building B has been out of order since Monday and elderly residents cannot reach their flats.' }] });
    evidence.chat = r.body.choices?.[0];
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(10);
    expect(r.body.usage.completion_tokens).toBeGreaterThan(0);
  }, 5 * MINUTES);

  it('streams, ending with a finish reason, the usage chunk and [DONE]', async () => {
    const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'community-assistant', stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 30, messages: [{ role: 'user', content: 'Say hello in Spanish.' }] }) });
    const events = (await r.text()).split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    evidence.stream = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(chunks.at(-2).choices[0].finish_reason).toBe('stop');
    expect(chunks.at(-1).usage.completion_tokens).toBeGreaterThan(0);
  }, 5 * MINUTES);

  it('calls a tool, then answers from its result', async () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const messages: unknown[] = [{ role: 'user', content: 'What is the weather in Paris right now?' }];
    const first = await post('/chat/completions', { model: 'community-assistant', temperature: 0, tools, messages });
    const choice = first.body.choices[0];
    evidence.toolCall = choice;
    expect(choice.finish_reason).toBe('tool_calls');
    const call = choice.message.tool_calls[0];
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments).city).toMatch(/paris/i);
    const second = await post('/chat/completions', { model: 'community-assistant', temperature: 0, tools, messages: [...messages, choice.message, { role: 'tool', tool_call_id: call.id, content: '{"temperature": 18, "unit": "celsius", "sky": "cloudy"}' }] });
    evidence.toolAnswer = second.body.choices[0];
    expect(second.body.choices[0].finish_reason).toBe('stop');
    expect(second.body.choices[0].message.content).toMatch(/18/);
  }, 5 * MINUTES);

  it('keeps to a JSON schema', async () => {
    const r = await post('/chat/completions', { model: 'community-assistant', temperature: 0, max_tokens: 60, messages: [{ role: 'user', content: 'Give a short title for a conversation about a broken elevator.' }], response_format: { type: 'json_schema', json_schema: { name: 'title', strict: true, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } } });
    evidence.json = r.body.choices[0].message.content;
    expect(typeof JSON.parse(r.body.choices[0].message.content).title).toBe('string');
  }, 5 * MINUTES);

  it('continues text with an adapter on its base model', async () => {
    const r = await post('/completions', { model: 'shakespeare-lora', prompt: 'Look in thy glass', max_tokens: 30, temperature: 0 });
    evidence.completion = r.body.choices?.[0];
    expect(r.status).toBe(200);
    expect(r.body.choices[0].text.length).toBeGreaterThan(10);
  }, 5 * MINUTES);

  it('auto: System 1 hands each task to a specialist', async () => {
    const r = await post('/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'Categorize and summarize this message: The heating in the community room has not worked for three days and it is freezing.' }] });
    evidence.autoSpecialists = { content: r.body.choices[0].message.content, route: r.body.modelxare };
    expect(r.body.modelxare.answered_by).toBe('specialists');
    expect(r.body.modelxare.steps.map((s: { task: string; model: string }) => `${s.task}→${s.model}`)).toEqual(['sort→community-assistant', 'summarize→tiny-summarizer']);
    expect(r.body.choices[0].message.content).toMatch(/^Topic: \w+\nSummary: .+/);
  }, 10 * MINUTES);

  it('auto: a task without a specialist goes to the general model', async () => {
    const r = await post('/chat/completions', { model: 'auto', temperature: 0, max_tokens: 40, messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    evidence.autoGeneral = { content: r.body.choices[0].message.content, route: r.body.modelxare };
    expect(r.body.modelxare.answered_by).toBe('general');
    expect(r.body.modelxare.system1.readings[0].choice).toBe('answer');
    expect(r.body.choices[0].message.content).toMatch(/Paris/);
  }, 10 * MINUTES);
});
