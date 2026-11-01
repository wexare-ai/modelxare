// Message contract between the UI and the catalog worker.
import type { CatalogQuery, CatalogStats, Conflict, QueryPage, ReleaseDetail, SourceRecord } from '@wexare/catalog';
import type { CatalogInventory, Issue, NostrEvent } from '@wexare/protocol';

export interface InitResult {
  persistent: boolean;
  vfs: string;
  sqliteVersion: string;
  schemaVersion: number;
  stats: CatalogStats;
  /** Why the catalog is not persistent, when it is not. */
  error?: string;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { id: string; code: string; message: string }[];
  unknownProfile: number;
  catalogAnnouncements: NostrEvent[];
}

export interface StagedImport {
  token: string;
  builderPubkey: string;
  announcementId: string | null;
  inventory: CatalogInventory;
  recordCount: number;
  zipSha256: string;
  zipSize: number;
  verifyMs: number;
  alreadyKnown: number;
}

export interface CandidateRow {
  eventId: string;
  pubkey: string;
  manifestJson: string;
  manifestSha256: string;
}

export interface CatalogApi {
  /** Opens the catalog (the first call decides how); every other call waits for it. */
  init(memoryOnly?: boolean): InitResult;
  query(q: CatalogQuery): QueryPage & { ms: number };
  getRelease(eventId: string): ReleaseDetail | null;
  /** Non-synthetic runtime-family releases with full manifests, for planning. */
  candidates(): CandidateRow[];
  ingestEvents(relayUrl: string, events: unknown[]): IngestResult;
  stageArchive(zip: Uint8Array, announcement: NostrEvent | null): { ok: true; staged: StagedImport } | { ok: false; errors: Issue[] };
  commitArchive(token: string, label: string): { added: number; total: number; pruned: number; ms: number };
  discardStaged(token: string): void;
  listSources(): SourceRecord[];
  setSourceEnabled(id: string, enabled: boolean): void;
  removeSource(id: string): number;
  markCached(sha256: string, size: number, store: string): void;
  unmarkCached(sha256: string): void;
  cachedArtifacts(): { sha256: string; size: number; verifiedAt: number; store: string }[];
  stats(): CatalogStats & { dbBytes: number };
  conflicts(): Conflict[];
  resetCatalog(): void;
}

export type CatalogMethod = keyof CatalogApi;
export type WorkerRequest = { id: number; method: CatalogMethod; args: unknown[] };
export type WorkerResponse = { id: number; result?: unknown; error?: string };
