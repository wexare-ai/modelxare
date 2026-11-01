// Shared locations for acceptance tests. Everything a test writes goes under
// .data/e2e/<run>/ (never committed) or tests/results/ (evidence, ignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const DATA = process.env.WEXARE_DATA ?? join(ROOT, '.data');

export interface Endpoints {
  relays: [string, string];
  kubo: { a: { api: string; gateway: string }; b: { api: string; gateway: string } };
  tracker: { ws: string; http: string };
  artifacts: string;
  indexer: { status: string };
  indexer2: { status: string };
}
export const endpoints: Endpoints = JSON.parse(readFileSync(join(ROOT, 'infra/dev-endpoints.json'), 'utf8'));
export const [RELAY_A, RELAY_B] = endpoints.relays;

/** The built app served by `vite preview` (service worker enabled). */
export const WEB = process.env.WEXARE_WEB_URL ?? 'http://localhost:4173';

/** One directory per test run, shared by global setup and every worker. */
export function runDir(): string {
  const id = (process.env.WEXARE_E2E_RUN ??= `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const dir = join(DATA, 'e2e', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface DemoState {
  keys: Record<string, string>;
  releases: Record<string, { event_id: string; manifest_sha256?: string; files?: { sha256: string; size: number; path: string; cid?: string }[] } & Record<string, unknown>>;
}

export function demoState(): DemoState {
  const path = join(DATA, 'demo-state.json');
  if (!existsSync(path)) throw new Error('Missing .data/demo-state.json. Run `pnpm infra:up && pnpm demo:prepare` first.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const RESULTS = join(ROOT, 'tests/results');

/** Append machine-readable evidence for an acceptance criterion. */
export function evidence(id: string, data: Record<string, unknown>): void {
  mkdirSync(RESULTS, { recursive: true });
  const path = join(RESULTS, `${id}.json`);
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(path, JSON.stringify({ ...prev, ...data, recorded_at: new Date().toISOString(), run: process.env.WEXARE_E2E_RUN }, null, 2) + '\n');
}
