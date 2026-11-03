// The same engine as the PoC (apps/web), wired once for this app: the local
// catalog, live discovery from relays, verified downloads and on-device
// inference. The screens only see models, tasks and answers.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { detectLanguage, runSingle, type CandidateRelease, type StageTrace } from '@wexare/orchestrator';
import { planEviction } from '@wexare/storage';
import { createCatalogClient } from '@wexare/web/src/lib/catalog-client.ts';
import { LiveDiscovery } from '@wexare/web/src/lib/live.ts';
import { ArtifactManager } from '@wexare/web/src/lib/artifacts.ts';
import { loadSettings } from '@wexare/web/src/lib/settings.ts';
import { choiceGrammar, runtime, toCandidate } from '@wexare/web/src/lib/runtime.ts';
import type { InitResult } from '@wexare/web/src/workers/catalog-api.ts';
import { buildModels, size, TOPICS, type Model, type TaskId } from './models.ts';

const settings = loadSettings();
/** The relays this app listens to: publish there and a release shows up here. */
export const relays = settings.relays;
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
  problem: 'download' | 'space' | 'answer' | null;
  /** For 'space': what was needed, and the room the browser really had. */
  space?: { bytes: number; room: number };
}

const IDLE: RunState = { phase: 'idle', progress: 0, partial: '', answer: null, problem: null };

// Space. Saved models stay until a new one needs room; then the ones used
// least recently are removed first. When each file was last used, and the
// limit, are kept in this browser only.
const USED_KEY = 'wexare.simple.last-used.v1';
const LIMIT_KEY = 'wexare.simple.space.v1';
export const SPACE_LIMITS = [2e9, 4e9, 8e9, 16e9];
const DEFAULT_LIMIT = 4e9;
const spaceEvents = new EventTarget();

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: files with no recorded use are removed first
  }
}

/** Record that these files were just used (one model's files share the moment). */
export function touch(shas: Iterable<string>): void {
  const used = readJson<Record<string, number>>(USED_KEY, {});
  const now = Date.now();
  for (const s of shas) used[s] = now;
  writeJson(USED_KEY, used);
}

export function spaceLimit(): number {
  const limit = readJson<{ limit?: unknown }>(LIMIT_KEY, {}).limit;
  return typeof limit === 'number' && limit > 0 ? limit : DEFAULT_LIMIT;
}

/** Change the limit, and trim saved models down to it right away. */
export async function setSpaceLimit(limit: number): Promise<void> {
  writeJson(LIMIT_KEY, { limit });
  spaceEvents.dispatchEvent(new Event('change'));
  await makeRoom(0, new Set(), Infinity);
}

/** Bytes saved models take on this device. */
async function savedBytes(): Promise<number> {
  const files = await (await artifacts.getCache()).list();
  return files.filter((f) => artifacts.isCached(f.sha256)).reduce((n, f) => n + f.size, 0);
}

/** Space the browser says this site may still use; null when it won't say. */
async function browserRoom(): Promise<number | null> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return typeof quota === 'number' && typeof usage === 'number' ? Math.max(0, quota - usage) : null;
  } catch {
    return null;
  }
}

/**
 * Remove the models used longest ago, never the files in `keep`, so that
 * `bytes` more fit within the limit and within `room`, the space the browser
 * has. When even removing every other model wouldn't make room by that count,
 * only the limit is kept: the count may be wrong, so the download is tried
 * anyway. Returns whether, by that count, it fits.
 */
async function makeRoom(bytes: number, keep: ReadonlySet<string>, room: number): Promise<boolean> {
  const init = await opened;
  // Another tab holds storage, and its models may be in use there: remove nothing.
  if (!init.persistent) return room >= bytes;
  const used = readJson<Record<string, number>>(USED_KEY, {});
  const files = (await (await artifacts.getCache()).list())
    .filter((f) => artifacts.isCached(f.sha256))
    .map((f) => ({ sha256: f.sha256, size: f.size, lastUsed: used[f.sha256] ?? 0 }));
  const byCount = planEviction({ files, needed: bytes, limit: spaceLimit(), free: room, keep });
  const plan = byCount.ok ? byCount : planEviction({ files, needed: bytes, limit: spaceLimit(), free: Infinity, keep });
  for (const sha of plan.remove) await artifacts.remove(sha);
  // Forget files that are gone, so the record doesn't grow forever.
  const now = readJson<Record<string, number>>(USED_KEY, {});
  const onDisk = new Set(files.map((f) => f.sha256).filter((s) => !plan.remove.includes(s)));
  writeJson(USED_KEY, Object.fromEntries(Object.entries(now).filter(([s]) => onDisk.has(s) || artifacts.isPending(s))));
  return byCount.ok;
}

/** Saved bytes and the limit, for Settings. */
export function useSpace(): { saved: number | null; limit: number } {
  const files = useEvent(artifacts);
  const changes = useEvent(spaceEvents);
  const [saved, setSaved] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void opened
      .then(savedBytes)
      .then((n) => current && setSaved(n))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [files, changes]);
  return { saved, limit: spaceLimit() };
}

/** 'no-space': the browser refused the bytes even after room was made; `room` is how much it took first. */
export type Fetched = { status: 'ok' } | { status: 'failed' } | { status: 'no-space'; room: number };

/** Plain words for a download that didn't fit, with the room the browser really had. */
export function noSpaceText(what: string, bytes: number, room: number): string {
  const left = room < 1e6 ? 'this browser won’t let modelXare store any more' : `this browser lets modelXare use only ${size(room)} more`;
  return `There isn’t enough free space on this device for ${what} (${size(bytes)}): ${left}. Free up space on this device, then try again.`;
}

/**
 * When the browser refused to store these files (it was out of space), the
 * most bytes it took before refusing: the room it really had. Null when
 * nothing failed for lack of space.
 */
function refusedAfter(files: { sha256: string }[]): number | null {
  let took: number | null = null;
  for (const f of files) {
    const d = artifacts.downloads.get(f.sha256);
    if (d?.noSpace) took = Math.max(took ?? 0, d.bytes);
  }
  return took;
}

type DownloadFile = { sha256: string; size: number; path: string; locations: CandidateRelease['manifest']['files'][number]['locations'] };

/**
 * Download (and verify) the files that are missing, making room for them as
 * needed: first by what the browser says it has; then, if it still refuses
 * the bytes, by what it actually took, and once more. `keep` lists other
 * files in use that must not be removed for room.
 */
export async function fetchFiles(files: DownloadFile[], keep: string[] = []): Promise<Fetched> {
  const keepSet = new Set([...files.map((f) => f.sha256), ...keep]);
  const missing = () => files.filter((f) => !artifacts.isCached(f.sha256));
  const bytes = (list: DownloadFile[]) => list.reduce((n, f) => n + f.size, 0);
  if (missing().length) {
    await makeRoom(bytes(missing()), keepSet, (await browserRoom()) ?? Infinity);
    await artifacts.download(missing()).catch(() => undefined);
    const took = refusedAfter(missing());
    if (took !== null && missing().length && (await makeRoom(bytes(missing()), keepSet, took))) {
      await artifacts.download(missing()).catch(() => undefined);
    }
  }
  if (missing().length) {
    const room = refusedAfter(missing());
    return room === null ? { status: 'failed' } : { status: 'no-space', room };
  }
  touch(files.map((f) => f.sha256));
  return { status: 'ok' };
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
  touch([...(base?.manifest.files ?? []), ...release.manifest.files].map((f) => f.sha256));
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
      const bytes = model.files.filter((f) => !artifacts.isCached(f.sha256)).reduce((n, f) => n + f.size, 0);
      const fetched = await fetchFiles(model.files);
      if (ac.signal.aborted) return setState(IDLE);
      if (fetched.status === 'no-space') return setState({ ...IDLE, phase: 'failed', problem: 'space', space: { bytes, room: fetched.room } });
      if (fetched.status !== 'ok') return setState({ ...IDLE, phase: 'failed', problem: 'download' });
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
