// Ask anything. System 1 (the Laya router release from the catalog, checked
// like every model) decides each step; steps run on models on this device
// first, and online only when the person turned that on with their own key.
import { useCallback, useEffect, useRef, useState } from 'react';
import { LayaWorkerClient } from '@wexare/laya-web';
import type { CandidateRelease } from '@wexare/orchestrator';
import { REMOTE_OFF, layaBundle, pickRouter, remoteHelp, route, routerFiles, type RemoteSettings, type RunResult, type Step, type System1 } from '@wexare/router';
import { capabilities, toCandidate } from '@wexare/web/src/lib/runtime.ts';
import { artifacts, catalog, fetchFiles, live, opened, runTask, useEvent } from './engine.ts';

/** How each kind of step reads to a person. */
export const STEP_WORDS: Record<string, { name: string; result: string; doing: string }> = {
  sort: { name: 'Sort by topic', result: 'Topic', doing: 'Sorting' },
  summarize: { name: 'Summarize', result: 'Summary', doing: 'Summarizing' },
  write: { name: 'Continue the text', result: 'Continued text', doing: 'Writing' },
  reply: { name: 'Draft a reply', result: 'Draft reply', doing: 'Drafting a reply' },
  translate: { name: 'Translate', result: 'Translation', doing: 'Translating' },
  answer: { name: 'Answer a question', result: 'Answer', doing: 'Answering' },
};

/** "Tiny summarizer (SmolLM2 360M Q8_0)" → "Tiny summarizer". */
export const plainName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;

// Online help: stored only in this browser, never exported or logged.
const HELP_KEY = 'wexare.simple.online-help.v1';
const helpEvents = new EventTarget();

export function loadOnlineHelp(): RemoteSettings {
  try {
    const raw = localStorage.getItem(HELP_KEY);
    if (raw) return { ...REMOTE_OFF, ...(JSON.parse(raw) as Partial<RemoteSettings>) };
  } catch {
    // unreadable storage: online help stays off
  }
  return { ...REMOTE_OFF };
}

export function saveOnlineHelp(s: RemoteSettings): void {
  try {
    localStorage.setItem(HELP_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: the setting lasts for this page only
  }
  helpEvents.dispatchEvent(new Event('change'));
}

export function useOnlineHelp(): RemoteSettings {
  useEvent(helpEvents);
  return loadOnlineHelp();
}

/** The router model: found in the catalog, downloaded with consent, loaded once. */
class RouterModel extends EventTarget {
  release: CandidateRelease | null = null;
  status: 'unknown' | 'missing' | 'not-downloaded' | 'downloaded' | 'loading' | 'ready' = 'unknown';
  private client: LayaWorkerClient | null = null;

  private set(status: RouterModel['status']) {
    this.status = status;
    this.dispatchEvent(new Event('change'));
  }

  get files() {
    return this.release?.manifest.files ?? [];
  }

  get totalBytes() {
    return this.files.reduce((n, f) => n + f.size, 0);
  }

  get missingBytes() {
    return this.files.filter((f) => !artifacts.isCached(f.sha256)).reduce((n, f) => n + f.size, 0);
  }

  async refresh(): Promise<void> {
    await opened;
    const rows = await catalog.candidates();
    this.release = pickRouter(rows.map(toCandidate), capabilities.features, artifacts.isCached);
    if (this.client) return this.set('ready');
    this.set(!this.release ? 'missing' : this.missingBytes > 0 ? 'not-downloaded' : 'downloaded');
  }

  /** Load the downloaded router: each file is re-checked against its hash first. */
  async load(): Promise<System1> {
    if (this.client) return this.client;
    const release = this.release;
    const files = release && routerFiles(release.manifest);
    if (!release || !files) throw new Error('no router model');
    this.set('loading');
    const urls = new Map<string, string>();
    try {
      for (const f of [files.weights, files.tokenizer, files.tokenizerConfig, files.config]) {
        urls.set(f.sha256, URL.createObjectURL(await artifacts.getVerifiedFile(f.sha256, f.size)));
      }
      this.client = await LayaWorkerClient.load({
        worker: new Worker(new URL('./laya.worker.ts', import.meta.url), { type: 'module', name: 'wexare-router' }),
        bundle: layaBundle(release, (sha) => urls.get(sha)!),
      });
    } catch (e) {
      this.set('downloaded');
      throw e;
    } finally {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    }
    this.set('ready');
    return this.client;
  }

  async remove(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    for (const f of this.files) await artifacts.remove(f.sha256);
    await this.refresh();
  }
}

export const routerModel = new RouterModel();

export function useRouterModel(): RouterModel {
  useEvent(routerModel);
  const files = useEvent(artifacts);
  // Releases keep arriving from the relays after the page opens.
  const releases = useEvent(live, 'catalog-updated');
  useEffect(() => void routerModel.refresh(), [files, releases]);
  return routerModel;
}

/** Chrome reports device memory (capped at 8 GB); the router needs about 3 GB free. */
const lowMemory = () => {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof gb === 'number' && gb < 8;
};

export type Prompt =
  | { kind: 'router'; bytes: number; lowMemory: boolean }
  | { kind: 'download'; model: string; bytes: number }
  | { kind: 'clarify'; options: { id: string; probability: number }[] };

export interface AskState {
  phase: 'idle' | 'working' | 'done' | 'failed';
  /** What is happening right now, in words. */
  activity: string | null;
  /** Files being downloaded, for progress. */
  downloading: { sha256: string; size: number }[];
  prompt: Prompt | null;
  steps: Step[];
  /** Text of the step being written right now. */
  partial: string;
  result: RunResult | null;
  problem: 'no-router' | 'router-download' | 'router-load' | null;
}

const IDLE: AskState = { phase: 'idle', activity: null, downloading: [], prompt: null, steps: [], partial: '', result: null, problem: null };

export function useAsk() {
  const [state, setState] = useState<AskState>(IDLE);
  const reply = useRef<((value: unknown) => void) | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEvent(artifacts);

  const ask = <T,>(prompt: Prompt) =>
    new Promise<T>((resolve) => {
      reply.current = resolve as (v: unknown) => void;
      setState((s) => ({ ...s, prompt }));
    });

  const respond = useCallback((value: unknown) => {
    const r = reply.current;
    reply.current = null;
    setState((s) => ({ ...s, prompt: null }));
    r?.(value);
  }, []);

  const download = async (files: CandidateRelease['manifest']['files'], activity: string) => {
    setState((s) => ({ ...s, activity, downloading: files.map((f) => ({ sha256: f.sha256, size: f.size })) }));
    const ok = await fetchFiles(files);
    setState((s) => ({ ...s, downloading: [] }));
    return ok;
  };

  const go = useCallback(async (request: string) => {
    const ac = new AbortController();
    abort.current = ac;
    const stopped = () => ac.signal.aborted;
    setState({ ...IDLE, phase: 'working', activity: 'Getting ready' });

    await routerModel.refresh();
    if (stopped()) return;
    if (!routerModel.release) return setState({ ...IDLE, phase: 'failed', problem: 'no-router' });
    if (routerModel.missingBytes > 0) {
      if (!(await ask<boolean>({ kind: 'router', bytes: routerModel.missingBytes, lowMemory: lowMemory() })) || stopped()) return setState(IDLE);
      if (!(await download(routerModel.files, 'Downloading the router'))) return setState(stopped() ? IDLE : { ...IDLE, phase: 'failed', problem: 'router-download' });
      await routerModel.refresh();
    }
    setState((s) => ({ ...s, activity: 'Getting the router ready' }));
    let system1: System1;
    try {
      system1 = await routerModel.load();
    } catch (e) {
      console.warn('router', e);
      return setState({ ...IDLE, phase: 'failed', problem: 'router-load' });
    }
    if (stopped()) return setState(IDLE);

    setState((s) => ({ ...s, activity: 'Working out what to do' }));
    const candidates = (await catalog.candidates()).map(toCandidate);
    const result = await route(request, system1, {
      candidates,
      isCached: artifacts.isCached,
      remote: remoteHelp(loadOnlineHelp()),
      signal: ac.signal,
      async runLocal(release, capability, input) {
        setState((s) => ({ ...s, activity: 'Getting the model ready', partial: '' }));
        const out = await runTask(release, undefined, capability, input, {
          signal: ac.signal,
          partial: (text) => setState((s) => ({ ...s, partial: text })),
        });
        if (!out) throw new Error('The model didn’t give a usable answer.');
        return out;
      },
      confirmDownload: (release, bytes) => ask<boolean>({ kind: 'download', model: plainName(release.name), bytes }),
      download: (release) => download(release.manifest.files, `Downloading ${plainName(release.name)}`),
      clarify: (options) => ask<string | null>({ kind: 'clarify', options: options.map((o) => ({ id: o.intent.id, probability: o.probability })) }),
      onUpdate: (steps) => {
        const running = steps.at(-1)?.status === 'running' ? steps.at(-1) : undefined;
        setState((s) => ({ ...s, steps, activity: running ? (STEP_WORDS[running.intent.id]?.doing ?? 'Working') : 'Working out what to do' }));
      },
    });
    if (stopped()) return setState(IDLE);
    setState((s) => ({ ...s, phase: 'done', activity: null, partial: '', steps: result.steps, result }));
  }, []);

  const cancel = useCallback(() => {
    abort.current?.abort();
    for (const d of state.downloading) artifacts.cancel(d.sha256);
    respond(false);
    setState(IDLE);
  }, [respond, state.downloading]);

  const total = state.downloading.reduce((n, f) => n + f.size, 0);
  const done = state.downloading.reduce((n, f) => n + (artifacts.isCached(f.sha256) ? f.size : (artifacts.downloads.get(f.sha256)?.bytes ?? 0)), 0);
  return { ...state, progress: total ? done / total : null, go, respond, cancel };
}
