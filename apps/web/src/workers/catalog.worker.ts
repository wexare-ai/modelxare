/// <reference lib="webworker" />
// Catalog worker: official SQLite WASM with FTS5, persisted in OPFS through the
// SAH pool VFS (no cross-origin-isolation headers required). Every row is
// derived from a verified original event; imports are staged, then committed
// in one transaction.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { CatalogStore, makeTransaction, readArchive, sourceIdFor, type SqlDatabase, type SqlValue } from '@wexare/catalog';
import { CATALOG_TAG, RELEASE_TAG, verifyCatalogAnnouncement, verifyReleaseEvent, type NostrEvent, type VerifiedRelease } from '@wexare/protocol';
import type { CatalogApi, IngestResult, StagedImport, WorkerRequest, WorkerResponse } from './catalog-api.ts';

type Db = {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
  selectValue(sql: string): unknown;
};
type Stmt = { bind(v: SqlValue[]): Stmt; step(): boolean; get(o: Record<string, never>): Record<string, SqlValue>; reset(clear?: boolean): Stmt; finalize(): void };

class WasmSqliteDatabase implements SqlDatabase {
  private readonly stmts = new Map<string, Stmt>();
  readonly transaction: SqlDatabase['transaction'];
  constructor(readonly raw: Db) {
    this.transaction = makeTransaction((sql) => raw.exec(sql));
  }
  private stmt(sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  run(sql: string, params: SqlValue[] = []) {
    const s = this.stmt(sql);
    try {
      if (params.length) s.bind(params);
      s.step();
    } finally {
      s.reset(true);
    }
  }
  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const s = this.stmt(sql);
    const out: T[] = [];
    try {
      if (params.length) s.bind(params);
      while (s.step()) out.push(s.get({}) as T);
    } finally {
      s.reset(true);
    }
    return out;
  }
  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }
  finalizeAll() {
    for (const s of this.stmts.values()) s.finalize();
    this.stmts.clear();
  }
}

const DB_FILE = '/wexare-catalog.sqlite3';
let db: WasmSqliteDatabase;
let store: CatalogStore;
let pool: { getFileNames(): string[]; wipeFiles(): Promise<void>; OpfsSAHPoolDb: new (f: string) => Db } | null = null;
let sqliteVersion = '';
let persistent = false;
const staged = new Map<string, { releases: VerifiedRelease[]; builder: string; meta: StagedImport; announcement: NostrEvent | null }>();

type Sqlite3 = {
  version: { libVersion: string };
  installOpfsSAHPoolVfs(o: { name: string; preserveOnInitFailure: boolean; forceReinitIfPreviouslyFailed: boolean }): Promise<NonNullable<typeof pool>>;
  oo1: { DB: new (f: string, mode: string) => Db };
};

/**
 * The pool holds exclusive OPFS access handles. After a reload, the previous
 * page's worker can keep them for a moment, so retry with backoff. A failed
 * attempt must never delete the stored catalog (preserveOnInitFailure).
 */
async function installPool(sqlite3: Sqlite3): Promise<NonNullable<typeof pool>> {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'wexare-sahpool', preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true });
    } catch (e) {
      last = e;
      if (/Missing required OPFS APIs/.test(String((e as Error)?.message))) break;
      await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt)));
    }
  }
  throw last;
}

async function open() {
  const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;
  sqliteVersion = sqlite3.version.libVersion;
  try {
    pool = await installPool(sqlite3);
    db = new WasmSqliteDatabase(new pool.OpfsSAHPoolDb(DB_FILE));
    persistent = true;
  } catch (e) {
    console.warn('OPFS SAH pool unavailable; using an in-memory catalog', e);
    db = new WasmSqliteDatabase(new sqlite3.oo1.DB(':memory:', 'c'));
  }
  // 64 MiB page cache: a 10,000-record catalog (~55 MB) stays in memory once warm.
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;');
  store = new CatalogStore(db);
  return store.migrate();
}

const ready = open();

const api: CatalogApi = {
  init() {
    return { persistent, vfs: persistent ? 'opfs-sahpool' : 'memory', sqliteVersion, schemaVersion: Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)?.value ?? 0), stats: store.stats() };
  },
  query(q) {
    const t0 = performance.now();
    const page = store.query(q);
    return { ...page, ms: Math.round((performance.now() - t0) * 10) / 10 };
  },
  getRelease: (id) => store.getRelease(id),
  candidates() {
    return db.all<{ event_id: string; pubkey: string; manifest_json: string; manifest_sha256: string }>(
      `SELECT r.event_id, r.pubkey, r.manifest_json, r.manifest_sha256 FROM releases r
       WHERE r.synthetic = 0 AND EXISTS (SELECT 1 FROM source_memberships sm JOIN sources s ON s.id = sm.source_id WHERE sm.event_id = r.event_id AND s.enabled = 1)
       ORDER BY r.event_id`,
    ).map((r) => ({ eventId: r.event_id, pubkey: r.pubkey, manifestJson: r.manifest_json, manifestSha256: r.manifest_sha256 }));
  },
  ingestEvents(relayUrl, events) {
    const out: IngestResult = { accepted: 0, duplicates: 0, rejected: [], unknownProfile: 0, catalogAnnouncements: [] };
    const sourceId = sourceIdFor.relay(relayUrl);
    db.transaction(() => {
      store.upsertSource({ id: sourceId, type: 'relay', label: relayUrl, url: relayUrl });
      for (const raw of events) {
        const t = ((raw as NostrEvent)?.tags ?? []).filter((x) => Array.isArray(x) && x[0] === 't').map((x) => x[1]);
        if (t.includes(CATALOG_TAG)) {
          const a = verifyCatalogAnnouncement(raw);
          if (a.ok) out.catalogAnnouncements.push(a.value.event);
          else out.rejected.push({ id: String((raw as NostrEvent)?.id ?? '?'), code: a.errors[0]!.code, message: a.errors[0]!.message });
          continue;
        }
        if (!t.includes(RELEASE_TAG)) {
          out.unknownProfile++;
          continue;
        }
        const r = verifyReleaseEvent(raw);
        if (!r.ok) {
          out.rejected.push({ id: String((raw as NostrEvent)?.id ?? '?').slice(0, 64), code: r.errors[0]!.code, message: r.errors[0]!.message });
          continue;
        }
        if (store.addVerifiedRelease(r.value, sourceId)) out.accepted++;
        else out.duplicates++;
      }
    });
    return out;
  },
  stageArchive(zip, announcement) {
    const t0 = performance.now();
    let expected: { expectedSha256?: string; expectedSize?: number; expectedBuilder?: string } = {};
    if (announcement) {
      const a = verifyCatalogAnnouncement(announcement);
      if (!a.ok) return { ok: false, errors: a.errors };
      expected = { expectedSha256: a.value.zipSha256, expectedSize: a.value.zipSize, expectedBuilder: a.value.event.pubkey };
    }
    const r = readArchive(zip, expected);
    if (!r.ok) return { ok: false, errors: r.errors };
    const token = crypto.randomUUID();
    const alreadyKnown = r.value.releases.filter((x) => store.hasEvent(x.event.id)).length;
    const meta: StagedImport = {
      token,
      builderPubkey: r.value.inventory.builder_pubkey,
      announcementId: announcement?.id ?? null,
      inventory: r.value.inventory,
      recordCount: r.value.releases.length,
      zipSha256: r.value.zipSha256,
      zipSize: zip.length,
      verifyMs: Math.round(performance.now() - t0),
      alreadyKnown,
    };
    staged.set(token, { releases: r.value.releases, builder: r.value.inventory.builder_pubkey, meta, announcement });
    return { ok: true, staged: meta };
  },
  commitArchive(token, label) {
    const s = staged.get(token);
    if (!s) throw new Error('nothing staged for this token');
    const t0 = performance.now();
    const res = store.replaceSourceSnapshot(
      {
        id: sourceIdFor.catalog(s.builder),
        type: s.announcement ? 'catalog' : 'manual',
        label,
        builderPubkey: s.builder,
        details: {
          announcementId: s.meta.announcementId,
          zipSha256: s.meta.zipSha256,
          buildTime: s.meta.inventory.build_time,
          collectionPolicy: s.meta.inventory.collection_policy,
          coverage: s.meta.inventory.coverage,
          recordCount: s.meta.recordCount,
          announcement: s.announcement,
        },
      },
      s.releases,
    );
    staged.delete(token);
    return { ...res, ms: Math.round(performance.now() - t0) };
  },
  discardStaged: (token) => void staged.delete(token),
  listSources: () => store.listSources(),
  setSourceEnabled: (id, enabled) => store.setSourceEnabled(id, enabled),
  removeSource: (id) => store.removeSource(id),
  markCached: (sha, size, s) => store.markCached(sha, size, s),
  unmarkCached: (sha) => store.unmarkCached(sha),
  cachedArtifacts: () => store.cachedArtifacts(),
  stats() {
    const pages = Number(db.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0);
    const size = Number(db.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0);
    return { ...store.stats(), dbBytes: pages * size };
  },
  conflicts: () => store.conflicts(),
  resetCatalog() {
    db.transaction(() => {
      for (const t of ['events', 'releases', 'capabilities', 'languages', 'hardware_profiles', 'files', 'file_locations', 'dependencies', 'sources', 'source_memberships', 'releases_fts']) {
        db.run(`DELETE FROM ${t}`);
      }
    });
  },
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, method, args } = ev.data;
  let res: WorkerResponse;
  try {
    await ready;
    const fn = api[method] as (...a: unknown[]) => unknown;
    res = { id, result: await fn(...args) };
  } catch (e) {
    res = { id, error: (e as Error)?.message ?? String(e) };
  }
  (self as unknown as Worker).postMessage(res);
};
