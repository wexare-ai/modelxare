// Sequential local execution of a WorkflowPlan. One resident model at a time;
// files are re-verified before each load; every answer is checked against the
// operation's output shape and never invented.
import {
  knownOutput,
  labelChoices,
  parseOperationOutput,
  promptVars,
  renderPromptTemplate,
  retryHint,
  type OperationOutput,
  type ReleaseManifest,
} from '@wexare/protocol';
import type { GenerateRequest, GenerateResult, LoadInfo, LoadRequest } from '@wexare/runtime';
import { LANGUAGE_NAMES, type CandidateRelease, type StageId, type WorkflowPlan } from './plan.ts';

/** `declined`: the model answered that the request is outside what it does. */
export type StageState = 'pending' | 'verifying' | 'loading' | 'generating' | 'completed' | 'declined' | 'canceled' | 'failed';

export interface RuntimeLike {
  readonly loaded: LoadInfo | null;
  load(req: LoadRequest): Promise<LoadInfo>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  unload(): Promise<void>;
}

export interface ExecutionDeps {
  runtime: RuntimeLike;
  /** Returns bytes only after re-hashing them against the expected SHA-256 and size. */
  getVerifiedFile(sha256: string, size: number): Promise<Blob>;
  /** GBNF grammar for a fixed label set (built by the client from the operation's labels). */
  choiceGrammar(labels: readonly string[]): string;
  onUpdate?: (trace: StageTrace[]) => void;
  onToken?: (stage: StageId, text: string) => void;
}

export interface Attempt {
  raw: string;
  parsed?: OperationOutput;
  error?: string;
  ms: number;
  tokens: number | null;
}

export interface StageTrace {
  stage: StageId | string;
  /** The operation's title, e.g. "Summarize". */
  title: string;
  releaseId: string;
  modelId: string;
  name: string;
  publisher: string;
  manifestSha256: string;
  files: { path: string; sha256: string; size: number }[];
  adapters: { sha256: string; scale: number }[];
  state: StageState;
  attempts: Attempt[];
  output?: OperationOutput;
  loadMs?: number;
  reusedLoadedModel?: boolean;
  verifyMs?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowResult {
  status: 'completed' | 'partial' | 'failed' | 'canceled';
  language: string;
  category?: string;
  summary?: string;
  /** Each completed stage's answer, by stage. */
  outputs: Record<string, OperationOutput>;
  /** Composed by a local typed template; no third model. */
  composed?: { category: string | null; summary: string | null; text: string };
  trace: StageTrace[];
  startedAt: number;
  finishedAt: number;
}

const MAX_TOKENS_CAP = 256;

/** What an answer reads as: the label, or the text. */
export const outputText = (o: OperationOutput | undefined): string => (!o ? '' : 'label' in o ? o.label : o.text);

function stageInputs(m: ReleaseManifest, stage: string, request: string, language: string) {
  const op = m.operations.find((o) => o.id === stage);
  if (!op) throw new Error(`release has no ${stage} operation`);
  if (!knownOutput(op)) throw new Error(`the ${stage} operation answers in a shape this client doesn't know`);
  const vars = promptVars(op, request, LANGUAGE_NAMES[language] ?? language);
  return {
    op,
    system: op.prompt.system ? renderPromptTemplate(op.prompt.system, vars) : undefined,
    prompt: renderPromptTemplate(op.prompt.template, vars),
  };
}

function newTrace(stage: string, c: CandidateRelease, adapters: StageTrace['adapters'] = []): StageTrace {
  return {
    stage,
    title: c.manifest.operations.find((o) => o.id === stage)?.title ?? stage,
    releaseId: c.eventId,
    modelId: c.manifest.model_id,
    name: c.name,
    publisher: c.pubkey,
    manifestSha256: c.manifestSha256,
    files: c.manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    adapters,
    state: 'pending',
    attempts: [],
  };
}

async function runStage(
  t: StageTrace,
  c: CandidateRelease,
  input: string,
  language: string,
  deps: ExecutionDeps,
  signal: AbortSignal | undefined,
  emit: () => void,
  extra: { adapters?: { candidate: CandidateRelease; scale: number }[]; base?: CandidateRelease } = {},
): Promise<void> {
  t.startedAt = Date.now();
  const weightsRelease = extra.base ?? c;
  const key = [...weightsRelease.manifest.files.map((f) => f.sha256), ...(extra.adapters ?? []).map((a) => `lora:${a.candidate.manifest.files[0]!.sha256}`)].join('+');
  try {
    signal?.throwIfAborted();
    if (deps.runtime.loaded?.key === key) {
      t.reusedLoadedModel = true;
    } else {
      t.state = 'verifying';
      emit();
      const v0 = performance.now();
      const weights = await Promise.all(weightsRelease.manifest.files.filter((f) => f.role === 'weights').map((f) => deps.getVerifiedFile(f.sha256, f.size)));
      const adapters = await Promise.all(
        (extra.adapters ?? []).map(async (a) => {
          const f = a.candidate.manifest.files.find((x) => x.role === 'adapter')!;
          return { blob: await deps.getVerifiedFile(f.sha256, f.size), sha256: f.sha256, scale: a.scale };
        }),
      );
      t.verifyMs = Math.round(performance.now() - v0);
      signal?.throwIfAborted();
      t.state = 'loading';
      emit();
      const info = await deps.runtime.load({
        key,
        weights,
        adapters,
        contextLength: weightsRelease.manifest.requirements.context_length,
        ...(weightsRelease.manifest.runtime.chat_template ? { chatTemplate: weightsRelease.manifest.runtime.chat_template } : {}),
      });
      t.loadMs = info.ms;
    }
    const { op, system, prompt } = stageInputs(c.manifest, t.stage, input, language);
    const gen = op.generation ?? {};
    const out = knownOutput(op)!;
    t.state = 'generating';
    emit();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const r = await deps.runtime.generate({
        mode: op.prompt.mode,
        ...(system ? { system } : {}),
        prompt: prompt + (attempt === 0 ? '' : retryHint(op)),
        maxTokens: Math.min(gen.max_tokens ?? 64, MAX_TOKENS_CAP),
        temperature: gen.temperature ?? 0,
        ...(gen.top_k !== undefined ? { topK: gen.top_k } : {}),
        ...(gen.top_p !== undefined ? { topP: gen.top_p } : {}),
        ...(gen.stop ? { stop: gen.stop } : {}),
        ...(out.type === 'label' ? { grammar: deps.choiceGrammar(labelChoices(out)) } : {}),
        ...(extra.adapters?.length ? { adapterScales: extra.adapters.map((a) => a.scale) } : {}),
        ...(signal ? { signal } : {}),
        onToken: (s) => deps.onToken?.(t.stage as StageId, s),
      });
      const parsed = parseOperationOutput(op, r.text);
      t.attempts.push({ raw: r.text, ms: r.ms, tokens: r.completionTokens, ...(parsed.value ? { parsed: parsed.value } : {}), ...(parsed.error ? { error: parsed.error } : {}) });
      emit();
      if (parsed.declined) {
        t.state = 'declined';
        t.error = 'the model answered that this request is outside what it does';
        break;
      }
      if (!parsed.error) {
        t.output = parsed.value!;
        t.state = 'completed';
        break;
      }
    }
    if (t.state !== 'completed' && t.state !== 'declined') {
      t.state = 'failed';
      t.error = `the answer did not have the shape ${t.stage} promises after ${t.attempts.length} attempts`;
    }
  } catch (e) {
    const aborted = signal?.aborted || (e as { code?: string }).code === 'canceled';
    t.state = aborted ? 'canceled' : 'failed';
    t.error = aborted ? 'canceled by user' : (e as Error).message;
    if (aborted) await deps.runtime.unload();
  } finally {
    t.finishedAt = Date.now();
    emit();
  }
}

export async function executeWorkflow(plan: WorkflowPlan, deps: ExecutionDeps, signal?: AbortSignal): Promise<WorkflowResult> {
  const startedAt = Date.now();
  const trace: StageTrace[] = [];
  const emit = () => deps.onUpdate?.(trace.map((t) => ({ ...t, attempts: [...t.attempts] })));
  if (!plan.ok) {
    return { status: 'failed', language: plan.language, outputs: {}, trace, startedAt, finishedAt: Date.now() };
  }
  for (const s of plan.stages) trace.push(newTrace(s.stage, s.release!));
  emit();
  for (let i = 0; i < plan.stages.length; i++) {
    if (signal?.aborted) {
      trace[i]!.state = 'canceled';
      continue;
    }
    await runStage(trace[i]!, plan.stages[i]!.release!, plan.input, plan.language, deps, signal, emit);
  }
  const outputs = Object.fromEntries(trace.filter((t) => t.state === 'completed').map((t) => [t.stage, t.output!]));
  const category = outputs['text-classification'] ? outputText(outputs['text-classification']) : undefined;
  const summary = outputs.summarization ? outputText(outputs.summarization) : undefined;
  const status: WorkflowResult['status'] = trace.some((t) => t.state === 'canceled')
    ? 'canceled'
    : trace.every((t) => t.state === 'completed')
      ? 'completed'
      : trace.some((t) => t.state === 'completed')
        ? 'partial'
        : 'failed';
  return {
    status,
    language: plan.language,
    outputs,
    ...(category ? { category } : {}),
    ...(summary ? { summary } : {}),
    composed: {
      category: category ?? null,
      summary: summary ?? null,
      text: `Category: ${category ?? '(classification failed)'}\nSummary: ${summary ?? '(summarization failed)'}`,
    },
    trace,
    startedAt,
    finishedAt: Date.now(),
  };
}

/**
 * One-model debug mode: run a single operation of one release, optionally with
 * LoRA adapters applied to its exact base.
 */
export async function runSingle(
  c: CandidateRelease,
  stage: string,
  input: string,
  deps: ExecutionDeps,
  opts: { signal?: AbortSignal; language?: string; adapters?: { candidate: CandidateRelease; scale: number }[]; base?: CandidateRelease } = {},
): Promise<StageTrace> {
  const adapters = (opts.adapters ?? []).map((a) => ({ sha256: a.candidate.manifest.files[0]!.sha256, scale: a.scale }));
  const t = newTrace(stage, c, adapters);
  if (opts.base) t.files = opts.base.manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }));
  await runStage(t, c, input, opts.language ?? 'und', deps, opts.signal, () => deps.onUpdate?.([{ ...t }]), {
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.base ? { base: opts.base } : {}),
  });
  return t;
}
