// Which releases this machine runs, under which model id. Manifests are built
// here; signatures are checked elsewhere (packages/protocol), so these are
// handed in as already verified.
import { describe, expect, it } from 'vitest';
import { OPERATION_CONTRACTS, type ReleaseManifest, type VerifiedRelease } from '@wexare/protocol';
import { buildCatalog, nativeSupport } from '../src/catalog.ts';
import { Trust } from '../src/config.ts';
import { withAddOnPrompt } from '../src/engine.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const hf = (name: string) => [{ transport: 'https' as const, uri: `https://huggingface.co/x/resolve/0/${name}` }];
const file = (sha: string, role = 'weights', path = 'model.gguf', locations: ReleaseManifest['files'][number]['locations'] = hf(path)) => ({ role, path, size: 100, sha256: sha.repeat(64).slice(0, 64), locations }) as ReleaseManifest['files'][number];

function manifest(model_id: string, over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schema: 'wexare.micromodel.release/0.1',
    model_id,
    name: `${model_id} (test)`,
    version: '1.0.0',
    kind: 'model',
    description: 'test',
    license: { id: 'MIT' },
    capabilities: ['summarization'],
    languages: ['en'],
    runtime: { format: 'gguf', family: 'wllama', requirement: '>=3.8.1 <3.9.0', browser_features: ['wasm-simd'], chat_template: { source: 'embedded' } },
    files: [file('1')],
    operations: [],
    requirements: { context_length: 1024 },
    ...over,
  } as ReleaseManifest;
}

let n = 0;
const release = (m: ReleaseManifest, pubkey = A, id = `${++n}`.padStart(64, '0')): VerifiedRelease => ({
  event: { id, pubkey, created_at: 1_800_000_000 + n, kind: 1063, tags: [], content: '', sig: '' },
  manifest: m,
  manifestJson: JSON.stringify(m),
  manifestSha256: `m${id}`.slice(0, 64),
  warnings: [],
});

const open = new Trust('any');
const none = () => false;

describe('native support', () => {
  it('runs GGUF releases made for wllama, whatever the wllama version range', () => {
    expect(nativeSupport(manifest('m')).supported).toBe(true);
    expect(nativeSupport(manifest('m', { runtime: { format: 'gguf', family: 'wllama', requirement: '>=9.0.0', browser_features: ['webgpu'] } })).supported).toBe(true);
  });

  it('refuses other formats, synthetic records and torrent-only files', () => {
    expect(nativeSupport(manifest('m', { runtime: { format: 'onnx', family: 'laya', requirement: '*', browser_features: [] } })).reasons.join()).toMatch(/not gguf/);
    expect(nativeSupport(manifest('m', { labels: ['synthetic'] })).supported).toBe(false);
    expect(nativeSupport(manifest('m', { files: [file('1', 'weights', 'm.gguf', [{ transport: 'torrent', uri: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), path: 'm.gguf' }])] })).reasons.join()).toMatch(/location/);
  });
});

describe('the catalog', () => {
  it('lists the newest version of each model under its model_id', () => {
    const c = buildCatalog([release(manifest('sum', { version: '1.0.0' })), release(manifest('sum', { version: '1.2.0', files: [file('2')] }))], open, none);
    expect(c.models.map((m) => [m.id, m.release.version])).toEqual([['sum', '1.2.0']]);
  });

  it('only lists approved publishers', () => {
    const trust = new Trust([{ pubkey: A, label: 'weXare', approvedBy: 'weXare', roles: ['models'] }]);
    const c = buildCatalog([release(manifest('mine'), A), release(manifest('theirs', { files: [file('3')] }), B)], trust, none);
    expect(c.models.map((m) => [m.id, m.publisher])).toEqual([['mine', 'weXare']]);
  });

  it('gives two publishers’ same model_id distinct ids, and reserves auto', () => {
    const c = buildCatalog([release(manifest('sum'), A), release(manifest('sum', { files: [file('4')] }), B), release(manifest('auto', { files: [file('5')] }), A)], open, none);
    expect(c.models.map((m) => m.id)).toEqual([`auto@${A.slice(0, 8)}`, `sum@${A.slice(0, 8)}`, `sum@${B.slice(0, 8)}`]);
  });

  it('runs an adapter on its exact base, and marks text-only models', () => {
    const baseM = manifest('story', { runtime: { format: 'gguf', family: 'wllama', requirement: '*', browser_features: [], chat_template: { source: 'none' } } });
    const base = release(baseM);
    const lora = release(
      manifest('style', {
        kind: 'lora',
        files: [file('6', 'adapter', 'lora.gguf')],
        base: { release_id: base.event.id, manifest_sha256: base.manifestSha256, files: [{ sha256: baseM.files[0]!.sha256, size: 100 }] },
        runtime: baseM.runtime,
      } as Partial<ReleaseManifest>),
    );
    const c = buildCatalog([base, lora], open, none);
    const style = c.models.find((m) => m.id === 'style')!;
    expect(style.base?.eventId).toBe(base.event.id);
    expect(style.files.map((f) => f.role).sort()).toEqual(['adapter', 'weights']);
    expect(style.chat).toBe(false);
  });

  it('gives a chat add-on its own tasks, and its trained system prompt when the caller sends none', () => {
    const baseM = manifest('assistant');
    const base = release(baseM);
    const contract = OPERATION_CONTRACTS['command-generation']!;
    const lora = release(
      manifest('git-commands', {
        kind: 'lora',
        capabilities: ['command-generation'],
        files: [file('5', 'adapter', 'git.gguf')],
        base: { release_id: base.event.id, manifest_sha256: base.manifestSha256, files: [{ sha256: baseM.files[0]!.sha256, size: 100 }] },
        operations: [{ id: 'command-generation', prompt: { mode: 'chat', system: 'You write git commands.', template: '{{input}}' }, generation: { max_tokens: 128, temperature: 0 }, input_schema: contract.input_schema, output_schema: contract.output_schema }],
      } as Partial<ReleaseManifest>),
    );
    const git = buildCatalog([base, lora], open, none).models.find((m) => m.id === 'git-commands')!;
    expect(git.tasks).toEqual(['command-generation']);
    expect(git.chat).toBe(true);
    const ask = { maxTokens: 256, messages: [{ role: 'user' as const, content: 'show all branches' }] };
    expect(withAddOnPrompt(git, ask).messages.map((m) => m.content)).toEqual(['You write git commands.', 'show all branches']);
    expect(withAddOnPrompt(git, ask).temperature).toBe(0);
    expect(withAddOnPrompt(git, { ...ask, temperature: 0.5 }).temperature).toBe(0.5);
    const own = { ...ask, messages: [{ role: 'system' as const, content: 'Be brief.' }, ...ask.messages] };
    expect(withAddOnPrompt(git, own)).toBe(own);
  });

  it('picks the router only from publishers approved for it', () => {
    const router = manifest('laya-router', {
      capabilities: ['intent-routing'],
      runtime: { format: 'onnx', family: 'laya', requirement: '>=0.1.1 <0.2.0', browser_features: ['wasm-simd'] },
      files: [file('7', 'weights', 'laya.onnx'), file('8', 'tokenizer', 'tokenizer.json'), file('9', 'tokenizer', 'tokenizer_config.json'), file('0', 'config', 'rl_agent_config.json')],
    });
    const modelsOnly = new Trust([{ pubkey: A, label: 'weXare', approvedBy: 'weXare', roles: ['models'] }]);
    expect(buildCatalog([release(router)], modelsOnly, none).router).toBeNull();
    const both = new Trust([{ pubkey: A, label: 'weXare', approvedBy: 'weXare', roles: ['models', 'router'] }]);
    const c = buildCatalog([release(router)], both, none);
    expect(c.router?.modelId).toBe('laya-router');
    expect(c.models).toEqual([]);
  });
});
