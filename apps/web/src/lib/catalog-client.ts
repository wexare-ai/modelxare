// Typed RPC client for the catalog worker, and the tab session that owns it.
//
// Only one context at a time can hold the catalog's OPFS files. The newest tab
// takes the catalog over: it broadcasts a takeover, older tabs terminate their
// worker (which releases the files and the worker's Web Lock) and offer
// "Use here". Pages also let go on pagehide, including into the back/forward
// cache, and reload if they are restored from it.
import type { CatalogApi, CatalogMethod, InitResult, WorkerRequest, WorkerResponse } from '../workers/catalog-api.ts';

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never };
export type CatalogClient = Async<CatalogApi>;

export interface CatalogSession extends EventTarget {
  /** 'released': a newer tab took the catalog over; this page has to reload to use it again. */
  readonly state: 'active' | 'released';
  /** Open the catalog. If storage fails or does not answer in time, fall back to memory and say why. */
  open(): Promise<InitResult>;
  /** Delete this site's local catalog and downloaded models in this browser, then reload. Settings stay. */
  resetLocalData(): Promise<void>;
}

/** A healthy open takes a few seconds; waiting for a previous tab adds at most 5 s plus handle release. */
const OPEN_TIMEOUT_MS = 20_000;
const CHANNEL = 'wexare-catalog';
type Broadcast = { type: 'takeover'; at: number } | { type: 'reset' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function createCatalogClient(): { client: CatalogClient; session: CatalogSession } {
  const startedAt = performance.timeOrigin + performance.now();
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const session = Object.assign(new EventTarget(), { state: 'active' as CatalogSession['state'], open, resetLocalData });

  let worker = start();
  function start(): Worker {
    const w = new Worker(new URL('../workers/catalog.worker.ts', import.meta.url), { type: 'module', name: 'wexare-catalog' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.error !== undefined) p.reject(new Error(ev.data.error));
      else p.resolve(ev.data.result);
    };
    w.onerror = (e) => console.error('catalog worker error', e.message);
    return w;
  }
  function stop(reason: string) {
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  }
  function release() {
    if (session.state === 'released') return;
    stop('the catalog moved to another tab');
    session.state = 'released';
    session.dispatchEvent(new Event('change'));
  }

  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent<Broadcast>) => {
    if (e.data.type === 'reset' || (e.data.type === 'takeover' && e.data.at > startedAt)) release();
  };
  channel.postMessage({ type: 'takeover', at: startedAt } satisfies Broadcast);

  addEventListener('pagehide', () => worker.terminate());
  addEventListener('pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) location.reload();
  });

  const client = new Proxy({} as CatalogClient, {
    get: (_t, method: string) => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        if (session.state === 'released') return reject(new Error('the catalog moved to another tab'));
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const msg: WorkerRequest = { id, method: method as CatalogMethod, args };
        const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer as ArrayBuffer);
        worker.postMessage(msg, transfer);
      }),
  });

  async function open(): Promise<InitResult> {
    try {
      return await withTimeout(client.init(), OPEN_TIMEOUT_MS, `local storage did not respond within ${OPEN_TIMEOUT_MS / 1000} s`);
    } catch (e) {
      if (session.state === 'released') throw e;
      // A worker stuck in a storage call cannot be interrupted: replace it with an in-memory one.
      const reason = (e as Error).message;
      console.warn('catalog storage unavailable; using an in-memory catalog', e);
      stop(reason);
      worker = start();
      return { ...(await client.init(true)), error: reason };
    }
  }

  async function resetLocalData(): Promise<void> {
    channel.postMessage({ type: 'reset' } satisfies Broadcast);
    // The page reloads afterwards, so calls in flight can simply be dropped.
    worker.terminate();
    await sleep(300);
    await withTimeout(
      (async () => {
        const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
        // Files still being written by a tab that is just closing are briefly locked: retry.
        for (let attempt = 0; ; attempt++) {
          try {
            for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
            return;
          } catch (e) {
            if (attempt >= 5) throw e;
            await sleep(500);
          }
        }
      })(),
      15_000,
      'local storage did not respond',
    ).catch((e: Error) => {
      throw new Error(`Could not delete local data (${e.message}). Close every other window of this app, or restart the browser, then try again.`);
    });
    location.reload();
  }

  return { client, session };
}
