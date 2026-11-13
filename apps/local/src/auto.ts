// The `auto` model: System 1 + System 2 behind one model id. The Laya router
// (System 1) reads the request and picks, among the tasks the catalog's models
// offer, what it asks for, and a specialist language model for each (System
// 2); each runs that release's operation, exactly as in the browser app. When a task has no specialist on
// this machine, or System 1 isn't sure, a general chat model answers the whole
// conversation instead, tools included. The response says which path it took.
import { runSingle, type CandidateRelease } from '@wexare/orchestrator';
import { route, type Hooks, type RunResult, type Step, type StepOutput } from '@wexare/router';
import type { Engine } from './engine.ts';
import type { ChatRun, Output } from './llama.ts';

/** A label as a person reads it: "travel" → "Travel". */
const labelText = (l: string) => (l ? l[0]!.toUpperCase() + l.slice(1) : l);

export interface RouteReport {
  /** 'specialists': System 1 planned steps and catalog models did each; 'general': one chat model answered. */
  answered_by: 'specialists' | 'general';
  /** Why the general model answered, when it did. */
  reason?: string;
  system1: { router: string; readings: { text: string; choice: string; probability: number }[]; latency_ms: number } | null;
  steps: { task: string; model: string | null; probability: number; decided_by: string; status: string; output?: string; ms?: number; error?: string }[];
  general_model?: string;
}

export interface AutoOutput extends Output {
  route: RouteReport;
}

/** GBNF that only admits one of the labels (the browser runtime's choiceGrammar). */
const choiceGrammar = (labels: readonly string[]) => `root ::= ${labels.map((l) => JSON.stringify(l)).join(' | ')}`;

const stepText = (o: StepOutput | undefined) => (o?.label ? labelText(o.label) : (o?.text ?? '').trim());

/** One step's answer, or several, each under its task's title. */
export function compose(steps: Step[]): string {
  const done = steps.filter((s) => s.status === 'done');
  if (done.length === 1) return stepText(done[0]!.output);
  return done.map((s) => `${s.task.title}: ${stepText(s.output)}`).join('\n');
}

export async function runAuto(engine: Engine, run: ChatRun): Promise<AutoOutput> {
  const t0 = Date.now();
  const general = async (reason: string, result: RunResult | null, router: string | null): Promise<AutoOutput> => {
    const m = engine.generalModel();
    if (!m) throw new Error(`${reason}, and no general chat model is downloaded to answer instead`);
    const out = await engine.chat(m, run);
    return { ...out, ms: Date.now() - t0, route: { ...report(result, router, engine), answered_by: 'general', reason, general_model: m.id } };
  };

  const last = run.messages.at(-1);
  if (last?.role !== 'user') return general('the conversation continues after tool results, which System 1 does not read', null, null);
  if (!last.content.trim()) return general('the last message is empty', null, null);
  const release = engine.catalog.router;
  if (!release) return general('no System 1 router is available', null, null);
  if (!engine.options.pullOnDemand && !engine.isReady(release.manifest.files)) return general('the System 1 router is not downloaded (`modelxare pull router`)', null, null);

  let completionTokens = 0;
  const byRelease = new Map(engine.catalog.models.map((m) => [m.release.eventId, m]));
  const sizes = new Map(engine.catalog.models.flatMap((m) => m.files.map((f) => [f.sha256, f.size] as const)));
  const hooks: Hooks = {
    candidates: engine.specialists(),
    baseOf: (r) => engine.baseOf(r),
    isCached: (sha) => engine.files.has(sha, sizes.get(sha) ?? -1),
    remote: null,
    download: async (r: CandidateRelease) => {
      // A catalog model's files include its base's, for an adapter.
      await engine.pull(byRelease.get(r.eventId)?.files ?? r.manifest.files, undefined, run.signal);
      return true;
    },
    clarify: async () => null,
    runLocal: (r, capability, input, language, signal, base) =>
      engine.exclusive(async () => {
        const m = byRelease.get(r.eventId);
        if (m) await engine.pull(m.files, undefined, signal);
        const trace = await runSingle(r, capability, input, {
          runtime: engine.llama,
          getVerifiedFile: (sha, size) => engine.files.verifiedBlob(sha, size),
          choiceGrammar,
        }, { ...(signal ? { signal } : {}), language, ...(base ? { base, adapters: [{ candidate: r, scale: 1 }] } : {}) });
        completionTokens += trace.attempts.reduce((n, a) => n + (a.tokens ?? 0), 0);
        if (trace.state === 'canceled') throw new Error('canceled');
        if (trace.state === 'declined') return { declined: true };
        if (trace.state !== 'completed' || !trace.output) throw new Error(trace.error ?? 'the model did not answer');
        return 'label' in trace.output ? { label: trace.output.label } : { text: trace.output.text.trim() };
      }),
    ...(run.signal ? { signal: run.signal } : {}),
  };

  const result = await engine.decide((laya) => route(last.content, laya, hooks, { maxSteps: 3 }), run.signal);
  if (run.signal?.aborted) throw Object.assign(new Error('canceled'), { code: 'canceled' });
  if (result.ended === 'unsure') return general('System 1 was not sure what the request asks for', result, release.name);
  const missing = result.steps.filter((s) => s.status !== 'done');
  if (!result.steps.length || missing.length) {
    const why = missing.map((s) => `${s.task.id}: ${s.status === 'unavailable' ? (s.error ?? 'no specialist model here') : (s.error ?? s.status)}`).join('; ');
    return general(`not every task had a specialist (${why})`, result, release.name);
  }
  const text = compose(result.steps);
  run.onText?.(text);
  return { text, toolCalls: [], finishReason: 'stop', promptTokens: 0, completionTokens, ms: Date.now() - t0, route: report(result, release.name, engine) };
}

function report(result: RunResult | null, router: string | null, engine: Engine): RouteReport {
  const idOf = (s: Step) => (s.route.kind === 'local' ? (engine.catalog.models.find((m) => m.release.eventId === (s.route as { release: CandidateRelease }).release.eventId)?.id ?? null) : null);
  return {
    answered_by: 'specialists',
    system1:
      result?.judgement && router
        ? { router, readings: result.judgement.readings.map((r) => ({ text: r.text, choice: r.choice, probability: r.probability })), latency_ms: Math.round(result.judgement.latencyMs) }
        : null,
    steps: (result?.steps ?? []).map((s) => ({
      task: s.task.id,
      model: idOf(s),
      probability: s.decision.probability,
      decided_by: s.decision.by,
      status: s.status,
      ...(s.output ? { output: stepText(s.output) } : {}),
      ...(s.ms !== undefined ? { ms: s.ms } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

