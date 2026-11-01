import { unzipSync, zipSync, type Zippable } from 'fflate';
import {
  ARCHIVE_FILES,
  CATALOG_SCHEMA,
  DEFAULT_MAX_EVENT_BYTES,
  RELEASE_SCHEMA,
  serializeEnvelope,
  sha256Hex,
  utf8,
  validateInventorySchema,
  verifyReleaseEvent,
  type CatalogInventory,
  type Issue,
  type NostrEvent,
  type Result,
  type VerifiedRelease,
} from '@wexare/protocol';

export interface ArchiveLimits {
  maxZipBytes: number;
  maxUncompressedBytes: number;
  maxRecords: number;
  maxEventBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxZipBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxRecords: 200_000,
  maxEventBytes: DEFAULT_MAX_EVENT_BYTES,
};

export const DEFAULT_COLLECTION_POLICY = 'wexare.policy.all-valid-releases/0.1';

export interface BuildArchiveInput {
  events: NostrEvent[];
  builderPubkey: string;
  buildTime: number;
  collectionPolicy?: string;
  coverage: CatalogInventory['coverage'];
  /** Optional convenience database generated from the same records. */
  sqlite?: Uint8Array;
}

export interface BuiltArchive {
  zip: Uint8Array;
  sha256: string;
  size: number;
  inventory: CatalogInventory;
}

/** Releases as JSONL: one original signed envelope per line, sorted by event ID, deduplicated. */
export function releasesJsonl(events: NostrEvent[]): string {
  const byId = new Map(events.map((e) => [e.id, e]));
  return [...byId.keys()]
    .sort()
    .map((id) => serializeEnvelope(byId.get(id)!) + '\n')
    .join('');
}

/**
 * Build a full immutable snapshot ZIP. The inner inventory hashes payload files
 * only; the ZIP hash is bound by the outer signed announcement.
 */
export function buildArchive(input: BuildArchiveInput): BuiltArchive {
  for (const e of input.events) {
    const r = verifyReleaseEvent(e);
    if (!r.ok) throw new Error(`refusing to archive invalid event ${e.id}: ${r.errors.map((x) => x.code).join(', ')}`);
  }
  const jsonl = utf8(releasesJsonl(input.events));
  const files: CatalogInventory['files'] = [{ path: ARCHIVE_FILES.releases, size: jsonl.length, sha256: sha256Hex(jsonl) }];
  if (input.sqlite) files.push({ path: ARCHIVE_FILES.sqlite, size: input.sqlite.length, sha256: sha256Hex(input.sqlite) });
  const inventory: CatalogInventory = {
    schema: CATALOG_SCHEMA,
    builder_pubkey: input.builderPubkey,
    build_time: input.buildTime,
    collection_policy: input.collectionPolicy ?? DEFAULT_COLLECTION_POLICY,
    release_schema_versions: [RELEASE_SCHEMA],
    record_count: new Set(input.events.map((e) => e.id)).size,
    coverage: input.coverage,
    files,
  };
  const schemaErrors = validateInventorySchema(inventory);
  if (schemaErrors.length) throw new Error(`invalid inventory: ${schemaErrors.map((e) => e.message).join('; ')}`);

  // Fixed timestamps keep the ZIP bytes reproducible for the same snapshot.
  const mtime = new Date(input.buildTime * 1000);
  const entries: Zippable = {
    [ARCHIVE_FILES.inventory]: [utf8(JSON.stringify(inventory, null, 2) + '\n'), { mtime, level: 6 }],
    [ARCHIVE_FILES.releases]: [jsonl, { mtime, level: 6 }],
  };
  if (input.sqlite) entries[ARCHIVE_FILES.sqlite] = [input.sqlite, { mtime, level: 6 }];
  const zip = zipSync(entries);
  return { zip, sha256: sha256Hex(zip), size: zip.length, inventory };
}

export interface ReadArchiveOptions {
  expectedSha256?: string;
  expectedSize?: number;
  /** Announcement signer; must equal the inventory's builder_pubkey. */
  expectedBuilder?: string;
  limits?: Partial<ArchiveLimits>;
}

export interface ReadArchive {
  zipSha256: string;
  inventory: CatalogInventory;
  releases: VerifiedRelease[];
  sqlite?: Uint8Array;
}

const ALLOWED = new Set<string>(Object.values(ARCHIVE_FILES));
const issue = (code: string, message: string): Issue => ({ code, message });

function unsafeEntryName(name: string): boolean {
  return name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((s) => s === '..' || s === '.') || name.includes('\0');
}

/**
 * Verify and parse a catalog ZIP: exact hash, entry whitelist (no traversal),
 * size limits, inventory schema and hashes, and every release event. Pure: it
 * never touches a database, so a failed import cannot alter existing state.
 */
export function readArchive(zip: Uint8Array, opts: ReadArchiveOptions = {}): Result<ReadArchive> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...opts.limits };
  const fail = (...errors: Issue[]): Result<ReadArchive> => ({ ok: false, errors });

  if (zip.length > limits.maxZipBytes) return fail(issue('archive_too_large', `archive is ${zip.length} bytes; limit ${limits.maxZipBytes}`));
  if (opts.expectedSize !== undefined && zip.length !== opts.expectedSize) {
    return fail(issue('archive_size_mismatch', `archive is ${zip.length} bytes; announcement says ${opts.expectedSize}`));
  }
  const zipSha256 = sha256Hex(zip);
  if (opts.expectedSha256 && zipSha256 !== opts.expectedSha256) return fail(issue('archive_hash_mismatch', 'archive SHA-256 does not match the announcement'));

  const errors: Issue[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        if (unsafeEntryName(f.name)) {
          errors.push(issue('archive_path_traversal', `unsafe entry name ${JSON.stringify(f.name)}`));
          return false;
        }
        if (!ALLOWED.has(f.name)) {
          errors.push(issue('archive_unexpected_entry', `unexpected entry ${JSON.stringify(f.name)}`));
          return false;
        }
        if (seen.has(f.name)) {
          errors.push(issue('archive_duplicate_entry', `duplicate entry ${f.name}`));
          return false;
        }
        seen.add(f.name);
        declaredTotal += f.originalSize;
        if (declaredTotal > limits.maxUncompressedBytes) {
          errors.push(issue('archive_too_large', 'uncompressed size exceeds limit'));
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    return fail(issue('archive_malformed', `not a readable ZIP: ${(e as Error).message}`));
  }
  if (errors.length) return fail(...errors);

  const inventoryBytes = entries[ARCHIVE_FILES.inventory];
  if (!inventoryBytes) return fail(issue('archive_missing_inventory', `missing ${ARCHIVE_FILES.inventory}`));
  let inventory: CatalogInventory;
  try {
    inventory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventoryBytes));
  } catch (e) {
    return fail(issue('inventory_parse_error', (e as Error).message));
  }
  const schemaErrors = validateInventorySchema(inventory);
  if (schemaErrors.length) return fail(...schemaErrors);
  if (opts.expectedBuilder && inventory.builder_pubkey !== opts.expectedBuilder) {
    return fail(issue('builder_mismatch', 'inventory builder_pubkey differs from the announcement signer'));
  }

  const listed = new Set(inventory.files.map((f) => f.path));
  for (const name of Object.keys(entries)) {
    if (name !== ARCHIVE_FILES.inventory && !listed.has(name as never)) errors.push(issue('inventory_mismatch', `${name} is not listed in the inventory`));
  }
  for (const f of inventory.files) {
    const bytes = entries[f.path];
    if (!bytes) errors.push(issue('inventory_mismatch', `${f.path} is listed but missing`));
    else if (bytes.length !== f.size || sha256Hex(bytes) !== f.sha256) errors.push(issue('inventory_mismatch', `${f.path} does not match its inventory size/hash`));
  }
  if (errors.length) return fail(...errors);

  const jsonlBytes = entries[ARCHIVE_FILES.releases];
  if (!jsonlBytes) return fail(issue('inventory_mismatch', `${ARCHIVE_FILES.releases} is required`));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(jsonlBytes);
  } catch {
    return fail(issue('archive_malformed', `${ARCHIVE_FILES.releases} is not valid UTF-8`));
  }
  if (text.length && !text.endsWith('\n')) return fail(issue('archive_malformed', `${ARCHIVE_FILES.releases} must end with a newline`));
  const lines = text.length ? text.slice(0, -1).split('\n') : [];
  if (lines.length > limits.maxRecords) return fail(issue('archive_too_large', `${lines.length} records exceed limit ${limits.maxRecords}`));
  if (lines.length !== inventory.record_count) return fail(issue('inventory_mismatch', `record_count ${inventory.record_count} but ${lines.length} lines`));

  const releases: VerifiedRelease[] = [];
  let prevId = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > limits.maxEventBytes * 2) return fail(issue('event_too_large', `line ${i + 1} is too long`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail(issue('archive_malformed', `line ${i + 1} is not JSON`));
    }
    const r = verifyReleaseEvent(parsed, { maxEventBytes: limits.maxEventBytes });
    if (!r.ok) return fail(issue('archive_invalid_record', `line ${i + 1}: ${r.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`));
    if (r.value.event.id <= prevId) return fail(issue('archive_not_canonical', `line ${i + 1}: records must be unique and sorted by event ID`));
    prevId = r.value.event.id;
    releases.push(r.value);
  }
  const sqlite = entries[ARCHIVE_FILES.sqlite];
  return { ok: true, value: { zipSha256, inventory, releases, ...(sqlite ? { sqlite } : {}) } };
}
