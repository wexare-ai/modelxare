// Typed RPC client for the catalog worker.
import type { CatalogApi, CatalogMethod, WorkerRequest, WorkerResponse } from '../workers/catalog-api.ts';

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never };
export type CatalogClient = Async<CatalogApi>;

export function createCatalogClient(): CatalogClient {
  const worker = new Worker(new URL('../workers/catalog.worker.ts', import.meta.url), { type: 'module', name: 'wexare-catalog' });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.error !== undefined) p.reject(new Error(ev.data.error));
    else p.resolve(ev.data.result);
  };
  worker.onerror = (e) => console.error('catalog worker error', e.message);
  // Release the worker's exclusive OPFS handles as soon as the page goes away
  // (reload, navigation), so the next page can open the catalog. Pages kept in
  // the back/forward cache keep their worker.
  addEventListener('pagehide', (e: PageTransitionEvent) => {
    if (!e.persisted) worker.terminate();
  });
  return new Proxy({} as CatalogClient, {
    get: (_t, method: string) => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const msg: WorkerRequest = { id, method: method as CatalogMethod, args };
        const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer as ArrayBuffer);
        worker.postMessage(msg, transfer);
      }),
  });
}
