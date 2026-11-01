// wexare-indexer: persistent, restartable Nostr collector for release announcements.
// Each operator runs with its own --data directory (database + config) and status port.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { CatalogStore, OperatorStore, migrateOperator } from '@wexare/catalog';
import { NodeSqliteDatabase } from '@wexare/catalog/node';
import { DEFAULT_COLLECTOR_OPTIONS, RelayCollector, type CollectorOptions } from './collector.ts';

interface IndexerConfig {
  name: string;
  relays: string[];
  statusPort: number;
  statusHost: string;
  collector: CollectorOptions;
}

const DEFAULT_RELAYS = ['ws://127.0.0.1:7777', 'ws://127.0.0.1:7778'];

async function loadConfig(dataDir: string, o: { name?: string; relay?: string[]; port?: string; historyDays?: string; overlap?: string; pageLimit?: string }): Promise<IndexerConfig> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'indexer.json');
  const saved = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Partial<IndexerConfig>;
  const cfg: IndexerConfig = {
    name: o.name ?? saved.name ?? 'indexer',
    relays: o.relay?.length ? o.relay : (saved.relays ?? DEFAULT_RELAYS),
    statusPort: Number(o.port ?? saved.statusPort ?? 8791),
    statusHost: saved.statusHost ?? '127.0.0.1',
    collector: {
      ...DEFAULT_COLLECTOR_OPTIONS,
      ...saved.collector,
      ...(o.historyDays ? { historyWindowSeconds: Number(o.historyDays) * 86400 } : {}),
      ...(o.overlap ? { overlapSeconds: Number(o.overlap) } : {}),
      ...(o.pageLimit ? { pageLimit: Number(o.pageLimit) } : {}),
    },
  };
  await writeFile(path, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

function openStores(dataDir: string) {
  const db = new NodeSqliteDatabase(join(dataDir, 'indexer.sqlite'));
  migrateOperator(db);
  return { db, store: new CatalogStore(db), op: new OperatorStore(db) };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const program = new Command().name('wexare-indexer').description('Persistent Nostr collector for weXare micro-model releases');
const common = (c: Command) =>
  c
    .requiredOption('--data <dir>', 'operator data directory (database + indexer.json)')
    .option('--name <name>', 'operator name')
    .option('--relay <url>', 'relay to watch (repeatable; saved to indexer.json)', collect, [])
    .option('--history-days <n>', 'historical window for first catch-up and rescans')
    .option('--overlap <seconds>', 'reconnect catch-up overlap')
    .option('--page-limit <n>', 'requested events per page');

common(program.command('run'))
  .option('--port <port>', 'status endpoint port (127.0.0.1)')
  .action(async (o) => {
    const dataDir = resolve(o.data);
    const cfg = await loadConfig(dataDir, o);
    const { db, store, op } = openStores(dataDir);
    const startedAt = new Date().toISOString();
    const collectors = cfg.relays.map((url) => new RelayCollector(url, store, op, cfg.collector));
    console.log(`[${cfg.name}] data ${dataDir}\n[${cfg.name}] watching ${cfg.relays.join(', ')}`);
    for (const c of collectors) void c.run();

    let rescanning = false;
    const server = createServer(async (req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body, null, 2));
      };
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/status') {
        const relays = op.list().filter((r) => cfg.relays.includes(r.url));
        return send(200, {
          operator: cfg.name,
          note: 'Operator status only. Clients search locally; there is no search API here.',
          startedAt,
          dataDir,
          relays,
          totals: { ...store.stats(), rejectedByCode: op.rejectionCounts() },
          coverage: op.coverage(cfg.relays),
          archiveBuilds: op.archiveBuilds(),
          recentLog: op.recentLog(30),
        });
      }
      if (req.method === 'POST' && url.pathname === '/rescan') {
        if (rescanning) return send(409, { error: 'rescan already running' });
        rescanning = true;
        send(202, { started: true });
        for (const c of collectors) {
          await c.rescan().then(
            (r) => console.log(`[${c.url}] rescan: ${r.complete ? 'complete' : 'POSSIBLY INCOMPLETE'} (${r.received} events, ${r.pages} pages)`),
            (e) => console.log(`[${c.url}] rescan failed: ${(e as Error).message}`),
          );
        }
        rescanning = false;
        return;
      }
      send(404, { error: 'not found' });
    });
    server.listen(cfg.statusPort, cfg.statusHost, () => console.log(`[${cfg.name}] status http://${cfg.statusHost}:${cfg.statusPort}/status`));

    const shutdown = () => {
      console.log(`[${cfg.name}] stopping`);
      for (const c of collectors) c.stop();
      server.close();
      setTimeout(() => {
        db.close();
        process.exit(0);
      }, 300);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

common(program.command('rescan').description('One-shot rescan of the historical window on every configured relay')).action(async (o) => {
  const dataDir = resolve(o.data);
  const cfg = await loadConfig(dataDir, o);
  const { db, store, op } = openStores(dataDir);
  for (const url of cfg.relays) {
    const c = new RelayCollector(url, store, op, cfg.collector);
    try {
      const r = await c.rescan();
      console.log(`${url}: ${r.complete ? 'complete' : 'POSSIBLY INCOMPLETE'} — ${r.received} events in ${r.pages} pages${r.gaps.length ? `; gaps at ${r.gaps.join(', ')}` : ''}`);
    } catch (e) {
      console.log(`${url}: failed (${(e as Error).message})`);
    }
  }
  console.log(JSON.stringify(store.stats()));
  db.close();
});

program
  .command('status')
  .requiredOption('--data <dir>')
  .action(async (o) => {
    const { db, store, op } = openStores(resolve(o.data));
    console.log(JSON.stringify({ relays: op.list(), totals: store.stats(), rejected: op.rejectionCounts() }, null, 2));
    db.close();
  });

await program.parseAsync();
