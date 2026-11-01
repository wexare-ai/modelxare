// Synthetic catalog records for scale/search tests (A08). Every record is a
// real signed event, labeled `synthetic`, with no operations and no retrieval
// locations: it can be searched, never downloaded or executed.
import { finalizeEvent } from 'nostr-tools/pure';
import { RELEASE_SCHEMA, buildReleaseEventTemplate, serializeManifest, sha256Hex, type NostrEvent, type ReleaseManifest } from '@wexare/protocol';
import type { LoadedKey } from './keys.ts';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = ['compact', 'swift', 'quiet', 'bright', 'tiny', 'robust', 'frugal', 'nimble', 'gentle', 'precise', 'humble', 'sturdy'];
const NOUN = ['heron', 'otter', 'lynx', 'falcon', 'badger', 'wren', 'marten', 'ibis', 'gecko', 'puffin', 'stoat', 'kestrel'];
const TASKS = ['summarization', 'text-classification', 'translation', 'sentiment-analysis', 'text-generation', 'question-answering'];
const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'und'];
const LICENSES = ['Apache-2.0', 'MIT', 'CC-BY-4.0', 'OpenRAIL-M'];
const RUNTIMES = [
  { format: 'gguf', family: 'wllama' },
  { format: 'onnx', family: 'onnx-web' },
  { format: 'mlc', family: 'mlc-web' },
];
const TOPICS = ['building maintenance', 'transit notices', 'school newsletters', 'garden club posts', 'repair requests', 'event announcements', 'lost and found', 'noise complaints'];

export interface SyntheticOptions {
  seed?: number;
  baseTime?: number;
  /** Per-record created_at; defaults to baseTime + i (strictly increasing). */
  timeOf?: (i: number) => number;
  /** model_id prefix, so separate synthetic sets never collide. */
  prefix?: string;
}

export function generateSyntheticEvents(key: LoadedKey, count: number, opts: SyntheticOptions = {}): NostrEvent[] {
  const rnd = mulberry32(opts.seed ?? 20261031);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const pickSome = <T>(xs: T[], max: number) => [...new Set(Array.from({ length: 1 + Math.floor(rnd() * max) }, () => pick(xs)))];
  const baseTime = opts.baseTime ?? Math.floor(Date.now() / 1000) - count;
  const timeOf = opts.timeOf ?? ((i: number) => baseTime + i);
  const prefix = opts.prefix ?? 'synthetic';
  const out: NostrEvent[] = [];
  for (let i = 0; i < count; i++) {
    const caps = pickSome(TASKS, 2);
    const kind = i % 23 === 0 ? 'lora' : 'model';
    const rt = pick(RUNTIMES);
    const ctx = pick([512, 1024, 2048, 4096]);
    const size = Math.floor(5e6 + rnd() * 2e9);
    const topic = pick(TOPICS);
    const m: ReleaseManifest = {
      schema: RELEASE_SCHEMA,
      model_id: `${prefix}-${String(i).padStart(5, '0')}`,
      name: `${pick(ADJ)} ${pick(NOUN)} ${caps[0]!.replace(/-/g, ' ')} ${i}`,
      description: `SYNTHETIC record ${i} for catalog scale tests. Not a runnable model. Pretends to handle ${caps.join(' and ')} for ${topic}.`,
      version: `1.${i % 10}.0`,
      kind,
      capabilities: caps,
      languages: pickSome(LANGS, 3),
      license: { id: pick(LICENSES) },
      runtime: { ...rt, requirement: '>=1.0.0', browser_features: ['wasm-simd'] },
      files: [{ role: kind === 'lora' ? 'adapter' : 'weights', path: `model.${rt.format}`, size, sha256: sha256Hex(`${prefix} file ${i}`), locations: [] }],
      operations: [],
      requirements: {
        context_length: ctx,
        ...(rnd() < 0.6 ? { memory_mb: { value: Math.ceil(size / 1e6) + 100, basis: 'estimated' as const, context_length: ctx } } : {}),
        ...(rnd() < 0.7 ? { hardware_profiles: pickSome(['cpu-wasm', 'webgpu'], 2) } : {}),
      },
      ...(kind === 'lora'
        ? { base: { release_id: sha256Hex(`${prefix} base ${i}`), manifest_sha256: sha256Hex(`${prefix} base manifest ${i}`), files: [{ sha256: sha256Hex(`${prefix} base file ${i}`), size: 1e8 }] } }
        : {}),
      labels: ['synthetic'],
    };
    out.push(finalizeEvent(buildReleaseEventTemplate({ manifestJson: serializeManifest(m), createdAt: timeOf(i) }), key.secretKey) as unknown as NostrEvent);
  }
  return out;
}
