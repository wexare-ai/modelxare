/** A signed Nostr event (NIP-01). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEventTemplate = Pick<NostrEvent, 'kind' | 'created_at' | 'tags' | 'content'>;

export type FileRole = 'weights' | 'adapter' | 'tokenizer' | 'config';

/** Transports recognized in P0. Unknown transports are valid data but ignored by clients. */
export type KnownTransport = 'ipfs' | 'https' | 'http' | 'torrent' | 'arweave';

export interface FileLocation {
  transport: KnownTransport | (string & {});
  uri: string;
  /** Torrent only: the exact file path inside the torrent. */
  path?: string;
}

export interface ManifestFile {
  role: FileRole;
  path: string;
  size: number;
  sha256: string;
  locations: FileLocation[];
}

export type ChatTemplateConfig = { source: 'embedded' | 'none' } | { source: 'inline'; template: string };

export interface OperationConfig {
  id: string;
  prompt: { mode: 'chat' | 'completion'; system?: string; template: string };
  generation?: { max_tokens?: number; temperature?: number; top_k?: number; top_p?: number; stop?: string[] };
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export interface ReleaseManifest {
  schema: 'wexare.micromodel.release/0.1';
  model_id: string;
  name: string;
  description: string;
  version: string;
  kind: 'model' | 'lora';
  capabilities: string[];
  languages: string[];
  license: { id: string; url?: string; attribution?: string };
  runtime: {
    format: string;
    family: string;
    requirement: string;
    browser_features: string[];
    chat_template?: ChatTemplateConfig;
  };
  files: ManifestFile[];
  operations: OperationConfig[];
  requirements: {
    context_length: number;
    memory_mb?: { value: number; basis: 'measured' | 'estimated'; context_length: number; notes?: string };
    hardware_profiles?: string[];
  };
  base?: {
    release_id: string;
    manifest_sha256: string;
    files: { sha256: string; size: number }[];
  };
  labels?: string[];
}

export type CoverageState = 'caught-up' | 'possibly-incomplete' | 'unavailable' | 'never-connected';

export interface CatalogInventory {
  schema: 'wexare.micromodel.catalog/0.1';
  builder_pubkey: string;
  build_time: number;
  collection_policy: string;
  release_schema_versions: string[];
  record_count: number;
  coverage: {
    statement: string;
    relays: { url: string; state: CoverageState; events?: number; last_success_at?: number | null; notes?: string }[];
  };
  files: { path: 'releases.jsonl' | 'catalog.sqlite'; size: number; sha256: string }[];
}

/** A verified release: original event plus the parsed manifest and derived identities. */
export interface VerifiedRelease {
  event: NostrEvent;
  /** Exact manifest string from the event (the bytes that were hashed). */
  manifestJson: string;
  manifest: ReleaseManifest;
  manifestSha256: string;
  warnings: Issue[];
}

export interface VerifiedCatalogAnnouncement {
  event: NostrEvent;
  zipSha256: string;
  zipSize: number;
  locations: FileLocation[];
  magnet?: string;
  description: string;
}

export interface Issue {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: Issue[] };
