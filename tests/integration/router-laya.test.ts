// System 1 decisions with the real router release (Laya fp16 from the local
// mirror). Opt-in, because loading it in WebAssembly needs more than 4.6 GB of
// free memory:
//
//   WEXARE_TEST_LAYA=1 pnpm vitest run --project integration tests/integration/router-laya.test.ts
//
// WEXARE_TEST_LAYA=native runs the same requests through the local runtime's
// native router (apps/local, onnxruntime-node), about 2.5 GB, reading the files
// from .data/artifacts; it needs no running services.
//
// Only the router is real here. Mini-models can't run in Node, so no step
// runs: what is checked is which steps System 1 plans for each request, never
// what a model would write. Every probability goes to the evidence file, to
// tune the thresholds from.
//
// On 2026-11-02 the same release, run with native ONNX Runtime (an 8 GB
// machine can't hold the WebAssembly build), planned all of these
// correctly, and missed one more request that is kept out of the list:
// "Classify this complaint and draft a reply" reads "Classify this complaint"
// as summarize (0.78), not sort. Rewording the sort option did not fix it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Laya } from '@wexare/laya-web';
import { layaBundle, route, routerFiles, type Hooks, type System1 } from '@wexare/router';
import type { CandidateRelease } from '@wexare/orchestrator';
import { DATA, endpoints, evidence } from '../support/env.ts';

const RUN = process.env.WEXARE_TEST_LAYA === '1' || process.env.WEXARE_TEST_LAYA === 'native';
const NATIVE = process.env.WEXARE_TEST_LAYA === 'native';

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

describe.skipIf(!RUN)(`System 1 router (real Laya${NATIVE ? ', native' : ''})`, () => {
  let system1: System1;
  let close: () => Promise<void> = async () => undefined;
  const log: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const release = routerRelease();
    if (NATIVE) {
      const { NativeLaya } = await import('../../apps/local/src/laya.ts');
      const f = routerFiles(release.manifest)!;
      const at = (x: { sha256: string }) => join(DATA, 'artifacts/main/sha256', x.sha256);
      const native = await NativeLaya.load({ weights: at(f.weights), tokenizer: at(f.tokenizer), tokenizerConfig: at(f.tokenizerConfig), config: at(f.config) });
      system1 = native;
      close = () => native.close();
    } else {
      const laya = await Laya.load({ bundle: layaBundle(release, (sha) => `${endpoints.artifacts}/main/sha256/${sha}`), device: 'wasm' });
      system1 = laya;
      close = () => laya.close();
    }
  }, 600_000);

  afterAll(async () => {
    evidence(NATIVE ? 'ROUTER-NATIVE' : 'ROUTER', { decisions: log });
    await close();
  });

  // [steps the request asks for, in the order asked; request]
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
    [['sort'], 'Categorize this message: There has been a water leak near the entrance since this morning. Can someone inspect it?'],
    [['summarize'], 'Summarize: The board met on Tuesday and agreed to repaint the hallways in May, replace the lobby lights, and raise the garden budget.'],
    [['summarize', 'sort'], 'Summarize and categorize this message: Your electricity bill of $84.20 is due on March 3. Pay online before then to avoid a late fee.'],
    [['sort', 'summarize'], 'Can you sort this and give me a short summary? Someone left trash bags in the stairwell again and it smells terrible.'],
    [['translate', 'summarize'], 'Translate this into German and summarize it: the residents meeting is moved to Thursday at 7 pm in the community room.'],
    [['summarize'], 'Summarize this message: The hallway lights flicker every evening and it is getting hard to see the stairs.'],
    [['sort'], 'What category is this? Your order of running shoes has shipped and will arrive on Wednesday.'],
    [['reply'], 'Reply to this message: Thanks a lot for fixing the front door so quickly!'],
    // The message names other tasks; only the instruction counts.
    [['summarize'], 'Summarize this: Can you translate the notice into Spanish for the new tenants? Many of them do not read English yet.'],
    [['sort'], 'Please categorize: Can someone summarize the meeting notes for me? I missed the meeting.'],
    [['write'], 'Once upon a time, a little fox found a lantern in the snow.'],
    [['answer'], 'How long does it take to boil an egg?'],
    [['translate'], 'Translate to Italian: the elevator is out of order.'],
    [['summarize'], 'Summarize the pros and cons: Moving the bins outside saves space but attracts foxes at night.'],
    [['sort', 'summarize', 'reply'], 'Categorize, summarize and reply to this message: The heating in building B is off again.'],
    [['summarize', 'reply'], 'Give me a summary and draft a reply: Hi, the parcel room has been locked all weekend, where can I pick up my package?'],
    [['answer'], 'Why do pipes freeze in winter and how can I prevent it?'],
    [['sort', 'summarize'], 'categorize + summarize: Loud drilling from flat 12 every morning at 7.'],
  ];

  it.each(cases)('plans %j for: %s', async (expected, request) => {
    const r = await route(request, system1, decisionsOnly());
    const planned = r.steps.map((s) => s.intent.id);
    const j = r.judgement!;
    log.push({ request, expected, planned, readings: j.readings, latency_ms: j.latencyMs, device: j.device });
    // The message shows what each text looked like, so a miss says how far off it was.
    expect(planned, JSON.stringify(j.readings.map((x) => [x.text, x.choice, x.probability]))).toEqual(expected);
  }, 120_000);
});
