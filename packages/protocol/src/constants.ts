/** Experimental weXare application profile identifiers (not an official Nostr standard). */
export const RELEASE_SCHEMA = 'wexare.micromodel.release/0.2';
export const CATALOG_SCHEMA = 'wexare.micromodel.catalog/0.1';
export const CATALOG_PROFILE_VERSION = '0.1';

/** NIP-94 file metadata kind, used for both release and catalog announcements. */
export const FILE_METADATA_KIND = 1063;

/** Common ecosystem tag carried by every release announcement. */
export const RELEASE_TAG = 'wexare-micromodel';
/** Tag carried by archive (catalog) announcements. Collectors must not index these as models. */
export const CATALOG_TAG = 'wexare-micromodel-catalog';

/** Application extension tag holding the exact inline manifest string. */
export const MANIFEST_TAG = 'wexare-manifest';
/** Application extension tag on archive announcements, carrying the catalog profile version. */
export const CATALOG_VERSION_TAG = 'wexare-catalog';

export const MANIFEST_MIME = 'application/json';
export const ARCHIVE_MIME = 'application/zip';

/** Default maximum serialized event size; relays may impose their own lower limit. */
export const DEFAULT_MAX_EVENT_BYTES = 32 * 1024;

/** Discovery tag prefixes derived from the manifest. */
export const TAG_PREFIX = {
  task: 'task:',
  lang: 'lang:',
  runtime: 'runtime:',
  artifact: 'artifact:',
  category: 'category:',
} as const;

/** Archive member names allowed in a catalog ZIP (protocol 0.1). */
export const ARCHIVE_FILES = {
  inventory: 'catalog.json',
  releases: 'releases.jsonl',
  sqlite: 'catalog.sqlite',
} as const;
