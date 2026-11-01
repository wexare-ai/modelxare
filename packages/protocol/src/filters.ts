import { FILE_METADATA_KIND, RELEASE_TAG, TAG_PREFIX } from './constants.ts';
import type { ReleaseManifest } from './types.ts';

export interface RelayFilter {
  kinds: number[];
  '#t': string[];
  since?: number;
  until?: number;
  limit?: number;
  authors?: string[];
}

/**
 * Relay filter for release discovery. Values inside one `#t` filter are
 * alternatives (OR), so this requests the common ecosystem tag only; required
 * intersections are checked locally with matchesTagQuery().
 */
export function releaseRelayFilter(opts: Omit<RelayFilter, 'kinds' | '#t'> = {}): RelayFilter {
  return { kinds: [FILE_METADATA_KIND], '#t': [RELEASE_TAG], ...opts };
}

export interface ReleaseTagQuery {
  /** All required (intersection). */
  capabilities?: string[];
  /** Any of. */
  languages?: string[];
  runtime?: string;
  kind?: 'model' | 'lora';
}

/**
 * Optional narrowing requests: one filter per required capability tag. Their
 * union is a superset of the intended result and must still pass
 * matchesTagQuery(); never treat a relay's OR-match as an intersection.
 */
export function narrowingRelayFilters(q: ReleaseTagQuery, opts: Omit<RelayFilter, 'kinds' | '#t'> = {}): RelayFilter[] {
  const caps = q.capabilities ?? [];
  if (caps.length === 0) return [releaseRelayFilter(opts)];
  return caps.map((c) => ({ kinds: [FILE_METADATA_KIND], '#t': [TAG_PREFIX.task + c], ...opts }));
}

/** Local intersection check over a verified manifest (tags were already proven consistent with it). */
export function matchesTagQuery(m: ReleaseManifest, q: ReleaseTagQuery): boolean {
  if (q.capabilities?.some((c) => !m.capabilities.includes(c))) return false;
  if (q.languages?.length && !q.languages.some((l) => m.languages.includes(l))) return false;
  if (q.runtime && m.runtime.family !== q.runtime) return false;
  if (q.kind && m.kind !== q.kind) return false;
  return true;
}
