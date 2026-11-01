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
