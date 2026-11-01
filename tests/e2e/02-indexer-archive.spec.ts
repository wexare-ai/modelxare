// A04 durable indexing, A17 bounded collection, A05 archive round trip,
// A06 real WebRTC torrent transfer, A09 invalid archives. Real indexer
// processes, real relays, real archive builder/publisher, real browser.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { RELAY_A, RELAY_B, ROOT, demoState, endpoints, evidence, runDir } from '../support/env.ts';
import { Indexer, cli, getJson, waitFor, waitSeeding, type IndexerStatus } from '../support/procs.ts';
import { publishNewRelease } from '../support/releases.ts';
import { catalogStats, externalRequests, gotoPage, importArchive, openApp, stageExpectingRejection } from '../support/app.ts';

test.describe.configure({ mode: 'serial' });

const BOUNDED = { tied: 60, spread: 20, at: 1767225600 };
let main: Indexer;
let archive: { zip: string; announcementPath: string; announcement: string; sha256: string; records: number; infoHash: string; builder: string };

function query<T>(db: string, sql: string, ...params: (string | number)[]): T[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all(...params) as T[];
  } finally {
    d.close();
  }
}
const boundedCount = (db: string) => query<{ n: number }>(db, "SELECT count(*) AS n FROM releases WHERE model_id LIKE 'bounded-%'")[0]!.n;
const relayRow = (s: IndexerStatus, url: string) => s.relays.find((r) => r.url === url)!;

test.afterAll(async () => {
  await main?.stop();
});

test('A17: a relay that truncates tied timestamps is reported as possibly incomplete', async () => {
  // 60 records share one created_at; relay B returns at most 50 per query.
  const fx = await cli(['demo', 'bounded-fixture', '--relay', RELAY_B, '--tied', String(BOUNDED.tied), '--spread', String(BOUNDED.spread), '--at', String(BOUNDED.at)]);
  expect(fx.out).toMatch(/accepted|duplicate/);
  const onlyB = await new Indexer('e2e-relay-b-only', join(runDir(), 'operators/relay-b-only'), 8795, [RELAY_B]).start();
  try {
    const s = await onlyB.waitCaughtUp(120_000);
    const b = relayRow(s, RELAY_B);
    const got = boundedCount(onlyB.db);
    expect(b.possiblyIncomplete).toBe(true);
    expect(b.incompleteReasons.join(' ')).toMatch(new RegExp(String(BOUNDED.at)));
    expect(got).toBeLessThan(BOUNDED.tied + BOUNDED.spread);
    expect(s.coverage.relays.find((r) => r.url === RELAY_B)!.state).toBe('possibly-incomplete');
    evidence('A17', { relay_b_only: { collected: got, published: BOUNDED.tied + BOUNDED.spread, relay: b, coverage: s.coverage } });
  } finally {
    await onlyB.stop();
  }
});

test('A04: the same event on two relays is one release with two observations; restart neither duplicates nor loses', async () => {
  // Relay A (limit 500) also carries the bounded set, so a two-relay indexer can recover it.
  await cli(['demo', 'bounded-fixture', '--relay', RELAY_A, '--tied', String(BOUNDED.tied), '--spread', String(BOUNDED.spread), '--at', String(BOUNDED.at)]);
  main = await new Indexer('e2e-operator-a', join(runDir(), 'operators/a'), 8793, [RELAY_A, RELAY_B]).start();
  const s1 = await main.waitCaughtUp(120_000);
  const state = demoState();
  const fixtureIds = Object.entries(state.releases)
    .filter(([n]) => !n.startsWith('_'))
    .map(([, r]) => r.event_id);
  const obs = (id: string) => query<{ source_id: string }>(main.db, 'SELECT source_id FROM source_memberships WHERE event_id = ? ORDER BY source_id', id).map((r) => r.source_id);
  for (const id of fixtureIds) expect(obs(id)).toEqual([`relay:${RELAY_A}`, `relay:${RELAY_B}`]);
  const count = () => query<{ n: number }>(main.db, 'SELECT count(*) AS n FROM releases')[0]!.n;
  // A release published while the indexer is live; it lies inside the reconnect overlap window.
  const fresh = await publishNewRelease('a04-overlap');
  await waitFor('live event observed on both relays', async () => obs(fresh.eventId).length === 2, 30_000);
  const before = { releases: count(), events: query<{ n: number }>(main.db, 'SELECT count(*) AS n FROM events')[0]!.n };
  expect(boundedCount(main.db)).toBe(BOUNDED.tied + BOUNDED.spread);
  // The altered-manifest fixture is rejected, never stored.
  const bad = state.releases['_invalid-manifest-hash']!.event_id;
  expect(query(main.db, 'SELECT id FROM events WHERE id = ?', bad)).toHaveLength(0);
  expect(Object.keys(s1.totals.rejectedByCode).join(' ')).toMatch(/manifest/);

  // Restart: reconnect catch-up overlaps the cursor; only duplicates arrive.
  await main.stop();
  main = await new Indexer('e2e-operator-a', join(runDir(), 'operators/a'), 8793, [RELAY_A, RELAY_B]).start();
  const s2 = await main.waitCaughtUp(120_000);
  const after = { releases: count(), events: query<{ n: number }>(main.db, 'SELECT count(*) AS n FROM events')[0]!.n };
  expect(after).toEqual(before);
  expect(relayRow(s2, RELAY_A).duplicates).toBeGreaterThan(relayRow(s1, RELAY_A).duplicates);
  // Coverage stays honest: relay B is still possibly incomplete, relay A caught up.
  expect(s2.coverage.relays.find((r) => r.url === RELAY_A)!.state).toBe('caught-up');
  expect(s2.coverage.relays.find((r) => r.url === RELAY_B)!.state).toBe('possibly-incomplete');
  evidence('A04', { fixture_observations: Object.fromEntries(fixtureIds.map((id) => [id, obs(id)])), before_restart: before, after_restart: after, rejected_by_code: s2.totals.rejectedByCode });
  evidence('A17', { two_relays: { bounded_collected: boundedCount(main.db), coverage: s2.coverage, duplicates_after_restart: { relayA: relayRow(s2, RELAY_A).duplicates, relayB: relayRow(s2, RELAY_B).duplicates } } });
});

test('A05/A06: build, sign and seed a snapshot; a clean browser imports it over WebRTC', async () => {
  const dir = runDir();
  const key = join(dir, 'builder-a.key.json');
  await cli(['keygen', '--out', key, '--label', 'e2e-builder-a']);
  const builder = JSON.parse(readFileSync(key, 'utf8')).pubkey as string;
  const mirror = `e2e-${(process.env.WEXARE_E2E_RUN ?? 'run').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  const out = await cli(['archive', 'build', '--indexer-db', main.db, '--builder-key', key, '--out', join(dir, 'archives-a'), '--relay', RELAY_A, '--relay', RELAY_B, '--publish', '--mirror-name', mirror]);
  const announcementPath = /saved (\S+\.announcement\.json)/.exec(out.out)![1]!;
  const announcement = readFileSync(announcementPath, 'utf8');
  const ev = JSON.parse(announcement) as { id: string; tags: string[][] };
  const magnet = ev.tags.find((t) => t[0] === 'magnet')![1]!;
  archive = {
    zip: announcementPath.replace(/\.announcement\.json$/, '.zip'),
    announcementPath,
    announcement,
    sha256: ev.tags.find((t) => t[0] === 'x')![1]!,
    records: Number(/(\d+) records/.exec(out.out)![1]),
    infoHash: /urn:btih:([0-9a-f]{40})/i.exec(magnet)![1]!.toLowerCase(),
    builder,
  };
  expect(out.out).toMatch(/coverage ws:\/\/127\.0\.0\.1:7778: possibly-incomplete/);
  await waitSeeding(endpoints.artifacts, archive.infoHash);

  // Clean browser, torrent only: HTTP web seeds disabled for this proof.
  const app = await openApp({ settings: { torrent: { enabled: true, preferForArchives: true, webSeedDelayMs: -1, seed: false } } });
  const t0 = Date.now();
  const r = await importArchive(app.page, announcement);
  const importMs = Date.now() - t0;
  expect(r.staged).toBe(archive.records);
  expect(r.transport).toBe('torrent');
  expect(r.peerBytes).toBeGreaterThan(0);
  expect(r.webSeedBytes).toBe(0);

  // Recovered release IDs equal the indexer's set, searched locally.
  const expected = query<{ event_id: string }>(main.db, 'SELECT event_id FROM releases WHERE synthetic = 0 ORDER BY event_id').map((x) => x.event_id);
  const got = (await allIds(app.page, 'Archives')).sort();
  expect(got).toEqual(expected);

  // No indexer API was called by the browser.
  const indexerCalls = externalRequests(app).filter((u) => /:(8791|8792|8793|8795)\//.test(u));
  expect(indexerCalls).toEqual([]);
  const seeder = await getJson<{ seeding: { infoHash: string; uploadedBytes: number; peers: number }[] }>(`${endpoints.artifacts}/status`);
  evidence('A05', { announcement_id: ev.id, zip_sha256: archive.sha256, records: archive.records, builder, recovered_non_synthetic: got.length, import_ms: importMs, indexer_calls: indexerCalls });
  evidence('A06', { info_hash: archive.infoHash, transport: r.transport, peer_bytes: r.peerBytes, web_seed_bytes: r.webSeedBytes, seeder: seeder.seeding.find((s) => s.infoHash === archive.infoHash) });
  await app?.close();
});

test('A09: tampered, traversal, oversized, malformed and forged archives are rejected without touching the catalog', async () => {
  const dir = join(runDir(), 'bad-archives');
  mkdirSync(dir, { recursive: true });
  const key = join(runDir(), 'builder-a.key.json');
  const sign = (zip: string) => {
    const r = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'tests/support/sign-announcement.ts'), zip, key], { encoding: 'utf8', cwd: join(ROOT, 'tests') });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const app = await openApp();
  const { page } = app;
  await importArchive(page, archive.announcement, { zipPath: archive.zip });
  const before = await catalogStats(page);

  // 1. One flipped byte under the genuine announcement.
  const tampered = join(dir, 'tampered.zip');
  copyFileSync(archive.zip, tampered);
  const bytes = readFileSync(tampered);
  bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
  writeFileSync(tampered, bytes);
  const e1 = await stageExpectingRejection(page, archive.announcement, tampered);
  expect(e1).toMatch(/archive_hash_mismatch/);

  // 2. Path traversal entry, correctly signed by the builder.
  const traversal = join(dir, 'traversal.zip');
  writeFileSync(traversal, zipSync({ 'catalog.json': strToU8('{}'), '../evil.txt': strToU8('owned') }));
  const e2 = await stageExpectingRejection(page, sign(traversal), traversal);
  expect(e2).toMatch(/archive_path_traversal/);

  // 3. Declared uncompressed size beyond the limit (zip-bomb shape).
  const bomb = join(dir, 'oversized.zip');
  const z = Buffer.from(zipSync({ 'releases.jsonl': strToU8('x'.repeat(1000)) }, { level: 9 }));
  for (let i = 0; i < z.length - 4; i++) {
    if (z.readUInt32LE(i) === 0x02014b50) z.writeUInt32LE(0xfffffff0, i + 24); // central directory: uncompressed size
    if (z.readUInt32LE(i) === 0x04034b50) z.writeUInt32LE(0xfffffff0, i + 22); // local header: uncompressed size
  }
  writeFileSync(bomb, z);
  const e3 = await stageExpectingRejection(page, sign(bomb), bomb);
  expect(e3).toMatch(/archive_too_large|archive_malformed/);

  // 4. Not a ZIP at all.
  const junk = join(dir, 'malformed.zip');
  writeFileSync(junk, Buffer.from('PK\u0003\u0004 definitely not a zip archive'));
  const e4 = await stageExpectingRejection(page, sign(junk), junk);
  expect(e4).toMatch(/archive_malformed/);

  // 5. Announcement altered after signing.
  await gotoPage(page, 'sources');
  const forged = JSON.parse(archive.announcement);
  forged.content += ' (edited)';
  await page.getByTestId('announcement-json').fill(JSON.stringify(forged));
  await page.getByTestId('inspect-announcement').click();
  await expect(page.getByText('Announcement rejected')).toBeVisible();

  const after = await catalogStats(page);
  expect(after.text).toBe(before.text);
  evidence('A09', { archive_rejections: { tampered: e1, traversal: e2, oversized: e3, malformed: e4, forged_announcement: 'Announcement rejected' }, catalog_before: before, catalog_after: after });
  await app?.close();
});

/** Page through Discover results and return every event ID. */
async function allIds(page: Page, mode: 'Live' | 'Archives' | 'Combined'): Promise<string[]> {
  await gotoPage(page, 'discover');
  await page.getByRole('tab', { name: mode, exact: true }).click();
  await page.getByTestId('search-text').fill('');
  await page.waitForTimeout(400);
  const ids: string[] = [];
  for (;;) {
    ids.push(...(await page.getByTestId('result-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-event-id')!))));
    const next = page.getByRole('button', { name: 'Next →' });
    if (!(await next.count()) || (await next.isDisabled())) break;
    const first = await page.getByTestId('result-item').first().getAttribute('data-event-id');
    await next.click();
    await expect(page.getByTestId('result-item').first()).not.toHaveAttribute('data-event-id', first!);
  }
  return ids;
}
