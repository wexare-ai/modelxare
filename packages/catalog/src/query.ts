import type { SqlValue } from './db.ts';

export type SourceType = 'relay' | 'catalog' | 'manual';

/** Typed local query contract, shared by the browser worker, the indexer and golden fixtures. */
export interface CatalogQuery {
  /** Keyword search over name, description, capabilities and model id (FTS5). */
  text?: string;
  /** All of these capabilities are required (intersection). */
  capabilities?: string[];
  /** Any of these languages. */
  languages?: string[];
  kind?: 'model' | 'lora';
  runtimeFamily?: string;
  format?: string;
  license?: string;
  maxDownloadBytes?: number;
  /** Only releases that report memory <= this value; unknown memory never matches unless includeUnknownMemory. */
  maxMemoryMb?: number;
  includeUnknownMemory?: boolean;
  hardwareProfile?: string;
  cached?: boolean;
  publishers?: string[];
  /** Restrict to records supplied by enabled sources of these types (Live = relay, Archives = catalog + manual). */
  sourceTypes?: SourceType[];
  /** Restrict to records supplied by these source ids. */
  sourceIds?: string[];
  includeSynthetic?: boolean;
  orderBy?: 'relevance' | 'newest' | 'name' | 'size';
  limit?: number;
  offset?: number;
}

export interface ReleaseSummary {
  eventId: string;
  pubkey: string;
  modelId: string;
  name: string;
  description: string;
  version: string;
  kind: 'model' | 'lora';
  licenseId: string;
  runtimeFamily: string;
  runtimeFormat: string;
  downloadBytes: number;
  contextLength: number;
  memoryMb: number | null;
  memoryBasis: 'measured' | 'estimated' | null;
  synthetic: boolean;
  createdAt: number;
  capabilities: string[];
  languages: string[];
  sourceIds: string[];
  cached: boolean;
}

export interface QueryPage {
  total: number;
  items: ReleaseSummary[];
}

const SEP = '\u001f';
export const MAX_LIMIT = 200;

/**
 * Convert free text to an FTS5 expression of quoted prefix tokens, so user
 * input cannot inject FTS operators. Returns null when no tokens remain.
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function buildCatalogQuery(q: CatalogQuery): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  const where: string[] = [];
  const fts = q.text ? toFtsQuery(q.text) : null;
  let cte = '';
  let join = '';
  if (fts) {
    cte = 'fts AS (SELECT event_id, bm25(releases_fts, 0, 10.0, 2.0, 4.0, 6.0) AS rank FROM releases_fts WHERE releases_fts MATCH ?), ';
    params.push(fts);
    join = 'JOIN fts ON fts.event_id = r.event_id';
  }

  const sourceConds = ['s.enabled = 1'];
  const sourceParams: SqlValue[] = [];
  if (q.sourceTypes?.length) {
    sourceConds.push(`s.type IN (${placeholders(q.sourceTypes.length)})`);
    sourceParams.push(...q.sourceTypes);
  }
  if (q.sourceIds?.length) {
    sourceConds.push(`s.id IN (${placeholders(q.sourceIds.length)})`);
    sourceParams.push(...q.sourceIds);
  }
  where.push(`EXISTS (SELECT 1 FROM source_memberships sm JOIN sources s ON s.id = sm.source_id WHERE sm.event_id = r.event_id AND ${sourceConds.join(' AND ')})`);
  params.push(...sourceParams);

  const caps = [...new Set(q.capabilities ?? [])];
  if (caps.length) {
    where.push(`r.event_id IN (SELECT event_id FROM capabilities WHERE capability IN (${placeholders(caps.length)}) GROUP BY event_id HAVING count(*) = ?)`);
    params.push(...caps, caps.length);
  }
  if (q.languages?.length) {
    where.push(`EXISTS (SELECT 1 FROM languages l WHERE l.event_id = r.event_id AND l.language IN (${placeholders(q.languages.length)}))`);
    params.push(...q.languages);
  }
  const eq = (col: string, v: SqlValue | undefined) => {
    if (v === undefined) return;
    where.push(`${col} = ?`);
    params.push(v);
  };
  eq('r.kind', q.kind);
  eq('r.runtime_family', q.runtimeFamily);
  eq('r.runtime_format', q.format);
  eq('r.license_id', q.license);
  if (q.maxDownloadBytes !== undefined) {
    where.push('r.download_bytes <= ?');
    params.push(q.maxDownloadBytes);
  }
  if (q.maxMemoryMb !== undefined) {
    where.push(q.includeUnknownMemory ? '(r.memory_mb IS NULL OR r.memory_mb <= ?)' : '(r.memory_mb IS NOT NULL AND r.memory_mb <= ?)');
    params.push(q.maxMemoryMb);
  }
  if (q.hardwareProfile) {
    where.push('EXISTS (SELECT 1 FROM hardware_profiles h WHERE h.event_id = r.event_id AND h.profile = ?)');
    params.push(q.hardwareProfile);
  }
  const cachedExpr = 'NOT EXISTS (SELECT 1 FROM files f WHERE f.event_id = r.event_id AND NOT EXISTS (SELECT 1 FROM cached_artifacts ca WHERE ca.sha256 = f.sha256))';
  if (q.cached !== undefined) where.push(q.cached ? cachedExpr : `NOT (${cachedExpr})`);
  if (q.publishers?.length) {
    where.push(`r.pubkey IN (${placeholders(q.publishers.length)})`);
    params.push(...q.publishers);
  }
  if (!q.includeSynthetic) where.push('r.synthetic = 0');

  const order = (() => {
    switch (q.orderBy ?? (fts ? 'relevance' : 'newest')) {
      case 'relevance':
        return fts ? 'fts.rank ASC, r.event_id ASC' : 'r.created_at DESC, r.event_id ASC';
      case 'name':
        return 'r.name COLLATE NOCASE ASC, r.event_id ASC';
      case 'size':
        return 'r.download_bytes ASC, r.event_id ASC';
      default:
        return 'r.created_at DESC, r.event_id ASC';
    }
  })();

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? 50)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  params.push(limit, offset);

  // Filter, order and count on cheap columns first; per-row details (the
  // correlated subqueries) are only evaluated for the rows of the page.
  const sql = `WITH ${cte}page AS (
       SELECT r.event_id, count(*) OVER () AS total, row_number() OVER (ORDER BY ${order}) AS pos
       FROM releases r ${join}
       WHERE ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT ? OFFSET ?
     )
     SELECT r.event_id, r.pubkey, r.model_id, r.name, r.description, r.version, r.kind, r.license_id,
       r.runtime_family, r.runtime_format, r.download_bytes, r.context_length, r.memory_mb, r.memory_basis,
       r.synthetic, r.created_at,
       (SELECT group_concat(capability, '${SEP}') FROM capabilities c WHERE c.event_id = r.event_id) AS caps,
       (SELECT group_concat(language, '${SEP}') FROM languages l WHERE l.event_id = r.event_id) AS langs,
       (SELECT group_concat(source_id, '${SEP}') FROM source_memberships sm WHERE sm.event_id = r.event_id) AS srcs,
       ${cachedExpr} AS cached,
       page.total AS total
     FROM page JOIN releases r ON r.event_id = page.event_id
     ORDER BY page.pos`;
  return { sql, params };
}

export interface ReleaseRow {
  event_id: string;
  pubkey: string;
  model_id: string;
  name: string;
  description: string;
  version: string;
  kind: string;
  license_id: string;
  runtime_family: string;
  runtime_format: string;
  download_bytes: number;
  context_length: number;
  memory_mb: number | null;
  memory_basis: string | null;
  synthetic: number;
  created_at: number;
  caps: string | null;
  langs: string | null;
  srcs: string | null;
  cached: number;
  total: number;
}

const split = (s: string | null) => (s ? s.split(SEP).sort() : []);

export function rowToSummary(r: ReleaseRow): ReleaseSummary {
  return {
    eventId: r.event_id,
    pubkey: r.pubkey,
    modelId: r.model_id,
    name: r.name,
    description: r.description,
    version: r.version,
    kind: r.kind as ReleaseSummary['kind'],
    licenseId: r.license_id,
    runtimeFamily: r.runtime_family,
    runtimeFormat: r.runtime_format,
    downloadBytes: Number(r.download_bytes),
    contextLength: Number(r.context_length),
    memoryMb: r.memory_mb === null ? null : Number(r.memory_mb),
    memoryBasis: r.memory_basis as ReleaseSummary['memoryBasis'],
    synthetic: Number(r.synthetic) === 1,
    createdAt: Number(r.created_at),
    capabilities: split(r.caps),
    languages: split(r.langs),
    sourceIds: split(r.srcs),
    cached: Number(r.cached) === 1,
  };
}
