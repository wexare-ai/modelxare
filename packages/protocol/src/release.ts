import { canonicalJson } from './canonical-json.ts';
import {
  CATALOG_TAG,
  DEFAULT_MAX_EVENT_BYTES,
  FILE_METADATA_KIND,
  MANIFEST_MIME,
  MANIFEST_TAG,
  RELEASE_TAG,
  TAG_PREFIX,
} from './constants.ts';
import { checkSignature, eventByteLength, parseEventShape, tagEntries, tagValues } from './events.ts';
import { sha256Hex, utf8Length } from './hash.ts';
import { inferTransport } from './locations.ts';
import { operationMatchesContract } from './operations.ts';
import { validateManifestSchema } from './schemas.ts';
import type { Issue, ReleaseManifest, Result, UnsignedEventTemplate, VerifiedRelease } from './types.ts';

const issue = (code: string, message: string): Issue => ({ code, message });

/** Discovery `t` values derived from a manifest (excluding the common ecosystem tag). */
export function deriveDiscoveryTags(m: Pick<ReleaseManifest, 'capabilities' | 'languages' | 'runtime' | 'kind'>): string[] {
  return [
    ...m.capabilities.map((c) => TAG_PREFIX.task + c),
    ...m.languages.map((l) => TAG_PREFIX.lang + l),
    TAG_PREFIX.runtime + m.runtime.family,
    TAG_PREFIX.artifact + m.kind,
  ];
}

const isDerivedTag = (t: string) => Object.values(TAG_PREFIX).some((p) => t.startsWith(p));

/** Serialize a manifest object with the deterministic serializer. */
export const serializeManifest = (m: ReleaseManifest): string => canonicalJson(m);

export interface ReleaseTemplateOptions {
  /** Exact manifest string; hashed byte-for-byte. */
  manifestJson: string;
  /** Primary manifest file location (NIP-94 `url`), e.g. ipfs://<cid>. */
  url?: string;
  fallbacks?: string[];
  content?: string;
  createdAt?: number;
}

/** Build the unsigned NIP-94 kind:1063 release announcement. */
export function buildReleaseEventTemplate(opts: ReleaseTemplateOptions): UnsignedEventTemplate {
  const manifest = JSON.parse(opts.manifestJson) as ReleaseManifest;
  const tags: string[][] = [
    ['t', RELEASE_TAG],
    ...deriveDiscoveryTags(manifest).map((t) => ['t', t]),
    ['m', MANIFEST_MIME],
    ['x', sha256Hex(opts.manifestJson)],
    ['size', String(utf8Length(opts.manifestJson))],
  ];
  if (opts.url) tags.push(['url', opts.url]);
  for (const f of opts.fallbacks ?? []) tags.push(['fallback', f]);
  tags.push(['alt', `weXare micro-model release: ${manifest.name} ${manifest.version}`]);
  tags.push([MANIFEST_TAG, opts.manifestJson]);
  return {
    kind: FILE_METADATA_KIND,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: opts.content ?? manifest.description.slice(0, 280),
  };
}

/** Semantic checks the JSON Schema cannot express. */
export function checkManifestSemantics(m: ReleaseManifest): Issue[] {
  const errors: Issue[] = [];
  const caps = new Set(m.capabilities);
  const opIds = new Set<string>();
  for (const op of m.operations) {
    if (opIds.has(op.id)) errors.push(issue('manifest_inconsistent', `duplicate operation ${op.id}`));
    opIds.add(op.id);
    if (!caps.has(op.id)) errors.push(issue('manifest_inconsistent', `operation ${op.id} is not listed in capabilities`));
  }
  const paths = new Set<string>();
  for (const f of m.files) {
    if (paths.has(f.path)) errors.push(issue('manifest_inconsistent', `duplicate file path ${f.path}`));
    paths.add(f.path);
  }
  const roles = m.files.map((f) => f.role);
  if (m.kind === 'model' && !roles.includes('weights')) errors.push(issue('manifest_inconsistent', 'model release has no weights file'));
  if (m.kind === 'model' && roles.includes('adapter')) errors.push(issue('manifest_inconsistent', 'model release contains an adapter file'));
  if (m.kind === 'lora' && !roles.includes('adapter')) errors.push(issue('manifest_inconsistent', 'lora release has no adapter file'));
  if (m.kind === 'lora' && roles.includes('weights')) errors.push(issue('manifest_inconsistent', 'lora release must reference base weights, not include them'));
  return errors;
}

export interface VerifyOptions {
  maxEventBytes?: number;
}

/**
 * Verify a release announcement: event ID and signature, application profile,
 * inline manifest hash, schema, and tag consistency. Signatures establish
 * authorship and hashes establish byte integrity; neither is a quality claim.
 */
export function verifyReleaseEvent(input: unknown, opts: VerifyOptions = {}): Result<VerifiedRelease> {
  const shape = parseEventShape(input);
  if (!shape.event) return { ok: false, errors: shape.errors };
  const event = shape.event;
  const fail = (...errors: Issue[]): Result<VerifiedRelease> => ({ ok: false, errors });

  const maxBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const size = eventByteLength(event);
  if (size > maxBytes) return fail(issue('event_too_large', `event is ${size} bytes; limit is ${maxBytes}`));
  if (event.kind !== FILE_METADATA_KIND) return fail(issue('wrong_kind', `kind ${event.kind} is not ${FILE_METADATA_KIND}`));

  const sigErrors = checkSignature(event);
  if (sigErrors.length) return fail(...sigErrors);

  const tTags = tagValues(event, 't');
  if (tTags.includes(CATALOG_TAG)) return fail(issue('catalog_announcement', 'event is a catalog announcement, not a model release'));
  if (!tTags.includes(RELEASE_TAG)) return fail(issue('not_release_profile', `missing t=${RELEASE_TAG}`));

  const manifestTags = tagEntries(event, MANIFEST_TAG);
  if (manifestTags.length === 0) return fail(issue('manifest_missing', `missing ${MANIFEST_TAG} tag`));
  if (manifestTags.length > 1) return fail(issue('manifest_multiple', `${manifestTags.length} ${MANIFEST_TAG} tags; exactly one required`));
  if (manifestTags[0]!.length !== 2) return fail(issue('tag_inconsistent', `${MANIFEST_TAG} tag must have exactly one value`));
  const manifestJson = manifestTags[0]![1]!;

  const mime = tagValues(event, 'm');
  if (mime.length !== 1 || mime[0] !== MANIFEST_MIME) return fail(issue('tag_inconsistent', `exactly one m=${MANIFEST_MIME} required`));

  const x = tagValues(event, 'x');
  if (x.length !== 1) return fail(issue('tag_inconsistent', 'exactly one x tag required'));
  const manifestSha256 = sha256Hex(manifestJson);
  if (x[0] !== manifestSha256) return fail(issue('manifest_hash_mismatch', 'x tag does not match SHA-256 of the inline manifest bytes'));

  const sizeTags = tagValues(event, 'size');
  if (sizeTags.length > 1 || (sizeTags.length === 1 && sizeTags[0] !== String(utf8Length(manifestJson)))) {
    return fail(issue('tag_inconsistent', 'size tag does not match manifest byte length'));
  }
  if (tagValues(event, 'url').length > 1) return fail(issue('tag_inconsistent', 'at most one url tag allowed'));

  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (e) {
    return fail(issue('manifest_parse_error', `inline manifest is not valid JSON: ${(e as Error).message}`));
  }
  const schemaErrors = validateManifestSchema(manifest);
  if (schemaErrors.length) return fail(...schemaErrors);
  const semantic = checkManifestSemantics(manifest);
  if (semantic.length) return fail(...semantic);

  const expected = new Set(deriveDiscoveryTags(manifest));
  const actual = new Set(tTags.filter(isDerivedTag));
  const missing = [...expected].filter((t) => !actual.has(t));
  const extra = [...actual].filter((t) => !expected.has(t));
  if (missing.length || extra.length) {
    return fail(
      issue(
        'tag_inconsistent',
        `discovery tags disagree with manifest${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unexpected ${extra.join(', ')}` : ''}`,
      ),
    );
  }

  const warnings: Issue[] = [];
  try {
    if (canonicalJson(manifest) !== manifestJson) warnings.push(issue('manifest_not_canonical', 'manifest string is not in canonical form (hash still verified on exact bytes)'));
  } catch {
    warnings.push(issue('manifest_not_canonical', 'manifest cannot be canonicalized'));
  }
  for (const op of manifest.operations) {
    if (!operationMatchesContract(op)) warnings.push(issue('operation_contract_mismatch', `operation ${op.id} does not match a bundled contract; it will not execute`));
  }
  for (const f of manifest.files) {
    for (const l of f.locations) {
      if (inferTransport(l.uri) !== l.transport) warnings.push(issue('unknown_transport', `${f.path}: transport ${l.transport} is not recognized; location ignored`));
    }
  }
  return { ok: true, value: { event, manifestJson, manifest, manifestSha256, warnings } };
}
