import { describe, expect, it } from 'vitest';
import { MESSAGE_CATEGORIES, OPERATION_CONTRACTS, sha256Hex, type ReleaseManifest } from '@wexare/protocol';
import type { GenerateRequest, LoadRequest } from '@wexare/runtime';
import { detectLanguage, executeWorkflow, parseStageOutput, planWorkflow, resolveLoraDependency, runSingle, type CandidateRelease } from '../src/index.ts';

const op = (id: string) => ({
  id,
  prompt: { mode: 'chat' as const, template: id === 'text-classification' ? 'Message: {{input}} ({{categories}})' : 'Summarize in {{language}}: {{input}}' },
  input_schema: OPERATION_CONTRACTS[id]!.input_schema,
  output_schema: OPERATION_CONTRACTS[id]!.output_schema,
});
let n = 0;
function cand(p: { caps: string[]; langs?: string[]; size: number; pub?: string; family?: string; kind?: 'model' | 'lora'; base?: ReleaseManifest['base'] }): CandidateRelease {
  n++;
  const files = [{ role: (p.kind === 'lora' ? 'adapter' : 'weights') as 'weights', path: `m${n}.gguf`, size: p.size, sha256: sha256Hex(`file ${n}`), locations: [{ transport: 'http', uri: `http://127.0.0.1/x${n}` }] }];
  const manifest: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.1',
    model_id: `m${n}`,
    name: `Model ${n}`,
    description: '',
    version: '1.0.0',
    kind: p.kind ?? 'model',
    capabilities: p.caps,
    languages: p.langs ?? ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: p.family ?? 'wllama', requirement: '*', browser_features: [] },
    files,
    operations: p.caps.filter((c) => OPERATION_CONTRACTS[c]).map(op),
    requirements: { context_length: 512 },
    ...(p.base ? { base: p.base } : {}),
  };
  const supported = (p.family ?? 'wllama') === 'wllama';
  return {
    eventId: sha256Hex(`event ${n}`),
    pubkey: p.pub ?? 'a'.repeat(64),
    modelId: manifest.model_id,
    name: manifest.name,
    version: '1.0.0',
    manifestSha256: sha256Hex(`manifest ${n}`),
    manifest,
    support: { supported, reasons: supported ? [] : ['unsupported runtime'], executableOperations: manifest.operations.map((o) => o.id) },
  };
}

const qwen = cand({ caps: ['text-classification', 'summarization'], langs: ['en', 'es'], size: 491 });
const smol = cand({ caps: ['summarization'], size: 386 });
const onnx = cand({ caps: ['summarization'], size: 10, family: 'onnx-web' });
const all = [qwen, smol, onnx];
const none = () => false;
const MSG = 'Hi Sam, because of a storm your flight to Lisbon on Friday will leave two hours late, at 16:40. Your seat and bags stay the same.';

describe('planning (A12)', () => {
  it('detects English and Spanish', () => {
    expect(detectLanguage(MSG)).toBe('en');
    expect(detectLanguage('Tu vuelo a Lisboa del viernes se retrasa dos horas por una tormenta. La nueva hora de salida es las 16:40.')).toBe('es');
    expect(detectLanguage('ok')).toBe('und');
  });

  it('selects two distinct releases by default: smaller compatible download wins summarization', () => {
    const p = planWorkflow(MSG, all, {}, none);
    expect(p.ok).toBe(true);
    expect(p.stages.map((s) => s.release!.eventId)).toEqual([qwen.eventId, smol.eventId]);
    expect(p.downloadBytes).toBe(491 + 386);
    expect(p.stages[1]!.considered.find((c) => c.eventId === onnx.eventId)!.compatible).toBe(false);
  });

  it('prefers cached releases, then honours explicit choice', () => {
    const cachedQwen = (s: string) => qwen.manifest.files.some((f) => f.sha256 === s);
    expect(planWorkflow(MSG, all, {}, cachedQwen).stages[1]!.release!.eventId).toBe(qwen.eventId);
    const explicit = planWorkflow(MSG, all, { explicit: { summarization: qwen.eventId } }, none);
    expect(explicit.stages[1]!.release!.eventId).toBe(qwen.eventId);
    expect(explicit.stages[1]!.reason).toBe('explicit user choice');
    expect(explicit.downloads).toHaveLength(1); // shared file deduplicated
  });

  it('keeps the approved plan while its downloads finish one by one', () => {
    const cachedQwen = (s: string) => qwen.manifest.files.some((f) => f.sha256 === s);
    const pendingSmol = (s: string) => smol.manifest.files.some((f) => f.sha256 === s);
    const p = planWorkflow(MSG, all, {}, cachedQwen, pendingSmol);
    expect(p.stages.map((s) => s.release!.eventId)).toEqual([qwen.eventId, smol.eventId]);
    expect(p.stages[1]!.reason).toBe('compatible, download in progress');
    // Still blocked: the pending file is not verified yet.
    expect(p.downloads.map((d) => d.eventId)).toEqual([smol.eventId]);
  });

  it('never substitutes an incompatible explicit choice', () => {
    const p = planWorkflow(MSG, all, { explicit: { summarization: onnx.eventId } }, none);
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/not compatible/);
  });

  it('filters by language and reports missing stages visibly', () => {
    const es = planWorkflow('Tu vuelo a Lisboa del viernes se retrasa dos horas por una tormenta.', all, {}, none);
    expect(es.language).toBe('es');
    expect(es.stages.map((s) => s.release?.eventId)).toEqual([qwen.eventId, qwen.eventId]);
    const missing = planWorkflow(MSG, [smol], {}, none);
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toMatch(/text-classification: no compatible release/);
  });

  it('uses a stable tie-break', () => {
    const a = cand({ caps: ['summarization'], size: 100, pub: 'b'.repeat(64) });
    const b = cand({ caps: ['summarization'], size: 100, pub: 'a'.repeat(64) });
    const s = planWorkflow(MSG, [qwen, a, b], {}, none).stages[1]!;
    expect(s.release!.eventId).toBe(b.eventId);
    expect(s.reason).toMatch(/tie-break/);
  });
});

describe('LoRA dependencies (A13)', () => {
  const base = cand({ caps: ['text-generation'], size: 73 });
  const lookup = (id: string) => (id === base.eventId ? base : null);
  const good = cand({
    caps: ['text-generation'],
    size: 16,
    kind: 'lora',
    base: { release_id: base.eventId, manifest_sha256: base.manifestSha256, files: [{ sha256: base.manifest.files[0]!.sha256, size: 73 }] },
  });
  it('resolves the exact base and totals both downloads', () => {
    const d = resolveLoraDependency(good, lookup, none);
    expect(d.ok).toBe(true);
    expect(d.missingBytes).toBe(16 + 73);
  });
  it('blocks a wrong base variant, wrong manifest or missing base', () => {
    const wrongVariant = { ...good, manifest: { ...good.manifest, base: { ...good.manifest.base!, files: [{ sha256: sha256Hex('q8'), size: 39 }] } } };
    expect(resolveLoraDependency(wrongVariant, lookup, none).problems.join()).toMatch(/wrong base variant/);
    const wrongManifest = { ...good, manifest: { ...good.manifest, base: { ...good.manifest.base!, manifest_sha256: '0'.repeat(64) } } };
    expect(resolveLoraDependency(wrongManifest, lookup, none).ok).toBe(false);
    expect(resolveLoraDependency(good, () => null, none).problems.join()).toMatch(/not in the verified local catalog/);
  });
});

/** Fake runtime: records loads; generation is scripted per stage. */
function fakeRuntime(script: Record<string, string[]>) {
  const loads: string[] = [];
  const prompts: string[] = [];
  let loaded: { key: string } | null = null;
  return {
    loads,
    prompts,
    get loaded() {
      return loaded as never;
    },
    async load(r: LoadRequest) {
      loads.push(r.key);
      loaded = { key: r.key };
      return { key: r.key, ms: 1, multithread: false, threads: 1, architecture: 'x', adapterEvidence: [], adapters: [] };
    },
    async generate(r: GenerateRequest) {
      const stage = r.grammar ? 'text-classification' : 'summarization';
      prompts.push(r.prompt);
      const text = script[stage]!.shift() ?? '';
      r.onToken?.(text);
      return { text, promptTokens: 10, completionTokens: 3, ms: 2, finishReason: 'stop' };
    },
    async unload() {
      loaded = null;
    },
  };
}
const deps = (rt: ReturnType<typeof fakeRuntime>, verified: string[] = []) => ({
  runtime: rt,
  getVerifiedFile: async (sha: string) => {
    verified.push(sha);
    return new Blob(['x']);
  },
  choiceGrammar: (l: readonly string[]) => `root ::= ${l.map((x) => JSON.stringify(x)).join(' | ')}`,
});

describe('execution', () => {
  it('runs both stages sequentially with two models and composes a typed result', async () => {
    const rt = fakeRuntime({ 'text-classification': ['travel'], summarization: ['The Friday flight to Lisbon leaves two hours late.'] });
    const verified: string[] = [];
    const r = await executeWorkflow(planWorkflow(MSG, all, {}, none), deps(rt, verified));
    expect(r.status).toBe('completed');
    expect(r.category).toBe('travel');
    expect(r.summary).toMatch(/Lisbon/);
    // Each topic is listed with what it covers.
    expect(rt.prompts[0]).toContain('travel (flights, trains, hotels and trips), health (');
    expect(rt.loads).toHaveLength(2);
    expect(verified).toHaveLength(2);
    expect(r.trace.map((t) => t.releaseId)).toEqual([qwen.eventId, smol.eventId]);
    expect(r.composed!.text).toContain('Category: travel');
  });

  it('reuses the resident model when both stages use the same release', async () => {
    const rt = fakeRuntime({ 'text-classification': ['money'], summarization: ['Short.'] });
    const r = await executeWorkflow(planWorkflow(MSG, all, { explicit: { summarization: qwen.eventId } }, none), deps(rt));
    expect(rt.loads).toHaveLength(1);
    expect(r.trace[1]!.reusedLoadedModel).toBe(true);
  });

  it('retries once, then fails visibly without inventing a category', async () => {
    const rt = fakeRuntime({ 'text-classification': ['airport', 'airport'], summarization: ['Flight delayed.'] });
    const r = await executeWorkflow(planWorkflow(MSG, all, {}, none), deps(rt));
    expect(r.status).toBe('partial');
    expect(r.category).toBeUndefined();
    expect(r.trace[0]!.state).toBe('failed');
    expect(r.trace[0]!.attempts.map((a) => a.raw)).toEqual(['airport', 'airport']);
    expect(r.composed!.text).toContain('(classification failed)');
  });

  it('cancels and unloads', async () => {
    const rt = fakeRuntime({ 'text-classification': ['travel'], summarization: ['x'] });
    const ac = new AbortController();
    ac.abort();
    const r = await executeWorkflow(planWorkflow(MSG, all, {}, none), deps(rt), ac.signal);
    expect(r.status).toBe('canceled');
    expect(rt.loaded).toBeNull();
  });

  it('parses outputs against bundled contracts', () => {
    expect(parseStageOutput('text-classification', ' Travel.\n').value).toEqual({ category: 'travel' });
    expect(parseStageOutput('text-classification', 'other stuff').error).toBeDefined();
    expect(parseStageOutput('summarization', 'Summary: "A delay."').value).toEqual({ summary: 'A delay.' });
    expect(parseStageOutput('summarization', 'x'.repeat(500)).error).toBeDefined();
    expect(MESSAGE_CATEGORIES).toHaveLength(9);
    expect(parseStageOutput('text-classification', 'maintenance').error).toBeDefined();
  });

  it('runs a single release in one-model mode', async () => {
    const rt = fakeRuntime({ 'text-classification': [], summarization: ['One sentence.'] });
    const t = await runSingle(smol, 'summarization', MSG, deps(rt));
    expect(t.state).toBe('completed');
  });
});
