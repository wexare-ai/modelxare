import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildArchive } from '@wexare/catalog';
import { type FileRole, type NostrEvent, type ReleaseManifest } from '@wexare/protocol';
import { ArtifactRoot, KuboClient, hashFile } from '@wexare/storage/node';
import { publishArchive } from './archive.ts';
import { ensureKey, type LoadedKey } from './keys.ts';
import { DATA, ROOT, endpoints, paths } from './paths.ts';
import { printPublishResults, publishManyToRelay, publishToRelays } from './relays.ts';
import { loadEvent, loadReleaseState, prepareRelease, recordPublication, saveRelease, signRelease, type ReleaseDefinition, type StorageTargets } from './release.ts';
import { generateSyntheticEvents } from './synthetic.ts';

interface FixtureModel {
  id: string;
  repository: string;
  revision: string;
  file: string;
  size: number;
  sha256: string;
  license: ReleaseManifest['license'];
}

interface FixtureDefinition {
  fixture: string;
  fixture_path?: string;
  publisher: string;
  base?: string;
  base_override?: Partial<NonNullable<ReleaseManifest['base']>>;
  declare_wrong_sha256?: boolean;
  /** More files of the same release, e.g. a tokenizer and a config next to the weights. */
  extra_files?: { fixture: string; role: FileRole }[];
  manifest: ReleaseDefinition['manifest'] & { license?: ReleaseManifest['license'] };
  locations: ReleaseDefinition['locations'];
}

/** Publication order: bases before adapters. */
export const DEMO_RELEASES = ['story-base', 'community-assistant', 'tiny-summarizer', 'shakespeare-lora', 'shakespeare-lora-wrong-base', 'future-runtime-model', 'wrong-file-hash', 'laya-router'];
export const DEMO_KEYS = ['publisher-a', 'publisher-b', 'builder-a', 'builder-b', 'synthetic-builder'];
const step = (s: string) => console.log(`\n▶ ${s}`);

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const fixtureModels = async () => (await readJson<{ models: FixtureModel[] }>(join(ROOT, 'fixtures/models.json'))).models;

/** Download each pinned upstream model once and verify its exact bytes. */
export async function fetchFixtureModels(): Promise<void> {
  await mkdir(paths.fixtureModels, { recursive: true });
  for (const m of await fixtureModels()) {
    const dest = join(paths.fixtureModels, m.file);
    if (await stat(dest).catch(() => null)) {
      const h = await hashFile(dest);
      if (h.sha256 === m.sha256 && h.size === m.size) {
        console.log(`  ✓ ${m.file} (verified ${m.sha256.slice(0, 12)}…)`);
        continue;
      }
      console.log(`  ! ${m.file} does not match the pinned hash; downloading again`);
    }
    await mkdir(dirname(dest), { recursive: true });
    const url = `${m.repository}/resolve/${m.revision}/${m.file}`;
    console.log(`  ↓ ${m.file} (${(m.size / 1e6).toFixed(0)} MB) from ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const h = await hashFile(part);
    if (h.sha256 !== m.sha256 || h.size !== m.size) {
      await rm(part, { force: true });
      throw new Error(`${m.file}: downloaded bytes do not match the pinned SHA-256/size`);
    }
    await rename(part, dest);
    console.log(`  ✓ ${m.file} verified`);
  }
}

async function toDefinition(name: string, d: FixtureDefinition): Promise<ReleaseDefinition> {
  const models = await fixtureModels();
  let source: string;
  let path: string;
  let license: ReleaseManifest['license'];
  if (d.fixture.startsWith('@bytes:')) {
    const dir = join(DATA, 'fixtures/generated');
    await mkdir(dir, { recursive: true });
    path = d.fixture_path ?? 'file.bin';
    source = join(dir, `${name}-${path}`);
    await writeFile(source, d.fixture.slice('@bytes:'.length));
    license = { id: 'Apache-2.0', attribution: 'weXare PoC test fixture (placeholder bytes, not a model)' };
  } else {
    const m = models.find((x) => x.id === d.fixture);
    if (!m) throw new Error(`unknown fixture ${d.fixture}`);
    source = join(paths.fixtureModels, m.file);
    path = basename(m.file);
    license = m.license;
  }
  const extra = (d.extra_files ?? []).map((x) => {
    const m = models.find((y) => y.id === x.fixture);
    if (!m) throw new Error(`unknown fixture ${x.fixture}`);
    return { role: x.role, path: basename(m.file), source: join(paths.fixtureModels, m.file) };
  });
  const base = d.base ? { event: await loadEvent(join(paths.release(d.base), 'event.json')), ...(d.base_override ? { override: d.base_override } : {}) } : undefined;
  return {
    manifest: { ...d.manifest, license: d.manifest.license ?? license },
    files: [{ role: d.manifest.kind === 'lora' ? 'adapter' : 'weights', path, source, ...(d.declare_wrong_sha256 ? { declareWrongSha256: true } : {}) }, ...extra],
    ...(base ? { base } : {}),
    locations: d.locations,
  };
}

async function storageTargets(skipIpfs: boolean): Promise<StorageTargets> {
  const ipfs = skipIpfs ? undefined : new KuboClient(endpoints.kubo.a.api);
  if (ipfs) {
    try {
      const id = await ipfs.id();
      console.log(`  Kubo A: ${id.AgentVersion} (${id.ID.slice(0, 12)}…)`);
    } catch {
      throw new Error(`Kubo API ${endpoints.kubo.a.api} is not reachable. Start services with: pnpm infra:up`);
    }
  }
  return {
    mirror: { root: new ArtifactRoot(paths.artifactRoot('main')), name: 'main', baseUrl: endpoints.artifacts },
    corruptMirror: { root: new ArtifactRoot(paths.artifactRoot('corrupt')), name: 'corrupt' },
    ...(ipfs ? { ipfs } : {}),
    trackers: [endpoints.tracker.ws],
  };
}

export async function loadDemoKeys(): Promise<Record<string, LoadedKey>> {
  const out: Record<string, LoadedKey> = {};
  for (const k of DEMO_KEYS) out[k] = await ensureKey(paths.key(k), k);
  return out;
}

export async function demoPrepare(opts: { skipIpfs?: boolean; replicate?: boolean; syntheticCount?: number }): Promise<void> {
  step('Keys (disposable local demo credentials, stored with mode 0600 under .data/keys)');
  const keys = await loadDemoKeys();
  for (const k of DEMO_KEYS) console.log(`  ${k.padEnd(18)} ${keys[k]!.npub}`);

  step('Fixture models (pinned upstream revisions, verified by SHA-256)');
  await fetchFixtureModels();

  step('Storage targets');
  const storage = await storageTargets(!!opts.skipIpfs);

  step('Releases (manifests are immutable: unchanged manifests keep their signed event)');
  const state: Record<string, unknown> = {};
  for (const name of DEMO_RELEASES) {
    const d = await readJson<FixtureDefinition>(join(ROOT, 'fixtures/releases', `${name}.json`));
    console.log(`  ${name}`);
    const prepared = await prepareRelease(await toDefinition(name, d), storage);
    const dir = paths.release(name);
    const existing = await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null);
    const publisher = keys[d.publisher]!;
    let event: NostrEvent;
    if (existing === prepared.manifestJson) {
      event = await loadEvent(join(dir, 'event.json'));
      console.log(`    unchanged → keeping release ${event.id.slice(0, 16)}…`);
    } else {
      event = signRelease(prepared, publisher);
      console.log(`    signed new release ${event.id.slice(0, 16)}… by ${d.publisher}`);
    }
    await saveRelease(dir, name, d.publisher, prepared, event);
    state[name] = { event_id: event.id, manifest_sha256: prepared.manifestSha256, publisher: publisher.pubkey, files: prepared.files };
  }

  step('Negative fixture: validly signed event whose inline manifest does not match its x hash');
  const good = await loadEvent(join(paths.release('community-assistant'), 'event.json'));
  const badDir = paths.release('_invalid-manifest-hash');
  let bad = await loadEvent(join(badDir, 'event.json')).catch(() => null);
  if (!bad) {
    const tags = good.tags.map((t) => (t[0] === 'wexare-manifest' ? [t[0], t[1]!.replace('"version":"1.0.0"', '"version":"1.0.1"')] : t));
    bad = finalizeEvent({ kind: 1063, created_at: Math.floor(Date.now() / 1000), content: 'Negative fixture: altered inline manifest.', tags }, keys['publisher-b']!.secretKey) as unknown as NostrEvent;
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, 'event.json'), JSON.stringify(bad, null, 2) + '\n');
  }
  console.log(`  ${bad.id.slice(0, 16)}… (expected rejection: manifest_hash_mismatch)`);
  state['_invalid-manifest-hash'] = { event_id: bad.id };

  if (storage.ipfs && opts.replicate !== false) {
    step('IPFS replication: pin every published CID on Kubo B too (redundant availability)');
    const b = new KuboClient(endpoints.kubo.b.api);
    try {
      const idA = (await storage.ipfs.id()).ID;
      await b.swarmConnect(`/dns4/kubo-a/tcp/4001/p2p/${idA}`).catch(() => undefined);
      for (const name of DEMO_RELEASES) {
        for (const f of (await loadReleaseState(paths.release(name))).files) {
          if (!f.cid) continue;
          await b.pinAdd(f.cid);
          console.log(`  ✓ ${name}/${f.path} pinned on Kubo B (${f.cid.slice(0, 16)}…)`);
        }
      }
    } catch (e) {
      console.log(`  ! replication skipped: ${(e as Error).message}`);
    }
  }

  const count = opts.syntheticCount ?? 10_000;
  if (count > 0) {
    step(`Synthetic catalog: ${count} signed, non-runnable records (A08)`);
    const synthDir = paths.synthetic;
    await mkdir(synthDir, { recursive: true });
    const marker = join(synthDir, `count-${count}.json`);
    let info = await readJson<{ zip: string; announcement: string; event_id: string; zip_sha256: string }>(marker).catch(() => null);
    if (!info) {
      const t0 = Date.now();
      const events = generateSyntheticEvents(keys['publisher-b']!, count);
      console.log(`  signed ${events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const built = buildArchive({
        events,
        builderPubkey: keys['synthetic-builder']!.pubkey,
        buildTime: Math.floor(Date.now() / 1000),
        collectionPolicy: 'wexare.policy.synthetic-scale-test/0.1',
        coverage: { statement: 'SYNTHETIC scale-test records generated locally; not collected from relays and not runnable.', relays: [] },
      });
      const zip = join(synthDir, `${built.sha256}.zip`);
      await writeFile(zip, built.zip);
      const pub = await publishArchive({
        zipPath: zip,
        builder: keys['synthetic-builder']!,
        mirror: { root: new ArtifactRoot(paths.artifactRoot('main')), name: 'main', baseUrl: endpoints.artifacts },
        ...(storage.ipfs ? { ipfs: storage.ipfs } : {}),
        trackers: [endpoints.tracker.ws],
        description: `SYNTHETIC catalog of ${count} non-runnable records for search scale tests.`,
      });
      info = { zip, announcement: pub.announcementPath, event_id: pub.announcement.id, zip_sha256: built.sha256 };
      await writeFile(marker, JSON.stringify(info, null, 2) + '\n');
    }
    console.log(`  archive ${info.zip_sha256.slice(0, 16)}… announcement ${info.event_id.slice(0, 16)}…`);
    state._synthetic = { ...info, count };
  }

  await writeFile(join(DATA, 'demo-state.json'), JSON.stringify({ generated_at: new Date().toISOString(), keys: Object.fromEntries(DEMO_KEYS.map((k) => [k, keys[k]!.pubkey])), releases: state }, null, 2) + '\n');
  console.log(`\nDone. State written to .data/demo-state.json. Next: pnpm dev (indexer, artifacts, web), then pnpm demo:publish.`);
}

export async function demoPublish(opts: { relays?: string[]; retry?: boolean }): Promise<void> {
  const relays = opts.relays?.length ? opts.relays : endpoints.relays;
  step(`Publishing demo releases to ${relays.join(', ')}`);
  for (const name of [...DEMO_RELEASES, '_invalid-manifest-hash']) {
    const dir = paths.release(name);
    const event = await loadEvent(join(dir, 'event.json')).catch(() => null);
    if (!event) throw new Error(`${name} is not prepared; run pnpm demo:prepare first`);
    const results = await publishToRelays(event, relays);
    printPublishResults(`${name} ${event.id.slice(0, 16)}…${name.startsWith('_') ? '  (negative fixture: relays store any signed event; collectors must reject it)' : ''}`, results);
    if (!name.startsWith('_')) await recordPublication(dir, results);
  }
  if (opts.retry !== false) {
    step('Retry: republishing an existing event does not create a new release');
    const event = await loadEvent(join(paths.release('community-assistant'), 'event.json'));
    printPublishResults(`community-assistant ${event.id.slice(0, 16)}… (same event ID)`, await publishToRelays(event, relays));
  }
  const synth = await readJson<{ announcement: string }>(join(paths.synthetic, 'count-10000.json')).catch(() => null);
  if (synth) {
    step('Synthetic catalog announcement');
    const ann = await loadEvent(synth.announcement);
    printPublishResults(`synthetic catalog ${ann.id.slice(0, 16)}…`, await publishToRelays(ann, relays));
  }
}

/**
 * A17 fixture: labeled synthetic, non-runnable releases sharing one timestamp,
 * more of them than a relay returns per query (relay B caps at 50). Event IDs
 * are deterministic for a given key, so republishing is idempotent.
 */
export async function demoBoundedFixture(opts: { relays: string[]; tied: number; spread: number; at: number }): Promise<{ ids: string[]; pubkey: string }> {
  const key = await ensureKey(paths.key('synthetic-publisher'), 'synthetic-publisher');
  const events = generateSyntheticEvents(key, opts.tied + opts.spread, {
    seed: 17,
    prefix: 'bounded',
    timeOf: (i) => (i < opts.tied ? opts.at : opts.at + 1 + (i - opts.tied)),
  });
  step(`A17 fixture: ${opts.tied} records at created_at ${opts.at} + ${opts.spread} later records (synthetic, by ${key.npub})`);
  for (const url of opts.relays) {
    const r = await publishManyToRelay(events, url);
    console.log(`  ${url}: ${r.accepted} accepted, ${r.duplicate} duplicate, ${r.rejected} rejected, ${r['timed-out']} timed out, ${r.disconnected} disconnected${r.firstError ? ` (${r.firstError})` : ''}`);
  }
  return { ids: events.map((e) => e.id), pubkey: key.pubkey };
}

export async function demoReset(opts: { force?: boolean; volumes?: boolean; downloads?: boolean }): Promise<void> {
  const targets = ['releases', 'operators', 'artifacts', 'synthetic', 'exports', 'keys', 'fixtures/generated', 'demo-state.json'];
  if (opts.downloads) targets.push('fixtures/models');
  console.log('Demo data under .data/ to delete:');
  for (const t of targets) console.log(`  .data/${t}`);
  if (opts.volumes) console.log('  docker volumes: relay-a-db, relay-b-db, kubo-a-data, kubo-b-data');
  if (!opts.downloads) console.log('Kept: .data/fixtures/models (verified upstream downloads; add --downloads to delete them).');
  if (!opts.force) {
    console.log('\nNothing deleted. Re-run with --force to delete.');
    process.exitCode = 1;
    return;
  }
  for (const t of targets) await rm(join(DATA, t), { recursive: true, force: true });
  if (opts.volumes) spawnSync('node', [join(ROOT, 'scripts/infra.mjs'), 'remove-volumes'], { stdio: 'inherit' });
  console.log('Deleted.');
}

