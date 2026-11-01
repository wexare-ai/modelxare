// Regenerates fixtures/golden-queries.json: a small signed dataset plus queries
// whose expected results are written by hand below (labels → event IDs).
// Keys are public TEST-ONLY keys. Usage: pnpm --filter @wexare/catalog exec tsx scripts/gen-golden.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { OPERATION_CONTRACTS, buildReleaseEventTemplate, serializeManifest, sha256Hex, type ReleaseManifest } from '@wexare/protocol';

const key = (l: string) => hexToBytes(sha256Hex(`wexare public test vector key: ${l}`));
const pubA = key('golden-publisher-a');
const pubB = key('golden-publisher-b');

type Spec = {
  label: string; sk: Uint8Array; name: string; description: string; caps: string[]; langs: string[];
  kind?: 'model' | 'lora'; family?: string; size: number; memory?: number; license?: string; synthetic?: boolean; hw?: string[];
};
const specs: Spec[] = [
  { label: 'qwen-like', sk: pubA, name: 'Community classifier', description: 'Classifies community messages and writes short summaries.', caps: ['summarization', 'text-classification'], langs: ['en', 'es'], size: 491_000_000, memory: 900, hw: ['cpu-wasm'] },
  { label: 'smol-like', sk: pubA, name: 'Tiny summarizer', description: 'Short English summaries of residents’ messages.', caps: ['summarization'], langs: ['en'], size: 386_000_000, hw: ['cpu-wasm'] },
  { label: 'same-name-b', sk: pubB, name: 'Tiny summarizer', description: 'A different publisher reusing the same display name.', caps: ['summarization'], langs: ['en'], size: 120_000_000, memory: 300, license: 'MIT' },
  { label: 'classifier-only', sk: pubB, name: 'Leak detector', description: 'Detects maintenance issues such as water leaks.', caps: ['text-classification'], langs: ['es'], size: 50_000_000, memory: 2000 },
  { label: 'lora', sk: pubA, name: 'Shakespeare adapter', description: 'Story style adapter.', caps: ['text-generation'], langs: ['en'], kind: 'lora', size: 16_000_000 },
  { label: 'unknown-runtime', sk: pubB, name: 'Future runtime model', description: 'Uses a runtime this client does not support.', caps: ['summarization'], langs: ['en'], family: 'onnx-web', size: 10_000_000 },
  { label: 'synthetic', sk: pubB, name: 'Synthetic summarizer 0001', description: 'SYNTHETIC record for scale tests. Not a runnable model.', caps: ['summarization'], langs: ['en'], size: 1_000, synthetic: true },
];

const events: Record<string, unknown> = {};
const ids: Record<string, string> = {};
let t = 1793491200;
for (const s of specs) {
  const kind = s.kind ?? 'model';
  const sha = sha256Hex(`golden file ${s.label}`);
  const m: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.1',
    model_id: s.label,
    name: s.name,
    description: s.description,
    version: '1.0.0',
    kind,
    capabilities: s.caps,
    languages: s.langs,
    license: { id: s.license ?? 'Apache-2.0' },
    runtime: { format: 'gguf', family: s.family ?? 'wllama', requirement: '>=3.8.1 <3.9.0', browser_features: ['wasm'] },
    files: [{ role: kind === 'lora' ? 'adapter' : 'weights', path: 'model.gguf', size: s.size, sha256: sha, locations: [] }],
    operations: s.caps.filter((c) => OPERATION_CONTRACTS[c]).map((c) => ({
      id: c, prompt: { mode: 'chat' as const, template: '{{input}}' },
      input_schema: OPERATION_CONTRACTS[c]!.input_schema, output_schema: OPERATION_CONTRACTS[c]!.output_schema,
    })),
    requirements: {
      context_length: 1024,
      ...(s.memory ? { memory_mb: { value: s.memory, basis: 'estimated' as const, context_length: 1024 } } : {}),
      ...(s.hw ? { hardware_profiles: s.hw } : {}),
    },
    ...(kind === 'lora' ? { base: { release_id: 'f'.repeat(64), manifest_sha256: 'e'.repeat(64), files: [{ sha256: 'd'.repeat(64), size: 1 }] } } : {}),
    ...(s.synthetic ? { labels: ['synthetic'] } : {}),
  };
  const e = finalizeEvent(buildReleaseEventTemplate({ manifestJson: serializeManifest(m), createdAt: t++ }), s.sk);
  events[s.label] = e;
  ids[s.label] = e.id;
}

// Hand-written expectations.
const queries: { name: string; query: Record<string, unknown>; expect: string[]; ordered?: boolean }[] = [
  { name: 'all non-synthetic', query: {}, expect: ['qwen-like', 'smol-like', 'same-name-b', 'classifier-only', 'lora', 'unknown-runtime'] },
  { name: 'include synthetic', query: { includeSynthetic: true }, expect: specs.map((s) => s.label) },
  { name: 'capability intersection', query: { capabilities: ['summarization', 'text-classification'] }, expect: ['qwen-like'] },
  { name: 'single capability', query: { capabilities: ['text-classification'] }, expect: ['qwen-like', 'classifier-only'] },
  { name: 'language any-of', query: { languages: ['es'] }, expect: ['qwen-like', 'classifier-only'] },
  { name: 'kind lora', query: { kind: 'lora' }, expect: ['lora'] },
  { name: 'runtime family', query: { runtimeFamily: 'onnx-web' }, expect: ['unknown-runtime'] },
  { name: 'license', query: { license: 'MIT' }, expect: ['same-name-b'] },
  { name: 'download size', query: { maxDownloadBytes: 60_000_000 }, expect: ['classifier-only', 'lora', 'unknown-runtime'] },
  { name: 'memory excludes unknown', query: { maxMemoryMb: 1000 }, expect: ['qwen-like', 'same-name-b'] },
  { name: 'memory includes unknown when asked', query: { maxMemoryMb: 1000, includeUnknownMemory: true }, expect: ['qwen-like', 'smol-like', 'same-name-b', 'lora', 'unknown-runtime'] },
  { name: 'hardware profile', query: { hardwareProfile: 'cpu-wasm' }, expect: ['qwen-like', 'smol-like'] },
  { name: 'text search', query: { text: 'summaries' }, expect: ['qwen-like', 'smol-like'] },
  { name: 'text prefix + diacritics', query: { text: 'résid' }, expect: ['smol-like'] },
  { name: 'text with FTS operators is literal', query: { text: 'leak OR NOT "x' }, expect: [] },
  { name: 'text leak', query: { text: 'water leaks' }, expect: ['classifier-only'] },
  { name: 'same name, distinct publishers', query: { text: 'Tiny summarizer' }, expect: ['smol-like', 'same-name-b'] },
  { name: 'combined filters', query: { capabilities: ['summarization'], languages: ['en'], maxDownloadBytes: 400_000_000, runtimeFamily: 'wllama' }, expect: ['smol-like', 'same-name-b'] },
  { name: 'order by size', query: { orderBy: 'size', capabilities: ['summarization'] }, expect: ['unknown-runtime', 'same-name-b', 'smol-like', 'qwen-like'], ordered: true },
  { name: 'pagination', query: { orderBy: 'size', capabilities: ['summarization'], limit: 2, offset: 1 }, expect: ['same-name-b', 'smol-like'], ordered: true },
];

const out = {
  description: 'Golden catalog queries. Every binding (node:sqlite, SQLite WASM) must return exactly these release sets. TEST-ONLY keys.',
  events: Object.values(events),
  labels: ids,
  queries: queries.map((q) => ({ ...q, expect: q.expect.map((l) => ids[l]) })),
};
writeFileSync(join(import.meta.dirname, '../fixtures/golden-queries.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote golden-queries.json with', out.events.length, 'events and', out.queries.length, 'queries');
