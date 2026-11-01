import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReleaseSupport, satisfies, WLLAMA_VERSION, type RuntimeCapabilities } from '../src/support.ts';
import { checkAdapterCompatibility, readGgufHeader } from '../src/gguf.ts';

const caps: RuntimeCapabilities = {
  runtime: 'wllama',
  version: '3.8.1',
  features: { wasm: true, 'wasm-simd': true, 'wasm-threads': true, webgpu: false, opfs: true },
  crossOriginIsolated: true,
  hardwareConcurrency: 4,
  adapterExecution: { supported: true, reason: 'test' },
};

describe('runtime support', () => {
  it('pins the installed wllama version', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../node_modules/@wllama/wllama/package.json'), 'utf8'));
    expect(pkg.version).toBe(WLLAMA_VERSION);
  });

  it('evaluates semver requirements', () => {
    expect(satisfies('3.8.1', '>=3.8.1 <3.9.0')).toBe(true);
    expect(satisfies('3.9.0', '>=3.8.1 <3.9.0')).toBe(false);
    expect(satisfies('3.8.1', '^3.0.0')).toBe(true);
    expect(satisfies('3.8.1', '~3.7.0')).toBe(false);
    expect(satisfies('3.8.1', '*')).toBe(true);
    expect(satisfies('3.8.1', 'garbage')).toBe(false);
  });

  const base = JSON.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../protocol/vectors/release-model.json'), 'utf8')).event.tags.find((t: string[]) => t[0] === 'wexare-manifest')[1],
  );
  it('reports unsupported runtimes, features and synthetic records', () => {
    expect(checkReleaseSupport(base, caps).supported).toBe(true);
    expect(checkReleaseSupport({ ...base, runtime: { ...base.runtime, family: 'onnx-web' } }, caps).reasons.join()).toMatch(/onnx-web/);
    expect(checkReleaseSupport({ ...base, runtime: { ...base.runtime, browser_features: ['webgpu'] } }, caps).reasons.join()).toMatch(/webgpu/);
    expect(checkReleaseSupport({ ...base, labels: ['synthetic'] }, caps).supported).toBe(false);
    expect(checkReleaseSupport({ ...base, kind: 'lora' }, { ...caps, adapterExecution: { supported: false, reason: 'Adapter execution unavailable in this runtime' } }).reasons).toContain(
      'Adapter execution unavailable in this runtime',
    );
  });
});

const models = join(import.meta.dirname, '../../../.data/fixtures/models');
describe.skipIf(!existsSync(join(models, 'moe_shakespeare15M.gguf')))('GGUF headers (real fixture files)', () => {
  const blob = (f: string) => new Blob([readFileSync(join(models, f))]);
  it('reads architecture and adapter metadata', async () => {
    const h = await readGgufHeader(blob('moe_shakespeare15M.gguf'));
    expect(h.metadata['general.type']).toBe('adapter');
    expect(h.metadata['adapter.type']).toBe('lora');
  });
  it('accepts the exact base pair and rejects a different architecture', async () => {
    expect((await checkAdapterCompatibility(blob('stories15M_MOE-F16.gguf'), blob('moe_shakespeare15M.gguf'))).ok).toBe(true);
    const qwenHead = new Blob([readFileSync(join(models, 'qwen2.5-0.5b-instruct-q4_k_m.gguf')).subarray(0, 4 << 20)]);
    const r = await checkAdapterCompatibility(qwenHead, blob('moe_shakespeare15M.gguf'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/qwen2/);
  });
});
