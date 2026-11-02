// System 1 decisions with the real router release (Laya fp16 from the local
// mirror). Opt-in, because loading it needs about 4 GB of free memory:
//
//   WEXARE_TEST_LAYA=1 pnpm vitest run --project integration tests/integration/router-laya.test.ts
//
// Only the router is real here. Mini-models can't run in Node, so no step
// runs: what is checked is which steps System 1 plans for each request, never
// what a model would write. Every probability goes to the evidence file, to
// tune the thresholds from.
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

  // [steps the request asks for, request]
  const cases: [string[], string][] = [
    [['summarize'], 'Please summarize this message: There has been a water leak near the entrance since this morning. Can someone inspect it?'],
    [['sort'], 'Which category does this message belong to? The people in apartment 4B play loud music every night.'],
    [['translate'], 'Translate into French: the swimming pool is closed today.'],
    [['write'], 'Continue this story: Once upon a time, a little fox'],
    [['answer'], 'What is the capital of Australia?'],
    [['reply'], 'Write a reply to this tenant: my heating has not worked for three days.'],
    [['sort', 'summarize'], 'Categorize and Summarize this message: There has been a water leak near the entrance since this morning. Can someone inspect it?'],
    [['sort', 'summarize'], 'Sort this message and then summarize it: water is leaking near the entrance.'],
    [['summarize', 'translate'], 'Summarize this and translate it into Spanish: the swimming pool will be closed all week for repairs.'],
  ];

  it.each(cases)('plans %j for: %s', async (expected, request) => {
    const r = await route(request, system1, decisionsOnly());
    const planned = r.steps.map((s) => s.intent.id);
    const j = r.judgement!;
    log.push({ request, expected, planned, asked: j.asked, main: j.main, latency_ms: j.latencyMs, device: j.device });
    // The message shows every probability, so a miss says how far off it was.
    expect(planned, JSON.stringify({ asked: j.asked, main: [j.main.choice, j.main.probability] })).toEqual(expected);
  }, 120_000);
});
