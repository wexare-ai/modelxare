// The routing plan. What a request can ask for comes from the catalog: every
// task a release offers, in its own words (see tasks.ts). System 1 picks among
// them with one choice question. When a request starts with an instruction
// naming several tasks ("Categorize and summarize this message: …"), each part
// is read on its own, because one System 1 choice finds one task. With many
// tasks, they compete in groups and the winners in a final round, so every
// question stays within the options System 1 is calibrated for. When several
// models offer the chosen task, System 1 also picks the one whose description
// fits the request best. Each step then runs on a model on this device, online
// only when the person allowed that, and is otherwise reported as unavailable.
// When nothing is clear, the person picks.
import { detectLanguage, type CandidateRelease } from '@wexare/orchestrator';
import { splitInstruction } from '@wexare/protocol';
import { GENERAL_TASKS, tasksFor, type Task } from './tasks.ts';
import type { ChoiceAnswer, ChoiceQuestion, Question, System1 } from './system-one.ts';

export interface RouterOptions {
  /** Most steps one request may take. */
  maxSteps?: number;
  /** System 1 is sure of a choice at or above this probability; when it is sure of none, the person picks. */
  sureAbove?: number;
  /** Most options in one System 1 question (it is calibrated for up to 10). */
  maxOptions?: number;
  /** Requests offered next to the catalog's tasks; defaults to GENERAL_TASKS. */
  general?: Task[];
}

const DEFAULTS = { maxSteps: 3, sureAbove: 0.5, maxOptions: 10 };
/** A runner-up worth trying when the chosen model declines. */
const ALTERNATIVE_ABOVE = 0.15;

export interface StepOutput {
  /** Summary, command, continued text, translation, answer. */
  text?: string;
  /** One of the operation's labels, such as a topic. */
  label?: string;
  /** The model answered that the request is outside what it does. */
  declined?: boolean;
}

export type Route =
  | { kind: 'local'; release: CandidateRelease; base?: CandidateRelease; downloadBytes: number }
  | { kind: 'remote'; provider: string; model: string }
  | { kind: 'none'; reason: string };

/** Why a step is in the plan, and why it runs on the model it runs on. */
export interface Decision {
  /** How sure System 1 is that this is what was asked. */
  probability: number;
  /** 'instruction': one part of the instruction, quoted in `text`; 'request': the whole request; 'person': picked when System 1 was unsure. */
  by: 'instruction' | 'request' | 'person';
  text?: string;
  /** When several models offer the task: System 1 picked one by its description, or the catalog order did (downloaded, then smallest). */
  model?: { by: 'system1'; probability: number; name: string } | { by: 'catalog' };
  /** The next likeliest tasks from the same reading, tried in turn when a model answers that the request is outside what it does. */
  alternatives?: { id: string; probability: number }[];
  /** The task first chosen, when its model declined and this step moved to an alternative. */
  insteadOf?: string;
}

export interface Step {
  task: Task;
  decision: Decision;
  route: Route;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'declined' | 'unavailable';
  output?: StepOutput;
  error?: string;
  ms?: number;
}

/** One text System 1 read, and what it thinks the person wants done. */
export interface Reading {
  /** A part of the instruction ("Categorize"), or the whole request. */
  text: string;
  /** A task ID. */
  choice: string;
  probability: number;
  /** The final round's options and their probabilities. */
  probabilities: Record<string, number>;
}

/** What System 1 answered, kept for "how this was decided" and for tuning. */
export interface Judgement {
  /** The instruction's parts in order, then the whole request when it was read too. */
  readings: Reading[];
  latencyMs: number;
  device?: string;
}

export type Ending = 'done' | 'step-limit' | 'unsure' | 'canceled';

export interface RunResult {
  request: string;
  /** The instruction at the start of the request, when it has one. */
  instruction: string | null;
  language: string;
  /** Every task System 1 chose among. */
  tasks: Task[];
  judgement: Judgement | null;
  steps: Step[];
  ended: Ending;
}

/** Online help the person turned on: provider, model, and how to ask it. */
export interface RemoteHelp {
  provider: string;
  model: string;
  run(task: Task, request: string, context: string[], signal?: AbortSignal): Promise<string>;
}

export interface Hooks {
  /** Local mini-models from the verified catalog. */
  candidates: CandidateRelease[];
  isCached(sha256: string): boolean;
  /** The base release an adapter runs on, when the catalog has it. Without this, adapters are left out. */
  baseOf?(release: CandidateRelease): CandidateRelease | null;
  /**
   * Run one task of a release on the request (the release's prompt decides what part of it the model
   * sees). `base` is set when `release` is an adapter: its own prompt runs on the base's weights.
   */
  runLocal(release: CandidateRelease, taskId: string, request: string, language: string, signal?: AbortSignal, base?: CandidateRelease): Promise<StepOutput>;
  /** Present only when the person allowed online help. */
  remote?: RemoteHelp | null;
  /** Ask before downloading a model; false skips the step. Without it, models download as needed. */
  confirmDownload?(release: CandidateRelease, bytes: number): Promise<boolean>;
  /** Download and verify a model's files (and its base's, for an adapter); false when that failed. */
  download(release: CandidateRelease, base?: CandidateRelease): Promise<boolean>;
  /** System 1 found nothing clear: offer the likeliest; null stops. */
  clarify(options: { task: Task; probability: number }[]): Promise<string | null>;
  onUpdate?(steps: Step[]): void;
  signal?: AbortSignal;
}

const missingBytes = (r: CandidateRelease, isCached: (s: string) => boolean, base?: CandidateRelease) =>
  [...(base?.manifest.files ?? []), ...r.manifest.files].filter((f) => !isCached(f.sha256)).reduce((n, f) => n + f.size, 0);

/** A model that can do a task here: a release, and its base when it is an adapter. */
export interface LocalChoice {
  release: CandidateRelease;
  base?: CandidateRelease;
}

const newer = (a: CandidateRelease, b: CandidateRelease) => a.version.localeCompare(b.version, undefined, { numeric: true }) > 0;

/**
 * The models in this device's catalog that can do a task in `language`: the
 * newest version of each, adapters only with a base that runs here.
 */
export function localChoices(taskId: string, language: string, hooks: Pick<Hooks, 'candidates' | 'baseOf'>): LocalChoice[] {
  const latest = new Map<string, LocalChoice>();
  for (const c of hooks.candidates) {
    const m = c.manifest;
    if (!c.support.supported || !m.capabilities.includes(taskId) || !c.support.executableOperations.includes(taskId)) continue;
    if (language !== 'und' && !m.languages.includes(language) && !m.languages.includes('und')) continue;
    let base: CandidateRelease | undefined;
    if (m.kind === 'lora') {
      base = hooks.baseOf?.(c) ?? undefined;
      if (!base?.support.supported) continue;
    } else if (m.kind !== 'model') continue;
    const key = `${c.pubkey}:${c.modelId}`;
    const seen = latest.get(key);
    if (!seen || newer(c, seen.release)) latest.set(key, { release: c, ...(base ? { base } : {}) });
  }
  return [...latest.values()].sort((a, b) => (a.release.eventId < b.release.eventId ? -1 : 1));
}

/** Files already here first, then the smallest download, then a stable order. */
function byCatalogOrder(choices: LocalChoice[], isCached: (s: string) => boolean): LocalChoice[] {
  const files = (c: LocalChoice) => [...(c.base?.manifest.files ?? []), ...c.release.manifest.files];
  const total = (c: LocalChoice) => files(c).reduce((n, f) => n + f.size, 0);
  const ready = (c: LocalChoice) => files(c).every((f) => isCached(f.sha256));
  return [...choices].sort((a, b) => Number(ready(b)) - Number(ready(a)) || total(a) - total(b) || (a.release.eventId < b.release.eventId ? -1 : 1));
}

/** The question System 1 answers about a text: which of these tasks? */
export function taskQuestion(tasks: Task[]): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: 'What does the person mainly want done with `request`?',
    criteria: Object.fromEntries(tasks.map((t) => [t.id, t.when])),
  };
}

/** Split a list into the fewest groups of at most `max`, as even as possible, keeping the order. */
function groups<T>(xs: T[], max: number): T[][] {
  const n = Math.ceil(xs.length / max);
  const size = Math.ceil(xs.length / n);
  return Array.from({ length: n }, (_, i) => xs.slice(i * size, (i + 1) * size)).filter((g) => g.length);
}

type Ask = (questions: Record<string, Question>) => Promise<Record<string, ChoiceAnswer>>;

/**
 * Which task does `text` ask for? Catalog tasks compete in groups (neighbours
 * in the same category share a group) until the winners and the general
 * requests fit one question, which decides.
 */
async function chooseTask(ask: Ask, catalog: Task[], general: Task[], max: number): Promise<{ choice: string; probabilities: Record<string, number> }> {
  let pool = catalog;
  while (pool.length + general.length > max && pool.length > 1) {
    const gs = groups(pool, max);
    const answers = await ask(Object.fromEntries(gs.filter((g) => g.length > 1).map((g, i) => [`group${i}`, taskQuestion(g)])));
    let i = 0;
    pool = gs.map((g) => {
      if (g.length === 1) return g[0]!;
      const winner = answers[`group${i++}`]!.choice;
      return g.find((t) => t.id === winner)!;
    });
  }
  const final = (await ask({ main: taskQuestion([...pool, ...general]) })).main!;
  return { choice: final.choice, probabilities: final.probabilities };
}

/** "Tiny summarizer (SmolLM2 360M Q8_0)" → "Tiny summarizer". */
const shortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;

/**
 * Of the models that can do a task here, which one? When their descriptions
 * differ, System 1 picks the one that fits the request; when it has no clear
 * preference, or they say the same, the catalog order decides (downloaded,
 * then smallest).
 */
async function chooseModel(ask: Ask, task: Task, models: LocalChoice[], sureAbove: number, max: number): Promise<{ preferred?: LocalChoice; model: Decision['model'] }> {
  const whenOf = (c: LocalChoice) => c.release.manifest.operations.find((o) => o.id === task.id)?.when ?? '';
  if (models.length < 2 || new Set(models.map(whenOf)).size < 2) return { model: { by: 'catalog' } };
  const keys = new Map<string, LocalChoice>();
  for (const c of models) {
    let k = shortName(c.release.name);
    for (let n = 2; keys.has(k); n++) k = `${shortName(c.release.name)} ${n}`;
    keys.set(k, c);
  }
  let pool = [...keys.keys()];
  let answer: ChoiceAnswer | undefined;
  while (!answer || pool.length > 1) {
    const gs = groups(pool, max);
    const answers = await ask(Object.fromEntries(gs.map((g, i) => [`model${i}`, { type: 'choice', instructions: `Which of these is best for \`request\`? Each one can ${task.when}.`, criteria: Object.fromEntries(g.map((k) => [k, whenOf(keys.get(k)!)])) } as ChoiceQuestion])));
    pool = gs.map((_, i) => answers[`model${i}`]!.choice);
    answer = gs.length === 1 ? answers.model0 : undefined;
  }
  // A clear preference: sure, and at least twice as likely as the runner-up (two options always give one half or more).
  const [p = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
  if (p < sureAbove || p < 2 * second) return { model: { by: 'catalog' } };
  return { preferred: keys.get(answer.choice)!, model: { by: 'system1', probability: p, name: answer.choice } };
}

/** Local first; online only when allowed; otherwise say why not. */
export function routeFor(task: Task, language: string, hooks: Pick<Hooks, 'candidates' | 'isCached' | 'remote' | 'baseOf'>, preferred?: LocalChoice): Route {
  if (task.category) {
    const usable = localChoices(task.id, language, hooks);
    const kept = preferred && usable.find((c) => c.release.eventId === preferred.release.eventId);
    const pick = kept ?? byCatalogOrder(usable, hooks.isCached)[0];
    if (pick) return { kind: 'local', release: pick.release, ...(pick.base ? { base: pick.base } : {}), downloadBytes: missingBytes(pick.release, hooks.isCached, pick.base) };
  }
  if (hooks.remote) return { kind: 'remote', provider: hooks.remote.provider, model: hooks.remote.model };
  return { kind: 'none', reason: task.category ? 'no model on this device can do this in this language' : 'no model on this device can do this yet' };
}

/** What a finished step adds to the context an online model sees. */
export function describe(step: Step): string {
  const what = step.output?.label ? step.output.label : step.output?.text ? step.output.text.slice(0, 300) : step.status;
  return `${step.task.id}: ${what}`;
}

/** Most parts of an instruction read; each is one short System 1 pass. */
const MAX_PARTS = 6;
/**
 * A part of one or two words ("summarize it") is a task only when System 1 is
 * this sure. Splitting on "and" also cuts phrases apart: "the pros and cons"
 * leaves "cons", which some option always half-matches, while real short task
 * parts read 0.93 or more.
 */
const SHORT_PART_SURE = 0.9;

/**
 * The tasks an instruction names: "Categorize, summarize and then reply" has
 * three. A part that is a bare verb borrows what a later part acts on, so
 * "Convert and resize this video" reads as "Convert this video" and "resize
 * this video": alone, "Convert" could be anything.
 */
export function partsOf(instruction: string): string[] {
  const parts = instruction
    .split(/\s*(?:[,;&+]|\b(?:and then|then|and also|also|and)\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, MAX_PARTS);
  const objectOf = (p: string) => p.split(/\s+/).slice(1).join(' ').replace(/^(?:to|for|on|into|about|of)\s+/i, '');
  return parts.map((p, i) => {
    if (/\s/.test(p)) return p;
    const object = parts.slice(i + 1).map(objectOf).find(Boolean);
    return object ? `${p} ${object}` : p;
  });
}

export async function route(request: string, system1: System1, hooks: Hooks, options: RouterOptions = {}): Promise<RunResult> {
  const opts = { ...DEFAULTS, ...options };
  const all = tasksFor(hooks.candidates, opts.general ?? GENERAL_TASKS);
  const catalog = all.filter((t) => t.category);
  const general = all.filter((t) => !t.category);
  const byId = new Map(all.map((t) => [t.id, t]));
  const { instruction, text } = splitInstruction(request);
  const language = detectLanguage(text);
  const readings: Reading[] = [];
  let latencyMs = 0;
  let device: string | undefined;
  const judgement = (): Judgement | null => (readings.length ? { readings: [...readings], latencyMs, ...(device ? { device } : {}) } : null);
  const finish = (steps: Step[], ended: Ending): RunResult => ({ request, instruction, language, tasks: all, judgement: judgement(), steps, ended });

  const askAbout =
    (state: string): Ask =>
    async (questions) => {
      const result = await system1.predict({ request: state }, questions);
      latencyMs += result.latency_ms;
      device ??= result.device;
      return result.answers as Record<string, ChoiceAnswer>;
    };
  const read = async (part: string): Promise<Reading> => {
    const r = await chooseTask(askAbout(part), catalog, general, opts.maxOptions);
    const reading = { text: part, choice: r.choice, probability: r.probabilities[r.choice] ?? 0, probabilities: r.probabilities };
    readings.push(reading);
    return reading;
  };

  const alternatives = (r: Reading) =>
    Object.entries(r.probabilities)
      .filter(([id, p]) => id !== r.choice && p >= ALTERNATIVE_ABOVE && byId.get(id)?.category)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([id, probability]) => ({ id, probability }));

  // Each task the instruction names, read on its own, in the order asked: the
  // message after it can mention other tasks without changing what was asked.
  const planned = new Map<string, Decision>();
  for (const part of instruction ? partsOf(instruction) : []) {
    if (hooks.signal?.aborted) return finish([], 'canceled');
    const r = await read(part);
    const sure = part.split(/\s+/).length <= 2 ? Math.max(opts.sureAbove, SHORT_PART_SURE) : opts.sureAbove;
    if (r.probability >= sure && !planned.has(r.choice)) planned.set(r.choice, { probability: r.probability, by: 'instruction', text: part, alternatives: alternatives(r) });
  }
  // No instruction, or none of its parts was clear: the whole request.
  if (!planned.size) {
    if (hooks.signal?.aborted) return finish([], 'canceled');
    const r = await read(request);
    if (r.probability >= opts.sureAbove) planned.set(r.choice, { probability: r.probability, by: 'request', alternatives: alternatives(r) });
  }
  if (hooks.signal?.aborted) return finish([], 'canceled');
  if (!planned.size) {
    const whole = readings.at(-1)!.probabilities;
    const offered = Object.entries(whole)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, probability]) => ({ task: byId.get(id)!, probability }));
    const picked = await hooks.clarify(offered);
    if (!picked) return finish([], 'unsure');
    planned.set(picked, { probability: whole[picked] ?? 0, by: 'person' });
  }

  // The first steps asked for, when there are more than one request may take; for each, the model that fits best.
  const preferred = new Map<string, LocalChoice>();
  const steps: Step[] = [];
  for (const [id, decision] of [...planned].slice(0, opts.maxSteps)) {
    if (hooks.signal?.aborted) return finish(steps, 'canceled');
    const task = byId.get(id)!;
    if (task.category) {
      const m = await chooseModel(askAbout(request), task, localChoices(task.id, language, hooks), opts.sureAbove, opts.maxOptions);
      if (m.preferred) preferred.set(id, m.preferred);
      decision.model = m.model;
    }
    steps.push({ task, decision, route: routeFor(task, language, hooks, preferred.get(id)), status: 'waiting' });
  }
  const update = () => hooks.onUpdate?.(steps.map((s) => ({ ...s })));
  update();

  const attempt = async (step: Step) => {
    step.status = 'running';
    delete step.error;
    update();
    try {
      step.output = await execute(step, request, steps.filter((s) => s.status === 'done').map(describe), hooks, language);
      step.status = step.output ? 'done' : step.status;
    } catch (e) {
      if (hooks.signal?.aborted) throw e;
      step.status = 'failed';
      step.error = (e as Error).message;
    }
    update();
  };
  const declined = (step: Step) => step.status === 'unavailable' && step.route.kind === 'local';

  for (const step of steps) {
    if (hooks.signal?.aborted) return finish(steps, 'canceled');
    const t0 = Date.now();
    const first = { task: step.task, decision: step.decision };
    try {
      // Chosen again now: a model an earlier step downloaded may do this one too.
      step.route = routeFor(step.task, language, hooks, preferred.get(step.task.id));
      await attempt(step);
      // The model answered that this is outside what it does: the next likeliest task a model here offers, then online help.
      for (const alt of declined(step) ? (first.decision.alternatives ?? []) : []) {
        const task = byId.get(alt.id)!;
        const route = routeFor(task, language, { ...hooks, remote: null });
        if (route.kind !== 'local' || steps.some((s) => s !== step && s.task.id === task.id)) continue;
        Object.assign(step, { task, route, decision: { ...first.decision, probability: alt.probability, insteadOf: first.task.id } });
        await attempt(step);
        if (!declined(step)) break;
      }
      if (declined(step) && hooks.remote) {
        Object.assign(step, { ...first, route: { kind: 'remote', provider: hooks.remote.provider, model: hooks.remote.model } });
        await attempt(step);
      }
    } catch {
      return finish(steps, 'canceled');
    }
    step.ms = Date.now() - t0;
    update();
  }
  return finish(steps, planned.size > opts.maxSteps ? 'step-limit' : 'done');
}

/** Run one step where it was routed. A local model that answers "not something I do" hands over to online help when allowed. */
async function execute(step: Step, request: string, context: string[], hooks: Hooks, language: string): Promise<StepOutput | undefined> {
  const r = step.route;
  if (r.kind === 'none') {
    step.status = 'unavailable';
    step.error = r.reason;
    return undefined;
  }
  if (r.kind === 'remote') return { text: (await hooks.remote!.run(step.task, request, context, hooks.signal)).trim() };
  if (r.downloadBytes > 0) {
    if (hooks.confirmDownload && !(await hooks.confirmDownload(r.release, r.downloadBytes))) {
      step.status = 'declined';
      return undefined;
    }
    if (!(await hooks.download(r.release, r.base))) throw new Error('the model could not be downloaded');
  }
  const out = await hooks.runLocal(r.release, step.task.id, request, language, hooks.signal, r.base);
  if (!out.declined) return out;
  step.status = 'unavailable';
  step.error = `${shortName(r.release.name)} answered that this request is outside what it does`;
  return undefined;
}
