/// <reference path="./webtorrent.d.ts" />
// Browser torrent transfer over WebRTC (WebTorrent). HTTP web seeds are held
// back for `webSeedDelayMs` so compatible peers get the first chance, and every
// byte is attributed to either a peer or a web seed.
export interface TorrentProgress {
  bytes: number;
  peerBytes: number;
  webSeedBytes: number;
  peers: number;
}

export interface TorrentDownloaderOptions {
  /** Delay before adding HTTP web seeds; 0 adds them immediately, -1 never adds them. */
  webSeedDelayMs?: number;
  /** Keep seeding completed torrents while the tab stays open (opt-in). */
  seed?: boolean;
  /** Fail when no bytes arrive for this long. */
  stallTimeoutMs?: number;
  /** Re-announce this often while no peer is connected. */
  reannounceMs?: number;
  /** Additional WebSocket trackers to announce to. */
  trackers?: string[];
}

type WT = any; // WebTorrent ships no types for its browser bundle.

export class TorrentDownloader {
  private client: WT | null = null;
  readonly totals = { peerBytes: 0, webSeedBytes: 0, uploadedBytes: 0 };
  seeding = new Set<string>();

  constructor(public opts: TorrentDownloaderOptions = {}) {}

  private async getClient(): Promise<WT> {
    if (!this.client) {
      const mod = await import('webtorrent/dist/webtorrent.min.js');
      const WebTorrent = (mod as { default: new (o: unknown) => WT }).default;
      this.client = new WebTorrent({ dht: false, lsd: false, utp: false, tracker: { announce: this.opts.trackers ?? [] } });
      this.client.on('error', (e: Error) => console.warn('webtorrent', e.message));
    }
    return this.client;
  }

  async download(
    magnet: string,
    path: string,
    o: { signal?: AbortSignal; onProgress?: (p: TorrentProgress) => void } = {},
  ): Promise<{ blob: Blob; peerBytes: number; webSeedBytes: number }> {
    const client = await this.getClient();
    // Split web seeds off by hand: re-serializing through URLSearchParams would
    // percent-encode `xt=urn:btih:` and break magnet parsing.
    const [head = '', query = ''] = magnet.split('?', 2);
    const params = query.split('&').filter(Boolean);
    const webSeeds = params.filter((p) => p.startsWith('ws=')).map((p) => decodeURIComponent(p.slice(3)));
    const peerMagnet = `${head}?${params.filter((p) => !p.startsWith('ws=')).join('&')}`;
    const delay = this.opts.webSeedDelayMs ?? 4000;
    const stats = { peerBytes: 0, webSeedBytes: 0 };

    const existing = client.torrents.find((t: WT) => magnet.toLowerCase().includes(t.infoHash));
    const torrent: WT = existing ?? client.add(peerMagnet, { announce: this.opts.trackers ?? [] });

    return await new Promise((resolve, reject) => {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let seedTimer: ReturnType<typeof setTimeout> | undefined;
      // A seeder that registers with the tracker after our announce is never
      // introduced to us until the next scheduled announce (minutes away), so
      // keep announcing, with fresh WebRTC offers, until a peer connects.
      const reannounce = setInterval(() => {
        if (!torrent.wires?.some((w: WT) => w.type !== 'webSeed')) torrent.discovery?.tracker?.update?.();
      }, this.opts.reannounceMs ?? 5000);
      const cleanup = () => {
        clearTimeout(stallTimer);
        clearTimeout(seedTimer);
        clearInterval(reannounce);
        o.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (e: Error) => {
        cleanup();
        if (!this.opts.seed) torrent.destroy();
        reject(e);
      };
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => fail(new Error('torrent stalled: no data from peers or web seeds')), this.opts.stallTimeoutMs ?? 45_000);
      };
      const onAbort = () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      o.signal?.addEventListener('abort', onAbort);
      armStall();

      const track = (wire: WT) =>
        wire.on('download', (n: number) => {
          if (wire.type === 'webSeed') stats.webSeedBytes += n;
          else stats.peerBytes += n;
          armStall();
          o.onProgress?.({ bytes: stats.peerBytes + stats.webSeedBytes, ...stats, peers: torrent.numPeers });
        });
      torrent.on('wire', track);
      torrent.on('upload', (n: number) => (this.totals.uploadedBytes += n));
      if (delay >= 0) seedTimer = setTimeout(() => webSeeds.forEach((ws) => torrent.addWebSeed(ws)), delay);

      const finish = async () => {
        try {
          const file = torrent.files.find((f: WT) => f.path === path || f.name === path) ?? (torrent.files.length === 1 ? torrent.files[0] : null);
          if (!file) throw new Error(`file ${path} not found in torrent`);
          const blob: Blob = await file.blob();
          cleanup();
          this.totals.peerBytes += stats.peerBytes;
          this.totals.webSeedBytes += stats.webSeedBytes;
          if (this.opts.seed) this.seeding.add(torrent.infoHash);
          else torrent.destroy();
          resolve({ blob, ...stats });
        } catch (e) {
          fail(e as Error);
        }
      };
      const start = () => {
        for (const f of torrent.files) (f.path === path || f.name === path || torrent.files.length === 1 ? f.select() : f.deselect());
        if (torrent.done) void finish();
        else torrent.once('done', () => void finish());
      };
      torrent.once('error', (e: Error) => fail(e));
      if (torrent.ready) start();
      else torrent.once('ready', start);
    });
  }

  /** Stop all browser seeding (also happens when the tab closes). */
  async stopSeeding(): Promise<void> {
    if (!this.client) return;
    for (const t of [...this.client.torrents]) t.destroy();
    this.seeding.clear();
  }

  setSeeding(enabled: boolean): void {
    this.opts.seed = enabled;
    if (!enabled) void this.stopSeeding();
  }

  destroy(): void {
    this.client?.destroy();
    this.client = null;
  }
}
