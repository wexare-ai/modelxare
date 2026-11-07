import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Locate the repository root (the directory holding pnpm-workspace.yaml). */
export function repoRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

export const ROOT = process.env.WEXARE_REPO ?? repoRoot(dirname(new URL(import.meta.url).pathname));
export const DATA = process.env.WEXARE_DATA ?? join(ROOT, '.data');

export interface Endpoints {
  relays: string[];
  kubo: { a: { api: string; gateway: string }; b: { api: string; gateway: string } };
  tracker: { ws: string; http: string };
  artifacts: string;
  indexer: { status: string };
  indexer2: { status: string };
  web: string;
  arweaveGateways: string[];
}

export const endpoints: Endpoints = JSON.parse(readFileSync(join(ROOT, 'infra/dev-endpoints.json'), 'utf8'));

export const paths = {
  keys: join(DATA, 'keys'),
  key: (name: string) => join(DATA, 'keys', `${name}.key.json`),
  fixtureModels: join(DATA, 'fixtures/models'),
  artifacts: join(DATA, 'artifacts'),
  artifactRoot: (name: string) => join(DATA, 'artifacts', name),
  releases: join(DATA, 'releases'),
  release: (name: string) => join(DATA, 'releases', name),
  operator: (name: string) => join(DATA, 'operators', name),
  synthetic: join(DATA, 'synthetic'),
  exports: join(DATA, 'exports'),
};

const list = (v: string | undefined) => (v ?? '').split(/[\s,]+/).filter(Boolean);

/**
 * Defaults for `release prepare` and `release publish`. Once any WEXARE_*
 * publishing variable is set (see infra/deploy/publisher.env.example), every
 * default comes from them, never from the local development services, so a
 * public release can't point at this machine by accident.
 */
export function publishDefaults(env: Record<string, string | undefined> = process.env) {
  const vars = ['WEXARE_RELAYS', 'WEXARE_MIRROR_URL', 'WEXARE_MIRROR_ROOT', 'WEXARE_IPFS_API', 'WEXARE_TRACKERS'];
  if (!vars.some((v) => env[v]?.trim()))
    return { relays: endpoints.relays, mirrorUrl: endpoints.artifacts, mirrorRoot: paths.artifactRoot('main'), ipfsApi: endpoints.kubo.a.api, trackers: [endpoints.tracker.ws] };
  return {
    relays: list(env.WEXARE_RELAYS),
    mirrorUrl: env.WEXARE_MIRROR_URL?.trim() || undefined,
    // Kept apart from the development mirror, so only this deployment's files get uploaded.
    mirrorRoot: env.WEXARE_MIRROR_ROOT?.trim() || join(DATA, 'deploy-mirror'),
    // The server's node through an SSH tunnel (never a public port). No default: on this
    // machine 5001 may be the development node, which must not get a deployment's pins.
    ipfsApi: env.WEXARE_IPFS_API?.trim() || undefined,
    trackers: list(env.WEXARE_TRACKERS),
  };
}
