// Real processes for acceptance tests: the publisher/builder CLI, indexers,
// and docker services. Nothing here is mocked.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.ts';

const TSX = join(ROOT, 'node_modules/.bin/tsx');

export interface ProcResult {
  code: number;
  out: string;
}

function exec(cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} timed out\n${out}`));
    }, opts.timeoutMs ?? 300_000);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** Run the weXare CLI (apps/cli). Throws on a non-zero exit unless allowFail. */
export async function cli(args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<ProcResult> {
  const r = await exec(TSX, ['--disable-warning=ExperimentalWarning', join(ROOT, 'apps/cli/src/main.ts'), ...args], opts);
  if (r.code !== 0 && !opts.allowFail) throw new Error(`cli ${args.join(' ')} exited ${r.code}:\n${r.out}`);
  return r;
}

/** Control docker services through scripts/infra.mjs (stop/start keep data). */
export async function infra(action: 'stop' | 'start' | 'status', ...services: string[]): Promise<ProcResult> {
  const r = await exec('node', [join(ROOT, 'scripts/infra.mjs'), action, ...services], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`infra ${action} ${services.join(' ')} exited ${r.code}:\n${r.out}`);
  return r;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export interface RelayRow {
  url: string;
  status: string;
  possiblyIncomplete: boolean;
  incompleteReasons: string[];
  lastEoseAt: number | null;
  eventsReceived: number;
  acceptedNew: number;
  duplicates: number;
}

export interface IndexerStatus {
  operator: string;
  relays: RelayRow[];
  totals: { releases: number; events: number; sources: number; synthetic: number; rejectedByCode: Record<string, number> };
  coverage: { relays: { url: string; state: string; events: number; notes?: string }[] };
}

export class Indexer {
  private proc: ChildProcess | null = null;
  readonly statusUrl: string;
  readonly db: string;

  constructor(
    readonly name: string,
    readonly dataDir: string,
    readonly port: number,
    readonly relays: string[],
  ) {
    this.statusUrl = `http://127.0.0.1:${port}`;
    this.db = join(dataDir, 'indexer.sqlite');
  }

  /** Start the real indexer process (apps/indexer) and wait for its status endpoint. */
  async start(): Promise<this> {
    mkdirSync(this.dataDir, { recursive: true });
    const log = createWriteStream(join(this.dataDir, 'indexer.log'), { flags: 'a' });
    const args = ['--disable-warning=ExperimentalWarning', join(ROOT, 'apps/indexer/src/main.ts'), 'run', '--data', this.dataDir, '--name', this.name, '--port', String(this.port)];
    for (const r of this.relays) args.push('--relay', r);
    const p = spawn(TSX, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.pipe(log);
    p.stderr!.pipe(log);
    this.proc = p;
    await waitFor(`indexer ${this.name} health`, () => getJson(`${this.statusUrl}/health`).then((b) => b.ok), 30_000);
    return this;
  }

  status(): Promise<IndexerStatus> {
    return getJson<IndexerStatus>(`${this.statusUrl}/status`);
  }

  /** Every configured relay finished its catch-up: live, or degraded and explicitly marked possibly incomplete. */
  async waitCaughtUp(timeoutMs = 90_000): Promise<IndexerStatus> {
    return waitFor(
      `indexer ${this.name} catch-up`,
      async () => {
        const s = await this.status();
        const rows = this.relays.map((u) => s.relays.find((r) => r.url === u));
        return rows.every((r) => r && (r.status === 'live' || (r.status === 'degraded' && r.possiblyIncomplete))) ? s : null;
      },
      timeoutMs,
      1000,
    );
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 5000);
    });
    this.proc = null;
  }
}

/** Wait until the artifacts seeder reports the torrent as ready and complete. */
export async function waitSeeding(artifacts: string, infoHash: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(
    `seeder ready for ${infoHash}`,
    async () => {
      const s = await getJson<{ seeding: { infoHash: string; ready: boolean; complete: boolean }[] | string }>(`${artifacts}/status`);
      return Array.isArray(s.seeding) && s.seeding.some((t) => t.infoHash === infoHash && t.ready && t.complete);
    },
    timeoutMs,
    1000,
  );
}
