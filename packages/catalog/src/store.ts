import { serializeEnvelope, type NostrEvent, type ReleaseManifest, type VerifiedRelease } from '@wexare/protocol';
import type { SqlDatabase } from './db.ts';
import { buildCatalogQuery, rowToSummary, type CatalogQuery, type QueryPage, type ReleaseRow, type SourceType } from './query.ts';
import { migrate } from './schema.ts';

export interface SourceRecord {
  id: string;
  type: SourceType;
  label: string;
  url: string | null;
  builderPubkey: string | null;
  enabled: boolean;
  addedAt: number;
  lastImportAt: number | null;
  details: Record<string, unknown>;
  memberCount: number;
}

export interface ReleaseDetail {
  eventId: string;
  event: NostrEvent;
  manifest: ReleaseManifest;
  manifestJson: string;
  manifestSha256: string;
  verification: { status: 'valid'; warnings: { code: string; message: string }[]; verifiedAt: number };
  firstSeenAt: number;
  sources: { id: string; type: SourceType; label: string; enabled: boolean; observedAt: number }[];
  cachedFiles: string[];
}

export interface Conflict {
  pubkey: string;
  modelId: string;
  version: string;
  eventIds: string[];
}

export interface CatalogStats {
  events: number;
  releases: number;
  synthetic: number;
  sources: number;
  cachedArtifacts: number;
  conflicts: number;
}

export const sourceIdFor = {
  relay: (url: string) => `relay:${url}`,
  catalog: (builderPubkey: string) => `catalog:${builderPubkey}`,
  manual: () => 'manual:local',
};

const now = () => Math.floor(Date.now() / 1000);

/** Catalog operations over the shared schema. Rows are always derived from verified original events. */
export class CatalogStore {
  constructor(readonly db: SqlDatabase) {}

  migrate(): number {
    return migrate(this.db);
  }

  hasEvent(id: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM events WHERE id = ?', [id]);
  }

  upsertSource(s: { id: string; type: SourceType; label: string; url?: string | null; builderPubkey?: string | null; details?: Record<string, unknown> }): void {
    this.db.run(
      `INSERT INTO sources (id, type, label, url, builder_pubkey, enabled, added_at, details) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, url = excluded.url, builder_pubkey = excluded.builder_pubkey,
         details = COALESCE(excluded.details, sources.details)`,
      [s.id, s.type, s.label, s.url ?? null, s.builderPubkey ?? null, now(), s.details ? JSON.stringify(s.details) : null],
    );
  }

  setSourceEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE sources SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  }

  markSourceImported(id: string, details?: Record<string, unknown>): void {
    this.db.run('UPDATE sources SET last_import_at = ?, details = COALESCE(?, details) WHERE id = ?', [now(), details ? JSON.stringify(details) : null, id]);
  }

  listSources(): SourceRecord[] {
    return this.db
      .all<{ id: string; type: SourceType; label: string; url: string | null; builder_pubkey: string | null; enabled: number; added_at: number; last_import_at: number | null; details: string | null; n: number }>(
        `SELECT s.*, (SELECT count(*) FROM source_memberships sm WHERE sm.source_id = s.id) AS n FROM sources s ORDER BY s.type, s.label`,
      )
      .map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label,
        url: r.url,
        builderPubkey: r.builder_pubkey,
        enabled: Number(r.enabled) === 1,
        addedAt: Number(r.added_at),
        lastImportAt: r.last_import_at === null ? null : Number(r.last_import_at),
        details: r.details ? JSON.parse(r.details) : {},
        memberCount: Number(r.n),
      }));
  }

  /**
   * Insert a verified release (idempotent by event ID) and record that
   * `sourceId` supplied it. Returns true when the event was new.
   */
  addVerifiedRelease(rel: VerifiedRelease, sourceId: string, observedAt = now()): boolean {
    const isNew = !this.hasEvent(rel.event.id);
    if (isNew) this.insertRelease(rel, observedAt);
    this.db.run('INSERT OR IGNORE INTO source_memberships (source_id, event_id, observed_at) VALUES (?, ?, ?)', [sourceId, rel.event.id, observedAt]);
    return isNew;
  }

  private insertRelease(rel: VerifiedRelease, seenAt: number): void {
    const { event: e, manifest: m } = rel;
    const synthetic = m.labels?.includes('synthetic') ? 1 : 0;
    this.db.run('INSERT INTO events (id, pubkey, kind, created_at, envelope, verification, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      e.id,
      e.pubkey,
      e.kind,
      e.created_at,
      serializeEnvelope(e),
      JSON.stringify({ status: 'valid', warnings: rel.warnings, verifiedAt: now() }),
      seenAt,
    ]);
    this.db.run(
      `INSERT INTO releases (event_id, pubkey, model_id, name, description, version, kind, license_id, runtime_format, runtime_family,
         runtime_requirement, manifest_sha256, manifest_json, download_bytes, context_length, memory_mb, memory_basis, memory_context_length,
         synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        e.pubkey,
        m.model_id,
        m.name,
        m.description,
        m.version,
        m.kind,
        m.license.id,
        m.runtime.format,
        m.runtime.family,
        m.runtime.requirement,
        rel.manifestSha256,
        rel.manifestJson,
        m.files.reduce((n, f) => n + f.size, 0),
        m.requirements.context_length,
        m.requirements.memory_mb?.value ?? null,
        m.requirements.memory_mb?.basis ?? null,
        m.requirements.memory_mb?.context_length ?? null,
        synthetic,
        e.created_at,
      ],
    );
    for (const c of m.capabilities) this.db.run('INSERT INTO capabilities (event_id, capability) VALUES (?, ?)', [e.id, c]);
    for (const l of m.languages) this.db.run('INSERT INTO languages (event_id, language) VALUES (?, ?)', [e.id, l]);
    for (const h of m.requirements.hardware_profiles ?? []) this.db.run('INSERT INTO hardware_profiles (event_id, profile) VALUES (?, ?)', [e.id, h]);
    m.files.forEach((f, i) => {
      this.db.run('INSERT INTO files (event_id, idx, role, path, size, sha256) VALUES (?, ?, ?, ?, ?, ?)', [e.id, i, f.role, f.path, f.size, f.sha256]);
      f.locations.forEach((l, j) =>
        this.db.run('INSERT INTO file_locations (event_id, file_idx, loc_idx, transport, uri, torrent_path) VALUES (?, ?, ?, ?, ?, ?)', [e.id, i, j, l.transport, l.uri, l.path ?? null]),
      );
    });
    if (m.base) {
      this.db.run('INSERT INTO dependencies (event_id, base_event_id, base_manifest_sha256, base_files) VALUES (?, ?, ?, ?)', [
        e.id,
        m.base.release_id,
        m.base.manifest_sha256,
        JSON.stringify(m.base.files),
      ]);
    }
    this.db.run('INSERT INTO releases_fts (event_id, name, description, capabilities, model_id) VALUES (?, ?, ?, ?, ?)', [
      e.id,
      m.name,
      m.description,
      m.capabilities.join(' ').replace(/-/g, ' '),
      m.model_id.replace(/[._-]/g, ' '),
    ]);
  }

  private deleteEvent(id: string): void {
    for (const t of ['capabilities', 'languages', 'hardware_profiles', 'files', 'file_locations', 'dependencies', 'releases_fts', 'releases']) {
      this.db.run(`DELETE FROM ${t} WHERE event_id = ?`, [id]);
    }
    this.db.run('DELETE FROM source_memberships WHERE event_id = ?', [id]);
    this.db.run('DELETE FROM events WHERE id = ?', [id]);
  }

  /** Delete events no source references any more. Records still referenced elsewhere are kept. */
  pruneOrphans(): number {
    const orphans = this.db.all<{ id: string }>('SELECT id FROM events e WHERE NOT EXISTS (SELECT 1 FROM source_memberships sm WHERE sm.event_id = e.id)');
    for (const o of orphans) this.deleteEvent(o.id);
    return orphans.length;
  }

  /** Remove a source and its memberships, then prune records nothing else supplies. */
  removeSource(id: string): number {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM source_memberships WHERE source_id = ?', [id]);
      this.db.run('DELETE FROM sources WHERE id = ?', [id]);
      return this.pruneOrphans();
    });
  }

  /**
   * Replace the membership set of a catalog source with a new snapshot, in one
   * transaction. Called only after every record was verified.
   */
  replaceSourceSnapshot(
    source: { id: string; type: SourceType; label: string; url?: string | null; builderPubkey?: string | null; details?: Record<string, unknown> },
    releases: VerifiedRelease[],
  ): { added: number; total: number; pruned: number } {
    return this.db.transaction(() => {
      this.upsertSource(source);
      this.db.run('DELETE FROM source_memberships WHERE source_id = ?', [source.id]);
      let added = 0;
      const t = now();
      for (const r of releases) if (this.addVerifiedRelease(r, source.id, t)) added++;
      const pruned = this.pruneOrphans();
      this.markSourceImported(source.id, source.details);
      return { added, total: releases.length, pruned };
    });
  }

  query(q: CatalogQuery): QueryPage {
    const { sql, params } = buildCatalogQuery(q);
    const rows = this.db.all<ReleaseRow>(sql, params);
    return { total: rows.length ? Number(rows[0]!.total) : 0, items: rows.map(rowToSummary) };
  }

  getRelease(eventId: string): ReleaseDetail | null {
    const r = this.db.get<{ envelope: string; verification: string; first_seen_at: number; manifest_json: string; manifest_sha256: string }>(
      'SELECT e.envelope, e.verification, e.first_seen_at, r.manifest_json, r.manifest_sha256 FROM events e JOIN releases r ON r.event_id = e.id WHERE e.id = ?',
      [eventId],
    );
    if (!r) return null;
    const manifest = JSON.parse(r.manifest_json) as ReleaseManifest;
    const sources = this.db
      .all<{ id: string; type: SourceType; label: string; enabled: number; observed_at: number }>(
        'SELECT s.id, s.type, s.label, s.enabled, sm.observed_at FROM source_memberships sm JOIN sources s ON s.id = sm.source_id WHERE sm.event_id = ? ORDER BY sm.observed_at',
        [eventId],
      )
      .map((s) => ({ id: s.id, type: s.type, label: s.label, enabled: Number(s.enabled) === 1, observedAt: Number(s.observed_at) }));
    const shas = manifest.files.map((f) => f.sha256);
    const cachedFiles = shas.length
      ? this.db.all<{ sha256: string }>(`SELECT sha256 FROM cached_artifacts WHERE sha256 IN (${shas.map(() => '?').join(', ')})`, shas).map((x) => x.sha256)
      : [];
    return {
      eventId,
      event: JSON.parse(r.envelope),
      manifest,
      manifestJson: r.manifest_json,
      manifestSha256: r.manifest_sha256,
      verification: JSON.parse(r.verification),
      firstSeenAt: Number(r.first_seen_at),
      sources,
      cachedFiles,
    };
  }

  /** Original signed envelopes, sorted by event ID (archive order). */
  allEnvelopes(opts: { sourceIds?: string[] } = {}): string[] {
    if (opts.sourceIds?.length) {
      return this.db
        .all<{ envelope: string }>(
          `SELECT DISTINCT e.id, e.envelope FROM events e JOIN source_memberships sm ON sm.event_id = e.id WHERE sm.source_id IN (${opts.sourceIds.map(() => '?').join(', ')}) ORDER BY e.id`,
          opts.sourceIds,
        )
        .map((r) => r.envelope);
    }
    return this.db.all<{ envelope: string }>('SELECT envelope FROM events ORDER BY id').map((r) => r.envelope);
  }

  eventIds(): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM events ORDER BY id').map((r) => r.id);
  }

  /** Same publisher/model/version label with different manifests: shown as conflicts, never overwritten. */
  conflicts(): Conflict[] {
    return this.db
      .all<{ pubkey: string; model_id: string; version: string; ids: string }>(
        `SELECT pubkey, model_id, version, group_concat(event_id, ' ') AS ids FROM releases
         GROUP BY pubkey, model_id, version HAVING count(DISTINCT manifest_sha256) > 1`,
      )
      .map((r) => ({ pubkey: r.pubkey, modelId: r.model_id, version: r.version, eventIds: r.ids.split(' ').sort() }));
  }

  markCached(sha256: string, size: number, store: string): void {
    this.db.run(
      'INSERT INTO cached_artifacts (sha256, size, verified_at, store) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET verified_at = excluded.verified_at, store = excluded.store',
      [sha256, size, now(), store],
    );
  }

  unmarkCached(sha256: string): void {
    this.db.run('DELETE FROM cached_artifacts WHERE sha256 = ?', [sha256]);
  }

  cachedArtifacts(): { sha256: string; size: number; verifiedAt: number; store: string }[] {
    return this.db
      .all<{ sha256: string; size: number; verified_at: number; store: string }>('SELECT * FROM cached_artifacts ORDER BY verified_at DESC')
      .map((r) => ({ sha256: r.sha256, size: Number(r.size), verifiedAt: Number(r.verified_at), store: r.store }));
  }

  /** Releases that depend on the given base event (for LoRA lookups). */
  dependentsOf(baseEventId: string): string[] {
    return this.db.all<{ event_id: string }>('SELECT event_id FROM dependencies WHERE base_event_id = ? ORDER BY event_id', [baseEventId]).map((r) => r.event_id);
  }

  stats(): CatalogStats {
    const n = (sql: string) => Number(this.db.get<{ n: number }>(sql)?.n ?? 0);
    return {
      events: n('SELECT count(*) AS n FROM events'),
      releases: n('SELECT count(*) AS n FROM releases'),
      synthetic: n('SELECT count(*) AS n FROM releases WHERE synthetic = 1'),
      sources: n('SELECT count(*) AS n FROM sources'),
      cachedArtifacts: n('SELECT count(*) AS n FROM cached_artifacts'),
      conflicts: this.conflicts().length,
    };
  }
}
