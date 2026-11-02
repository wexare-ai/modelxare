// The routing plan. A request usually starts with an instruction
// ("Categorize and summarize this message: …"). System 1 reads each task the
// instruction names on its own, so "sort and summarize" gets both steps and
// the message itself can't sway the choice. A request without an instruction
// is read whole. Each step goes to a local mini-model when one can do it, to an
// online model only when the person allowed that, and otherwise is reported as
// unavailable. When nothing is clear, the person picks.
import { detectLanguage, selectRelease, type CandidateRelease } from '@wexare/orchestrator';
import { INTENTS, type Intent } from './intents.ts';
import type { ChoiceAnswer, Question, System1 } from './system-one.ts';

export interface RouterOptions {
  /** Most steps one request may take. */
  maxSteps?: number;
  /** System 1 is sure of a step at or above this probability; when it is sure of none, the person picks. */
  sureAbove?: number;
  intents?: Intent[];
}

const DEFAULTS = { maxSteps: 3, sureAbove: 0.5 };

export interface StepOutput {
  /** Summary, continued text, translation, answer. */
  text?: string;
  /** Topic, for sorting. */
  topic?: string;
}

export type Route =
  | { kind: 'local'; release: CandidateRelease; downloadBytes: number }
  | { kind: 'remote'; provider: string; model: string }
  | { kind: 'none'; reason: string };

/** Why a step is in the plan. */
export interface Decision {
  /** How sure System 1 is that this is what was asked. */
  probability: number;
  /** 'instruction': one part of the instruction, quoted in `text`; 'request': the whole request; 'person': picked when System 1 was unsure. */
  by: 'instruction' | 'request' | 'person';
  text?: string;
}

export interface Step {
  intent: Intent;
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
  choice: string;
  probability: number;
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
  /** What local models work on: the request without its instruction. */
  message: string;
  language: string;
  judgement: Judgement | null;
  steps: Step[];
  ended: Ending;
}

/** Online help the person turned on: provider, model, and how to ask it. */
export interface RemoteHelp {
  provider: string;
  model: string;
  run(intent: Intent, request: string, context: string[], signal?: AbortSignal): Promise<string>;
}

export interface Hooks {
  /** Local mini-models from the verified catalog. */
  candidates: CandidateRelease[];
  isCached(sha256: string): boolean;
  runLocal(release: CandidateRelease, capability: string, input: string, language: string, signal?: AbortSignal): Promise<StepOutput>;
  /** Present only when the person allowed online help. */
  remote?: RemoteHelp | null;
  /** Ask before downloading a model; false skips the step. Without it, models download as needed. */
  confirmDownload?(release: CandidateRelease, bytes: number): Promise<boolean>;
  /** Download and verify a model's files; false when that failed. */
  download(release: CandidateRelease): Promise<boolean>;
  /** System 1 found nothing clear: offer the likeliest; null stops. */
  clarify(options: { intent: Intent; probability: number }[]): Promise<string | null>;
  onUpdate?(steps: Step[]): void;
  signal?: AbortSignal;
}

const missingBytes = (r: CandidateRelease, isCached: (s: string) => boolean) => r.manifest.files.filter((f) => !isCached(f.sha256)).reduce((n, f) => n + f.size, 0);

/** Local first; online only when allowed; otherwise say why not. */
export function routeFor(intent: Intent, language: string, hooks: Pick<Hooks, 'candidates' | 'isCached' | 'remote'>): Route {
  if (intent.capability) {
    const sel = selectRelease(intent.capability, hooks.candidates, language, {}, hooks.isCached);
    if (sel.release) return { kind: 'local', release: sel.release, downloadBytes: missingBytes(sel.release, hooks.isCached) };
  }
  if (hooks.remote) return { kind: 'remote', provider: hooks.remote.provider, model: hooks.remote.model };
  return { kind: 'none', reason: intent.capability ? `no model on this device can do this in this language` : 'no model on this device can do this yet' };
}

/** What a finished step adds to the context an online model sees. */
export function describe(step: Step): string {
  const what = step.output?.topic ? `topic: ${step.output.topic}` : step.output?.text ? step.output.text.slice(0, 300) : step.status;
  return `${step.intent.id}: ${what}`;
}

/** Longest instruction looked for at the start of a request. */
const INSTRUCTION_MAX = 120;
/** Most parts of an instruction read; each is one short System 1 pass. */
const MAX_PARTS = 6;

/**
 * Splits "Categorize and summarize this message: There is a leak." into its
 * instruction and its message. The instruction ends at a colon near the start
 * ("Translate into French: …"), or with a first sentence that is a question
 * followed by more text ("Can you sort this? There is a leak."). Without
 * either, there is no instruction and the message is the whole request.
 */
export function splitRequest(request: string): { instruction: string | null; message: string } {
  const text = request.trim();
  const colon = text.search(/:(\s|$)/);
  if (colon > 0 && colon <= INSTRUCTION_MAX) return { instruction: text.slice(0, colon).trim(), message: text.slice(colon + 1).trim() || text };
  const question = text.indexOf('?') + 1;
  if (question > 1 && question <= INSTRUCTION_MAX && text.slice(question).trim()) return { instruction: text.slice(0, question).trim(), message: text.slice(question).trim() };
  return { instruction: null, message: text };
}

/** The tasks an instruction names: "Categorize, summarize and then reply" has three. */
export function partsOf(instruction: string): string[] {
  return instruction
    .split(/\s*(?:[,;&+]|\b(?:and then|then|and also|also|and)\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, MAX_PARTS);
}

/** The one question System 1 answers about each text. */
export function mainQuestion(intents: Intent[]): Question {
  return {
    type: 'choice',
    instructions: 'What does the person mainly want done with `request`?',
    criteria: Object.fromEntries(intents.map((x) => [x.id, x.criterion])),
  };
}

export async function route(request: string, system1: System1, hooks: Hooks, options: RouterOptions = {}): Promise<RunResult> {
  const opts = { ...DEFAULTS, ...options };
  const intents = opts.intents ?? INTENTS;
  const { instruction, message } = splitRequest(request);
  const language = detectLanguage(message);
  const readings: Reading[] = [];
  let latencyMs = 0;
  let device: string | undefined;
  const judgement = (): Judgement | null => (readings.length ? { readings: [...readings], latencyMs, ...(device ? { device } : {}) } : null);
  const finish = (steps: Step[], ended: Ending): RunResult => ({ request, instruction, message, language, judgement: judgement(), steps, ended });

  const questions = { main: mainQuestion(intents) };
  const read = async (text: string): Promise<Reading> => {
    const result = await system1.predict({ request: text }, questions);
    const a = result.answers.main as ChoiceAnswer;
    latencyMs += result.latency_ms;
    device ??= result.device;
    const reading = { text, choice: a.choice, probability: a.probabilities[a.choice] ?? 0, probabilities: a.probabilities };
    readings.push(reading);
    return reading;
  };

  // Each task the instruction names, read on its own, in the order asked.
  const planned = new Map<string, Decision>();
  for (const part of instruction ? partsOf(instruction) : []) {
    if (hooks.signal?.aborted) return finish([], 'canceled');
    const r = await read(part);
    if (r.probability >= opts.sureAbove && !planned.has(r.choice)) planned.set(r.choice, { probability: r.probability, by: 'instruction', text: part });
  }
  // No instruction, or none of its parts was clear: the whole request.
  if (!planned.size) {
    if (hooks.signal?.aborted) return finish([], 'canceled');
    const r = await read(request);
    if (r.probability >= opts.sureAbove) planned.set(r.choice, { probability: r.probability, by: 'request' });
  }
  if (hooks.signal?.aborted) return finish([], 'canceled');
  if (!planned.size) {
    const whole = readings.at(-1)!.probabilities;
    const offered = intents
      .map((intent) => ({ intent, probability: whole[intent.id] ?? 0 }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 3);
    const picked = await hooks.clarify(offered);
    if (!picked) return finish([], 'unsure');
    planned.set(picked, { probability: whole[picked] ?? 0, by: 'person' });
  }

  // The first steps asked for, when there are more than one request may take.
  const steps: Step[] = [...planned]
    .slice(0, opts.maxSteps)
    .map(([id, decision]) => {
      const intent = intents.find((x) => x.id === id)!;
      return { intent, decision, route: routeFor(intent, language, hooks), status: 'waiting' };
    });
  const update = () => hooks.onUpdate?.(steps.map((s) => ({ ...s })));
  update();

  for (const step of steps) {
    if (hooks.signal?.aborted) return finish(steps, 'canceled');
    // Chosen again now: a model an earlier step downloaded may do this one too.
    step.route = routeFor(step.intent, language, hooks);
    step.status = 'running';
    update();
    const t0 = Date.now();
    try {
      step.output = await execute(step, request, message, steps.filter((s) => s.status === 'done').map(describe), hooks, language);
      step.status = step.output ? 'done' : step.status;
    } catch (e) {
      if (hooks.signal?.aborted) return finish(steps, 'canceled');
      step.status = 'failed';
      step.error = (e as Error).message;
    }
    step.ms = Date.now() - t0;
    update();
  }
  return finish(steps, planned.size > opts.maxSteps ? 'step-limit' : 'done');
}

/** Online models get the whole request (it may say which language, say); local ones get the message. */
async function execute(step: Step, request: string, message: string, context: string[], hooks: Hooks, language: string): Promise<StepOutput | undefined> {
  const r = step.route;
  if (r.kind === 'none') {
    step.status = 'unavailable';
    return undefined;
  }
  if (r.kind === 'remote') return { text: (await hooks.remote!.run(step.intent, request, context, hooks.signal)).trim() };
  if (r.downloadBytes > 0) {
    if (hooks.confirmDownload && !(await hooks.confirmDownload(r.release, r.downloadBytes))) {
      step.status = 'declined';
      return undefined;
    }
    if (!(await hooks.download(r.release))) throw new Error('the model could not be downloaded');
  }
  return hooks.runLocal(r.release, step.intent.capability!, message, language, hooks.signal);
}
