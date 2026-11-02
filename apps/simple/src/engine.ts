// The same engine as the PoC (apps/web), wired once for this app: the local
// catalog, live discovery from relays, verified downloads and on-device
// inference. The screens only see models, tasks and answers.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { detectLanguage, runSingle, type CandidateRelease, type StageTrace } from '@wexare/orchestrator';
import { createCatalogClient } from '@wexare/web/src/lib/catalog-client.ts';
import { LiveDiscovery } from '@wexare/web/src/lib/live.ts';
import { ArtifactManager } from '@wexare/web/src/lib/artifacts.ts';
import { loadSettings } from '@wexare/web/src/lib/settings.ts';
import { choiceGrammar, runtime, toCandidate } from '@wexare/web/src/lib/runtime.ts';
import type { InitResult } from '@wexare/web/src/workers/catalog-api.ts';
import { buildModels, TOPICS, type Model, type TaskId } from './models.ts';

const settings = loadSettings();
export const { client: catalog, session } = createCatalogClient();
export const live = new LiveDiscovery(catalog);
export const artifacts = new ArtifactManager(catalog, () => settings);

/** Storage first, then the model cache, then relay sync. */
export const opened: Promise<InitResult> = session.open().then(async (r) => {
  await artifacts.init(r.persistent).catch((e) => console.warn('model cache', e));
  if (settings.networkSync) live.start(settings.relays);
  return r;
});

/** Re-render when an engine object reports a change. */
export function useEvent(target: EventTarget, type = 'change'): number {
  const version = useRef(0);
  return useSyncExternalStore(
    (notify) => {
      const on = () => {
        version.current++;
        notify();
      };
      target.addEventListener(type, on);
      return () => target.removeEventListener(type, on);
    },
    () => version.current,
  );
}

export function useStorage(): { init: InitResult | null; steppedAside: boolean } {
  const [init, setInit] = useState<InitResult | null>(null);
  useEvent(session);
  useEffect(() => {
    void opened.then(setInit, () => undefined);
  }, []);
  return { init, steppedAside: session.state === 'released' };
}

export type Connection = 'connecting' | 'online' | 'offline';

export function useConnection(): Connection {
  useEvent(live);
  const states = [...live.states.values()];
  if (states.some((s) => s.status === 'live' || s.status === 'catching-up')) return 'online';
  if (states.length && states.every((s) => s.status === 'error' || s.status === 'closed')) return 'offline';
  return 'connecting';
}

/** Every model this browser can run, refreshed as releases arrive and downloads finish. */
export function useModels(): { models: Model[]; loaded: boolean } {
  const updates = useEvent(live, 'catalog-updated');
  const files = useEvent(artifacts);
  const [state, setState] = useState<{ models: Model[]; loaded: boolean }>({ models: [], loaded: false });
  useEffect(() => {
    let current = true;
    void opened
      .then(() => catalog.candidates())
      .then((rows) => current && setState({ models: buildModels(rows.map(toCandidate), artifacts.isCached), loaded: true }))
      .catch(() => current && setState((s) => ({ ...s, loaded: true })));
    return () => {
      current = false;
    };
  }, [updates, files]);
  return state;
}

export type Phase = 'idle' | 'downloading' | 'preparing' | 'working' | 'done' | 'failed';

export interface Answer {
  task: TaskId;
  input: string;
  /** Summary or continued text. */
  text?: string;
  /** Topic name, for sorting. */
  topic?: string;
}

export interface RunState {
  phase: Phase;
  /** 0–1 while downloading. */
  progress: number;
  /** Text as it is being written. */
  partial: string;
  answer: Answer | null;
  problem: 'download' | 'answer' | null;
}

const IDLE: RunState = { phase: 'idle', progress: 0, partial: '', answer: null, problem: null };

/** Download (and verify) files that are missing; true when all of them are here. */
export async function fetchFiles(files: { sha256: string; size: number; path: string; locations: CandidateRelease['manifest']['files'][number]['locations'] }[]): Promise<boolean> {
  const needed = files.filter((f) => !artifacts.isCached(f.sha256));
  if (needed.length) await artifacts.download(needed).catch(() => undefined);
  return files.every((f) => artifacts.isCached(f.sha256));
}

/** Run one task with a local model (a style add-on runs on its base). */
export async function runTask(
  release: CandidateRelease,
  base: CandidateRelease | undefined,
  task: string,
  input: string,
  on: { signal?: AbortSignal; working?: () => void; partial?: (text: string) => void } = {},
): Promise<{ topic?: string; text?: string } | null> {
  const deps = {
    runtime,
    choiceGrammar,
    getVerifiedFile: (sha256: string, size: number) => artifacts.getVerifiedFile(sha256, size),
    onUpdate: ([t]: StageTrace[]) => void (t?.state === 'generating' && on.working?.()),
    onToken: (_stage: string, text: string) => on.partial?.(text),
  };
  const opts = { ...(on.signal ? { signal: on.signal } : {}), language: detectLanguage(input) };
  const trace = base
    ? await runSingle(base, task, input, deps, { ...opts, adapters: [{ candidate: release, scale: 1 }], base })
    : await runSingle(release, task, input, deps, opts);
  if (trace.state === 'canceled') throw new DOMException('canceled', 'AbortError');
  if (trace.state !== 'completed') return null;
  const out = trace.output ?? {};
  if (typeof out.category === 'string') return { topic: TOPICS[out.category] ?? out.category };
  return { text: String(out.summary ?? out.text ?? trace.attempts.at(-1)?.raw ?? '').trim() };
}

/** One button: download what is missing (verified), load the model, answer. */
export function useRun(model: Model | undefined) {
  const [state, setState] = useState<RunState>(IDLE);
  const abort = useRef<AbortController | null>(null);
  useEvent(artifacts);

  const missing = model ? model.files.filter((f) => !artifacts.isCached(f.sha256)) : [];
  // Download progress across the files still needed, from the engine's counters.
  const progress = (() => {
    if (state.phase !== 'downloading' || !model) return 0;
    const total = model.files.reduce((n, f) => n + f.size, 0);
    const done = model.files.reduce((n, f) => n + (artifacts.isCached(f.sha256) ? f.size : (artifacts.downloads.get(f.sha256)?.bytes ?? 0)), 0);
    return total ? done / total : 0;
  })();

  const run = useCallback(
    async (task: TaskId, input: string) => {
      if (!model) return;
      const ac = new AbortController();
      abort.current = ac;
      setState({ ...IDLE, phase: 'downloading' });
      const here = await fetchFiles(model.files);
      if (ac.signal.aborted) return setState(IDLE);
      if (!here) return setState({ ...IDLE, phase: 'failed', problem: 'download' });
      setState({ ...IDLE, phase: 'preparing' });
      let out: Awaited<ReturnType<typeof runTask>>;
      try {
        out = await runTask(model.release, model.base, task, input, {
          signal: ac.signal,
          working: () => setState((s) => (s.phase === 'preparing' ? { ...s, phase: 'working' } : s)),
          partial: (text) => setState((s) => ({ ...s, phase: 'working', partial: text })),
        });
      } catch {
        return setState(ac.signal.aborted ? IDLE : { ...IDLE, phase: 'failed', problem: 'answer' });
      }
      if (ac.signal.aborted) return setState(IDLE);
      if (!out) return setState({ ...IDLE, phase: 'failed', problem: 'answer' });
      setState({ ...IDLE, phase: 'done', answer: { task, input, ...out } });
    },
    [model],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    for (const f of model?.files ?? []) artifacts.cancel(f.sha256);
    setState(IDLE);
  }, [model]);

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, progress, missingBytes: missing.reduce((n, f) => n + f.size, 0), run, stop, reset };
}

/** Free the space a model's files take (a style add-on keeps its shared base). */
export async function removeFromDevice(model: Model): Promise<void> {
  for (const f of model.base ? model.release.manifest.files : model.files) await artifacts.remove(f.sha256);
}
