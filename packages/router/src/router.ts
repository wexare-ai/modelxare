// The routing loop. System 1 reads the request (and what is already done) and
// picks the next step; each step goes to a local mini-model when one can do
// it, to an online model only when the person allowed that, and otherwise is
// reported as unavailable. Results join the state for the next decision,
// until System 1 says the request is handled or the step limit is reached.
import { detectLanguage, selectRelease, type CandidateRelease } from '@wexare/orchestrator';
import { DONE, DONE_CRITERION, INTENTS, type Intent } from './intents.ts';
import type { ChoiceAnswer, System1 } from './system-one.ts';

export interface RouterOptions {
  /** Most steps one request may take. */
  maxSteps?: number;
  /** Below this probability, the first step is confirmed with the person instead of guessed. */
  confirmBelow?: number;
  /** Below this probability, a later step is not started: the request ends instead. */
  continueAbove?: number;
  intents?: Intent[];
}

const DEFAULTS = { maxSteps: 3, confirmBelow: 0.5, continueAbove: 0.5 };

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

export interface Decision {
  choice: string;
  probability: number;
  confidence: number;
  probabilities: Record<string, number>;
  latencyMs: number;
  device?: string;
  /** Laya's act head, recorded for later use; routing does not depend on it. */
  actProbability: number | null;
  /** 'person' when System 1 was unsure and the person picked the step. */
  chosenBy: 'system1' | 'person';
}

export interface Step {
  intent: Intent;
  decision: Decision;
  route: Route;
  status: 'running' | 'done' | 'failed' | 'declined' | 'unavailable';
  output?: StepOutput;
  error?: string;
  ms?: number;
}

export type Ending = 'done' | 'step-limit' | 'unsure' | 'canceled';

export interface RunResult {
  request: string;
  language: string;
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
  /** Ask before downloading a model; false skips the step. */
  confirmDownload(release: CandidateRelease, bytes: number): Promise<boolean>;
  /** Download and verify a model's files; false when that failed. */
  download(release: CandidateRelease): Promise<boolean>;
  /** System 1 was unsure about the first step: offer the likeliest; null stops. */
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

/** What a finished step contributes to the next decision and to online context. */
export function describe(step: Step): string {
  const what = step.output?.topic ? `topic: ${step.output.topic}` : step.output?.text ? step.output.text.slice(0, 300) : step.status;
  return `${step.intent.id}: ${what}`;
}

export async function route(request: string, system1: System1, hooks: Hooks, options: RouterOptions = {}): Promise<RunResult> {
  const opts = { ...DEFAULTS, ...options };
  const intents = opts.intents ?? INTENTS;
  const language = detectLanguage(request);
  const steps: Step[] = [];
  const update = () => hooks.onUpdate?.(steps.map((s) => ({ ...s })));
  const finish = (ended: Ending): RunResult => ({ request, language, steps, ended });

  for (let i = 0; i < opts.maxSteps; i++) {
    if (hooks.signal?.aborted) return finish('canceled');
    const remaining = intents.filter((x) => !steps.some((s) => s.intent.id === x.id));
    if (!remaining.length) return finish('done');

    const first = steps.length === 0;
    const criteria: Record<string, string> = Object.fromEntries(remaining.map((x) => [x.id, x.criterion]));
    if (!first) criteria[DONE] = DONE_CRITERION;
    const state = first ? { request } : { request, completed: steps.map(describe) };
    const instructions = first
      ? 'What does the person want done with `request`?'
      : 'What should happen next for `request`? `completed` lists the steps already done. Choose done when nothing else was asked for.';
    const result = await system1.predict(state, { next_step: { type: 'choice', instructions, criteria } });
    const answer = result.answers.next_step as ChoiceAnswer;
    let choice = answer.choice;
    const probability = answer.probabilities[choice] ?? 0;
    const decision: Decision = {
      choice,
      probability,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      latencyMs: result.latency_ms,
      ...(result.device ? { device: result.device } : {}),
      actProbability: answer.action?.act_probability ?? null,
      chosenBy: 'system1',
    };

    if (choice === DONE) return finish('done');
    if (first && probability < opts.confirmBelow) {
      const options = remaining
        .map((intent) => ({ intent, probability: answer.probabilities[intent.id] ?? 0 }))
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 3);
      const picked = await hooks.clarify(options);
      if (!picked) return finish('unsure');
      choice = picked;
      decision.chosenBy = 'person';
    } else if (!first && probability < opts.continueAbove) {
      return finish('done');
    }

    const intent = remaining.find((x) => x.id === choice);
    if (!intent) return finish('done');
    const step: Step = { intent, decision, route: routeFor(intent, language, hooks), status: 'running' };
    steps.push(step);
    update();
    const t0 = Date.now();
    try {
      step.output = await execute(step, request, language, steps.slice(0, -1).map(describe), hooks);
      step.status = step.output ? 'done' : step.status;
    } catch (e) {
      if (hooks.signal?.aborted) return finish('canceled');
      step.status = 'failed';
      step.error = (e as Error).message;
    }
    step.ms = Date.now() - t0;
    update();
  }
  return finish('step-limit');
}

async function execute(step: Step, request: string, language: string, context: string[], hooks: Hooks): Promise<StepOutput | undefined> {
  const r = step.route;
  if (r.kind === 'none') {
    step.status = 'unavailable';
    return undefined;
  }
  if (r.kind === 'remote') return { text: (await hooks.remote!.run(step.intent, request, context, hooks.signal)).trim() };
  if (r.downloadBytes > 0) {
    if (!(await hooks.confirmDownload(r.release, r.downloadBytes))) {
      step.status = 'declined';
      return undefined;
    }
    if (!(await hooks.download(r.release))) throw new Error('the model could not be downloaded');
  }
  return hooks.runLocal(r.release, step.intent.capability!, request, language, hooks.signal);
}
