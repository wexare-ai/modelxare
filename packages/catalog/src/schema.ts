import type { SqlDatabase } from './db.ts';

/**
 * Catalog schema migrations, shared by the indexer, archive builder and
 * browser. Each entry runs once, in order; `meta.schema_version` tracks progress.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Full original signed events. Only verified events are stored.
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    envelope TEXT NOT NULL,
    verification TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL
  );

  CREATE TABLE releases (
    event_id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL,
    license_id TEXT NOT NULL,
    runtime_format TEXT NOT NULL,
    runtime_family TEXT NOT NULL,
    runtime_requirement TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    download_bytes INTEGER NOT NULL,
    context_length INTEGER NOT NULL,
    memory_mb INTEGER,
    memory_basis TEXT,
    memory_context_length INTEGER,
    synthetic INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX releases_family ON releases(pubkey, model_id, version);
  CREATE INDEX releases_kind_runtime ON releases(kind, runtime_family);
  CREATE INDEX releases_size ON releases(download_bytes);
  CREATE INDEX releases_created ON releases(created_at);
  CREATE INDEX releases_license ON releases(license_id);

  CREATE TABLE capabilities (event_id TEXT NOT NULL, capability TEXT NOT NULL, PRIMARY KEY (event_id, capability)) WITHOUT ROWID;
  CREATE INDEX capabilities_by_value ON capabilities(capability, event_id);
  CREATE TABLE languages (event_id TEXT NOT NULL, language TEXT NOT NULL, PRIMARY KEY (event_id, language)) WITHOUT ROWID;
  CREATE INDEX languages_by_value ON languages(language, event_id);
  CREATE TABLE hardware_profiles (event_id TEXT NOT NULL, profile TEXT NOT NULL, PRIMARY KEY (event_id, profile)) WITHOUT ROWID;

  CREATE TABLE files (
    event_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    role TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (event_id, idx)
  ) WITHOUT ROWID;
  CREATE INDEX files_by_sha ON files(sha256);
  CREATE TABLE file_locations (
    event_id TEXT NOT NULL,
    file_idx INTEGER NOT NULL,
    loc_idx INTEGER NOT NULL,
    transport TEXT NOT NULL,
    uri TEXT NOT NULL,
    torrent_path TEXT,
    PRIMARY KEY (event_id, file_idx, loc_idx)
  ) WITHOUT ROWID;

  CREATE TABLE dependencies (
    event_id TEXT PRIMARY KEY,
    base_event_id TEXT NOT NULL,
    base_manifest_sha256 TEXT NOT NULL,
    base_files TEXT NOT NULL
  );
  CREATE INDEX dependencies_by_base ON dependencies(base_event_id);

  -- Relays, catalogs and manual imports, and which events each one supplied.
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT,
    builder_pubkey TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL,
    last_import_at INTEGER,
    details TEXT
  );
  CREATE TABLE source_memberships (
    source_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, event_id)
  ) WITHOUT ROWID;
  CREATE INDEX memberships_by_event ON source_memberships(event_id, source_id);

  -- Verified local bytes, keyed by content hash.
  CREATE TABLE cached_artifacts (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    store TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE releases_fts USING fts5(
    event_id UNINDEXED, name, description, capabilities, model_id,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

export function migrate(db: SqlDatabase): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!.replace('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);', '');
    db.transaction(() => {
      db.exec(sql);
      version++;
      db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(version)]);
    });
  }
  return version;
}
