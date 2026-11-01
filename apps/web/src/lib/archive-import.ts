// Resolve a signed archive announcement to the exact ZIP bytes through any of
// its locations (torrent first when preferred, then IPFS/HTTP/Arweave gateways).
import { fetchVerifiedBytes, type TorrentDownloader } from '@wexare/storage/browser';
import { resolveSources, type AttemptReport } from '@wexare/storage';
import { verifyCatalogAnnouncement, type NostrEvent, type VerifiedCatalogAnnouncement } from '@wexare/protocol';
import type { Settings } from './settings.ts';

export function parseAnnouncement(input: unknown): { ok: true; value: VerifiedCatalogAnnouncement } | { ok: false; error: string } {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
  }
  const ev = (obj as { event?: NostrEvent })?.event ?? obj;
  const r = verifyCatalogAnnouncement(ev);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.errors.map((e) => `${e.code}: ${e.message}`).join('; ') };
}

export async function fetchArchive(
  ann: VerifiedCatalogAnnouncement,
  settings: Settings,
  torrent: TorrentDownloader | undefined,
  onProgress?: (p: { bytes: number; total: number; peerBytes?: number; webSeedBytes?: number; source: string }) => void,
): Promise<{ bytes: Uint8Array; attempts: AttemptReport[] }> {
  const locations = [...ann.locations];
  if (ann.magnet) {
    const dn = new URL(ann.magnet).searchParams.get('dn') ?? '';
    locations.push({ transport: 'torrent', uri: ann.magnet, path: dn });
  }
  const sources = resolveSources(locations, {
    ipfsGateways: settings.ipfsGateways,
    arweaveGateways: settings.arweaveGateways,
    extraMirrors: settings.extraMirrors,
    preferTorrent: settings.torrent.enabled && settings.torrent.preferForArchives,
  }, ann.zipSha256).filter((s) => s.kind === 'http' || settings.torrent.enabled);
  return fetchVerifiedBytes(sources, { sha256: ann.zipSha256, size: ann.zipSize }, {
    ...(torrent ? { torrent } : {}),
    onProgress: (p) => onProgress?.({ bytes: p.bytes, total: p.total, ...(p.peerBytes !== undefined ? { peerBytes: p.peerBytes } : {}), ...(p.webSeedBytes !== undefined ? { webSeedBytes: p.webSeedBytes } : {}), source: p.source.kind === 'http' ? p.source.url : 'torrent' }),
  });
}
