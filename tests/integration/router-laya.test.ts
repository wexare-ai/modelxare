// System 1 decisions with the real router release (Laya fp16 from the local
// mirror). Opt-in, because loading it needs about 4 GB of free memory:
//
//   WEXARE_TEST_LAYA=1 pnpm vitest run --project integration tests/integration/router-laya.test.ts
//
// Only the router is real here. Mini-models can't run in Node, so the
// multi-step check gives each step a fixed result; what is checked is which
// step System 1 picks next, never what a model would write.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Laya } from '@wexare/laya-web';
import { layaBundle, route, type Hooks, type System1 } from '@wexare/router';
import type { CandidateRelease } from '@wexare/orchestrator';
import { DATA, endpoints, evidence } from '../support/env.ts';

const RUN = process.env.WEXARE_TEST_LAYA === '1';

function routerRelease(): CandidateRelease {
  const ev = JSON.parse(readFileSync(join(DATA, 'releases/laya-router/event.json'), 'utf8')) as { id: string; pubkey: string; tags: string[][] };
  const manifest = JSON.parse(ev.tags.find((t) => t[0] === 'wexare-manifest')![1]!);
  return { eventId: ev.id, pubkey: ev.pubkey, modelId: manifest.model_id, name: manifest.name, version: manifest.version, manifestSha256: '', manifest, support: { supported: true, reasons: [], executableOperations: [] } };
}

/** No local models and no online help: every step is recorded as unavailable; only decisions matter. */
const decisionsOnly = (): Hooks => ({
  candidates: [],
  isCached: () => false,
  runLocal: async () => ({}),
  remote: null,
  confirmDownload: async () => false,
  download: async () => false,
  clarify: async () => null,
});

describe.skipIf(!RUN)('System 1 router (real Laya)', () => {
  let laya: Laya;
  let system1: System1;
  const log: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const release = routerRelease();
    laya = await Laya.load({ bundle: layaBundle(release, (sha) => `${endpoints.artifacts}/main/sha256/${sha}`), device: 'wasm' });
    system1 = laya;
  }, 600_000);

  afterAll(async () => {
    evidence('ROUTER', { decisions: log });
    await laya?.close();
  });

  const cases: [string, string][] = [
    ['summarize', 'Please summarize this message: There has been a water leak near the entrance since this morning. Can someone inspect it?'],
    ['sort', 'Which category does this message belong to? The people in apartment 4B play loud music every night.'],
    ['translate', 'Translate into French: the swimming pool is closed today.'],
    ['write', 'Continue this story: Once upon a time, a little fox'],
    ['answer', 'What is the capital of Australia?'],
    ['reply', 'Write a reply to this tenant: my heating has not worked for three days.'],
  ];

  it.each(cases)('routes a request asking to %s', async (expected, request) => {
    const r = await route(request, system1, decisionsOnly(), { maxSteps: 1, confirmBelow: 0 });
    const d = r.steps[0]!.decision;
    log.push({ request, expected, choice: d.choice, probability: d.probability, confidence: d.confidence, latency_ms: d.latencyMs, device: d.device });
    expect(d.choice).toBe(expected);
  }, 120_000);

  it('chains two asked-for steps, then stops', async () => {
    const results: Record<string, { topic?: string; text?: string }> = {
      'text-classification': { topic: 'maintenance' },
      summarization: { text: 'Water is leaking near the entrance.' },
    };
    const step = (capability: string) => ({ manifest: { kind: 'model', capabilities: [capability], languages: ['en'], files: [] }, support: { supported: true, reasons: [], executableOperations: [capability] } }) as unknown as CandidateRelease;
    const hooks: Hooks = { ...decisionsOnly(), candidates: [step('text-classification'), step('summarization')], isCached: () => true, runLocal: async (_r, capability) => results[capability]! };
    const r = await route('Sort this message and then summarize it: water is leaking near the entrance.', system1, hooks);
    log.push({ request: 'multi-step', steps: r.steps.map((s) => [s.intent.id, s.decision.probability]), ended: r.ended });
    expect(r.steps.map((s) => s.intent.id).sort()).toEqual(['sort', 'summarize']);
    expect(r.ended).toBe('done');
  }, 300_000);
});
