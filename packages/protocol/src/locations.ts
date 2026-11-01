import type { FileLocation, KnownTransport } from './types.ts';

const LOOPBACK_HTTP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\//;

export const isLoopbackHttp = (uri: string) => LOOPBACK_HTTP.test(uri);

/** Infer the transport from a URI scheme; null for unsupported or non-loopback http. */
export function inferTransport(uri: string): KnownTransport | null {
  if (uri.startsWith('ipfs://')) return 'ipfs';
  if (uri.startsWith('ar://')) return 'arweave';
  if (uri.startsWith('magnet:?')) return 'torrent';
  if (uri.startsWith('https://')) return 'https';
  if (isLoopbackHttp(uri)) return 'http';
  return null;
}

export function locationFromUri(uri: string, torrentPath?: string): FileLocation | null {
  const transport = inferTransport(uri);
  if (!transport) return null;
  return transport === 'torrent' ? { transport, uri, path: torrentPath ?? '' } : { transport, uri };
}

/** ipfs://<cid>[/path] → { cid, path } */
export function parseIpfsUri(uri: string): { cid: string; path: string } | null {
  const m = /^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/.exec(uri);
  return m ? { cid: m[1]!, path: m[2] ?? '' } : null;
}

/** ar://<transaction-id>[/path] → { txid, path } */
export function parseArweaveUri(uri: string): { txid: string; path: string } | null {
  const m = /^ar:\/\/([A-Za-z0-9_-]{43})(\/.*)?$/.exec(uri);
  return m ? { txid: m[1]!, path: m[2] ?? '' } : null;
}

/** Info hash (lowercase hex) from a magnet URI, if present. */
export function magnetInfoHash(uri: string): string | null {
  const m = /xt=urn:btih:([0-9a-fA-F]{40})/.exec(uri);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Resolve a location to concrete HTTP(S) URLs through user-configured gateways.
 * Torrent locations are not HTTP-resolvable and return an empty list.
 */
export function resolveHttpUrls(loc: FileLocation, gateways: { ipfs: string[]; arweave: string[] }): string[] {
  const join = (base: string, rest: string) => base.replace(/\/+$/, '') + rest;
  switch (loc.transport) {
    case 'https':
      return [loc.uri];
    case 'http':
      return isLoopbackHttp(loc.uri) ? [loc.uri] : [];
    case 'ipfs': {
      const p = parseIpfsUri(loc.uri);
      return p ? gateways.ipfs.map((g) => join(g, `/ipfs/${p.cid}${p.path}`)) : [];
    }
    case 'arweave': {
      const p = parseArweaveUri(loc.uri);
      return p ? gateways.arweave.map((g) => join(g, `/${p.txid}${p.path}`)) : [];
    }
    default:
      return [];
  }
}
