/// <reference path="./modules.d.ts" />
import createTorrent from 'create-torrent';
import parseTorrent, { toMagnetURI } from 'parse-torrent';

export interface TorrentInfo {
  torrent: Uint8Array;
  infoHash: string;
  magnet: string;
  /** Exact file path inside the torrent. */
  path: string;
}

export interface TorrentOptions {
  /** Name of the single file inside the torrent. */
  name: string;
  /** WebSocket trackers (browser-compatible signaling). */
  trackers: string[];
  /** HTTP web seeds (BEP 19); browsers may fall back to them. */
  webSeeds?: string[];
  /** URL of the .torrent file itself (magnet `xs`), so metadata survives without peers. */
  torrentUrl?: string;
}

/**
 * Create a single-file torrent. The info hash depends only on the file bytes,
 * name and piece length, so it is reproducible across operators.
 */
export async function createSingleFileTorrent(input: string | Uint8Array, opts: TorrentOptions): Promise<TorrentInfo> {
  const torrent = await new Promise<Uint8Array>((resolve, reject) => {
    const src = typeof input === 'string' ? input : Object.assign(Buffer.from(input), { name: opts.name });
    createTorrent(
      src as never,
      {
        name: opts.name,
        announceList: opts.trackers.map((t) => [t]),
        // Web seeds live only in the magnet (ws=), so clients can try WebRTC peers
        // first and add HTTP seeds as an explicit fallback. The info hash is unaffected.
        urlList: [],
        createdBy: 'modelxare/0.1',
        creationDate: new Date(0),
        private: false,
        comment: undefined,
      } as never,
      (err: Error | null, t: Uint8Array) => (err ? reject(err) : resolve(t)),
    );
  });
  const parsed = await parseTorrent(torrent);
  const files = (parsed as { files?: { path: string }[] }).files ?? [];
  if (files.length !== 1) throw new Error('expected a single-file torrent');
  let magnet = toMagnetURI({ infoHash: parsed.infoHash, name: opts.name, announce: opts.trackers, urlList: opts.webSeeds ?? [] } as never);
  if (opts.torrentUrl) magnet += `&xs=${encodeURIComponent(opts.torrentUrl)}`;
  return { torrent, infoHash: parsed.infoHash as string, magnet, path: opts.name };
}
