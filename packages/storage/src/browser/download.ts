// Download with integrity verification and source fallback. Bytes stream into a
// temp OPFS file while being hashed; only an exact length + SHA-256 match is
// promoted into the verified cache. Corrupt or partial results never escape.
import { createSHA256 } from 'hash-wasm';
import { IntegrityError, type AttemptReport, type DownloadSource, type VerifiedDownload } from '../index.ts';
import type { OpfsArtifactCache } from './opfs-cache.ts';
import type { TorrentDownloader } from './torrent.ts';

export interface DownloadProgress {
  source: DownloadSource;
  bytes: number;
  total: number;
  peerBytes?: number;
  webSeedBytes?: number;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  onAttempt?: (a: AttemptReport) => void;
  torrent?: TorrentDownloader;
}

export async function downloadToCache(
  sources: DownloadSource[],
  expected: { sha256: string; size: number },
  cache: OpfsArtifactCache,
  opts: DownloadOptions = {},
): Promise<VerifiedDownload> {
  if (await cache.has(expected.sha256, expected.size)) return { ...expected, attempts: [] };
  const attempts: AttemptReport[] = [];
  for (const source of sources) {
    opts.signal?.throwIfAborted();
    const t0 = performance.now();
    const label = source.kind === 'http' ? source.url : source.magnet;
    const temp = await cache.createTemp();
    let bytes = 0;
    let extra: Partial<AttemptReport> = {};
    try {
      const h = await createSHA256();
      h.init();
      const write = async (chunk: Uint8Array) => {
        bytes += chunk.length;
        if (bytes > expected.size) throw new IntegrityError(`source returned more than ${expected.size} bytes`, 'size_mismatch');
        h.update(chunk);
        await temp.writable.write(chunk as BufferSource);
      };
      if (source.kind === 'http') {
        const res = await fetch(source.url, { signal: opts.signal ?? null, cache: 'no-store', credentials: 'omit' });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await write(value);
          opts.onProgress?.({ source, bytes, total: expected.size });
        }
      } else {
        if (!opts.torrent) throw new Error('torrent transport disabled');
        const r = await opts.torrent.download(source.magnet, source.path, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (p) => opts.onProgress?.({ source, bytes: p.bytes, total: expected.size, peerBytes: p.peerBytes, webSeedBytes: p.webSeedBytes }),
        });
        extra = { peerBytes: r.peerBytes, webSeedBytes: r.webSeedBytes };
        const reader = r.blob.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await write(value);
        }
      }
      if (bytes !== expected.size) throw new IntegrityError(`expected ${expected.size} bytes, got ${bytes}`, 'size_mismatch');
      const digest = h.digest('hex');
      if (digest !== expected.sha256) throw new IntegrityError(`SHA-256 mismatch (got ${digest.slice(0, 16)}…)`, 'hash_mismatch');
      await temp.writable.close();
      await cache.promote(temp.name, expected.sha256);
      const a: AttemptReport = { source: label, transport: source.kind === 'http' ? source.transport : 'torrent', ok: true, bytes, ms: Math.round(performance.now() - t0), ...extra };
      attempts.push(a);
      opts.onAttempt?.(a);
      return { ...expected, attempts };
    } catch (e) {
      await temp.writable.abort().catch(() => undefined);
      await cache.discardTemp(temp.name);
      const a: AttemptReport = {
        source: label,
        transport: source.kind === 'http' ? source.transport : 'torrent',
        ok: false,
        bytes,
        error: (e as Error).message,
        ms: Math.round(performance.now() - t0),
        ...extra,
      };
      attempts.push(a);
      opts.onAttempt?.(a);
      if ((e as Error).name === 'AbortError' || opts.signal?.aborted) throw e;
    }
  }
  const err = new Error(sources.length ? 'all sources failed' : 'no usable source for this file');
  (err as Error & { attempts: AttemptReport[] }).attempts = attempts;
  throw err;
}

/** Fetch small metadata (e.g. a catalog ZIP) into memory with the same checks. */
export async function fetchVerifiedBytes(
  sources: DownloadSource[],
  expected: { sha256: string; size: number },
  opts: DownloadOptions = {},
): Promise<{ bytes: Uint8Array; attempts: AttemptReport[] }> {
  const attempts: AttemptReport[] = [];
  for (const source of sources) {
    const t0 = performance.now();
    const label = source.kind === 'http' ? source.url : source.magnet;
    let extra: Partial<AttemptReport> = {};
    let n = 0;
    try {
      let bytes: Uint8Array;
      if (source.kind === 'http') {
        const res = await fetch(source.url, { signal: opts.signal ?? null, cache: 'no-store', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > expected.size) throw new IntegrityError('response larger than announced', 'size_mismatch');
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        if (!opts.torrent) throw new Error('torrent transport disabled');
        const r = await opts.torrent.download(source.magnet, source.path, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (p) => opts.onProgress?.({ source, bytes: p.bytes, total: expected.size, peerBytes: p.peerBytes, webSeedBytes: p.webSeedBytes }),
        });
        extra = { peerBytes: r.peerBytes, webSeedBytes: r.webSeedBytes };
        bytes = new Uint8Array(await r.blob.arrayBuffer());
      }
      n = bytes.length;
      if (bytes.length !== expected.size) throw new IntegrityError(`expected ${expected.size} bytes, got ${bytes.length}`, 'size_mismatch');
      const h = await createSHA256();
      h.init();
      h.update(bytes);
      if (h.digest('hex') !== expected.sha256) throw new IntegrityError('SHA-256 mismatch', 'hash_mismatch');
      const a: AttemptReport = { source: label, transport: source.kind === 'http' ? source.transport : 'torrent', ok: true, bytes: n, ms: Math.round(performance.now() - t0), ...extra };
      attempts.push(a);
      opts.onAttempt?.(a);
      return { bytes, attempts };
    } catch (e) {
      const a: AttemptReport = { source: label, transport: source.kind === 'http' ? source.transport : 'torrent', ok: false, bytes: n, error: (e as Error).message, ms: Math.round(performance.now() - t0), ...extra };
      attempts.push(a);
      opts.onAttempt?.(a);
      if (opts.signal?.aborted) throw e;
    }
  }
  const err = new Error(sources.length ? 'all sources failed' : 'no usable source');
  (err as Error & { attempts: AttemptReport[] }).attempts = attempts;
  throw err;
}
