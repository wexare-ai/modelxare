import { describe, expect, it } from 'vitest';
import { sha256Hex, type OperationConfig, type ReleaseManifest } from '@wexare/protocol';
import type { CandidateRelease } from '@wexare/orchestrator';
import {
  GENERAL_TASKS,
  LAYA_WEB_VERSION,
  REMOTE_OFF,
  catalogTasks,
  layaBundle,
  localChoices,
  partsOf,
  pickRouter,
  remoteHelp,
  remoteProblem,
  route,
  routerSupport,
  taskQuestion,
  tasksFor,
  type ChoiceQuestion,
  type Hooks,
  type RemoteHelp,
  type System1,
  type System1Result,
} from '../src/index.ts';

/** Tasks as releases describe them. */
const TASKS: Record<string, Omit<OperationConfig, 'id' | 'prompt'>> = {
  'text-classification': { title: 'Sort by topic', category: 'messages', when: 'put a message into one topic', output: { type: 'label', labels: [{ id: 'travel' }, { id: 'other' }] } },
  summarization: { title: 'Summarize', category: 'messages', when: 'shorten a message into one short sentence', output: { type: 'text', max_chars: 400 } },
  'text-generation': { title: 'Continue a story', category: 'writing', when: 'continue a story', output: { type: 'text' } },
  'git-command': { title: 'Write a git command', category: 'command-line', when: 'write a git command', output: { type: 'text', single_line: true, decline: 'UNSUPPORTED' } },
  'ffmpeg-command': { title: 'Write an ffmpeg command', category: 'command-line', when: 'write an ffmpeg command for a video', output: { type: 'text', single_line: true, decline: 'UNSUPPORTED' } },
};

let n = 0;
function model(p: { caps: string[]; langs?: string[]; size?: number; kind?: 'model' | 'lora'; when?: Record<string, string>; name?: string; id?: string; version?: string }): CandidateRelease {
  n++;
  const manifest: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.2',
    model_id: p.id ?? `m${n}`,
    name: p.name ?? `Model ${n}`,
    description: '',
    version: p.version ?? '1.0.0',
    kind: p.kind ?? 'model',
    capabilities: p.caps,
    languages: p.langs ?? ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: 'wllama', requirement: '*', browser_features: [] },
    files: [{ role: p.kind === 'lora' ? 'adapter' : 'weights', path: `m${n}.gguf`, size: p.size ?? 100, sha256: sha256Hex(`file ${n}`), locations: [{ transport: 'http', uri: `http://127.0.0.1/${n}` }] }],
    operations: p.caps.map((id) => ({
      id,
      ...(TASKS[id] ?? { title: id, category: 'other-things', when: `do ${id}`, output: { type: 'text' as const } }),
      ...(p.when?.[id] ? { when: p.when[id] } : {}),
      prompt: { mode: 'chat' as const, template: '{{input}}' },
    })),
    requirements: { context_length: 512 },
  };
  return {
    eventId: sha256Hex(`event ${n}`),
    pubkey: 'a'.repeat(64),
    modelId: manifest.model_id,
    name: manifest.name,
    version: manifest.version,
    manifestSha256: sha256Hex(`manifest ${n}`),
    manifest,
    support: { supported: true, reasons: [], executableOperations: p.caps },
  };
}

/**
 * System 1 that answers from a table: text read -> [choice, probability]. A
 * question that doesn't offer the choice (another group, or `otherwise` for
 * any other text) is answered unsure: its first option, evenly. Model
 * questions are answered from `models`: option name -> probability. Records
 * every text read and every question's options.
 */
function reads(table: Record<string, [string, number]>, otherwise: [string, number] = ['summarization', 0.3], models: Record<string, number> = {}) {
  const texts: string[] = [];
  const questions: string[][] = [];
  const system1: System1 = {
    async predict(state, qs) {
      const text = (state as { request: string }).request;
      const answers: System1Result['answers'] = {};
      for (const [key, q] of Object.entries(qs)) {
        const keys = Object.keys((q as ChoiceQuestion).criteria);
        questions.push(keys);
        if (key.startsWith('model')) {
          const choice = keys.find((k) => k in models) ?? keys[0]!;
          const p = models[choice] ?? 1 / keys.length;
          answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / (keys.length - 1)])), confidence: 0.5 };
          continue;
        }
        texts.push(text);
        const [want, p] = table[text] ?? otherwise;
        const [choice, pc] = keys.includes(want) ? [want, p] : [keys[0]!, 1 / keys.length];
        answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? pc : (1 - pc) / (keys.length - 1)])), confidence: 0.5 };
      }
      return { answers, latency_ms: 125, device: 'wasm' };
    },
  };
  return { system1, texts, questions };
}

function hooks(over: Partial<Hooks> & { cached?: string[] } = {}) {
  const calls = { local: [] as string[], inputs: [] as string[], confirm: 0, download: 0, clarify: [] as string[][] };
  const cached = new Set(over.cached ?? []);
  const h: Hooks = {
    candidates: [],
    isCached: (s) => cached.has(s),
    async runLocal(release, task, input) {
      calls.local.push(`${release.name}:${task}`);
      calls.inputs.push(input);
      return task === 'text-classification' ? { label: 'travel' } : { text: `${task} by ${release.name}` };
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
      calls.clarify.push(options.map((o) => o.task.id));
      return options[1]!.task.id;
    },
    ...over,
  };
  return { h, calls };
}

const online = (): RemoteHelp & { asked: string[]; sent: string[] } => {
  const asked: string[] = [];
  const sent: string[] = [];
  return { provider: 'OpenRouter', model: 'openrouter/auto', asked, sent, run: async (task, request) => (asked.push(task.id), sent.push(request), `online ${task.id}`) };
};

const summarizer = model({ caps: ['summarization'], size: 386, name: 'Tiny summarizer (SmolLM2)' });
const assistant = model({ caps: ['text-classification', 'summarization'], langs: ['en', 'es'], size: 491, name: 'Message assistant (Qwen2.5)' });
const ready = (...m: CandidateRelease[]) => m.flatMap((x) => x.manifest.files.map((f) => f.sha256));

describe('what a request can ask for', () => {
  it('comes from the catalog: each task once, in its own words, then the general requests', () => {
    const story = model({ caps: ['text-generation'] });
    const adapter = model({ caps: ['text-generation'], kind: 'lora', when: { 'text-generation': 'write like Shakespeare' } });
    const tasks = tasksFor([summarizer, assistant, story, adapter]);
    expect(tasks.map((t) => [t.id, t.category])).toEqual([
      ['summarization', 'messages'],
      ['text-classification', 'messages'],
      ['text-generation', 'writing'],
      ['answer', undefined],
      ['translation', undefined],
      ['reply', undefined],
    ]);
    expect(tasks.find((t) => t.id === 'text-generation')!.when).toBe('continue a story'); // a model speaks for a task before an add-on that restyles it
    expect(taskQuestion(tasks)).toMatchObject({ type: 'choice', criteria: { summarization: 'shorten a message into one short sentence', answer: 'answer a question or explain something' } });
  });

  it('lets a release that offers a general task speak for it', () => {
    const translator = model({ caps: ['translation'], when: { translation: 'translate English text into Spanish' } });
    const tasks = tasksFor([translator]);
    expect(tasks.filter((t) => t.id === 'translation')).toEqual([expect.objectContaining({ category: 'other-things', when: 'translate English text into Spanish' })]);
    expect(catalogTasks([translator])).toHaveLength(1);
  });

  it('keeps every description short enough for System 1 to read', () => {
    for (const t of GENERAL_TASKS) expect(t.when.length).toBeLessThan(160); // Laya fits options in 192 tokens
  });

  it('finds each task an instruction names', () => {
    expect(partsOf('Categorize and Summarize this message')).toEqual(['Categorize this message', 'Summarize this message']);
    expect(partsOf('Sort this message and then summarize it')).toEqual(['Sort this message', 'summarize it']);
    expect(partsOf('Categorize, summarize and reply to this message')).toEqual(['Categorize this message', 'summarize this message', 'reply to this message']);
    expect(partsOf('Convert and resize this video')).toEqual(['Convert this video', 'resize this video']);
    expect(partsOf('categorize + summarize')).toEqual(['categorize', 'summarize']);
    expect(partsOf('Translate into French')).toEqual(['Translate into French']);
    expect(partsOf('Sandra and Andy')).toEqual(['Sandra', 'Andy']); // whole words only
    expect(partsOf('a, b, c, d, e, f, g, h')).toHaveLength(6);
  });
});

describe('routing plan', () => {
  const leak = 'there is a water leak near the entrance.';

  it('reads each task the instruction names on its own, and does them all', async () => {
    const { system1, texts } = reads({ 'Categorize this message': ['text-classification', 0.99], 'summarize this message': ['summarization', 1] });
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const request = `Categorize and summarize this message: ${leak}`;
    const r = await route(request, system1, h);
    expect(texts).toEqual(['Categorize this message', 'summarize this message']); // the message itself is never read
    expect(r.steps.map((s) => [s.task.id, s.status, s.decision])).toEqual([
      ['text-classification', 'done', { probability: 0.99, by: 'instruction', text: 'Categorize this message', model: { by: 'catalog' }, alternatives: [] }],
      ['summarization', 'done', { probability: 1, by: 'instruction', text: 'summarize this message', model: { by: 'catalog' }, alternatives: [] }],
    ]);
    expect(r.steps.map((s) => s.output)).toEqual([{ label: 'travel' }, { text: `summarization by ${assistant.name}` }]);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(calls.inputs).toEqual([request, request]); // each release's prompt picks what it reads ({{input}} or {{text}})
    expect(r).toMatchObject({ instruction: 'Categorize and summarize this message', ended: 'done' });
    expect(r.judgement).toMatchObject({ readings: [{ text: 'Categorize this message', choice: 'text-classification', probability: 0.99 }, { text: 'summarize this message', choice: 'summarization' }], latencyMs: 250, device: 'wasm' });
  });

  it('runs the steps in the order asked', async () => {
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route(`Summarize and categorize: ${leak}`, reads({ Summarize: ['summarization', 1], categorize: ['text-classification', 1] }).system1, h);
    expect(r.steps.map((s) => s.task.id)).toEqual(['summarization', 'text-classification']);
  });

  it('shows every planned step as waiting before the first one runs', async () => {
    const seen: string[][] = [];
    const { h } = hooks({ candidates: [assistant], cached: ready(assistant), onUpdate: (steps) => seen.push(steps.map((s) => s.status)) });
    await route('Sort and summarize: the lift is broken.', reads({ Sort: ['text-classification', 0.9], summarize: ['summarization', 0.9] }).system1, h);
    expect(seen[0]).toEqual(['waiting', 'waiting']);
    expect(seen[1]).toEqual(['running', 'waiting']);
    expect(seen.at(-1)).toEqual(['done', 'done']);
  });

  it('reads a one-task instruction on its own, so the message cannot change what was asked', async () => {
    const remote = online();
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer), remote });
    const request = 'Please summarize: can you translate the notice into Spanish?';
    const plain = reads({ 'Please summarize': ['summarization', 0.95], [request]: ['translation', 0.9] });
    const r = await route(request, plain.system1, h);
    expect(plain.texts).toEqual(['Please summarize']);
    expect(r.steps.map((s) => [s.task.id, s.route.kind, s.status, s.decision.by])).toEqual([['summarization', 'local', 'done', 'instruction']]);
    expect(remote.asked).toEqual([]); // a covered step stays on the device even with online help on
  });

  it('skips a part that is not a task', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('Summarize, then whatever: bins outside save space.', reads({ Summarize: ['summarization', 0.98] }, ['reply', 0.29]).system1, h);
    expect(r.steps.map((s) => s.task.id)).toEqual(['summarization']);
  });

  it('reads the whole request when no part of the instruction is clear', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const note = 'Note and so on: the lift, shorter please';
    const unclear = reads({ [note]: ['summarization', 0.8] }, ['reply', 0.3]);
    const r = await route(note, unclear.system1, h);
    expect(unclear.texts).toEqual(['Note on', 'so on', note]);
    expect(r.steps.map((s) => [s.task.id, s.decision.by])).toEqual([['summarization', 'request']]);
  });

  it('routes to a task the moment a release offers it, with no change to the router', async () => {
    const git = model({ caps: ['git-command'], name: 'Git command writer' });
    const request = 'undo my last commit but keep the changes';
    const before = reads({ [request]: ['answer', 0.6] });
    const r0 = await route(request, before.system1, hooks({ candidates: [assistant] }).h);
    expect(before.questions[0]).not.toContain('git-command');
    expect(r0.steps.map((s) => s.task.id)).toEqual(['answer']);

    const { h, calls } = hooks({ candidates: [assistant, git], cached: ready(git) });
    const r = await route(request, reads({ [request]: ['git-command', 0.94] }).system1, h);
    expect(r.steps.map((s) => [s.task.id, s.task.title, s.status])).toEqual([['git-command', 'Write a git command', 'done']]);
    expect(calls.inputs).toEqual([request]);
  });

  it('keeps each question within what System 1 is calibrated for: tasks compete in groups, winners in a final', async () => {
    const many = Array.from({ length: 14 }, (_, i) => model({ caps: [`task-${String(i).padStart(2, '0')}`] }));
    const request = 'do the eleventh thing';
    const { system1, questions } = reads({ [request]: ['task-11', 0.9] });
    const { h } = hooks({ candidates: many, cached: ready(...many) });
    const r = await route(request, system1, h);
    expect(questions.every((q) => q.length <= 10)).toBe(true);
    expect(questions.at(-1)).toEqual(expect.arrayContaining(['task-11', 'answer', 'translation', 'reply']));
    expect(r.steps.map((s) => [s.task.id, s.status])).toEqual([['task-11', 'done']]);
  });

  it('asks System 1 which model fits best when several do the task differently', async () => {
    const emails = model({ caps: ['summarization'], when: { summarization: 'shorten a long work email' }, name: 'Email summarizer (x)' });
    const request = 'Summarize this email from my manager about the budget';
    const { h, calls } = hooks({ candidates: [summarizer, emails], cached: ready(summarizer, emails) });
    const r = await route(request, reads({ [request]: ['summarization', 0.9] }, undefined, { 'Email summarizer': 0.8 }).system1, h);
    expect(r.steps[0]!.decision.model).toEqual({ by: 'system1', probability: 0.8, name: 'Email summarizer' });
    expect(calls.local).toEqual([`${emails.name}:summarization`]);

    // Unsure, or the same description: the catalog order decides (downloaded, then smallest).
    const unsure = hooks({ candidates: [summarizer, emails], cached: ready(summarizer) });
    const r2 = await route(request, reads({ [request]: ['summarization', 0.9] }).system1, unsure.h);
    expect(r2.steps[0]!.decision.model).toEqual({ by: 'catalog' });
    expect(unsure.calls.local).toEqual([`${summarizer.name}:summarization`]);
  });

  it('asks the person when nothing is clear, and stops if they decline', async () => {
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant) });
    const r = await route('the lift', reads({}, ['summarization', 0.4]).system1, h);
    expect(calls.clarify[0]![0]).toBe('summarization'); // likeliest first
    expect(r.steps.map((s) => [s.task.id, s.decision.by])).toEqual([[calls.clarify[0]![1], 'person']]);

    const declined = await route('the lift', reads({}, ['summarization', 0.4]).system1, hooks({ clarify: async () => null }).h);
    expect(declined).toMatchObject({ ended: 'unsure', steps: [] });
  });

  it('uses online help only for steps no local model covers, and sends it the whole request', async () => {
    const remote = online();
    const { h, calls } = hooks({ candidates: [assistant], cached: ready(assistant), remote });
    const request = 'Summarize this and translate it into French: the pool is closed today.';
    const r = await route(request, reads({ 'Summarize this': ['summarization', 0.99], 'translate it into French': ['translation', 1] }).system1, h);
    expect(r.steps.map((s) => [s.task.id, s.route.kind])).toEqual([
      ['summarization', 'local'],
      ['translation', 'remote'],
    ]);
    expect(r.steps[1]!.output).toEqual({ text: 'online translation' });
    expect(remote.asked).toEqual(['translation']);
    expect(remote.sent).toEqual([request]); // it needs "into French"
    expect(calls.inputs).toEqual([request]);
  });

  it('without online help, reports an uncovered step as unavailable and does the rest', async () => {
    const { h } = hooks({ candidates: [summarizer], cached: ready(summarizer) });
    const r = await route('Translate and summarize: the pool is closed today.', reads({ Translate: ['translation', 0.95], summarize: ['summarization', 0.95] }).system1, h);
    expect(r.steps.map((s) => [s.task.id, s.status])).toEqual([
      ['translation', 'unavailable'],
      ['summarization', 'done'],
    ]);
    expect(r.steps[0]!.route).toEqual({ kind: 'none', reason: 'no model on this device can do this yet' });
  });

  it('moves a request a model says is outside what it does to the next likeliest task', async () => {
    const pictures = model({ caps: ['imagemagick-command'], name: 'Picture commands (x)' });
    const media = model({ caps: ['ffmpeg-command'], name: 'Media commands (x)' });
    const request = 'grab a 15 second clip from wedding.mov';
    const seen: string[] = [];
    const { h, calls } = hooks({
      candidates: [pictures, media],
      cached: ready(pictures, media),
      runLocal: async (release, task) => (seen.push(task), task === 'imagemagick-command' ? { declined: true } : { text: 'ffmpeg -i wedding.mov -t 15 output.mp4' }),
    });
    const fake = reads({});
    fake.system1.predict = async (_state, qs) => {
      const keys = Object.keys((qs.main as ChoiceQuestion).criteria);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === 'imagemagick-command' ? 0.55 : k === 'ffmpeg-command' ? 0.35 : 0.1 / (keys.length - 2)]));
      return { answers: { main: { type: 'choice', choice: 'imagemagick-command', probabilities, confidence: 0.4 } }, latency_ms: 1 };
    };
    const r = await route(request, fake.system1, h);
    expect(seen).toEqual(['imagemagick-command', 'ffmpeg-command']);
    expect(r.steps.map((s) => [s.task.id, s.status, s.output, s.decision.insteadOf, s.decision.probability])).toEqual([
      ['ffmpeg-command', 'done', { text: 'ffmpeg -i wedding.mov -t 15 output.mp4' }, 'imagemagick-command', 0.35],
    ]);
    expect(calls.local).toEqual([]); // runLocal was replaced
  });

  it('hands a request a model says is outside what it does to online help, or reports it', async () => {
    const git = model({ caps: ['git-command'], name: 'Git command writer (x)' });
    const request = 'push my changes to the moon';
    const decline = { runLocal: async () => ({ declined: true }) };
    const r = await route(request, reads({ [request]: ['git-command', 0.9] }).system1, hooks({ candidates: [git], cached: ready(git), ...decline }).h);
    expect(r.steps.map((s) => [s.status, s.error])).toEqual([['unavailable', 'Git command writer answered that this request is outside what it does']]);
    const remote = online();
    const r2 = await route(request, reads({ [request]: ['git-command', 0.9] }).system1, hooks({ candidates: [git], cached: ready(git), remote, ...decline }).h);
    expect(r2.steps.map((s) => [s.status, s.route.kind, s.output])).toEqual([['done', 'remote', { text: 'online git-command' }]]);
  });

  it('reuses a model an earlier step downloaded instead of fetching another', async () => {
    // Nothing is downloaded yet: sort needs the assistant, which can summarize too.
    const { h, calls } = hooks({ candidates: [summarizer, assistant] });
    delete h.confirmDownload;
    const r = await route('Sort and summarize: the lift is broken.', reads({ Sort: ['text-classification', 0.9], summarize: ['summarization', 0.9] }).system1, h);
    expect(calls.local).toEqual([`${assistant.name}:text-classification`, `${assistant.name}:summarization`]);
    expect(calls.download).toBe(1);
    expect(r.steps.every((s) => s.status === 'done')).toBe(true);
  });

  const summarizeAll = () => reads({}, ['summarization', 0.9]).system1;
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
    const table = { Summarize: ['summarization', 0.95], sort: ['text-classification', 0.94], translate: ['translation', 0.93] } as Record<string, [string, number]>;
    const r = await route('Summarize, sort and translate: the lift is broken.', reads(table).system1, h, { maxSteps: 2 });
    expect(r.ended).toBe('step-limit');
    expect(r.steps.map((s) => [s.task.id, s.status, s.error])).toEqual([
      ['summarization', 'failed', 'out of memory'],
      ['text-classification', 'failed', 'out of memory'],
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
    const r2 = await route('Sort and summarize: x', reads({ Sort: ['text-classification', 0.9], summarize: ['summarization', 0.9] }).system1, h);
    expect(r2.ended).toBe('canceled');
    expect(r2.steps.map((s) => s.status)).toEqual(['running', 'waiting']);
  });

});

describe('add-ons and versions', () => {
  const base = model({ caps: ['summarization'], size: 491, name: 'Base (x)' });
  const git = model({ caps: ['git-command'], id: 'git-commands', kind: 'lora', size: 6, name: 'Git commands (x)' });
  const ffmpeg = model({ caps: ['ffmpeg-command'], id: 'ffmpeg-commands', kind: 'lora', size: 6, name: 'FFmpeg commands (x)' });
  const baseOf = (c: CandidateRelease) => (c.manifest.kind === 'lora' ? base : null);

  it('lists the newest version of each model that can do a task, adapters only with their base', () => {
    const newer = model({ caps: ['git-command'], id: 'git-commands', version: '1.0.10', kind: 'lora' });
    const spanish = model({ caps: ['git-command'], id: 'es-only', langs: ['es'] });
    const orphan = model({ caps: ['git-command'], id: 'orphan', kind: 'lora' });
    const choices = localChoices('git-command', 'en', { candidates: [git, newer, spanish, orphan, base], baseOf: (c) => (c === orphan ? null : baseOf(c)) });
    expect(choices.map((c) => [c.release, c.base])).toEqual([[newer, base]]);
    // Without a way to find bases, adapters are left out.
    expect(localChoices('git-command', 'en', { candidates: [git, ffmpeg] })).toEqual([]);
  });

  it('offers the tasks add-ons do, and runs the chosen add-on on its base', async () => {
    expect(catalogTasks([base, git, ffmpeg]).map((t) => t.id)).toEqual(['ffmpeg-command', 'git-command', 'summarization']);
    const request = 'Extract the audio from talk.mp4';
    const runs: { name: string; base?: string; input: string }[] = [];
    const downloads: (string | undefined)[] = [];
    const { h } = hooks({
      candidates: [base, git, ffmpeg],
      baseOf,
      async runLocal(release, _task, input, _language, _signal, b) {
        runs.push({ name: release.modelId, ...(b ? { base: b.modelId } : {}), input });
        return { text: 'ffmpeg -i talk.mp4 -vn talk.mp3' };
      },
      async download(_release, b) {
        downloads.push(b?.modelId);
        return true;
      },
    });
    const r = await route(request, reads({ [request]: ['ffmpeg-command', 0.9] }).system1, h);
    const step = r.steps[0]!;
    expect(step.route).toMatchObject({ kind: 'local', release: { modelId: 'ffmpeg-commands' }, base: { modelId: base.modelId }, downloadBytes: 491 + 6 });
    expect([step.task.id, step.status]).toEqual(['ffmpeg-command', 'done']);
    expect(downloads).toEqual([base.modelId]);
    expect(runs).toEqual([{ name: 'ffmpeg-commands', base: base.modelId, input: request }]);
  });
});

describe('short parts of an instruction', () => {
  it('count only when System 1 is very sure, so a phrase cut in two is not a task', async () => {
    const { h } = hooks({ candidates: [summarizer, assistant] });
    const { system1 } = reads({ 'Summarize the pros': ['summarization', 0.96], cons: ['answer', 0.71] });
    const r = await route('Summarize the pros and cons: bins outside save space but attract foxes.', system1, h);
    expect(r.steps.map((s) => s.task.id)).toEqual(['summarization']);
    const r2 = await route('Categorize it and summarize the pros: x', reads({ 'Categorize it': ['text-classification', 0.98], 'summarize the pros': ['summarization', 0.96] }).system1, h);
    expect(r2.steps.map((s) => s.task.id)).toEqual(['text-classification', 'summarization']);
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

  it('sends an OpenAI-compatible chat request with the task as the system message', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: ' La piscine est fermée. ' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const help = remoteHelp(settings, fake)!;
    const translate = GENERAL_TASKS.find((t) => t.id === 'translation')!;
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
    const answer = GENERAL_TASKS.find((t) => t.id === 'answer')!;
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
