// The routing plan. In one forward pass, System 1 judges every kind of step
// on its own (does the request ask for this?) and picks the main one. Every
// step the request asks for runs, so "sort and summarize" gets both. Each step
// goes to a local mini-model when one can do it, to an online model only when
// the person allowed that, and otherwise is reported as unavailable. When
// nothing is clear, the person picks.
import { detectLanguage, selectRelease, type CandidateRelease } from '@wexare/orchestrator';
import { INTENTS, type Intent } from './intents.ts';
import type { ChoiceAnswer, NoulAnswer, Question, System1 } from './system-one.ts';

export interface RouterOptions {
  /** Most steps one request may take. */
  maxSteps?: number;
  /** A step runs when the request asks for it with at least this probability. */
  askedAbove?: number;
  /** The main-task choice counts at or above this probability; when nothing counts, the person picks. */
  confirmBelow?: number;
  intents?: Intent[];
}

const DEFAULTS = { maxSteps: 3, askedAbove: 0.5, confirmBelow: 0.5 };

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
  /** How likely System 1 thinks the request asks for this step. */
  probability: number;
  /** 'asked': its yes/no question; 'main': the main-task choice; 'person': picked when System 1 was unsure. */
  by: 'asked' | 'main' | 'person';
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

/** What System 1 answered, kept for "how this was decided" and for tuning. */
export interface Judgement {
  /** P(the request asks for it), per intent. */
  asked: Record<string, number>;
  /** The main task, as one choice among the intents. */
  main: { choice: string; probability: number; probabilities: Record<string, number>; confidence: number };
  latencyMs: number;
  device?: string;
}

export type Ending = 'done' | 'step-limit' | 'unsure' | 'canceled';

export interface RunResult {
  request: string;
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

const MAIN = 'main';
const askKey = (intent: Intent) => `asks_${intent.id}`;

/** The questions for one forward pass: a yes/no per intent, and the main task. */
export function questionsFor(intents: Intent[]): Record<string, Question> {
  const asks = intents.map((x): [string, Question] => [askKey(x), { type: 'noul', instructions: x.asks, criteria: { true: 'yes, it asks for this', false: 'no' } }]);
  return {
    [MAIN]: {
      type: 'choice',
      instructions: 'What does the person mainly want done with `request`?',
      criteria: Object.fromEntries(intents.map((x) => [x.id, x.criterion])),
    },
    ...Object.fromEntries(asks),
  };
}

export async function route(request: string, system1: System1, hooks: Hooks, options: RouterOptions = {}): Promise<RunResult> {
  const opts = { ...DEFAULTS, ...options };
  const intents = opts.intents ?? INTENTS;
  const language = detectLanguage(request);
  const finish = (judgement: Judgement | null, steps: Step[], ended: Ending): RunResult => ({ request, language, judgement, steps, ended });
  if (hooks.signal?.aborted) return finish(null, [], 'canceled');

  const result = await system1.predict({ request }, questionsFor(intents));
  const main = result.answers[MAIN] as ChoiceAnswer;
  const judgement: Judgement = {
    asked: Object.fromEntries(intents.map((x) => [x.id, (result.answers[askKey(x)] as NoulAnswer | undefined)?.noul ?? 0])),
    main: { choice: main.choice, probability: main.probabilities[main.choice] ?? 0, probabilities: main.probabilities, confidence: main.confidence },
    latencyMs: result.latency_ms,
    ...(result.device ? { device: result.device } : {}),
  };
  if (hooks.signal?.aborted) return finish(judgement, [], 'canceled');

  // Every step asked for, plus the main task when System 1 is sure of it.
  const planned = new Map<string, Decision>();
  for (const x of intents) if (judgement.asked[x.id]! >= opts.askedAbove) planned.set(x.id, { probability: judgement.asked[x.id]!, by: 'asked' });
  if (judgement.main.probability >= opts.confirmBelow && !planned.has(main.choice)) planned.set(main.choice, { probability: judgement.main.probability, by: 'main' });
  if (!planned.size) {
    const offered = intents
      .map((intent) => ({ intent, probability: main.probabilities[intent.id] ?? 0 }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 3);
    const picked = await hooks.clarify(offered);
    if (!picked) return finish(judgement, [], 'unsure');
    planned.set(picked, { probability: main.probabilities[picked] ?? 0, by: 'person' });
  }

  // The likeliest steps when more were asked for than one request may take, in the usual order.
  const chosen = new Map([...planned].sort((a, b) => b[1].probability - a[1].probability).slice(0, opts.maxSteps));
  const steps: Step[] = intents
    .filter((x) => chosen.has(x.id))
    .map((intent) => ({ intent, decision: chosen.get(intent.id)!, route: routeFor(intent, language, hooks), status: 'waiting' }));
  const update = () => hooks.onUpdate?.(steps.map((s) => ({ ...s })));
  update();

  for (const step of steps) {
    if (hooks.signal?.aborted) return finish(judgement, steps, 'canceled');
    // Chosen again now: a model an earlier step downloaded may do this one too.
    step.route = routeFor(step.intent, language, hooks);
    step.status = 'running';
    update();
    const t0 = Date.now();
    try {
      step.output = await execute(step, request, steps.filter((s) => s.status === 'done').map(describe), hooks, language);
      step.status = step.output ? 'done' : step.status;
    } catch (e) {
      if (hooks.signal?.aborted) return finish(judgement, steps, 'canceled');
      step.status = 'failed';
      step.error = (e as Error).message;
    }
    step.ms = Date.now() - t0;
    update();
  }
  return finish(judgement, steps, planned.size > opts.maxSteps ? 'step-limit' : 'done');
}

async function execute(step: Step, request: string, context: string[], hooks: Hooks, language: string): Promise<StepOutput | undefined> {
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
  return hooks.runLocal(r.release, step.intent.capability!, request, language, hooks.signal);
}
