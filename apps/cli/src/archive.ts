import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import { CatalogStore, OperatorStore, buildArchive, migrateOperator, readArchive, sourceIdFor, type BuiltArchive } from '@wexare/catalog';
import { NodeSqliteDatabase } from '@wexare/catalog/node';
import { buildCatalogAnnouncementTemplate, verifyCatalogAnnouncement, type CatalogInventory, type NostrEvent } from '@wexare/protocol';
import { ArtifactRoot, KuboClient, createSingleFileTorrent, mirrorUrl, torrentUrl } from '@wexare/storage/node';
import type { LoadedKey } from './keys.ts';
import { printPublishResults, publishToRelays } from './relays.ts';

/** Generate the optional convenience catalog.sqlite from exactly the archived records. */
async function convenienceSqlite(events: NostrEvent[], builder: string, workDir: string): Promise<Uint8Array> {
  const path = join(workDir, `catalog-${process.pid}-${Date.now()}.sqlite`);
  const db = new NodeSqliteDatabase(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const store = new CatalogStore(db);
    store.migrate();
    const { verifyReleaseEvent } = await import('@wexare/protocol');
    const releases = events.map((e) => {
      const r = verifyReleaseEvent(e);
      if (!r.ok) throw new Error(`invalid event ${e.id}`);
      return r.value;
    });
    store.replaceSourceSnapshot({ id: sourceIdFor.catalog(builder), type: 'catalog', label: 'this archive', builderPubkey: builder }, releases);
    db.exec('VACUUM');
  } finally {
    db.close();
  }
  const bytes = new Uint8Array(await readFile(path));
  await rm(path, { force: true });
  return bytes;
}

export interface SnapshotResult extends BuiltArchive {
  path: string;
}

/**
 * Freeze a consistent set of accepted events from an indexer database and
 * write a new immutable ZIP. Previous snapshots are kept until explicit cleanup.
 */
export async function buildSnapshot(opts: {
  /** Indexer database to freeze; or */
  indexerDb?: string;
  /** signed events supplied directly (e.g. preserved event files), with no relay coverage claimed. */
  events?: NostrEvent[];
  outDir: string;
  builder: LoadedKey;
  relays: string[];
  policy?: string;
  withSqlite?: boolean;
}): Promise<SnapshotResult> {
  let events: NostrEvent[];
  let coverage: CatalogInventory['coverage'];
  if (opts.events) {
    events = opts.events;
    coverage = { statement: 'Built from signed event files supplied directly to the builder. No relay coverage is claimed.', relays: [] };
  } else {
    if (!opts.indexerDb) throw new Error('indexerDb or events required');
    const db = new NodeSqliteDatabase(opts.indexerDb);
    try {
      migrateOperator(db);
      const store = new CatalogStore(db);
      const op = new OperatorStore(db);
      // One read transaction: the event set and the coverage statement describe the same instant.
      ({ events, coverage } = db.transaction(() => ({
        events: store.allEnvelopes().map((s) => JSON.parse(s) as NostrEvent),
        coverage: op.coverage(opts.relays),
      })));
    } finally {
      db.close();
    }
  }
  await mkdir(opts.outDir, { recursive: true });
  const buildTime = Math.floor(Date.now() / 1000);
  const sqlite = opts.withSqlite === false ? undefined : await convenienceSqlite(events, opts.builder.pubkey, opts.outDir);
  const built = buildArchive({
    events,
    builderPubkey: opts.builder.pubkey,
    buildTime,
    ...(opts.policy ? { collectionPolicy: opts.policy } : {}),
    coverage,
    ...(sqlite ? { sqlite } : {}),
  });
  const path = join(opts.outDir, `${built.sha256}.zip`);
  await writeFile(path, built.zip);
  // Re-read what was written: the archive must verify like any client would verify it.
  const check = readArchive(new Uint8Array(await readFile(path)), { expectedSha256: built.sha256, expectedBuilder: opts.builder.pubkey });
  if (!check.ok) throw new Error(`built archive failed verification: ${check.errors.map((e) => e.message).join('; ')}`);

  if (opts.indexerDb) {
    const idb = new NodeSqliteDatabase(opts.indexerDb);
    try {
      migrateOperator(idb);
      new OperatorStore(idb).recordArchiveBuild({ zipSha256: built.sha256, recordCount: built.inventory.record_count, zipSize: built.size, path, inventory: built.inventory });
    } finally {
      idb.close();
    }
  }
  return { ...built, path };
}

export interface PublishArchiveOptions {
  zipPath: string;
  builder: LoadedKey;
  mirror?: { root: ArtifactRoot; name: string; baseUrl: string };
  ipfs?: KuboClient;
  trackers?: string[];
  relays?: string[];
  description?: string;
  indexerDb?: string;
}

export interface PublishedArchive {
  announcement: NostrEvent;
  announcementPath: string;
  status: Record<string, unknown>;
}

/** Distribute a built archive (mirror, IPFS pin, torrent + seeding) and sign its announcement. */
export async function publishArchive(o: PublishArchiveOptions): Promise<PublishedArchive> {
  const zip = new Uint8Array(await readFile(o.zipPath));
  const r = readArchive(zip, { expectedBuilder: o.builder.pubkey });
  if (!r.ok) throw new Error(`archive does not verify: ${r.errors.map((e) => e.message).join('; ')}`);
  const sha = r.value.zipSha256;
  const status: Record<string, unknown> = {};
  const urls: string[] = [];
  let magnet: string | undefined;

  if (o.ipfs) {
    try {
      const { cid } = await o.ipfs.addBytes(zip, `catalog-${sha.slice(0, 12)}.zip`);
      urls.push(`ipfs://${cid}`);
      status.ipfs = { cid, pinned: await o.ipfs.isPinned(cid) };
    } catch (e) {
      status.ipfs = { error: (e as Error).message };
    }
  }
  if (o.mirror) {
    await o.mirror.root.putBytes(zip);
    const url = mirrorUrl(o.mirror.baseUrl, o.mirror.name, sha);
    urls.push(url);
    status.mirror = { url };
    if (o.trackers?.length) {
      const name = `wexare-catalog-${sha.slice(0, 16)}.zip`;
      const t = await createSingleFileTorrent(zip, { name, trackers: o.trackers, webSeeds: [url] });
      t.magnet += `&xs=${encodeURIComponent(torrentUrl(o.mirror.baseUrl, o.mirror.name, t.infoHash))}`;
      await o.mirror.root.putTorrent(t.infoHash, t.torrent, sha, name);
      magnet = t.magnet;
      status.torrent = { infoHash: t.infoHash, magnet, seeding: 'registered with the artifacts seeder (apps/artifacts)' };
    }
  }
  const inv = r.value.inventory;
  const template = buildCatalogAnnouncementTemplate({
    zipSha256: sha,
    zipSize: zip.length,
    urls,
    ...(magnet ? { magnet } : {}),
    content:
      o.description ??
      `weXare micro-model catalog snapshot: ${inv.record_count} release records, built ${new Date(inv.build_time * 1000).toISOString()} under policy ${inv.collection_policy}.`,
  });
  const announcement = finalizeEvent(template, o.builder.secretKey) as unknown as NostrEvent;
  const check = verifyCatalogAnnouncement(announcement);
  if (!check.ok) throw new Error(`announcement failed verification: ${check.errors.map((e) => e.message).join('; ')}`);
  const announcementPath = o.zipPath.replace(/\.zip$/, '.announcement.json');
  await writeFile(announcementPath, JSON.stringify(announcement, null, 2) + '\n');

  if (o.relays?.length) {
    const results = await publishToRelays(announcement, o.relays);
    printPublishResults(`archive announcement ${announcement.id.slice(0, 16)}…`, results);
    status.relays = results.map(({ relay, outcome, message }) => ({ relay, outcome, message }));
  }
  if (o.indexerDb) {
    const db = new NodeSqliteDatabase(o.indexerDb);
    try {
      migrateOperator(db);
      new OperatorStore(db).updateArchivePublication(sha, { ...status, announcementPath }, announcement.id);
    } finally {
      db.close();
    }
  }
  return { announcement, announcementPath, status };
}
