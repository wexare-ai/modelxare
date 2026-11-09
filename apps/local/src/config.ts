// Where the local runtime keeps its files, which relays it reads releases
// from, and whose releases it runs. The same WEXARE_* settings as a deployed
// app (infra/deploy/app.env.example), read when the command starts:
//
//   WEXARE_RELAYS             relay URLs, comma-separated (wss://, or ws:// on this machine)
//   WEXARE_IPFS_GATEWAYS      https:// gateways, for ipfs:// file locations
//   WEXARE_ARWEAVE_GATEWAYS   https:// gateways, for ar:// file locations
//   WEXARE_PUBLISHERS         approved publishers file (default infra/publishers.json)
//
// None set: the local development services (infra/dev-endpoints.json), and
// every validly signed release, as in the apps. Settings of the local runtime
// itself (data folder, address, API key) are WEXARE_LOCAL_*, read in main.ts.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** What an approved publisher may provide. */
export type PublisherRole = 'models' | 'router';

/** One vouch for a publisher key (same shape as the apps' infra/publishers.json entries). */
export interface PublisherApproval {
  pubkey: string;
  label: string;
  approvedBy: string;
  roles: PublisherRole[];
}

export interface LocalConfig {
  relays: string[];
  ipfsGateways: string[];
  arweaveGateways: string[];
  /** "any": every validly signed release (local development). A list: only these publishers. */
  publishers: 'any' | PublisherApproval[];
  /** 'dev': no WEXARE_* settings, so the local development services. */
  source: 'dev' | 'env';
}

/** The repository root, for infra/ files. */
export const ROOT = join(import.meta.dirname, '../../..');

const VARS = ['WEXARE_RELAYS', 'WEXARE_IPFS_GATEWAYS', 'WEXARE_ARWEAVE_GATEWAYS', 'WEXARE_PUBLISHERS'];

const list = (v: string | undefined) => (v ?? '').split(/[\s,]+/).filter(Boolean);

const LOOPBACK_WS = /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/|$)/;

export function loadConfig(env: Record<string, string | undefined> = process.env): LocalConfig {
  if (!VARS.some((v) => env[v]?.trim())) {
    const dev = JSON.parse(readFileSync(join(ROOT, 'infra/dev-endpoints.json'), 'utf8'));
    return { relays: dev.relays, ipfsGateways: [dev.kubo.a.gateway, dev.kubo.b.gateway], arweaveGateways: dev.arweaveGateways, publishers: 'any', source: 'dev' };
  }
  const file = env.WEXARE_PUBLISHERS?.trim() || 'infra/publishers.json';
  let publishers: unknown;
  try {
    publishers = JSON.parse(readFileSync(isAbsolute(file) ? file : join(ROOT, file), 'utf8')).publishers;
  } catch (e) {
    throw new Error(`WEXARE_PUBLISHERS: can't read ${file}: ${(e as Error).message}`);
  }
  const config: LocalConfig = {
    relays: list(env.WEXARE_RELAYS),
    ipfsGateways: list(env.WEXARE_IPFS_GATEWAYS),
    arweaveGateways: list(env.WEXARE_ARWEAVE_GATEWAYS),
    publishers: publishers as PublisherApproval[],
    source: 'env',
  };
  const problems = checkConfig(config, file);
  if (problems.length) throw new Error(`These WEXARE_* settings can't be used:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return config;
}

export function checkConfig(c: LocalConfig, publishersFile = 'publishers'): string[] {
  const problems: string[] = [];
  if (!c.relays.length) problems.push('WEXARE_RELAYS: required');
  for (const u of c.relays) if (!u.startsWith('wss://') && !LOOPBACK_WS.test(u)) problems.push(`WEXARE_RELAYS: ${JSON.stringify(u)} isn't a wss:// URL (ws:// only on this machine)`);
  for (const [name, values] of [['WEXARE_IPFS_GATEWAYS', c.ipfsGateways], ['WEXARE_ARWEAVE_GATEWAYS', c.arweaveGateways]] as const) {
    for (const u of values) if (!/^https:\/\/[^/\s]+/.test(u) && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/.test(u)) problems.push(`${name}: ${JSON.stringify(u)} isn't an https:// URL`);
  }
  const pubs = c.publishers;
  if (pubs === 'any') return problems;
  if (!Array.isArray(pubs) || !pubs.length) {
    problems.push(`${publishersFile}: list at least one approved publisher`);
    return problems;
  }
  for (const [i, p] of pubs.entries()) {
    const at = `${publishersFile}: publishers[${i}]`;
    if (typeof p?.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(p.pubkey)) problems.push(`${at}.pubkey: expected 64 lowercase hex characters`);
    if (typeof p?.label !== 'string' || !p.label.trim()) problems.push(`${at}.label: expected the name people see`);
    if (!Array.isArray(p?.roles) || !p.roles.length || p.roles.some((r: unknown) => r !== 'models' && r !== 'router')) problems.push(`${at}.roles: expected "models" and/or "router"`);
  }
  return problems;
}

/** The data folder: WEXARE_LOCAL_HOME, else the platform's usual place for app data. */
export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  if (env.WEXARE_LOCAL_HOME?.trim()) return env.WEXARE_LOCAL_HOME.trim();
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'modelxare');
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'modelxare');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'modelxare');
}

/** Load KEY=value lines into process.env (values already set win), like `node --env-file`. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) throw new Error(`env file ${path} not found`);
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

/** Whose releases are listed and run (the apps' Trust, for one machine). */
export class Trust {
  private readonly approvals = new Map<string, PublisherApproval>();

  constructor(readonly policy: LocalConfig['publishers']) {
    if (policy !== 'any') for (const a of policy) this.approvals.set(a.pubkey, a);
  }

  get open(): boolean {
    return this.policy === 'any';
  }

  allows(pubkey: string, role: PublisherRole): boolean {
    return this.open || !!this.approvals.get(pubkey)?.roles.includes(role);
  }

  /** "weXare", or the start of the key when the publisher has no approval. */
  label(pubkey: string): string {
    return this.approvals.get(pubkey)?.label ?? `${pubkey.slice(0, 8)}…`;
  }

  /** Keys to ask relays for; none (all) when open. */
  authors(): string[] | undefined {
    return this.open ? undefined : [...this.approvals.keys()];
  }
}
