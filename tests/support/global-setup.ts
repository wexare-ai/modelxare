// Fail fast with instructions when services or demo data are missing, then make
// sure the relays hold the fixture releases (republishing is idempotent).
import { endpoints, demoState, runDir } from './env.ts';
import { cli } from './procs.ts';

async function reachable(name: string, probe: () => Promise<boolean>): Promise<string | null> {
  try {
    return (await probe()) ? null : name;
  } catch {
    return name;
  }
}

const ok = async (url: string, init?: RequestInit) => (await fetch(url, { ...init, signal: AbortSignal.timeout(3000) })).ok;

export default async function globalSetup(): Promise<void> {
  const missing = (
    await Promise.all([
      reachable(`relay A ${endpoints.relays[0]}`, () => ok(endpoints.relays[0].replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } })),
      reachable(`relay B ${endpoints.relays[1]}`, () => ok(endpoints.relays[1].replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } })),
      reachable(`Kubo A ${endpoints.kubo.a.api}`, () => ok(`${endpoints.kubo.a.api}/api/v0/id`, { method: 'POST' })),
      reachable(`Kubo B ${endpoints.kubo.b.api}`, () => ok(`${endpoints.kubo.b.api}/api/v0/id`, { method: 'POST' })),
      reachable(`tracker ${endpoints.tracker.ws}`, () => ok(endpoints.tracker.http.replace('/announce', '/stats.json'))),
    ])
  ).filter(Boolean);
  if (missing.length) throw new Error(`Services not reachable: ${missing.join(', ')}.\nStart them with: pnpm infra:up`);
  demoState();
  const dir = runDir();
  console.log(`acceptance run data: ${dir}`);
  const r = await cli(['demo', 'publish', '--no-retry']);
  if (!/✓/.test(r.out)) throw new Error(`demo publish did not reach any relay:\n${r.out}`);
}
