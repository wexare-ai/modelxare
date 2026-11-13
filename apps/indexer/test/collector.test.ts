import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { CatalogStore, OperatorStore, migrateOperator } from '@wexare/catalog';
import { openNodeDatabase } from '@wexare/catalog/node';
import { buildReleaseEventTemplate, serializeManifest, sha256Hex, type NostrEvent, type ReleaseManifest } from '@wexare/protocol';
import { DEFAULT_COLLECTOR_OPTIONS, RelayCollector } from '../src/collector.ts';

const sk = generateSecretKey();
function release(i: number, createdAt: number): NostrEvent {
  const m: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.2',
    model_id: `m-${i}`,
    name: `Model ${i}`,
    description: 'collector test',
    version: '1.0.0',
    kind: 'model',
    capabilities: ['summarization'],
    languages: ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: 'wllama', requirement: '*', browser_features: [] },
    files: [{ role: 'weights', path: 'm.gguf', size: 1, sha256: sha256Hex(`f${i}`), locations: [] }],
    operations: [
      { id: 'summarization', title: 'Summarize', category: 'messages', when: 'shorten the text into a brief summary', prompt: { mode: 'chat', template: '{{text}}' }, output: { type: 'text', max_chars: 400 } },
    ],
    requirements: { context_length: 512 },
  };
  return finalizeEvent(buildReleaseEventTemplate({ manifestJson: serializeManifest(m), createdAt }), sk) as unknown as NostrEvent;
}

/** A relay that returns newest-first and silently caps every response at `cap`. */
function mockRelay(events: unknown[], cap: number) {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    subscribe(filters: { since?: number; until?: number; limit?: number }[], p: { onevent: (e: unknown) => void; oneose: () => void }) {
      requests++;
      const f = filters[0]!;
      const matching = (events as NostrEvent[])
        .filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, Math.min(f.limit ?? Infinity, cap));
      queueMicrotask(() => {
        for (const e of matching) p.onevent(e);
        p.oneose();
      });
      return { close() {} };
    },
  };
}

function setup() {
  const db = openNodeDatabase();
  migrateOperator(db);
  const store = new CatalogStore(db);
  const op = new OperatorStore(db);
  return { store, op };
}
const collector = (url: string, s: ReturnType<typeof setup>) => new RelayCollector(url, s.store, s.op, { ...DEFAULT_COLLECTOR_OPTIONS, pageLimit: 500 }, () => {});

describe('bounded collection (A17)', () => {
  const t0 = Math.floor(Date.now() / 1000) - 10_000;

  it('detects a silent relay cap and still recovers every record', async () => {
    const events = Array.from({ length: 120 }, (_, i) => release(i, t0 + i));
    const s = setup();
    const c = collector('ws://capped', s);
    const r = await c.catchUp(mockRelay(events, 50) as never, 0);
    expect(r.complete).toBe(true);
    expect(s.store.stats().releases).toBe(120);
    expect(s.op.recentLog().some((l) => l.code === 'relay_cap_detected')).toBe(true);
  });

  it('reports tied timestamps beyond the cap as possibly incomplete instead of skipping', async () => {
    const tied = Array.from({ length: 60 }, (_, i) => release(1000 + i, t0 + 500));
    const older = Array.from({ length: 10 }, (_, i) => release(2000 + i, t0 + i));
    const s = setup();
    const c = collector('ws://tied', s);
    const r = await c.catchUp(mockRelay([...tied, ...older], 50) as never, 0);
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual([t0 + 500]);
    expect(s.op.get('ws://tied')!.possiblyIncomplete).toBe(true);
    expect(s.op.get('ws://tied')!.incompleteReasons.join(' ')).toMatch(/created_at=/);
    // Records older than the saturated timestamp are still collected.
    expect(s.store.stats().releases).toBe(50 + 10);
  });

  it('completes when the relay limit covers the tie', async () => {
    const tied = Array.from({ length: 60 }, (_, i) => release(3000 + i, t0 + 700));
    const s = setup();
    const r = await collector('ws://big', s).catchUp(mockRelay(tied, 500) as never, 0);
    expect(r.complete).toBe(true);
    expect(s.store.stats().releases).toBe(60);
  });

  it('deduplicates the same event seen on two relays and keeps both observations (A04)', async () => {
    const events = Array.from({ length: 5 }, (_, i) => release(4000 + i, t0 + i));
    const s = setup();
    await collector('ws://a', s).catchUp(mockRelay(events, 500) as never, 0);
    await collector('ws://b', s).catchUp(mockRelay(events, 500) as never, 0);
    expect(s.store.stats().releases).toBe(5);
    expect(s.store.getRelease(events[0]!.id)!.sources.map((x) => x.id).sort()).toEqual(['relay:ws://a', 'relay:ws://b']);
    expect(s.op.get('ws://b')!.acceptedNew).toBe(0);
    expect(s.op.get('ws://b')!.duplicates).toBeGreaterThanOrEqual(5); // overlap re-fetches count as duplicate receipts
  });

  it('counts invalid, unknown-profile and catalog events without storing them', () => {
    const s = setup();
    const c = collector('ws://x', s);
    const good = release(5000, t0);
    expect(c.handle({ ...good, sig: good.sig.replace(/^./, good.sig[0] === 'a' ? 'b' : 'a') })).toBe('rejected');
    expect(c.handle({ ...good, tags: [['t', 'other']] })).toBe('unknown_profile');
    expect(c.handle({ ...good, tags: [['t', 'wexare-micromodel-catalog']] })).toBe('catalog_ignored');
    expect(c.handle(good)).toBe('accepted_new');
    expect(s.store.stats().releases).toBe(1);
    expect(s.op.rejectionCounts()).toEqual({ bad_signature: 1 });
  });
});
