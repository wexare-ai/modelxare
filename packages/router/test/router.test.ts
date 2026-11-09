import { describe, expect, it } from 'vitest';
import { OPERATION_CONTRACTS, sha256Hex, type ReleaseManifest } from '@wexare/protocol';
import type { CandidateRelease } from '@wexare/orchestrator';
import {
  INTENTS,
  LAYA_WEB_VERSION,
  REMOTE_OFF,
  layaBundle,
  mainQuestion,
  partsOf,
  pickRouter,
  remoteHelp,
  remoteProblem,
  route,
  routerSupport,
  splitRequest,
  type ChoiceQuestion,
  type Hooks,
  type RemoteHelp,
  type System1,
  type System1Result,
} from '../src/index.ts';

let n = 0;
function model(p: { caps: string[]; langs?: string[]; size?: number }): CandidateRelease {
  n++;
  const manifest: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.1',
    model_id: `m${n}`,
    name: `Model ${n}`,
    description: '',
    version: '1.0.0',
    kind: 'model',
    capabilities: p.caps,
    languages: p.langs ?? ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: 'wllama', requirement: '*', browser_features: [] },
    files: [{ role: 'weights', path: `m${n}.gguf`, size: p.size ?? 100, sha256: sha256Hex(`file ${n}`), locations: [{ transport: 'http', uri: `http://127.0.0.1/${n}` }] }],
    operations: p.caps.map((id) => ({
      id,
      prompt: { mode: 'chat' as const, template: '{{input}}' },
      input_schema: OPERATION_CONTRACTS[id]!.input_schema,
      output_schema: OPERATION_CONTRACTS[id]!.output_schema,
    })),
    requirements: { context_length: 512 },
  };
  return {
    eventId: sha256Hex(`event ${n}`),
    pubkey: 'a'.repeat(64),
    modelId: manifest.model_id,
    name: manifest.name,
    version: '1.0.0',
    manifestSha256: sha256Hex(`manifest ${n}`),
    manifest,
    support: { supported: true, reasons: [], executableOperations: p.caps },
  };
}

/**
 * System 1 that answers from a table: text read -> [choice, probability];
 * any other text gets `otherwise`. Records every text it reads.
 */
function reads(table: Record<string, [string, number]>, otherwise: [string, number] = ['summarize', 0.3]) {
  const texts: string[] = [];
  const system1: System1 = {
    async predict(state, questions) {
      const text = (state as { request: string }).request;
      texts.push(text);
      const [choice, p] = table[text] ?? otherwise;
      const rest = Object.keys((questions.main as ChoiceQuestion).criteria).filter((k) => k !== choice);
      const answers: System1Result['answers'] = {
        main: { type: 'choice', choice, probabilities: Object.fromEntries([[choice, p], ...rest.map((k) => [k, (1 - p) / rest.length])]), confidence: 0.5 },
      };
      return { answers, latency_ms: 125, device: 'wasm' };
    },
  };
  return { system1, texts };
}

function hooks(over: Partial<Hooks> & { cached?: string[] } = {}) {
  const calls = { local: [] as string[], inputs: [] as string[], confirm: 0, download: 0, clarify: [] as string[][] };
  const cached = new Set(over.cached ?? []);
  const h: Hooks = {
    candidates: [],
    isCached: (s) => cached.has(s),
    async runLocal(release, capability, input) {
      calls.local.push(`${release.name}:${capability}`);
      calls.inputs.push(input);
      return capability === 'text-classification' ? { topic: 'travel' } : { text: `${capability} by ${release.name}` };
    },
    remote: null,
    async confirmDownload() {
      calls.confirm++;
      return true;
    },
    async download(release) {
      calls.download++;
      for (const f of release.manifest.files) cached.add(f.sha256);
      return true;
    },
    async clarify(options) {
      calls.clarify.push(options.map((o) => o.intent.id));
      return options[1]!.intent.id;
    },
    ...over,
  };
  return { h, calls };
}

const online = (): RemoteHelp & { asked: string[]; sent: string[] } => {
  const asked: string[] = [];
  const sent: string[] = [];
  return { provider: 'OpenRouter', model: 'openrouter/auto', asked, sent, run: async (intent, request) => (asked.push(intent.id), sent.push(request), `online ${intent.id}`) };
};

const summarizer = model({ caps: ['summarization'], size: 386 });
const assistant = model({ caps: ['text-classification', 'summarization'], langs: ['en', 'es'], size: 491 });
const ready = (...m: CandidateRelease[]) => m.flatMap((x) => x.manifest.files.map((f) => f.sha256));

describe('reading a request', () => {
  it('splits off the instruction at the start', () => {
    const msg = 'There has been a water leak near the entrance since this morning. Can someone inspect it?';
    expect(splitRequest(`Categorize and Summarize this message: ${msg}`)).toEqual({ instruction: 'Categorize and Summarize this message', message: msg });
    expect(splitRequest('Can you sort this and give me a short summary? The bins smell.')).toEqual({ instruction: 'Can you sort this and give me a short summary?', message: 'The bins smell.' });
    // A question with nothing after it is the request itself.
    expect(splitRequest('What is the capital of Australia?')).toEqual({ instruction: null, message: 'What is the capital of Australia?' });
    expect(splitRequest('Once upon a time, a little fox')).toEqual({ instruction: null, message: 'Once upon a time, a little fox' });
    // Times and links are not instructions.
    expect(splitRequest('The meeting moved to 7:30 tonight.').instruction).toBeNull();
    expect(splitRequest('See https://example.com for the rules.').instruction).toBeNull();
    // Only near the start.
    expect(splitRequest(`${'The garden committee met again. '.repeat(5)}Agenda: bins`).instruction).toBeNull();
    expect(splitRequest('Summarize:')).toEqual({ instruction: 'Summarize', message: 'Summarize:' });
  });

  it('finds each task an instruction names', () => {
    expect(partsOf('Categorize and Summarize this message')).toEqual(['Categorize', 'Summarize this message']);
    expect(partsOf('Sort this message and then summarize it')).toEqual(['Sort this message', 'summarize it']);
    expect(partsOf('Categorize, summarize and reply to this message')).toEqual(['Categorize', 'summarize', 'reply to this message']);
    expect(partsOf('categorize + summarize')).toEqual(['categorize', 'summarize']);
    expect(partsOf('Translate into French')).toEqual(['Translate into French']);
    expect(partsOf('Sandra and Andy')).toEqual(['Sandra', 'Andy']); // whole words only
    expect(partsOf('a, b, c, d, e, f, g, h')).toHaveLength(6);
  });
});

describe('routing plan', () => {
  const leak = 'there is a water leak near the entrance.';

  it('reads each task the instruction names on its own, and does them all', async () => {
    const { system1, texts } = reads({ Categorize: ['sort', 0.99], 'summarize this message': ['summarize', 1] });
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route(`Categorize and summarize this message: ${leak}`, system1, h);
    expect(texts).toEqual(['Categorize', 'summarize this message']); // the message itself is never read
    expect(r.steps.map((s) => [s.intent.id, s.status, s.decision])).toEqual([
      ['sort', 'done', { probability: 0.99, by: 'instruction', text: 'Categorize' }],
      ['summarize', 'done', { probability: 1, by: 'instruction', text: 'summarize this message' }],
    ]);
    expect(r.steps.map((s) => s.output)).toEqual([{ topic: 'travel' }, { text: `summarization by ${assistant.name}` }]);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(calls.inputs).toEqual([leak, leak]); // local models get the message, without the instruction
    expect(r).toMatchObject({ instruction: 'Categorize and summarize this message', message: leak, ended: 'done' });
    expect(r.judgement).toMatchObject({ readings: [{ text: 'Categorize', choice: 'sort', probability: 0.99 }, { text: 'summarize this message', choice: 'summarize' }], latencyMs: 250, device: 'wasm' });
  });

  it('runs the steps in the order asked', async () => {
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route(`Summarize and categorize: ${leak}`, reads({ Summarize: ['summarize', 1], categorize: ['sort', 1] }).system1, h);
    expect(r.steps.map((s) => s.intent.id)).toEqual(['summarize', 'sort']);
  });

  it('shows every planned step as waiting before the first one runs', async () => {
    const seen: string[][] = [];
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), onUpdate: (steps) => seen.push(steps.map((s) => s.status)) });
    await route('Sort and summarize: the lift is broken.', reads({ Sort: ['sort', 0.9], summarize: ['summarize', 0.9] }).system1, h);
    expect(seen[0]).toEqual(['waiting', 'waiting']);
    expect(seen[1]).toEqual(['running', 'waiting']);
    expect(seen.at(-1)).toEqual(['done', 'done']);
  });

  it('runs one step for a request that asks for one thing', async () => {
    const remote = online();
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer), remote });
    const r = await route('Please summarize: the lift is broken again.', reads({ 'Please summarize': ['summarize', 0.95] }).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.route.kind, s.status])).toEqual([['summarize', 'local', 'done']]);
    expect(remote.asked).toEqual([]); // a covered step stays on the device even with online help on
  });

  it('skips a part that is not a task', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('Summarize the pros and cons: bins outside save space.', reads({ 'Summarize the pros': ['summarize', 0.98] }, ['reply', 0.29]).system1, h);
    expect(r.steps.map((s) => s.intent.id)).toEqual(['summarize']);
  });

  it('reads the whole request when it has no instruction, or no part of it is clear', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const story = 'Once upon a time, a little fox found a lantern.';
    const plain = reads({ [story]: ['write', 0.93] });
    const r = await route(story, plain.system1, h);
    expect(plain.texts).toEqual([story]);
    expect(r.steps.map((s) => [s.intent.id, s.decision])).toEqual([['write', { probability: 0.93, by: 'request' }]]);

    const note = 'Note: the lift, shorter please';
    const unclear = reads({ [note]: ['summarize', 0.8] }, ['reply', 0.3]);
    const r2 = await route(note, unclear.system1, h);
    expect(unclear.texts).toEqual(['Note', note]);
    expect(r2.steps.map((s) => [s.intent.id, s.decision.by])).toEqual([['summarize', 'request']]);
    expect(r2.judgement!.readings.map((x) => x.text)).toEqual(['Note', note]);
  });

  it('asks the person when nothing is clear, and stops if they decline', async () => {
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route('the lift', reads({}, ['summarize', 0.4]).system1, h);
    expect(calls.clarify[0]![0]).toBe('summarize'); // likeliest first
    expect(r.steps.map((s) => [s.intent.id, s.decision.by])).toEqual([[calls.clarify[0]![1], 'person']]);

    const declined = await route('the lift', reads({}, ['summarize', 0.4]).system1, hooks({ clarify: async () => null }).h);
    expect(declined).toMatchObject({ ended: 'unsure', steps: [] });
  });

  it('uses online help only for steps no local model covers, and sends it the whole request', async () => {
    const remote = online();
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant), remote });
    const request = 'Summarize this and translate it into French: the pool is closed today.';
    const r = await route(request, reads({ 'Summarize this': ['summarize', 0.99], 'translate it into French': ['translate', 1] }).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.route.kind])).toEqual([
      ['summarize', 'local'],
      ['translate', 'remote'],
    ]);
    expect(r.steps[1]!.output).toEqual({ text: 'online translate' });
    expect(remote.asked).toEqual(['translate']);
    expect(remote.sent).toEqual([request]); // it needs "into French"
    expect(calls.inputs).toEqual(['the pool is closed today.']);
  });

  it('without online help, reports an uncovered step as unavailable and does the rest', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('Translate and summarize: the pool is closed today.', reads({ Translate: ['translate', 0.9], summarize: ['summarize', 0.8] }).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.status])).toEqual([
      ['translate', 'unavailable'],
      ['summarize', 'done'],
    ]);
    expect(r.steps[0]!.route).toEqual({ kind: 'none', reason: 'no model on this device can do this yet' });
  });

  it('reuses a model an earlier step downloaded instead of fetching another', async () => {
    // Nothing is downloaded yet: sort needs the assistant, which can summarize too.
    const { h, calls } = hooks({ candidates: [summarizer, assistant] });
    delete h.confirmDownload;
    const r = await route('Sort and summarize: the lift is broken.', reads({ Sort: ['sort', 0.9], summarize: ['summarize', 0.9] }).system1, h);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(calls.download).toBe(1);
    expect(r.steps.every((s) => s.status === 'done')).toBe(true);
  });

  const summarizeAll = () => reads({}, ['summarize', 0.9]).system1;

  it('asks before a download when the host wants that; declining skips the step', async () => {
    const { h, calls } = hooks({ candidates: [summarizer], confirmDownload: async () => false });
    const r = await route('Summarize: the lift is broken.', summarizeAll(), h);
    expect(r.steps[0]!.status).toBe('declined');
    expect(calls.download).toBe(0);

    const ok = hooks({ candidates: [summarizer] });
    const r2 = await route('Summarize: the lift is broken.', summarizeAll(), ok.h);
    expect(r2.steps[0]!.route).toMatchObject({ kind: 'local', downloadBytes: 386 });
    expect([ok.calls.confirm, ok.calls.download, ok.calls.local.length]).toEqual([1, 1, 1]);
  });

  it('downloads without asking when the host has no confirmation step', async () => {
    const { h, calls } = hooks({ candidates: [summarizer] });
    delete h.confirmDownload;
    const r = await route('Summarize: the lift is broken.', summarizeAll(), h);
    expect(r.steps[0]!.status).toBe('done');
    expect([calls.confirm, calls.download, calls.local.length]).toEqual([0, 1, 1]);
  });

  it('reports why a download failed in the step', async () => {
    const { h } = hooks({
      candidates: [summarizer],
      download: async () => {
        throw new Error('There isn’t enough free space on this device for this model.');
      },
    });
    delete h.confirmDownload;
    const r = await route('Summarize: the lift is broken.', summarizeAll(), h);
    expect(r.steps[0]).toMatchObject({ status: 'failed', error: 'There isn’t enough free space on this device for this model.' });
  });

  it('picks a local model that declares the language of the message', async () => {
    const { h, calls } = hooks({ candidates: [summarizer, assistant], cached: ready(summarizer, assistant) });
    await route('Hay una fuga de agua cerca de la entrada desde esta mañana. ¿Alguien puede revisarla?', summarizeAll(), h);
    expect(calls.local).toEqual([`${assistant.name}:summarization`]);
    const r = await route('Summarize: Hay una fuga de agua cerca de la entrada desde esta mañana.', summarizeAll(), h);
    expect(r.language).toBe('es');
  });

  it('keeps the first steps asked for when there are more than one request may take', async () => {
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), runLocal: async () => Promise.reject(new Error('out of memory')) });
    const table = { Summarize: ['summarize', 0.9], sort: ['sort', 0.8], translate: ['translate', 0.6] } as Record<string, [string, number]>;
    const r = await route('Summarize, sort and translate: the lift is broken.', reads(table).system1, h, { maxSteps: 2 });
    expect(r.ended).toBe('step-limit');
    expect(r.steps.map((s) => [s.intent.id, s.status, s.error])).toEqual([
      ['summarize', 'failed', 'out of memory'],
      ['sort', 'failed', 'out of memory'],
    ]);
  });

  it('stops when canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await route('Summarize: x', summarizeAll(), hooks({ signal: ac.signal }).h);
    expect(r).toMatchObject({ ended: 'canceled', steps: [] });

    const later = new AbortController();
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), signal: later.signal });
    h.runLocal = async () => (later.abort(), Promise.reject(new DOMException('canceled', 'AbortError')));
    const r2 = await route('Sort and summarize: x', reads({ Sort: ['sort', 0.9], summarize: ['summarize', 0.9] }).system1, h);
    expect(r2.ended).toBe('canceled');
    expect(r2.steps.map((s) => s.status)).toEqual(['running', 'waiting']);
  });

  it('asks System 1 one short question it can read', () => {
    for (const i of INTENTS) expect(i.criterion.length).toBeLessThan(160); // Laya fits options in 192 tokens
    expect(mainQuestion(INTENTS)).toMatchObject({ type: 'choice', criteria: Object.fromEntries(INTENTS.map((i) => [i.id, i.criterion])) });
  });
});

describe('online help', () => {
  const settings = { ...REMOTE_OFF, enabled: true, apiKey: 'sk-test-secret', model: 'openrouter/auto' };

  it('is off unless enabled with a key, a model and an https address', () => {
    expect(remoteProblem(REMOTE_OFF)).toBe('online help is off');
    expect(remoteProblem({ ...settings, apiKey: ' ' })).toBe('add an API key');
    expect(remoteProblem({ ...settings, model: '' })).toBe('name a model');
    expect(remoteProblem({ ...settings, provider: 'custom', baseUrl: 'http://example.com/v1' })).toMatch(/https/);
    expect(remoteProblem({ ...settings, provider: 'custom', baseUrl: 'http://localhost:11434/v1' })).toBeNull();
    expect(remoteHelp(REMOTE_OFF)).toBeNull();
  });

  it('sends an OpenAI-compatible chat request with the intent as the system message', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: ' La piscine est fermée. ' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const help = remoteHelp(settings, fake)!;
    const translate = INTENTS.find((i) => i.id === 'translate')!;
    expect(await help.run(translate, 'The pool is closed.', ['sort: topic: other'])).toBe('La piscine est fermée.');
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-secret');
    const body = JSON.parse(sent[0]!.init.body as string);
    expect(body.model).toBe('openrouter/auto');
    expect(body.messages[0].content).toContain(translate.instruction);
    expect(body.messages[0].content).toContain('sort: topic: other');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'The pool is closed.' });
  });

  it('explains failures in plain words and never repeats the key', async () => {
    const status = (code: number) => (async () => new Response('{"error":"bad key sk-test-secret"}', { status: code })) as unknown as typeof fetch;
    const answer = INTENTS.find((i) => i.id === 'answer')!;
    const refused = remoteHelp(settings, status(401))!.run(answer, 'Why?', []);
    await expect(refused).rejects.toThrow('OpenRouter refused the API key');
    await expect(remoteHelp(settings, status(429))!.run(answer, 'Why?', [])).rejects.toThrow(/limiting requests/);
    const offline = (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const err = await remoteHelp(settings, offline)!.run(answer, 'Why?', []).catch((e: Error) => e);
    expect((err as Error).message).toBe('could not reach OpenRouter');
    for (const e of [await refused.catch((x: Error) => x), err]) expect((e as Error).message).not.toContain('sk-test');
  });
});

describe('System 1 release', () => {
  const f = (role: 'weights' | 'tokenizer' | 'config', path: string, size = 10, salt = '') => ({ role, path, size, sha256: sha256Hex(path + salt), locations: [{ transport: 'http' as const, uri: `http://127.0.0.1/${path}` }] });
  const laya = (version = '1.0.0', over: Partial<ReleaseManifest> = {}): CandidateRelease => {
    const m = model({ caps: ['summarization'] });
    const manifest: ReleaseManifest = {
      ...m.manifest,
      version,
      capabilities: ['intent-routing'],
      runtime: { format: 'onnx', family: 'laya', requirement: '>=0.1.1 <0.2.0', browser_features: ['wasm-simd'] },
      // Each version has its own weights; 1.0.0 keeps the plain hashes the bundle test expects.
      files: [f('weights', 'laya_fp16.onnx', 900, version === '1.0.0' ? '' : version), f('tokenizer', 'tokenizer.json'), f('tokenizer', 'tokenizer_config.json'), f('config', 'rl_agent_config.json')],
      operations: [],
      ...over,
    };
    return { ...m, version, manifest };
  };
  const features = { 'wasm-simd': true };

  it('accepts a complete Laya export this client can run, and says why not otherwise', () => {
    expect(routerSupport(laya().manifest, features)).toEqual({ supported: true, reasons: [] });
    expect(routerSupport(laya().manifest, {}).reasons).toEqual(['browser feature wasm-simd unavailable']);
    const wrongVersion = laya('1.0.0', { runtime: { format: 'onnx', family: 'laya', requirement: '>=0.2.0', browser_features: [] } });
    expect(routerSupport(wrongVersion.manifest, features).reasons).toEqual([`requires laya >=0.2.0; bundled ${LAYA_WEB_VERSION}`]);
    const noTokenizer = laya('1.0.0', { files: [f('weights', 'laya_fp16.onnx'), f('config', 'rl_agent_config.json')] });
    expect(routerSupport(noTokenizer.manifest, features).reasons).toEqual(['missing weights, tokenizer or config file']);
    expect(routerSupport(assistant.manifest, features).supported).toBe(false);
  });

  it('prefers a downloaded router, then the newest version', () => {
    const v1 = laya('1.0.0');
    const v2 = laya('1.2.0');
    expect(pickRouter([v1, v2, assistant], features, () => false)).toBe(v2);
    const cachedV1 = new Set(v1.manifest.files.map((x) => x.sha256));
    expect(pickRouter([v1, v2], features, (s) => cachedV1.has(s))).toBe(v1);
    expect(pickRouter([assistant], features, () => false)).toBeNull();
  });

  it('maps verified files onto the bundle the Laya library loads', () => {
    const r = laya();
    const b = layaBundle(r, (sha) => `blob:${sha.slice(0, 6)}`);
    const by = (p: string) => `blob:${sha256Hex(p).slice(0, 6)}`;
    expect(b).toMatchObject({ url: by('laya_fp16.onnx'), bytes: 900, tokenizerUrl: by('tokenizer.json'), tokenizerConfigUrl: by('tokenizer_config.json'), configUrl: by('rl_agent_config.json'), devices: ['webgpu', 'wasm'], maxOptions: null });
  });
});
