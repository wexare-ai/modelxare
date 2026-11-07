// wexare: publisher and operator CLI for the weXare micro-model PoC.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { readArchive } from '@wexare/catalog';
import {
  type NostrEvent,
  checkManifestSemantics,
  sha256Hex,
  validateManifestSchema,
  verifyCatalogAnnouncement,
  verifyReleaseEvent,
} from '@wexare/protocol';
import { ArtifactRoot, KuboClient } from '@wexare/storage/node';
import { buildSnapshot, publishArchive } from './archive.ts';
import { demoBoundedFixture, demoPrepare, demoPublish, demoReset, fetchFixtureModels } from './demo.ts';
import { generateKeyFile, loadKey } from './keys.ts';
import { endpoints, paths, publishDefaults } from './paths.ts';
import { printPublishResults, publishToRelays } from './relays.ts';
import { loadEvent, prepareRelease, saveRelease, signRelease, type ReleaseDefinition } from './release.ts';

/** Read signed events from .json (single event or {event}) or .jsonl files; invalid releases are skipped with a warning. */
async function readEventFiles(files: string[]): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    const items = f.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [JSON.parse(text)];
    for (const it of items) {
      const e = (it.event ?? it) as NostrEvent;
      const r = verifyReleaseEvent(e);
      if (r.ok) out.push(e);
      else console.warn(`skipping ${f} (${e.id?.slice(0, 12)}…): ${r.errors.map((x) => x.code).join(', ')}`);
    }
  }
  return out;
}

const publish = publishDefaults();

const program = new Command();
program.name('wexare').description('Publisher and operator tooling for the weXare micro-model PoC').version('0.1.0');
const collect = (v: string, prev: string[] = []) => [...prev, v];
const run = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
  try {
    await fn(...a);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

program
  .command('keygen')
  .description('Generate a publisher/builder key locally (file mode 0600); prints only the public key')
  .requiredOption('--out <file>', 'key file to create')
  .option('--label <label>', 'label stored with the key', 'publisher')
  .option('--force', 'overwrite an existing file')
  .action(
    run(async (o) => {
      const k = await generateKeyFile(resolve(o.out), o.label, { force: o.force });
      console.log(`created ${k.path}\npubkey ${k.pubkey}\nnpub   ${k.npub}`);
    }),
  );

program
  .command('pubkey')
  .requiredOption('--key <file>')
  .action(
    run(async (o) => {
      const k = await loadKey(resolve(o.key));
      console.log(`pubkey ${k.pubkey}\nnpub   ${k.npub}`);
    }),
  );

const release = program.command('release').description('Prepare, sign and publish model or LoRA releases');

release
  .command('prepare')
  .description('Hash files, publish bytes (mirror/IPFS/torrent), write the manifest and the signed portable event')
  .requiredOption('--definition <file>', 'release definition JSON (see docs/protocol.md#publisher-definition)')
  .requiredOption('--key <file>', 'publisher key file')
  .requiredOption('--out <dir>', 'output directory (manifest.json, event.json, release.json)')
  .option('--base-event <file>', 'LoRA: the base release event.json')
  .option('--ipfs-api <url>', 'Kubo RPC API (WEXARE_IPFS_API)', publish.ipfsApi)
  .option('--no-ipfs', 'skip IPFS publication')
  .option('--mirror-root <dir>', 'local artifact root to upload to the mirror (WEXARE_MIRROR_ROOT)', publish.mirrorRoot)
  .option('--mirror-name <name>', 'artifact root name on the mirror', 'main')
  .option('--mirror-url <url>', 'mirror base URL (WEXARE_MIRROR_URL)', publish.mirrorUrl)
  .option('--tracker <url>', 'WebSocket tracker for torrents, repeatable (WEXARE_TRACKERS)', collect, [])
  .option('--no-check-urls', "don't download the files' urls to check their bytes")
  .action(
    run(async (o) => {
      const def = JSON.parse(await readFile(o.definition, 'utf8')) as ReleaseDefinition;
      const base = o.baseEvent ? { event: await loadEvent(o.baseEvent) } : def.base;
      def.files = def.files.map((f) => ({ ...f, source: resolve(join(o.definition, '..'), f.source) }));
      const kinds = def.locations ?? [];
      if (kinds.some((k) => k !== 'ipfs') && !o.mirrorUrl) throw new Error('this definition publishes to a mirror: give its address with --mirror-url or WEXARE_MIRROR_URL');
      const prepared = await prepareRelease(
        { ...def, ...(base ? { base } : {}) },
        {
          ...(o.mirrorUrl ? { mirror: { root: new ArtifactRoot(o.mirrorRoot), name: o.mirrorName, baseUrl: o.mirrorUrl } } : {}),
          ...(o.ipfs ? { ipfs: new KuboClient(o.ipfsApi) } : {}),
          trackers: o.tracker.length ? o.tracker : publish.trackers,
        },
        { checkUrls: o.checkUrls },
      );
      const key = await loadKey(o.key);
      const event = signRelease(prepared, key);
      await saveRelease(resolve(o.out), prepared.manifest.model_id, key.label, prepared, event);
      console.log(`release ${event.id}\nmanifest sha256 ${prepared.manifestSha256}\nwrote ${resolve(o.out)}/{manifest.json,event.json,release.json}`);
    }),
  );

release
  .command('publish')
  .description('Publish the exact same signed event to several relays (safe to retry: same event, same release)')
  .requiredOption('--event <file>', 'portable event JSON')
  .option('--relay <url>', 'relay URL, repeatable (WEXARE_RELAYS)', collect, [])
  .option('--timeout <ms>', 'per-relay timeout', '8000')
  .action(
    run(async (o) => {
      const event = await loadEvent(o.event);
      const v = verifyReleaseEvent(event);
      if (!v.ok) throw new Error(`refusing to publish an invalid release: ${v.errors.map((e) => e.code).join(', ')}`);
      const relays = o.relay.length ? o.relay : publish.relays;
      if (!relays.length) throw new Error('no relay to publish to: give one with --relay or WEXARE_RELAYS');
      const results = await publishToRelays(event, relays, Number(o.timeout));
      printPublishResults(`release ${event.id}`, results);
      if (!results.some((r) => r.outcome === 'accepted' || r.outcome === 'duplicate')) process.exitCode = 2;
    }),
  );

program
  .command('validate')
  .description('Validate a manifest JSON, a release event, or a catalog announcement before publication')
  .argument('<file>')
  .action(
    run(async (file) => {
      const raw = await readFile(file, 'utf8');
      const json = JSON.parse(raw);
      const obj = json.event ?? json;
      if (obj.schema) {
        const errors = [...validateManifestSchema(obj), ...checkManifestSemantics(obj)];
        console.log(errors.length ? errors.map((e) => `✗ ${e.code}: ${e.message}`).join('\n') : `✓ manifest valid (sha256 of file bytes ${sha256Hex(raw)})`);
        if (errors.length) process.exitCode = 1;
        return;
      }
      const isCatalog = obj.tags?.some((t: string[]) => t[0] === 't' && t[1] === 'wexare-micromodel-catalog');
      const r = isCatalog ? verifyCatalogAnnouncement(obj) : verifyReleaseEvent(obj);
      if (r.ok) {
        console.log(`✓ valid ${isCatalog ? 'catalog announcement' : 'release event'} ${obj.id}`);
        for (const w of 'warnings' in r.value ? r.value.warnings : []) console.log(`  warning ${w.code}: ${w.message}`);
      } else {
        console.log(r.errors.map((e) => `✗ ${e.code}: ${e.message}`).join('\n'));
        process.exitCode = 1;
      }
    }),
  );

const archive = program.command('archive').description('Build, publish and verify catalog snapshots');

const operatorPaths = (name: string) => ({ dir: paths.operator(name), db: join(paths.operator(name), 'indexer.sqlite'), archives: join(paths.operator(name), 'archives') });

/** Where a snapshot is distributed. Defaults are the local demo endpoints. */
const distributionOptions = (c: Command) =>
  c
    .option('--mirror-root <dir>', 'artifact root directory (default .data/artifacts/<mirror-name>)')
    .option('--mirror-url <url>', 'public base URL of the artifacts server that serves the mirror root', endpoints.artifacts)
    .option('--ipfs-api <url>', 'Kubo RPC API used to pin the ZIP', endpoints.kubo.a.api)
    .option('--no-ipfs', 'skip IPFS publication')
    .option('--tracker <url>', 'WebSocket tracker for the torrent (repeatable)', collect, []);

const distribution = (o: { mirrorRoot?: string; mirrorUrl: string; ipfsApi: string; ipfs: boolean; tracker: string[] }, mirrorName: string) => ({
  mirror: { root: new ArtifactRoot(o.mirrorRoot ? resolve(o.mirrorRoot) : paths.artifactRoot(mirrorName)), name: mirrorName, baseUrl: o.mirrorUrl },
  ...(o.ipfs ? { ipfs: new KuboClient(o.ipfsApi) } : {}),
  trackers: o.tracker.length ? o.tracker : [endpoints.tracker.ws],
});

distributionOptions(archive.command('build'))
  .description('Freeze accepted events from an indexer store into a new immutable snapshot ZIP')
  .option('--operator <name>', 'demo operator name (uses .data/operators/<name>)', 'a')
  .option('--indexer-db <file>', 'indexer SQLite database (overrides --operator)')
  .option('--events <file>', 'build from signed event JSON/JSONL files instead of an indexer (repeatable; verified first)', collect, [])
  .option('--out <dir>', 'output directory for ZIPs')
  .option('--builder-key <file>', 'builder key file (default .data/keys/builder-<operator>.key.json)')
  .option('--relay <url>', 'relays covered by this indexer (repeatable)', collect, [])
  .option('--policy <id>', 'collection policy identifier')
  .option('--no-sqlite', 'omit the convenience catalog.sqlite')
  .option('--publish', 'also publish: mirror, IPFS pin, torrent, signed announcement to relays')
  .option('--mirror-name <name>', 'artifact root for publication (default operator-<operator>)')
  .action(
    run(async (o) => {
      const op = operatorPaths(o.operator);
      const builder = await loadKey(o.builderKey ?? paths.key(`builder-${o.operator}`));
      const relays = o.relay.length ? o.relay : endpoints.relays;
      const events = o.events.length ? await readEventFiles(o.events) : undefined;
      const snap = await buildSnapshot({
        ...(events ? { events } : { indexerDb: o.indexerDb ?? op.db }),
        outDir: o.out ?? op.archives,
        builder,
        relays,
        ...(o.policy ? { policy: o.policy } : {}),
        withSqlite: o.sqlite,
      });
      console.log(`built ${snap.path}\n  sha256 ${snap.sha256}\n  ${snap.inventory.record_count} records, ${snap.size} bytes, builder ${builder.npub}`);
      for (const r of snap.inventory.coverage.relays) console.log(`  coverage ${r.url}: ${r.state}${r.notes ? ` (${r.notes})` : ''}`);
      if (o.publish) {
        const mirrorName = o.mirrorName ?? `operator-${o.operator}`;
        const pub = await publishArchive({
          zipPath: snap.path,
          builder,
          ...distribution(o, mirrorName),
          relays,
          ...(events ? {} : { indexerDb: o.indexerDb ?? op.db }),
        });
        console.log(`announcement ${pub.announcement.id}\n  saved ${pub.announcementPath}\n  publication ${JSON.stringify({ ...pub.status, relays: undefined })}`);
      }
    }),
  );

archive
  .command('verify')
  .description('Verify a catalog ZIP (and optionally its signed announcement) exactly as a browser would')
  .requiredOption('--zip <file>')
  .option('--announcement <file>')
  .action(
    run(async (o) => {
      const zip = new Uint8Array(await readFile(o.zip));
      let expected: { expectedSha256?: string; expectedSize?: number; expectedBuilder?: string } = {};
      if (o.announcement) {
        const a = verifyCatalogAnnouncement(await loadEvent(o.announcement));
        if (!a.ok) throw new Error(`announcement invalid: ${a.errors.map((e) => e.code).join(', ')}`);
        expected = { expectedSha256: a.value.zipSha256, expectedSize: a.value.zipSize, expectedBuilder: a.value.event.pubkey };
        console.log(`✓ announcement ${a.value.event.id} by ${a.value.event.pubkey}`);
      }
      const r = readArchive(zip, expected);
      if (!r.ok) {
        console.log(r.errors.map((e) => `✗ ${e.code}: ${e.message}`).join('\n'));
        process.exitCode = 1;
        return;
      }
      console.log(`✓ archive ${r.value.zipSha256}: ${r.value.releases.length} verified releases, builder ${r.value.inventory.builder_pubkey}`);
      if (r.value.sqlite) {
        const { NodeSqliteDatabase } = await import('@wexare/catalog/node');
        const tmp = join(paths.exports, `verify-${Date.now()}.sqlite`);
        await (await import('node:fs/promises')).mkdir(paths.exports, { recursive: true });
        await writeFile(tmp, r.value.sqlite);
        const db = new NodeSqliteDatabase(tmp);
        const ids = db.all<{ id: string }>('SELECT id FROM events ORDER BY id').map((x) => x.id);
        db.close();
        await (await import('node:fs/promises')).rm(tmp, { force: true });
        const expectedIds = r.value.releases.map((x) => x.event.id).sort();
        const same = ids.length === expectedIds.length && ids.every((id, i) => id === expectedIds[i]);
        console.log(same ? '✓ convenience catalog.sqlite contains exactly the archived records' : '✗ catalog.sqlite rows differ from releases.jsonl');
        if (!same) process.exitCode = 1;
      }
    }),
  );

distributionOptions(archive.command('publish'))
  .description('Publish an existing snapshot ZIP and sign its announcement')
  .requiredOption('--zip <file>')
  .requiredOption('--builder-key <file>')
  .option('--mirror-name <name>', 'artifact root name', 'main')
  .option('--relay <url>', 'relay (repeatable)', collect, [])
  .action(
    run(async (o) => {
      const pub = await publishArchive({
        zipPath: resolve(o.zip),
        builder: await loadKey(o.builderKey),
        ...distribution(o, o.mirrorName),
        relays: o.relay.length ? o.relay : endpoints.relays,
      });
      console.log(`announcement ${pub.announcement.id} saved to ${pub.announcementPath}`);
    }),
  );

program
  .command('storage')
  .description('Storage operations')
  .command('replicate')
  .description('Pin CIDs on another Kubo node (connects it to the source node first)')
  .requiredOption('--cid <cid>', 'CID (repeatable)', collect, [])
  .option('--from <api>', 'source Kubo API', endpoints.kubo.a.api)
  .option('--to <api>', 'target Kubo API', endpoints.kubo.b.api)
  .action(
    run(async (o) => {
      const from = new KuboClient(o.from);
      const to = new KuboClient(o.to);
      await to.swarmConnect(`/dns4/kubo-a/tcp/4001/p2p/${(await from.id()).ID}`).catch(() => undefined);
      for (const cid of o.cid) {
        await to.pinAdd(cid);
        console.log(`✓ pinned ${cid} on ${o.to}`);
      }
    }),
  );

const demo = program.command('demo').description('End-to-end demo setup (disposable local data under .data/)');
demo
  .command('prepare')
  .option('--no-ipfs', 'skip IPFS publication')
  .option('--no-replicate', 'do not pin replicas on Kubo B')
  .option('--synthetic <n>', 'number of synthetic records', '10000')
  .action(run(async (o) => demoPrepare({ skipIpfs: !o.ipfs, replicate: o.replicate, syntheticCount: Number(o.synthetic) })));
demo
  .command('fetch-models')
  .description('Download and verify the pinned upstream model fixtures only')
  .action(run(async () => fetchFixtureModels()));
demo
  .command('publish')
  .option('--relay <url>', 'relay (repeatable)', collect, [])
  .option('--no-retry')
  .action(run(async (o) => demoPublish({ relays: o.relay, retry: o.retry })));
demo
  .command('bounded-fixture')
  .description('A17: publish labeled synthetic records with tied timestamps (more than one relay page)')
  .option('--relay <url>', 'relay (repeatable; default relay B, which returns at most 50 events per query)', collect, [])
  .option('--tied <n>', 'records sharing one created_at', '60')
  .option('--spread <n>', 'records at later, distinct timestamps', '20')
  .option('--at <unix>', 'the shared created_at (default 2026-01-01T00:00:00Z)', '1767225600')
  .action(
    run(async (o) => {
      await demoBoundedFixture({ relays: o.relay.length ? o.relay : [endpoints.relays[1]!], tied: Number(o.tied), spread: Number(o.spread), at: Number(o.at) });
    }),
  );
demo
  .command('reset')
  .description('Delete documented demo data under .data/ (requires --force)')
  .option('--force', 'actually delete')
  .option('--volumes', 'also delete docker volumes (relay and IPFS data)')
  .option('--downloads', 'also delete downloaded fixture models')
  .action(run(async (o) => demoReset({ force: o.force, volumes: o.volumes, downloads: o.downloads })));

await program.parseAsync();
