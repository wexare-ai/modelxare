import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildCatalogAnnouncementTemplate, buildReleaseEventTemplate, sha256Hex, verifyReleaseEvent, type NostrEvent, type VerifiedRelease } from '@wexare/protocol';
import { CatalogStore, buildArchive, readArchive, releasesJsonl, sourceIdFor, toFtsQuery, type CatalogQuery } from '../src/index.ts';
import { openNodeDatabase } from '../src/node-sqlite.ts';

const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/golden-queries.json'), 'utf8'));
const verified = (e: unknown): VerifiedRelease => {
  const r = verifyReleaseEvent(e);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const releases: VerifiedRelease[] = golden.events.map(verified);
const L = golden.labels as Record<string, string>;

function freshStore() {
  const store = new CatalogStore(openNodeDatabase());
  store.migrate();
  return store;
}
function seeded() {
  const store = freshStore();
  store.upsertSource({ id: sourceIdFor.relay('ws://a'), type: 'relay', label: 'relay A', url: 'ws://a' });
  for (const r of releases) store.addVerifiedRelease(r, sourceIdFor.relay('ws://a'));
  return store;
}

describe('golden queries (node:sqlite)', () => {
  const store = seeded();
  type Golden = { name: string; query: CatalogQuery; expect: string[]; ordered?: boolean };
  it.each(golden.queries as Golden[])('$name', (q) => {
    const ids = store.query(q.query).items.map((i) => i.eventId);
    if (q.ordered) expect(ids).toEqual(q.expect);
    else expect([...ids].sort()).toEqual([...q.expect].sort());
  });

  it('reports totals independent of pagination', () => {
    const page = store.query({ capabilities: ['summarization'], limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(4);
  });

  it('builds safe FTS expressions', () => {
    expect(toFtsQuery('water "leak" OR NOT')).toBe('"water"* "leak"* "OR"* "NOT"*');
    expect(toFtsQuery('  ¡¿ ')).toBeNull();
  });
});

describe('store', () => {
  it('deduplicates by event ID and keeps per-source provenance (A04)', () => {
    const store = freshStore();
    store.upsertSource({ id: 'relay:ws://a', type: 'relay', label: 'A', url: 'ws://a' });
    store.upsertSource({ id: 'relay:ws://b', type: 'relay', label: 'B', url: 'ws://b' });
    const r = releases[0]!;
    expect(store.addVerifiedRelease(r, 'relay:ws://a')).toBe(true);
    expect(store.addVerifiedRelease(r, 'relay:ws://b')).toBe(false);
    expect(store.addVerifiedRelease(r, 'relay:ws://b')).toBe(false);
    expect(store.stats().releases).toBe(1);
    expect(store.getRelease(r.event.id)!.sources.map((s) => s.id)).toEqual(['relay:ws://a', 'relay:ws://b']);
  });

  it('disabling and removing sources recomputes membership without deleting shared records', () => {
    const store = freshStore();
    store.upsertSource({ id: 'relay:ws://a', type: 'relay', label: 'A' });
    store.upsertSource({ id: 'catalog:x', type: 'catalog', label: 'X' });
    store.addVerifiedRelease(releases[0]!, 'relay:ws://a');
    store.addVerifiedRelease(releases[0]!, 'catalog:x');
    store.addVerifiedRelease(releases[1]!, 'catalog:x');
    expect(store.query({ sourceTypes: ['relay'] }).total).toBe(1);
    expect(store.query({ sourceTypes: ['catalog'] }).total).toBe(2);
    store.setSourceEnabled('catalog:x', false);
    expect(store.query({}).total).toBe(1);
    store.setSourceEnabled('catalog:x', true);
    expect(store.removeSource('catalog:x')).toBe(1);
    expect(store.eventIds()).toEqual([releases[0]!.event.id]);
  });

  it('tracks cached status by content hash', () => {
    const store = seeded();
    const smol = store.getRelease(L['smol-like']!)!;
    store.markCached(smol.manifest.files[0]!.sha256, smol.manifest.files[0]!.size, 'opfs');
    expect(store.query({ cached: true }).items.map((i) => i.eventId)).toEqual([L['smol-like']]);
    store.unmarkCached(smol.manifest.files[0]!.sha256);
    expect(store.query({ cached: true }).total).toBe(0);
  });

  it('reports same-label conflicts instead of overwriting', () => {
    const store = seeded();
    const sk = generateSecretKey();
    const mk = (description: string) => {
      const manifestJson = JSON.stringify({ ...JSON.parse(releases[1]!.manifestJson), description });
      return verified(finalizeEvent(buildReleaseEventTemplate({ manifestJson, createdAt: 1 }), sk));
    };
    store.addVerifiedRelease(mk('one'), 'relay:ws://a');
    store.addVerifiedRelease(mk('two'), 'relay:ws://a');
    expect(store.conflicts()).toHaveLength(1);
    expect(store.stats().releases).toBe(releases.length + 2);
  });
});

describe('archives', () => {
  const sk = generateSecretKey();
  const builder = getPublicKey(sk);
  const events = golden.events as NostrEvent[];
  const coverage = { statement: 'test', relays: [{ url: 'ws://127.0.0.1:7777', state: 'caught-up' as const, events: 7 }] };
  const built = buildArchive({ events: [...events].reverse(), builderPubkey: builder, buildTime: 1793491200, coverage });

  it('round-trips and recovers the exact release ID set (A05)', () => {
    const r = readArchive(built.zip, { expectedSha256: built.sha256, expectedSize: built.size, expectedBuilder: builder });
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (!r.ok) return;
    expect(r.value.releases.map((x) => x.event.id)).toEqual(events.map((e) => e.id).sort());
    const store = freshStore();
    store.replaceSourceSnapshot({ id: sourceIdFor.catalog(builder), type: 'catalog', label: 'test', builderPubkey: builder }, r.value.releases);
    expect(store.eventIds()).toEqual(events.map((e) => e.id).sort());
  });

  it('is reproducible for the same snapshot', () => {
    const again = buildArchive({ events, builderPubkey: builder, buildTime: 1793491200, coverage });
    expect(again.sha256).toBe(built.sha256);
  });

  it('announcement binds the ZIP hash', () => {
    const ann = finalizeEvent(buildCatalogAnnouncementTemplate({ zipSha256: built.sha256, zipSize: built.size, urls: ['http://127.0.0.1:8790/a.zip'], content: 'x' }), sk);
    expect(ann.tags).toContainEqual(['x', built.sha256]);
  });

  const codes = (zip: Uint8Array, opts = {}) => {
    const r = readArchive(zip, opts);
    return r.ok ? [] : r.errors.map((e) => e.code);
  };
  const inv = (b: typeof built) => JSON.stringify(b.inventory);
  const jsonl = strToU8(releasesJsonl(events));

  it('rejects wrong hash, size and builder (A09)', () => {
    expect(codes(built.zip, { expectedSha256: '0'.repeat(64) })).toContain('archive_hash_mismatch');
    expect(codes(built.zip, { expectedSize: 1 })).toContain('archive_size_mismatch');
    expect(codes(built.zip, { expectedBuilder: '0'.repeat(64) })).toContain('builder_mismatch');
  });

  it('rejects path traversal and unexpected entries', () => {
    expect(codes(zipSync({ 'catalog.json': strToU8(inv(built)), 'releases.jsonl': jsonl, '../evil.sh': strToU8('x') }))).toContain('archive_path_traversal');
    expect(codes(zipSync({ 'catalog.json': strToU8(inv(built)), 'releases.jsonl': jsonl, 'extra.txt': strToU8('x') }))).toContain('archive_unexpected_entry');
  });

  it('rejects malformed and oversized archives', () => {
    expect(codes(strToU8('not a zip'))).toContain('archive_malformed');
    expect(codes(built.zip, { limits: { maxZipBytes: 10 } })).toContain('archive_too_large');
    expect(codes(built.zip, { limits: { maxUncompressedBytes: 100 } })).toContain('archive_too_large');
  });

  it('rejects altered records and inventory mismatches', () => {
    const tampered = releasesJsonl(events).replace('Community classifier', 'Community classifiex');
    expect(codes(zipSync({ 'catalog.json': strToU8(inv(built)), 'releases.jsonl': strToU8(tampered) }))).toContain('inventory_mismatch');
    const fixedInv = { ...built.inventory, files: [{ path: 'releases.jsonl', size: strToU8(tampered).length, sha256: sha256Hex(strToU8(tampered)) }] };
    expect(codes(zipSync({ 'catalog.json': strToU8(JSON.stringify(fixedInv)), 'releases.jsonl': strToU8(tampered) }))).toContain('archive_invalid_record');
  });

  it('a failed import leaves the existing catalog untouched', () => {
    const store = seeded();
    const before = store.eventIds();
    const r = readArchive(strToU8('garbage'));
    expect(r.ok).toBe(false);
    expect(() =>
      store.db.transaction(() => {
        store.replaceSourceSnapshot({ id: 'catalog:y', type: 'catalog', label: 'y' }, releases.slice(0, 2));
        throw new Error('simulated failure mid-import');
      }),
    ).toThrow(/simulated/);
    expect(store.eventIds()).toEqual(before);
    expect(store.listSources().map((s) => s.id)).toEqual([sourceIdFor.relay('ws://a')]);
  });
});
