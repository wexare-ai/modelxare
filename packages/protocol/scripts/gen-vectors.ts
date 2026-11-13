// Regenerates the public test vectors in ../vectors. The keys are derived from
// public strings and are TEST-ONLY: never use them for real publication.
// Usage: pnpm --filter @wexare/protocol exec tsx scripts/gen-vectors.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  buildCatalogAnnouncementTemplate,
  buildReleaseEventTemplate,
  canonicalJson,
  serializeManifest,
  sha256Hex,
  type NostrEvent,
  type ReleaseManifest,
} from '../src/index.ts';

const out = join(import.meta.dirname, '../vectors');
const testKey = (label: string) => {
  const sk = sha256Hex(`wexare public test vector key: ${label}`);
  return { label, secret_key_hex: sk, pubkey: getPublicKey(hexToBytes(sk)) };
};
const publisher = testKey('publisher-a');
const builder = testKey('archive-builder');
const sign = (t: Parameters<typeof finalizeEvent>[0], k: { secret_key_hex: string }) =>
  finalizeEvent(t, hexToBytes(k.secret_key_hex)) as unknown as NostrEvent;
const write = (name: string, v: unknown) => writeFileSync(join(out, name), JSON.stringify(v, null, 2) + '\n');

const TASKS: Record<string, Pick<ReleaseManifest['operations'][number], 'title' | 'category' | 'when' | 'output'>> = {
  'text-classification': {
    title: 'Sort by topic',
    category: 'messages',
    when: 'put a message into one topic, such as family, work or travel',
    output: { type: 'label', labels: [{ id: 'family' }, { id: 'work' }, { id: 'other' }] },
  },
  summarization: { title: 'Summarize', category: 'messages', when: 'shorten a message into one short sentence', output: { type: 'text', max_chars: 400, single_line: true } },
};
const op = (id: string, template: string) => ({
  id,
  ...TASKS[id]!,
  prompt: { mode: 'chat' as const, template },
  generation: { max_tokens: 32, temperature: 0 },
});
const fileHash = sha256Hex('test-vector weights bytes');

const model: ReleaseManifest = {
  schema: 'wexare.micromodel.release/0.2',
  model_id: 'vector-classifier',
  name: 'Vector classifier',
  description: 'Test-vector release. Not a runnable model.',
  version: '1.0.0',
  kind: 'model',
  capabilities: ['summarization', 'text-classification'],
  languages: ['en', 'es'],
  license: { id: 'Apache-2.0' },
  runtime: { format: 'gguf', family: 'wllama', requirement: '>=3.8.1 <3.9.0', browser_features: ['wasm'], chat_template: { source: 'embedded' } },
  files: [
    {
      role: 'weights',
      path: 'model.gguf',
      size: 25,
      sha256: fileHash,
      locations: [
        { transport: 'ipfs', uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' },
        { transport: 'http', uri: 'http://127.0.0.1:8790/sha256/' + fileHash },
      ],
    },
  ],
  operations: [op('text-classification', 'Classify: {{input}}'), op('summarization', 'Summarize: {{input}}')],
  requirements: { context_length: 1024 },
  labels: ['test-vector'],
};
const modelJson = serializeManifest(model);
const modelEvent = sign(buildReleaseEventTemplate({ manifestJson: modelJson, createdAt: 1793491200 }), publisher);

const lora: ReleaseManifest = {
  ...model,
  model_id: 'vector-adapter',
  name: 'Vector adapter',
  kind: 'lora',
  capabilities: ['summarization'],
  languages: ['en'],
  files: [{ role: 'adapter', path: 'adapter.gguf', size: 7, sha256: sha256Hex('adapter'), locations: [] }],
  operations: [op('summarization', 'Summarize: {{input}}')],
  base: { release_id: modelEvent.id, manifest_sha256: sha256Hex(modelJson), files: [{ sha256: fileHash, size: 25 }] },
};
const loraEvent = sign(buildReleaseEventTemplate({ manifestJson: serializeManifest(lora), createdAt: 1793491260 }), publisher);

const announcement = sign(
  buildCatalogAnnouncementTemplate({
    zipSha256: sha256Hex('zip bytes'),
    zipSize: 9,
    urls: ['ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', 'http://127.0.0.1:8790/archives/x.zip'],
    magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=catalog.zip',
    content: 'Test-vector catalog snapshot.',
    createdAt: 1793491300,
  }),
  builder,
);

// Invalid variants (each must be rejected with the noted code).
const badSignature = { ...modelEvent, sig: modelEvent.sig.slice(0, -2) + (modelEvent.sig.endsWith('00') ? '01' : '00') };
const alteredManifestTags = modelEvent.tags.map((t) => (t[0] === 'wexare-manifest' ? [t[0], t[1]!.replace('Vector classifier', 'Vector classifiex')] : t));
const alteredManifest = sign({ kind: 1063, created_at: modelEvent.created_at, content: modelEvent.content, tags: alteredManifestTags }, publisher);
const tagMismatch = sign(
  { kind: 1063, created_at: modelEvent.created_at, content: '', tags: modelEvent.tags.map((t) => (t[1] === 'lang:es' ? ['t', 'lang:fr'] : t)) },
  publisher,
);

write('keys.json', { warning: 'PUBLIC TEST-ONLY KEYS. Never use for real publication.', keys: [publisher, builder] });
write('release-model.json', { expect: 'valid', manifest_sha256: sha256Hex(modelJson), event: modelEvent });
write('release-lora.json', { expect: 'valid', event: loraEvent });
write('catalog-announcement.json', { expect: 'valid', event: announcement });
write('invalid-bad-signature.json', { expect: 'bad_signature', event: badSignature });
write('invalid-altered-manifest.json', { expect: 'manifest_hash_mismatch', event: alteredManifest });
write('invalid-tag-mismatch.json', { expect: 'tag_inconsistent', event: tagMismatch });
write('canonical-json.json', {
  input: { b: [3, { z: 1, a: 'é' }], a: null, c: 1.5, 'é': true },
  expected: canonicalJson({ b: [3, { z: 1, a: 'é' }], a: null, c: 1.5, 'é': true }),
});
console.log('vectors written to', out);
