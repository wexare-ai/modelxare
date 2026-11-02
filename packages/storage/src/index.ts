// Isomorphic source resolution: turn manifest/announcement locations into an
// ordered list of concrete retrieval attempts using the user's gateways.
import { resolveHttpUrls, type FileLocation } from '@wexare/protocol';

export type DownloadSource =
  | { kind: 'http'; transport: 'https' | 'http' | 'ipfs' | 'arweave'; url: string; location: FileLocation }
  | { kind: 'torrent'; magnet: string; path: string; location: FileLocation };

export interface GatewaySettings {
  ipfsGateways: string[];
  arweaveGateways: string[];
  /** Try torrent sources before HTTP sources. */
  preferTorrent?: boolean;
  /** Extra HTTP mirrors keyed by expected SHA-256 (public client configuration). */
  extraMirrors?: Record<string, string[]>;
}

/**
 * Candidate sources in manifest order (the publisher's preference), expanded
 * through every configured gateway. Unknown transports are skipped.
 */
export function resolveSources(locations: FileLocation[], settings: GatewaySettings, expectedSha256?: string): DownloadSource[] {
  const http: DownloadSource[] = [];
  const torrent: DownloadSource[] = [];
  const seen = new Set<string>();
  for (const loc of locations) {
    if (loc.transport === 'torrent') {
      if (!seen.has(loc.uri)) torrent.push({ kind: 'torrent', magnet: loc.uri, path: loc.path ?? '', location: loc });
      seen.add(loc.uri);
      continue;
    }
    for (const url of resolveHttpUrls(loc, { ipfs: settings.ipfsGateways, arweave: settings.arweaveGateways })) {
      if (seen.has(url)) continue;
      seen.add(url);
      http.push({ kind: 'http', transport: loc.transport as 'https', url, location: loc });
    }
  }
  for (const url of (expectedSha256 && settings.extraMirrors?.[expectedSha256]) || []) {
    if (!seen.has(url)) http.push({ kind: 'http', transport: url.startsWith('https:') ? 'https' : 'http', url, location: { transport: 'https', uri: url } });
  }
  return settings.preferTorrent ? [...torrent, ...http] : [...http, ...torrent];
}

export interface AttemptReport {
  source: string;
  transport: string;
  ok: boolean;
  bytes: number;
  error?: string;
  /** Torrent only: bytes from WebRTC peers vs HTTP web seeds. */
  peerBytes?: number;
  webSeedBytes?: number;
  ms: number;
}

export interface VerifiedDownload {
  sha256: string;
  size: number;
  attempts: AttemptReport[];
}

export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly code: 'size_mismatch' | 'hash_mismatch',
  ) {
    super(message);
  }
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
};

export * from './eviction.ts';
