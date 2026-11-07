// Public client configuration. Never contains private keys; export/import is plain JSON.
import type { NostrEvent } from '@wexare/protocol';
import { CLIENT_CONFIG } from './client-config.ts';

export interface TrustedCatalog {
  builderPubkey: string;
  label: string;
  /** Last imported announcement (public, signed). */
  announcement?: NostrEvent;
}

export interface Settings {
  version: 1;
  relays: string[];
  ipfsGateways: string[];
  arweaveGateways: string[];
  /** Extra HTTP mirrors keyed by expected SHA-256. */
  extraMirrors: Record<string, string[]>;
  catalogs: TrustedCatalog[];
  preferredPublishers: string[];
  torrent: { enabled: boolean; trackers: string[]; webSeedDelayMs: number; seed: boolean; preferForArchives: boolean };
  /** Off = no relay connections and no downloads (offline demonstration). */
  networkSync: boolean;
  operatorStatusUrls: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  relays: CLIENT_CONFIG.relays,
  ipfsGateways: CLIENT_CONFIG.ipfsGateways,
  arweaveGateways: CLIENT_CONFIG.arweaveGateways,
  extraMirrors: {},
  catalogs: [],
  preferredPublishers: [],
  torrent: { enabled: CLIENT_CONFIG.trackers.length > 0, trackers: CLIENT_CONFIG.trackers, webSeedDelayMs: 4000, seed: false, preferForArchives: true },
  networkSync: true,
  operatorStatusUrls: CLIENT_CONFIG.operatorStatusUrls,
};

const KEY = 'wexare.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch {
    // ignore: fall back to defaults
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: settings stay in memory for this session
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 2048) : []);

/** Accept only known public fields from imported JSON. */
export function sanitize(input: unknown): Settings {
  const o = (input ?? {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  return {
    version: 1,
    relays: o.relays ? strings(o.relays).filter((u) => /^wss?:\/\//.test(u)) : d.relays,
    ipfsGateways: o.ipfsGateways ? strings(o.ipfsGateways).filter((u) => /^https?:\/\//.test(u)) : d.ipfsGateways,
    arweaveGateways: o.arweaveGateways ? strings(o.arweaveGateways).filter((u) => /^https?:\/\//.test(u)) : d.arweaveGateways,
    extraMirrors: Object.fromEntries(
      Object.entries(o.extraMirrors ?? {})
        .filter(([k]) => /^[0-9a-f]{64}$/.test(k))
        .map(([k, v]) => [k, strings(v).filter((u) => /^https?:\/\//.test(u))]),
    ),
    catalogs: Array.isArray(o.catalogs)
      ? o.catalogs.filter((c) => /^[0-9a-f]{64}$/.test(c?.builderPubkey ?? '')).map((c) => ({ builderPubkey: c.builderPubkey, label: String(c.label ?? '').slice(0, 120), ...(c.announcement ? { announcement: c.announcement } : {}) }))
      : d.catalogs,
    preferredPublishers: strings(o.preferredPublishers).filter((k) => /^[0-9a-f]{64}$/.test(k)),
    torrent: {
      enabled: o.torrent?.enabled ?? d.torrent.enabled,
      trackers: o.torrent?.trackers ? strings(o.torrent.trackers).filter((u) => /^wss?:\/\//.test(u)) : d.torrent.trackers,
      webSeedDelayMs: Number.isFinite(o.torrent?.webSeedDelayMs) ? Number(o.torrent!.webSeedDelayMs) : d.torrent.webSeedDelayMs,
      seed: o.torrent?.seed ?? d.torrent.seed,
      preferForArchives: o.torrent?.preferForArchives ?? d.torrent.preferForArchives,
    },
    networkSync: o.networkSync ?? d.networkSync,
    operatorStatusUrls: o.operatorStatusUrls ? strings(o.operatorStatusUrls).filter((u) => /^https?:\/\//.test(u)) : d.operatorStatusUrls,
  };
}

export function exportSettings(s: Settings): string {
  return JSON.stringify({ ...s, exported_at: new Date().toISOString(), note: 'Public weXare client configuration. Contains no private keys.' }, null, 2);
}
