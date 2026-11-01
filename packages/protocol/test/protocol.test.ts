import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  MESSAGE_CATEGORIES,
  OPERATION_CONTRACTS,
  buildReleaseEventTemplate,
  canonicalJson,
  matchesTagQuery,
  narrowingRelayFilters,
  releaseRelayFilter,
  renderPromptTemplate,
  resolveHttpUrls,
  serializeManifest,
  sha256Hex,
  validateInventorySchema,
  validateManifestSchema,
  verifyCatalogAnnouncement,
  verifyReleaseEvent,
  type NostrEvent,
  type ReleaseManifest,
} from '../src/index.ts';

const vec = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../vectors', name), 'utf8'));
const modelVector = vec('release-model.json');
const sign = (t: Parameters<typeof finalizeEvent>[0], sk = generateSecretKey()) => finalizeEvent(t, sk) as unknown as NostrEvent;
const manifestOf = (e: NostrEvent) => JSON.parse(e.tags.find((t) => t[0] === 'wexare-manifest')![1]!) as ReleaseManifest;
const resign = (e: NostrEvent, tags: string[][]) => sign({ kind: e.kind, created_at: e.created_at, content: e.content, tags });
const codes = (r: ReturnType<typeof verifyReleaseEvent>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe('canonical JSON', () => {
  it('matches the public vector', () => {
    const v = vec('canonical-json.json');
    expect(canonicalJson(v.input)).toBe(v.expected);
    expect(v.expected).toBe('{"a":null,"b":[3,{"a":"é","z":1}],"c":1.5,"é":true}');
  });
  it('rejects non-finite numbers and class instances', () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(/Non-finite/);
    expect(() => canonicalJson({ d: new Date() })).toThrow(/Unsupported/);
  });
});

describe('release events', () => {
  it('accepts the valid vectors', () => {
    for (const name of ['release-model.json', 'release-lora.json']) {
      const r = verifyReleaseEvent(vec(name).event);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const r = verifyReleaseEvent(modelVector.event);
    expect(r.ok && r.value.manifestSha256).toBe(modelVector.manifest_sha256);
    expect(r.ok && r.value.warnings).toEqual([]);
  });

  it.each(['invalid-bad-signature.json', 'invalid-altered-manifest.json', 'invalid-tag-mismatch.json'])('rejects %s', (name) => {
    const v = vec(name);
    expect(codes(verifyReleaseEvent(v.event))).toContain(v.expect);
  });

  it('rejects a tampered id', () => {
    expect(codes(verifyReleaseEvent({ ...modelVector.event, created_at: modelVector.event.created_at + 1 }))).toContain('bad_id');
  });

  it('rejects catalog announcements as models', () => {
    expect(codes(verifyReleaseEvent(vec('catalog-announcement.json').event))).toContain('catalog_announcement');
  });

  it('requires exactly one inline manifest', () => {
    const e: NostrEvent = modelVector.event;
    const m = e.tags.find((t) => t[0] === 'wexare-manifest')!;
    expect(codes(verifyReleaseEvent(resign(e, [...e.tags, m])))).toContain('manifest_multiple');
    expect(codes(verifyReleaseEvent(resign(e, e.tags.filter((t) => t !== m))))).toContain('manifest_missing');
  });

  it('enforces the event size limit', () => {
    expect(codes(verifyReleaseEvent(modelVector.event, { maxEventBytes: 500 }))).toContain('event_too_large');
  });

  it('rejects discovery tags that claim capabilities the manifest lacks', () => {
    const e: NostrEvent = modelVector.event;
    expect(codes(verifyReleaseEvent(resign(e, [...e.tags, ['t', 'task:translation']])))).toContain('tag_inconsistent');
  });

  it('rejects schema violations, path traversal and non-loopback http', () => {
    const base = manifestOf(modelVector.event);
    const bad = (m: unknown) => verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: canonicalJson(m) })));
    expect(codes(bad({ ...base, version: 'v1' }))).toContain('schema_invalid');
    expect(codes(bad({ ...base, files: [{ ...base.files[0]!, path: '../etc/passwd' }] }))).toContain('schema_invalid');
    expect(codes(bad({ ...base, files: [{ ...base.files[0]!, locations: [{ transport: 'http', uri: 'http://example.com/x' }] }] }))).toContain('schema_invalid');
    expect(codes(bad({ ...base, extra: 1 }))).toContain('schema_invalid');
    expect(codes(bad({ ...base, kind: 'lora' }))).toContain('schema_invalid');
  });

  it('rejects operations missing from capabilities', () => {
    const base = manifestOf(modelVector.event);
    const r = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, capabilities: ['summarization'] }) })));
    expect(codes(r)).toContain('manifest_inconsistent');
  });

  it('accepts an unknown runtime family as metadata', () => {
    const base = manifestOf(modelVector.event);
    const m = { ...base, runtime: { ...base.runtime, family: 'future-runtime' } };
    const r = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest(m) })));
    expect(r.ok).toBe(true);
  });

  it('hashes exact manifest bytes and flags non-canonical form', () => {
    const base = manifestOf(modelVector.event);
    const pretty = JSON.stringify(base, null, 2);
    const r = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: pretty })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifestSha256).toBe(sha256Hex(pretty));
      expect(r.value.warnings.map((w) => w.code)).toContain('manifest_not_canonical');
    }
  });

  it('warns when an operation widens the bundled contract', () => {
    const base = manifestOf(modelVector.event);
    const ops = base.operations.map((o) => ({ ...o, output_schema: { type: 'object' } }));
    const r = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, operations: ops }) })));
    expect(r.ok && r.value.warnings.map((w) => w.code)).toContain('operation_contract_mismatch');
  });
});

describe('catalog announcements', () => {
  it('accepts the valid vector', () => {
    const r = verifyCatalogAnnouncement(vec('catalog-announcement.json').event);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.value.locations.map((l) => l.transport)).toEqual(['ipfs', 'http']);
      expect(r.value.magnet).toMatch(/^magnet:/);
    }
  });
  it('rejects release events', () => {
    const r = verifyCatalogAnnouncement(modelVector.event);
    expect(r.ok).toBe(false);
  });
});

describe('tag queries (A03)', () => {
  it('relay filter requests the ecosystem tag only', () => {
    expect(releaseRelayFilter({ limit: 10 })).toEqual({ kinds: [1063], '#t': ['wexare-micromodel'], limit: 10 });
  });
  it('narrowing filters are a union that still needs a local intersection', () => {
    const fs = narrowingRelayFilters({ capabilities: ['summarization', 'text-classification'] });
    expect(fs).toHaveLength(2);
    const summarizerOnly = { ...manifestOf(modelVector.event), capabilities: ['summarization'] };
    expect(matchesTagQuery(summarizerOnly, { capabilities: ['summarization', 'text-classification'] })).toBe(false);
    expect(matchesTagQuery(manifestOf(modelVector.event), { capabilities: ['summarization', 'text-classification'] })).toBe(true);
    expect(matchesTagQuery(manifestOf(modelVector.event), { languages: ['fr'] })).toBe(false);
  });
});

describe('schemas and helpers', () => {
  it('validates inventories', () => {
    const inv = {
      schema: 'wexare.micromodel.catalog/0.1',
      builder_pubkey: 'a'.repeat(64),
      build_time: 1,
      collection_policy: 'wexare.policy.all-valid-releases/0.1',
      release_schema_versions: ['wexare.micromodel.release/0.1'],
      record_count: 0,
      coverage: { statement: 'x', relays: [{ url: 'ws://127.0.0.1:7777', state: 'caught-up' }] },
      files: [{ path: 'releases.jsonl', size: 0, sha256: 'b'.repeat(64) }],
    };
    expect(validateInventorySchema(inv)).toEqual([]);
    expect(validateInventorySchema({ ...inv, files: [{ path: '../x', size: 0, sha256: 'b'.repeat(64) }] })).not.toEqual([]);
  });
  it('bundled contracts are valid manifest operation schemas', () => {
    expect(Object.keys(OPERATION_CONTRACTS)).toContain('text-classification');
    expect(MESSAGE_CATEGORIES).toContain('maintenance');
    expect(validateManifestSchema({})).not.toEqual([]);
  });
  it('renders prompt placeholders as text', () => {
    expect(renderPromptTemplate('A {{input}} B {{ categories }} {{unknown}}', { input: '<b>x</b>', categories: 'a, b' })).toBe('A <b>x</b> B a, b {{unknown}}');
  });
  it('resolves gateways', () => {
    expect(resolveHttpUrls({ transport: 'ipfs', uri: 'ipfs://bafyabc' }, { ipfs: ['http://127.0.0.1:8080/'], arweave: [] })).toEqual(['http://127.0.0.1:8080/ipfs/bafyabc']);
    expect(resolveHttpUrls({ transport: 'arweave', uri: 'ar://' + 'a'.repeat(43) }, { ipfs: [], arweave: ['https://arweave.net'] })).toEqual(['https://arweave.net/' + 'a'.repeat(43)]);
    expect(resolveHttpUrls({ transport: 'http', uri: 'http://evil.example/x' }, { ipfs: [], arweave: [] })).toEqual([]);
  });
});
