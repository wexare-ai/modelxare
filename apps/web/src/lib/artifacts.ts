// Verified artifact downloads into OPFS, with source fallback and per-transport
// accounting. Bytes reach the runtime only through getVerifiedFile(), which
// re-hashes the cached file first.
import { IntegrityError, resolveSources, type AttemptReport } from '@wexare/storage';
import { OpfsArtifactCache, TorrentDownloader, downloadToCache, hashBlob } from '@wexare/storage/browser';
import type { FileLocation } from '@wexare/protocol';
import type { CatalogClient } from './catalog-client.ts';
import type { Settings } from './settings.ts';

export type FileStatus = 'queued' | 'downloading' | 'verified' | 'failed' | 'canceled';

export interface FileDownloadState {
  sha256: string;
  path: string;
  size: number;
  status: FileStatus;
  bytes: number;
  source?: string;
  peerBytes?: number;
  webSeedBytes?: number;
  error?: string;
  attempts: AttemptReport[];
}

export interface TransferStats {
  bytesByTransport: Record<string, number>;
  peerBytes: number;
  webSeedBytes: number;
  hashFailures: number;
  sizeFailures: number;
  verified: number;
  recentAttempts: AttemptReport[];
}

export interface DownloadFile {
  sha256: string;
  size: number;
  path: string;
  locations: FileLocation[];
}

export class ArtifactManager extends EventTarget {
  private cache: OpfsArtifactCache | null = null;
  readonly torrent: TorrentDownloader;
  readonly downloads = new Map<string, FileDownloadState>();
  readonly cached = new Set<string>();
  readonly stats: TransferStats = { bytesByTransport: {}, peerBytes: 0, webSeedBytes: 0, hashFailures: 0, sizeFailures: 0, verified: 0, recentAttempts: [] };
  private controllers = new Map<string, AbortController>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly catalog: CatalogClient,
    private readonly settings: () => Settings,
  ) {
    super();
    const t = settings().torrent;
    this.torrent = new TorrentDownloader({ trackers: t.trackers, webSeedDelayMs: t.webSeedDelayMs, seed: t.seed });
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }

  async getCache(): Promise<OpfsArtifactCache> {
    if (!this.cache) this.cache = await OpfsArtifactCache.open();
    return this.cache;
  }

  /**
   * Reconcile catalog cache marks with OPFS contents; never trust an unverified mark.
   * With an in-memory catalog the marks are missing and another tab may own these
   * files, so delete nothing: list what is on disk (re-hashed before any use).
   */
  async init(persistentCatalog = true): Promise<void> {
    const cache = await this.getCache();
    if (!persistentCatalog) {
      for (const f of await cache.list()) this.cached.add(f.sha256);
      this.changed();
      return;
    }
    await cache.clearTemp();
    const onDisk = new Map((await cache.list()).map((f) => [f.sha256, f.size]));
    for (const a of await this.catalog.cachedArtifacts()) {
      if (onDisk.get(a.sha256) === a.size) this.cached.add(a.sha256);
      else await this.catalog.unmarkCached(a.sha256);
    }
    for (const [sha] of onDisk) if (!this.cached.has(sha)) await cache.remove(sha); // unrecorded bytes are discarded
    this.changed();
  }

  isCached = (sha256: string) => this.cached.has(sha256);
  /** Queued or downloading right now. */
  isPending = (sha256: string) => ['queued', 'downloading'].includes(this.downloads.get(sha256)?.status ?? '');

  private applyTorrentSettings() {
    const t = this.settings().torrent;
    this.torrent.opts.trackers = t.trackers;
    this.torrent.opts.webSeedDelayMs = t.webSeedDelayMs;
    this.torrent.setSeeding(t.seed);
  }

  private record(a: AttemptReport) {
    this.stats.recentAttempts.unshift(a);
    this.stats.recentAttempts.splice(60);
    if (a.ok) {
      this.stats.bytesByTransport[a.transport] = (this.stats.bytesByTransport[a.transport] ?? 0) + a.bytes;
      this.stats.verified++;
    } else if (/SHA-256 mismatch/.test(a.error ?? '')) this.stats.hashFailures++;
    else if (/bytes/.test(a.error ?? '')) this.stats.sizeFailures++;
    this.stats.peerBytes += a.peerBytes ?? 0;
    this.stats.webSeedBytes += a.webSeedBytes ?? 0;
  }

  /** Download files one at a time (bounded memory); each is verified before promotion. */
  download(files: DownloadFile[]): Promise<void> {
    const s = this.settings();
    if (!s.networkSync) return Promise.reject(new Error('Network sync is off (Sources & diagnostics). Downloads are disabled.'));
    this.applyTorrentSettings();
    for (const f of files) {
      if (this.cached.has(f.sha256)) continue;
      const cur = this.downloads.get(f.sha256);
      if (cur && (cur.status === 'queued' || cur.status === 'downloading')) continue;
      this.downloads.set(f.sha256, { sha256: f.sha256, path: f.path, size: f.size, status: 'queued', bytes: 0, attempts: [] });
    }
    this.changed();
    const run = async () => {
      for (const f of files) {
        const st = this.downloads.get(f.sha256);
        if (!st || st.status !== 'queued') continue;
        const ac = new AbortController();
        this.controllers.set(f.sha256, ac);
        st.status = 'downloading';
        this.changed();
        try {
          const settings = this.settings();
          const sources = resolveSources(f.locations, { ipfsGateways: settings.ipfsGateways, arweaveGateways: settings.arweaveGateways, extraMirrors: settings.extraMirrors }, f.sha256);
          await downloadToCache(sources, { sha256: f.sha256, size: f.size }, await this.getCache(), {
            signal: ac.signal,
            ...(settings.torrent.enabled ? { torrent: this.torrent } : {}),
            onProgress: (p) => {
              st.bytes = p.bytes;
              st.source = p.source.kind === 'http' ? p.source.url : 'torrent';
              st.peerBytes = p.peerBytes;
              st.webSeedBytes = p.webSeedBytes;
              this.changed();
            },
            onAttempt: (a) => {
              st.attempts.push(a);
              this.record(a);
              this.changed();
            },
          });
          await this.catalog.markCached(f.sha256, f.size, 'opfs');
          this.cached.add(f.sha256);
          st.status = 'verified';
          st.bytes = f.size;
        } catch (e) {
          st.status = ac.signal.aborted ? 'canceled' : 'failed';
          st.error = ac.signal.aborted ? 'canceled' : (e as Error).message;
        } finally {
          this.controllers.delete(f.sha256);
          this.changed();
        }
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  cancel(sha256: string): void {
    this.controllers.get(sha256)?.abort();
    const st = this.downloads.get(sha256);
    if (st?.status === 'queued') {
      st.status = 'canceled';
      this.changed();
    }
  }

  cancelAll(): void {
    for (const sha of [...this.downloads.keys()]) this.cancel(sha);
  }

  async remove(sha256: string): Promise<void> {
    await (await this.getCache()).remove(sha256);
    await this.catalog.unmarkCached(sha256);
    this.cached.delete(sha256);
    this.downloads.delete(sha256);
    this.changed();
  }

  async clearAll(): Promise<void> {
    for (const sha of [...this.cached]) await this.remove(sha);
    await (await this.getCache()).clearAll();
    this.changed();
  }

  /** Re-hash a cached file before it is handed to the runtime. */
  async getVerifiedFile(sha256: string, size: number): Promise<Blob> {
    const file = await (await this.getCache()).getFile(sha256);
    if (!file || file.size !== size) {
      if (this.cached.has(sha256)) await this.remove(sha256);
      throw new IntegrityError(`file ${sha256.slice(0, 12)}… is not in the verified cache`, 'size_mismatch');
    }
    if ((await hashBlob(file)) !== sha256) {
      this.stats.hashFailures++;
      await this.remove(sha256);
      throw new IntegrityError(`cached file ${sha256.slice(0, 12)}… failed re-verification and was removed`, 'hash_mismatch');
    }
    return file;
  }

  async usage(): Promise<{ usage: number; quota: number; persisted: boolean; files: number; bytes: number }> {
    const est = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    const files = await (await this.getCache()).list();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  /** Check quota before a download of `bytes`. */
  async hasRoomFor(bytes: number): Promise<{ ok: boolean; available: number }> {
    const est = await navigator.storage.estimate();
    const available = (est.quota ?? 0) - (est.usage ?? 0);
    return { ok: available > bytes * 1.05, available };
  }
}
