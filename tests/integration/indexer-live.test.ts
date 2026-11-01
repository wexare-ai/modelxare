// Real relay and indexer process (pnpm infra:up, pnpm demo:prepare).
// Relays apply `since` to live events too: a release signed earlier and published
// while the indexer is already live must still be collected (README quick start:
// `pnpm dev`, then `pnpm demo:publish` of events signed by `demo:prepare`).
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { MANIFEST_TAG, buildReleaseEventTemplate, type NostrEvent } from '@wexare/protocol';
import { publishToRelays } from '../../apps/cli/src/relays.ts';
import { DATA, RELAY_A, runDir } from '../support/env.ts';
import { Indexer, waitFor } from '../support/procs.ts';

const indexer = new Indexer('live-probe', mkdtempSync(join(runDir(), 'indexer-live-')), 8797, [RELAY_A]);
afterAll(() => indexer.stop());

describe('live collection', () => {
  it('collects a release published now but signed two hours ago', async () => {
    await indexer.start();
    const before = (await indexer.waitCaughtUp()).totals.releases;

    const stored = JSON.parse(readFileSync(join(DATA, 'releases/story-base/event.json'), 'utf8')) as NostrEvent;
    const manifestJson = stored.tags.find((t) => t[0] === MANIFEST_TAG)![1]!;
    const tpl = buildReleaseEventTemplate({ manifestJson, createdAt: Math.floor(Date.now() / 1000) - 7200 });
    const ev = finalizeEvent(tpl, generateSecretKey()) as unknown as NostrEvent;
    const [outcome] = await publishToRelays(ev, [RELAY_A]);
    expect(outcome!.outcome).toBe('accepted');

    const after = await waitFor('the backdated release to reach the live indexer', async () => {
      const s = await indexer.status();
      return s.totals.releases > before ? s : null;
    }, 10_000);
    expect(after.totals.releases).toBe(before + 1);
  });
});
