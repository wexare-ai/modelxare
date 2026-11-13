import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  buildReleaseEventTemplate,
  canonicalJson,
  categoryName,
  labelList,
  operationExecutable,
  parseOperationOutput,
  promptVars,
  splitInstruction,
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

  it('tells an authentic release in another format version apart from a broken one', () => {
    const base = manifestOf(modelVector.event);
    const older = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, schema: 'wexare.micromodel.release/0.1' } as never) })));
    expect(older.ok ? [] : older.errors.map((e) => [e.code, e.message])).toEqual([['other_release_version', 'release format 0.1; this client reads 0.2']]);
    const odd = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, schema: 'something-else' } as never) })));
    expect(codes(odd)).toContain('schema_invalid');
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

  it('accepts an output type this client does not know, and warns it will not run', () => {
    const base = manifestOf(modelVector.event);
    const ops = base.operations.map((o) => ({ ...o, output: { type: 'audio', sample_rate: 16000 } }));
    const r = verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, operations: ops }) })));
    expect(r.ok && r.value.warnings.map((w) => w.code)).toContain('unknown_output_type');
  });

  it('rejects malformed known outputs and repeated labels', () => {
    const base = manifestOf(modelVector.event);
    const bad = (output: unknown) =>
      codes(verifyReleaseEvent(sign(buildReleaseEventTemplate({ manifestJson: serializeManifest({ ...base, operations: [{ ...base.operations[0]!, output } as never, base.operations[1]!] }) }))));
    expect(bad({ type: 'text', single_line: 'yes' })).toContain('schema_invalid');
    expect(bad({ type: 'label', labels: [{ id: 'a' }] })).toContain('schema_invalid');
    expect(bad({ type: 'label', labels: [{ id: 'a' }, { id: 'a' }] })).toContain('manifest_inconsistent');
    expect(bad({ type: 'label', labels: [{ id: 'a' }, { id: 'b' }], decline: 'a' })).toContain('manifest_inconsistent');
  });

  it('derives a category tag from the operations', () => {
    expect(modelVector.event.tags).toContainEqual(['t', 'category:messages']);
    const e: NostrEvent = modelVector.event;
    expect(codes(verifyReleaseEvent(resign(e, [...e.tags, ['t', 'category:command-line']])))).toContain('tag_inconsistent');
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
      release_schema_versions: ['wexare.micromodel.release/0.2'],
      record_count: 0,
      coverage: { statement: 'x', relays: [{ url: 'ws://127.0.0.1:7777', state: 'caught-up' }] },
      files: [{ path: 'releases.jsonl', size: 0, sha256: 'b'.repeat(64) }],
    };
    expect(validateInventorySchema(inv)).toEqual([]);
    expect(validateInventorySchema({ ...inv, files: [{ path: '../x', size: 0, sha256: 'b'.repeat(64) }] })).not.toEqual([]);
  });
  it('runs operations whose answer shape it knows', () => {
    expect(validateManifestSchema({})).not.toEqual([]);
    expect(operationExecutable({ output: { type: 'text' } })).toBe(true);
    expect(operationExecutable({ output: { type: 'label', labels: [{ id: 'a' }, { id: 'b' }] } })).toBe(true);
    expect(operationExecutable({ output: { type: 'audio' } })).toBe(false);
  });
  it('checks answers against the output shape, never inventing one', () => {
    const label = { output: { type: 'label' as const, labels: [{ id: 'work' }, { id: 'travel' }], decline: 'NONE' } };
    expect(parseOperationOutput(label, ' "Travel." ')).toEqual({ value: { label: 'travel' } });
    expect(parseOperationOutput(label, 'pets').error).toMatch(/not one of work, travel/);
    expect(parseOperationOutput(label, 'none')).toEqual({ declined: true });
    const line = { output: { type: 'text' as const, single_line: true, max_chars: 40, decline: 'UNSUPPORTED' } };
    expect(parseOperationOutput(line, '```sh\nffmpeg -i a.mp4 b.gif\n```')).toEqual({ value: { text: 'ffmpeg -i a.mp4 b.gif' } });
    expect(parseOperationOutput(line, '`git status`')).toEqual({ value: { text: 'git status' } });
    expect(parseOperationOutput({ output: { type: 'text' } }, '```bash\n$ git add .\n$ git commit -m "x"\n```')).toEqual({ value: { text: 'git add .\ngit commit -m "x"' } });
    expect(parseOperationOutput(line, 'UNSUPPORTED')).toEqual({ declined: true });
    expect(parseOperationOutput(line, 'git add .\ngit commit').error).toMatch(/one line/);
    expect(parseOperationOutput(line, 'x'.repeat(41)).error).toMatch(/longer than 40/);
    expect(parseOperationOutput(line, '  ').error).toMatch(/empty/);
    expect(parseOperationOutput({ output: { type: 'audio' } }, 'x').error).toMatch(/unknown output type/);
  });
  it('lists each label with what it covers, and names categories', () => {
    expect(labelList({ type: 'label', labels: [{ id: 'family', description: 'parents and children' }, { id: 'other' }] })).toBe('family (parents and children), other');
    expect(categoryName('command-line')).toBe('Command line');
    expect(categoryName('messages')).toBe('Messages');
  });
  it('gives prompts the whole request, and the text after a leading instruction', () => {
    expect(splitInstruction('Summarize this message: The lift is broken.')).toEqual({ instruction: 'Summarize this message', text: 'The lift is broken.' });
    expect(splitInstruction('Can you sort this? The lift is broken.')).toEqual({ instruction: 'Can you sort this?', text: 'The lift is broken.' });
    expect(splitInstruction('make a gif from movie.mkv')).toEqual({ instruction: null, text: 'make a gif from movie.mkv' });
    const vars = promptVars({ output: { type: 'label', labels: [{ id: 'a' }, { id: 'b' }] } }, 'Sort: hello', 'English');
    expect(vars).toEqual({ input: 'Sort: hello', text: 'hello', language: 'English', labels: 'a, b' });
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
