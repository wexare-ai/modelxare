import { describe, expect, it } from 'vitest';
import { OPERATION_CONTRACTS, sha256Hex, type ReleaseManifest } from '@wexare/protocol';
import type { CandidateRelease } from '@wexare/orchestrator';
import {
  INTENTS,
  LAYA_WEB_VERSION,
  REMOTE_OFF,
  layaBundle,
  pickRouter,
  questionsFor,
  remoteHelp,
  remoteProblem,
  route,
  routerSupport,
  type Hooks,
  type Question,
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
 * System 1 that answers from a table: P(yes) per intent for the yes/no
 * questions (0.05 when not listed), and the main-task choice. Records each pass.
 */
function judged(asked: Record<string, number>, main: [string, number] = ['summarize', 0.3]) {
  const passes: Record<string, Question>[] = [];
  const system1: System1 = {
    async predict(_state, questions) {
      passes.push(questions);
      const answers: System1Result['answers'] = {};
      for (const [key, q] of Object.entries(questions)) {
        if (q.type === 'noul') {
          answers[key] = { type: 'noul', noul: asked[key.replace(/^asks_/, '')] ?? 0.05, confidence: 0.5 };
        } else {
          const [choice, p] = main;
          const rest = Object.keys(q.criteria).filter((k) => k !== choice);
          answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries([[choice, p], ...rest.map((k) => [k, (1 - p) / rest.length])]), confidence: 0.5 };
        }
      }
      return { answers, latency_ms: 125, device: 'wasm' };
    },
  };
  return { system1, passes };
}

function hooks(over: Partial<Hooks> & { cached?: string[] } = {}) {
  const calls = { local: [] as string[], remote: [] as string[], confirm: 0, download: 0, clarify: [] as string[][] };
  const cached = new Set(over.cached ?? []);
  const h: Hooks = {
    candidates: [],
    isCached: (s) => cached.has(s),
    async runLocal(release, capability) {
      calls.local.push(`${release.name}:${capability}`);
      return capability === 'text-classification' ? { topic: 'maintenance' } : { text: `${capability} by ${release.name}` };
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

const online = (): RemoteHelp & { asked: string[] } => {
  const asked: string[] = [];
  return { provider: 'OpenRouter', model: 'openrouter/auto', asked, run: async (intent) => (asked.push(intent.id), `online ${intent.id}`) };
};

const summarizer = model({ caps: ['summarization'], size: 386 });
const assistant = model({ caps: ['text-classification', 'summarization'], langs: ['en', 'es'], size: 491 });
const ready = (...m: CandidateRelease[]) => m.flatMap((x) => x.manifest.files.map((f) => f.sha256));

describe('routing plan', () => {
  it('runs every step the request asks for, decided in one pass', async () => {
    const { system1, passes } = judged({ sort: 0.93, summarize: 0.88 }, ['sort', 0.55]);
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route('Categorize and summarize this message: there is a water leak near the entrance.', system1, h);
    expect(passes).toHaveLength(1);
    expect(Object.keys(passes[0]!).sort()).toEqual(['asks_answer', 'asks_reply', 'asks_sort', 'asks_summarize', 'asks_translate', 'asks_write', 'main']);
    expect(r.steps.map((s) => [s.intent.id, s.status, s.decision.by])).toEqual([
      ['sort', 'done', 'asked'],
      ['summarize', 'done', 'asked'],
    ]);
    expect(r.steps.map((s) => s.output)).toEqual([{ topic: 'maintenance' }, { text: `summarization by ${assistant.name}` }]);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(r.ended).toBe('done');
    expect(r.judgement).toMatchObject({ asked: { sort: 0.93, summarize: 0.88, reply: 0.05 }, main: { choice: 'sort', probability: 0.55 }, latencyMs: 125 });
  });

  it('shows every planned step as waiting before the first one runs', async () => {
    const seen: string[][] = [];
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), onUpdate: (steps) => seen.push(steps.map((s) => s.status)) });
    await route('Sort and summarize: the lift is broken.', judged({ sort: 0.9, summarize: 0.9 }).system1, h);
    expect(seen[0]).toEqual(['waiting', 'waiting']);
    expect(seen[1]).toEqual(['running', 'waiting']);
    expect(seen.at(-1)).toEqual(['done', 'done']);
  });

  it('runs one step for a request that asks for one thing', async () => {
    const remote = online();
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer), remote });
    const r = await route('Please summarize: the lift is broken again.', judged({ summarize: 0.95 }, ['summarize', 0.9]).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.route.kind, s.status])).toEqual([['summarize', 'local', 'done']]);
    expect(remote.asked).toEqual([]); // a covered step stays on the device even with online help on
  });

  it('counts the main-task choice when the yes/no questions are unsure', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('the lift, shorter please', judged({ summarize: 0.4 }, ['summarize', 0.8]).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.decision])).toEqual([['summarize', { probability: 0.8, by: 'main' }]]);
  });

  it('asks the person when nothing is clear, and stops if they decline', async () => {
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route('the lift', judged({}, ['summarize', 0.4]).system1, h);
    expect(calls.clarify[0]![0]).toBe('summarize'); // likeliest first
    expect(r.steps.map((s) => [s.intent.id, s.decision.by])).toEqual([[calls.clarify[0]![1], 'person']]);

    const declined = await route('the lift', judged({}, ['summarize', 0.4]).system1, hooks({ clarify: async () => null }).h);
    expect(declined).toMatchObject({ ended: 'unsure', steps: [] });
  });

  it('uses online help only for steps no local model covers', async () => {
    const remote = online();
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), remote });
    const r = await route('Summarize this and translate it into French: the pool is closed today.', judged({ summarize: 0.9, translate: 0.9 }).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.route.kind])).toEqual([
      ['summarize', 'local'],
      ['translate', 'remote'],
    ]);
    expect(r.steps[1]!.output).toEqual({ text: 'online translate' });
    expect(remote.asked).toEqual(['translate']);
  });

  it('without online help, reports an uncovered step as unavailable and does the rest', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('Translate and summarize: the pool is closed today.', judged({ translate: 0.9, summarize: 0.8 }).system1, h);
    expect(r.steps.map((s) => [s.intent.id, s.status])).toEqual([
      ['summarize', 'done'],
      ['translate', 'unavailable'],
    ]);
    expect(r.steps[1]!.route).toEqual({ kind: 'none', reason: 'no model on this device can do this yet' });
  });

  it('reuses a model an earlier step downloaded instead of fetching another', async () => {
    // Nothing is downloaded yet: sort needs the assistant, which can summarize too.
    const { h, calls } = hooks({ candidates: [summarizer, assistant] });
    delete h.confirmDownload;
    const r = await route('Sort and summarize: the lift is broken.', judged({ sort: 0.9, summarize: 0.9 }).system1, h);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(calls.download).toBe(1);
    expect(r.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('asks before a download when the host wants that; declining skips the step', async () => {
    const { h, calls } = hooks({ candidates: [summarizer], confirmDownload: async () => false });
    const r = await route('Summarize: the lift is broken.', judged({ summarize: 0.9 }).system1, h);
    expect(r.steps[0]!.status).toBe('declined');
    expect(calls.download).toBe(0);

    const ok = hooks({ candidates: [summarizer] });
    const r2 = await route('Summarize: the lift is broken.', judged({ summarize: 0.9 }).system1, ok.h);
    expect(r2.steps[0]!.route).toMatchObject({ kind: 'local', downloadBytes: 386 });
    expect([ok.calls.confirm, ok.calls.download, ok.calls.local.length]).toEqual([1, 1, 1]);
  });

  it('downloads without asking when the host has no confirmation step', async () => {
    const { h, calls } = hooks({ candidates: [summarizer] });
    delete h.confirmDownload;
    const r = await route('Summarize: the lift is broken.', judged({ summarize: 0.9 }).system1, h);
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
    const r = await route('Summarize: the lift is broken.', judged({ summarize: 0.9 }).system1, h);
    expect(r.steps[0]).toMatchObject({ status: 'failed', error: 'There isn’t enough free space on this device for this model.' });
  });

  it('picks a local model that declares the request language', async () => {
    const { h, calls } = hooks({ candidates: [summarizer, assistant], cached: ready(summarizer, assistant) });
    await route('Hay una fuga de agua cerca de la entrada desde esta mañana. ¿Alguien puede revisarla?', judged({ summarize: 0.9 }).system1, h);
    expect(calls.local).toEqual([`${assistant.name}:summarization`]);
  });

  it('keeps the likeliest steps when more are asked for than one request may take', async () => {
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), runLocal: async () => Promise.reject(new Error('out of memory')) });
    const r = await route('Summarize, sort and translate: the lift is broken.', judged({ summarize: 0.9, sort: 0.8, translate: 0.6 }).system1, h, { maxSteps: 2 });
    expect(r.ended).toBe('step-limit');
    expect(r.steps.map((s) => [s.intent.id, s.status, s.error])).toEqual([
      ['sort', 'failed', 'out of memory'],
      ['summarize', 'failed', 'out of memory'],
    ]);
  });

  it('stops when canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await route('Summarize: x', judged({ summarize: 0.9 }).system1, hooks({ signal: ac.signal }).h);
    expect(r).toMatchObject({ ended: 'canceled', steps: [] });

    const later = new AbortController();
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), signal: later.signal });
    h.runLocal = async () => (later.abort(), Promise.reject(new DOMException('canceled', 'AbortError')));
    const r2 = await route('Sort and summarize: x', judged({ sort: 0.9, summarize: 0.9 }).system1, h);
    expect(r2.ended).toBe('canceled');
    expect(r2.steps.map((s) => s.status)).toEqual(['running', 'waiting']);
  });

  it('asks System 1 short questions it can read', () => {
    for (const i of INTENTS) {
      expect(i.criterion.length).toBeLessThan(160); // Laya fits options in 192 tokens
      expect(i.asks).toContain('`request`');
    }
    const q = questionsFor(INTENTS);
    expect(q.main).toMatchObject({ type: 'choice' });
    expect(Object.values(q).filter((x) => x.type === 'noul')).toHaveLength(INTENTS.length);
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
