// Operator-side tables layered on the catalog schema: per-relay collection
// state, rejections, a collection log, and archive builds. Used by the indexer
// and the archive builder (CLI); never shipped to browsers.
import type { CatalogInventory, CoverageState } from '@wexare/protocol';
import type { SqlDatabase } from './db.ts';
import { migrate } from './schema.ts';

const OPERATOR_MIGRATIONS = [
  `
  CREATE TABLE relay_state (
    url TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_connected_at INTEGER,
    last_eose_at INTEGER,
    cursor INTEGER,
    possibly_incomplete INTEGER NOT NULL DEFAULT 0,
    incomplete_reasons TEXT NOT NULL DEFAULT '[]',
    events_received INTEGER NOT NULL DEFAULT 0,
    accepted_new INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    unknown_profile INTEGER NOT NULL DEFAULT 0,
    catalog_ignored INTEGER NOT NULL DEFAULT 0,
    reconnects INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE rejected_events (
    event_id TEXT NOT NULL,
    relay TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (event_id, relay)
  ) WITHOUT ROWID;
  CREATE TABLE collection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    relay TEXT,
    level TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE archive_builds (
    zip_sha256 TEXT PRIMARY KEY,
    built_at INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    zip_size INTEGER NOT NULL,
    path TEXT NOT NULL,
    inventory TEXT NOT NULL,
    announcement_id TEXT,
    publication TEXT NOT NULL DEFAULT '{}'
  );
  `,
];

export function migrateOperator(db: SqlDatabase): void {
  migrate(db);
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'operator_schema_version'`);
  let v = row ? Number(row.value) : 0;
  while (v < OPERATOR_MIGRATIONS.length) {
    db.transaction(() => {
      db.exec(OPERATOR_MIGRATIONS[v]!);
      v++;
      db.run(`INSERT INTO meta (key, value) VALUES ('operator_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(v)]);
    });
  }
}

export type RelayStatus = 'connecting' | 'catching-up' | 'live' | 'degraded' | 'disconnected';

export interface RelayStateRow {
  url: string;
  status: RelayStatus;
  lastConnectedAt: number | null;
  lastEoseAt: number | null;
  cursor: number | null;
  possiblyIncomplete: boolean;
  incompleteReasons: string[];
  eventsReceived: number;
  acceptedNew: number;
  duplicates: number;
  rejected: number;
  unknownProfile: number;
  catalogIgnored: number;
  reconnects: number;
  lastError: string | null;
  lastErrorAt: number | null;
  updatedAt: number | null;
}

export type RelayCounter = 'events_received' | 'accepted_new' | 'duplicates' | 'rejected' | 'unknown_profile' | 'catalog_ignored' | 'reconnects';

const now = () => Math.floor(Date.now() / 1000);

export class OperatorStore {
  constructor(readonly db: SqlDatabase) {}

  ensureRelay(url: string): void {
    this.db.run(`INSERT OR IGNORE INTO relay_state (url, status, updated_at) VALUES (?, 'disconnected', ?)`, [url, now()]);
  }

  setStatus(url: string, status: RelayStatus, extra: { connected?: boolean } = {}): void {
    this.db.run(
      `UPDATE relay_state SET status = ?, updated_at = ?, last_connected_at = CASE WHEN ? THEN ? ELSE last_connected_at END WHERE url = ?`,
      [status, now(), extra.connected ? 1 : 0, now(), url],
    );
  }

  bump(url: string, counter: RelayCounter, n = 1): void {
    this.db.run(`UPDATE relay_state SET ${counter} = ${counter} + ? WHERE url = ?`, [n, url]);
  }

  /** Record a finished catch-up. Advance the cursor only up to what was fully covered. */
  completeCatchUp(url: string, cursor: number): void {
    this.db.run('UPDATE relay_state SET last_eose_at = ?, cursor = MAX(COALESCE(cursor, 0), ?), updated_at = ? WHERE url = ?', [now(), cursor, now(), url]);
  }

  markIncomplete(url: string, reason: string): void {
    const row = this.get(url);
    const reasons = [...new Set([...(row?.incompleteReasons ?? []), reason])].slice(-20);
    this.db.run('UPDATE relay_state SET possibly_incomplete = 1, incomplete_reasons = ? WHERE url = ?', [JSON.stringify(reasons), url]);
  }

  clearIncomplete(url: string): void {
    this.db.run(`UPDATE relay_state SET possibly_incomplete = 0, incomplete_reasons = '[]' WHERE url = ?`, [url]);
  }

  recordError(url: string, message: string): void {
    this.db.run('UPDATE relay_state SET last_error = ?, last_error_at = ? WHERE url = ?', [message.slice(0, 500), now(), url]);
    this.log('error', 'relay_error', message, url);
  }

  recordRejection(url: string, eventId: string, code: string, message: string): void {
    this.db.run('INSERT OR REPLACE INTO rejected_events (event_id, relay, code, message, at) VALUES (?, ?, ?, ?, ?)', [eventId, url, code, message.slice(0, 500), now()]);
  }

  log(level: 'info' | 'warn' | 'error', code: string, message: string, relay?: string): void {
    this.db.run('INSERT INTO collection_log (at, relay, level, code, message) VALUES (?, ?, ?, ?, ?)', [now(), relay ?? null, level, code, message.slice(0, 1000)]);
    this.db.run('DELETE FROM collection_log WHERE id <= (SELECT max(id) - 2000 FROM collection_log)');
  }

  get(url: string): RelayStateRow | undefined {
    return this.list().find((r) => r.url === url);
  }

  list(): RelayStateRow[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM relay_state ORDER BY url').map((r) => ({
      url: r.url as string,
      status: r.status as RelayStatus,
      lastConnectedAt: (r.last_connected_at as number | null) ?? null,
      lastEoseAt: (r.last_eose_at as number | null) ?? null,
      cursor: (r.cursor as number | null) ?? null,
      possiblyIncomplete: Number(r.possibly_incomplete) === 1,
      incompleteReasons: JSON.parse((r.incomplete_reasons as string) || '[]'),
      eventsReceived: Number(r.events_received),
      acceptedNew: Number(r.accepted_new),
      duplicates: Number(r.duplicates),
      rejected: Number(r.rejected),
      unknownProfile: Number(r.unknown_profile),
      catalogIgnored: Number(r.catalog_ignored),
      reconnects: Number(r.reconnects),
      lastError: (r.last_error as string | null) ?? null,
      lastErrorAt: (r.last_error_at as number | null) ?? null,
      updatedAt: (r.updated_at as number | null) ?? null,
    }));
  }

  recentLog(limit = 50): { at: number; relay: string | null; level: string; code: string; message: string }[] {
    return this.db.all('SELECT at, relay, level, code, message FROM collection_log ORDER BY id DESC LIMIT ?', [limit]);
  }

  rejectionCounts(): Record<string, number> {
    const rows = this.db.all<{ code: string; n: number }>('SELECT code, count(*) AS n FROM rejected_events GROUP BY code');
    return Object.fromEntries(rows.map((r) => [r.code, Number(r.n)]));
  }

  /** Coverage declared in an archive inventory. Never claims global completeness. */
  coverage(configuredRelays: string[]): CatalogInventory['coverage'] {
    const rows = new Map(this.list().map((r) => [r.url, r]));
    const relays = configuredRelays.map((url) => {
      const r = rows.get(url);
      const membership = Number(
        this.db.get<{ n: number }>('SELECT count(*) AS n FROM source_memberships WHERE source_id = ?', [`relay:${url}`])?.n ?? 0,
      );
      let state: CoverageState;
      let notes: string | undefined;
      if (!r || r.lastConnectedAt === null) state = 'never-connected';
      else if (r.possiblyIncomplete) {
        state = 'possibly-incomplete';
        notes = r.incompleteReasons.join('; ');
      } else if (r.lastEoseAt === null) state = 'unavailable';
      else {
        state = 'caught-up';
        if (r.status === 'disconnected' || r.status === 'degraded') notes = `relay was ${r.status} at build time; coverage as of last completed catch-up`;
      }
      return { url, state, events: membership, last_success_at: r?.lastEoseAt ?? null, ...(notes ? { notes } : {}) };
    });
    return {
      statement:
        'Verified release events this builder collected from the listed relays under its collection policy. Coverage is limited to what those relays retained and returned; it is not a list of every published release.',
      relays,
    };
  }

  recordArchiveBuild(b: { zipSha256: string; recordCount: number; zipSize: number; path: string; inventory: CatalogInventory }): void {
    this.db.run(
      'INSERT OR IGNORE INTO archive_builds (zip_sha256, built_at, record_count, zip_size, path, inventory) VALUES (?, ?, ?, ?, ?, ?)',
      [b.zipSha256, now(), b.recordCount, b.zipSize, b.path, JSON.stringify(b.inventory)],
    );
  }

  updateArchivePublication(zipSha256: string, patch: Record<string, unknown>, announcementId?: string): void {
    const row = this.db.get<{ publication: string }>('SELECT publication FROM archive_builds WHERE zip_sha256 = ?', [zipSha256]);
    const merged = { ...(row ? JSON.parse(row.publication) : {}), ...patch };
    this.db.run('UPDATE archive_builds SET publication = ?, announcement_id = COALESCE(?, announcement_id) WHERE zip_sha256 = ?', [
      JSON.stringify(merged),
      announcementId ?? null,
      zipSha256,
    ]);
  }

  archiveBuilds(): { zipSha256: string; builtAt: number; recordCount: number; zipSize: number; path: string; announcementId: string | null; publication: Record<string, unknown> }[] {
    return this.db
      .all<{ zip_sha256: string; built_at: number; record_count: number; zip_size: number; path: string; announcement_id: string | null; publication: string }>(
        'SELECT zip_sha256, built_at, record_count, zip_size, path, announcement_id, publication FROM archive_builds ORDER BY built_at DESC',
      )
      .map((r) => ({
        zipSha256: r.zip_sha256,
        builtAt: Number(r.built_at),
        recordCount: Number(r.record_count),
        zipSize: Number(r.zip_size),
        path: r.path,
        announcementId: r.announcement_id,
        publication: JSON.parse(r.publication),
      }));
  }
}
