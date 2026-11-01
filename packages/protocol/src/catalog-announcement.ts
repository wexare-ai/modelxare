import {
  ARCHIVE_MIME,
  CATALOG_PROFILE_VERSION,
  CATALOG_TAG,
  CATALOG_VERSION_TAG,
  DEFAULT_MAX_EVENT_BYTES,
  FILE_METADATA_KIND,
  RELEASE_TAG,
} from './constants.ts';
import { checkSignature, eventByteLength, parseEventShape, tagValues } from './events.ts';
import { HEX64 } from './hash.ts';
import { locationFromUri, magnetInfoHash } from './locations.ts';
import type { FileLocation, Issue, Result, UnsignedEventTemplate, VerifiedCatalogAnnouncement } from './types.ts';

const issue = (code: string, message: string): Issue => ({ code, message });

export interface CatalogAnnouncementOptions {
  zipSha256: string;
  zipSize: number;
  /** Retrieval URLs; the first becomes NIP-94 `url`, the rest `fallback`. */
  urls: string[];
  magnet?: string;
  content: string;
  createdAt?: number;
}

/** Build the unsigned archive announcement binding the exact ZIP hash to its locations. */
export function buildCatalogAnnouncementTemplate(opts: CatalogAnnouncementOptions): UnsignedEventTemplate {
  const [primary, ...fallbacks] = opts.urls;
  const tags: string[][] = [
    ['t', CATALOG_TAG],
    ['m', ARCHIVE_MIME],
    ['x', opts.zipSha256],
    ['size', String(opts.zipSize)],
  ];
  if (primary) tags.push(['url', primary]);
  for (const f of fallbacks) tags.push(['fallback', f]);
  if (opts.magnet) tags.push(['magnet', opts.magnet]);
  tags.push([CATALOG_VERSION_TAG, CATALOG_PROFILE_VERSION]);
  tags.push(['alt', 'weXare micro-model catalog snapshot']);
  return { kind: FILE_METADATA_KIND, created_at: opts.createdAt ?? Math.floor(Date.now() / 1000), tags, content: opts.content };
}

/**
 * Verify an archive announcement. The builder signature proves who announced
 * which exact ZIP bytes; it does not prove the archive is complete.
 */
export function verifyCatalogAnnouncement(input: unknown, opts: { maxEventBytes?: number } = {}): Result<VerifiedCatalogAnnouncement> {
  const shape = parseEventShape(input);
  if (!shape.event) return { ok: false, errors: shape.errors };
  const event = shape.event;
  const fail = (...errors: Issue[]): Result<VerifiedCatalogAnnouncement> => ({ ok: false, errors });

  const maxBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  if (eventByteLength(event) > maxBytes) return fail(issue('event_too_large', `event exceeds ${maxBytes} bytes`));
  if (event.kind !== FILE_METADATA_KIND) return fail(issue('wrong_kind', `kind ${event.kind} is not ${FILE_METADATA_KIND}`));
  const sigErrors = checkSignature(event);
  if (sigErrors.length) return fail(...sigErrors);

  const t = tagValues(event, 't');
  if (!t.includes(CATALOG_TAG)) return fail(issue('not_catalog_profile', `missing t=${CATALOG_TAG}`));
  if (t.includes(RELEASE_TAG)) return fail(issue('tag_inconsistent', 'catalog announcement must not carry the release tag'));
  const version = tagValues(event, CATALOG_VERSION_TAG);
  if (version.length !== 1 || version[0] !== CATALOG_PROFILE_VERSION) {
    return fail(issue('unsupported_catalog_version', `expected ${CATALOG_VERSION_TAG}=${CATALOG_PROFILE_VERSION}`));
  }
  const mime = tagValues(event, 'm');
  if (mime.length !== 1 || mime[0] !== ARCHIVE_MIME) return fail(issue('tag_inconsistent', `exactly one m=${ARCHIVE_MIME} required`));
  const x = tagValues(event, 'x');
  if (x.length !== 1 || !HEX64.test(x[0]!)) return fail(issue('tag_inconsistent', 'exactly one hex SHA-256 x tag required'));
  const size = tagValues(event, 'size');
  if (size.length !== 1 || !/^\d+$/.test(size[0]!) || !Number.isSafeInteger(Number(size[0]))) {
    return fail(issue('tag_inconsistent', 'exactly one integer size tag required'));
  }
  const urls = tagValues(event, 'url');
  if (urls.length > 1) return fail(issue('tag_inconsistent', 'at most one url tag allowed'));

  const locations: FileLocation[] = [];
  for (const uri of [...urls, ...tagValues(event, 'fallback')]) {
    const loc = locationFromUri(uri);
    if (loc && loc.transport !== 'torrent') locations.push(loc);
  }
  const magnets = tagValues(event, 'magnet').filter((m) => magnetInfoHash(m));
  const magnet = magnets[0];
  if (locations.length === 0 && !magnet) return fail(issue('no_locations', 'announcement has no usable retrieval location'));

  return {
    ok: true,
    value: { event, zipSha256: x[0]!, zipSize: Number(size[0]), locations, ...(magnet ? { magnet } : {}), description: event.content },
  };
}
