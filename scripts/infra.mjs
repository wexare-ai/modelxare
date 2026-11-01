#!/usr/bin/env node
// pnpm infra:up | infra:down | infra:status
// Wraps `docker compose` for infra/docker-compose.yml, waits for readiness and
// connects the two Kubo nodes. `down` keeps all named volumes (no data loss).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const compose = ['compose', '-f', join(root, 'infra/docker-compose.yml')];
const endpoints = JSON.parse(readFileSync(join(root, 'infra/dev-endpoints.json'), 'utf8'));

/** Run docker; fall back to `sg docker` when the user's new docker group is not active in this shell yet. */
function docker(args, { capture = false } = {}) {
  const opts = { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' };
  let r = spawnSync('docker', args, opts);
  if (r.error?.code === 'ENOENT') {
    console.error('docker is not installed. See README.md (Prerequisites).');
    process.exit(1);
  }
  const denied = r.status !== 0 && /permission denied/i.test(`${r.stderr ?? ''}`);
  if (denied || (r.status !== 0 && !capture && !canTalkToDocker())) {
    const quoted = ['docker', ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    r = spawnSync('sg', ['docker', '-c', quoted], opts);
  }
  if (r.status !== 0) {
    if (capture) process.stderr.write(r.stderr ?? '');
    throw new Error(`docker ${args.join(' ')} failed (exit ${r.status})`);
  }
  return r.stdout;
}

function canTalkToDocker() {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

async function waitFor(name, probe, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await probe()) return console.log(`  ✓ ${name}`);
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`${name} did not become ready`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const httpOk = async (url, init) => (await fetch(url, { ...init, signal: AbortSignal.timeout(3000) })).ok;
const relayInfo = (ws) => httpOk(ws.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } });
const kuboId = async (api) => (await (await fetch(`${api}/api/v0/id`, { method: 'POST' })).json()).ID;

async function probes() {
  await waitFor(`relay A ${endpoints.relays[0]}`, () => relayInfo(endpoints.relays[0]));
  await waitFor(`relay B ${endpoints.relays[1]}`, () => relayInfo(endpoints.relays[1]));
  await waitFor(`kubo A api ${endpoints.kubo.a.api}`, () => httpOk(`${endpoints.kubo.a.api}/api/v0/id`, { method: 'POST' }));
  await waitFor(`kubo B api ${endpoints.kubo.b.api}`, () => httpOk(`${endpoints.kubo.b.api}/api/v0/id`, { method: 'POST' }));
  await waitFor(`kubo A gateway ${endpoints.kubo.a.gateway}`, async () => (await fetch(`${endpoints.kubo.a.gateway}/ipfs/bafkqaaa`)).ok);
  await waitFor(`kubo B gateway ${endpoints.kubo.b.gateway}`, async () => (await fetch(`${endpoints.kubo.b.gateway}/ipfs/bafkqaaa`)).ok);
  await waitFor(`tracker ${endpoints.tracker.ws}`, () => httpOk(endpoints.tracker.http.replace('/announce', '/stats.json')));
}

/** Connect kubo-b to kubo-a over the compose network so replicas can be fetched. */
async function connectKubo() {
  const idA = await kuboId(endpoints.kubo.a.api);
  const addr = `/dns4/kubo-a/tcp/4001/p2p/${idA}`;
  const r = await fetch(`${endpoints.kubo.b.api}/api/v0/swarm/connect?arg=${encodeURIComponent(addr)}`, { method: 'POST' });
  console.log(r.ok ? `  ✓ kubo-b connected to kubo-a (${idA.slice(0, 12)}…)` : `  ! kubo-b could not connect to kubo-a: ${await r.text()}`);
}

const cmd = process.argv[2];
try {
  if (cmd === 'up') {
    docker([...compose, 'up', '-d', '--build', '--remove-orphans']);
    console.log('Waiting for services:');
    await probes();
    await connectKubo();
    console.log('Infra is up. Next: pnpm demo:prepare (first time), then pnpm dev.');
  } else if (cmd === 'down') {
    docker([...compose, 'down']);
    console.log('Services stopped. Data volumes were kept (pnpm demo:reset --force deletes them).');
  } else if (cmd === 'status') {
    docker([...compose, 'ps']);
    await probes();
  } else if (cmd === 'stop' || cmd === 'start') {
    const services = process.argv.slice(3);
    docker([...compose, cmd, ...services]);
  } else if (cmd === 'remove-volumes') {
    docker([...compose, 'down', '--volumes']);
  } else {
    console.error('usage: node scripts/infra.mjs up|down|status|stop <svc...>|start <svc...>');
    process.exit(2);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
