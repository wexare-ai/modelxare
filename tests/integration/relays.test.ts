// Real relays (pnpm infra:up, pnpm demo:prepare && pnpm demo:publish).
// A03: a relay treats values inside one tag filter as OR; the intersection is
// enforced locally. A02: per-relay acknowledgments and idempotent republishing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesTagQuery, narrowingRelayFilters, verifyReleaseEvent, type NostrEvent } from '@wexare/protocol';
import { publishToRelays, queryRelay } from '../../apps/cli/src/relays.ts';
import { DATA, RELAY_A, RELAY_B, demoState } from '../support/env.ts';

const state = demoState();
const id = (n: string) => state.releases[n]!.event_id;

describe('A03 tag queries against a real relay', () => {
  it('one #t filter with two capability tags returns their union (OR), never the intersection', async () => {
    const union = await queryRelay(RELAY_A, { kinds: [1063], '#t': ['task:text-classification', 'task:summarization'], limit: 500 });
    const ids = new Set(union.map((e) => e.id));
    expect(ids.has(id('community-assistant'))).toBe(true);
    expect(ids.has(id('tiny-summarizer'))).toBe(true); // summarization only: an OR match
  });

  it('narrowing requests plus the local check yield exactly the intended intersection', async () => {
    const q = { capabilities: ['text-classification', 'summarization'] };
    const fetched = (await Promise.all(narrowingRelayFilters(q, { limit: 500 }).map((f) => queryRelay(RELAY_A, f as never)))).flat();
    const verified = [...new Map(fetched.map((e) => [e.id, e])).values()].map((e) => verifyReleaseEvent(e)).filter((r) => r.ok);
    const matched = verified.filter((r) => r.ok && matchesTagQuery(r.value.manifest, q)).map((r) => (r.ok ? r.value.event.id : ''));
    expect(matched).toContain(id('community-assistant'));
    expect(matched).not.toContain(id('tiny-summarizer'));
    expect(matched).not.toContain(id('future-runtime-model'));
  });

  it('a tag nobody uses matches nothing, and missing tags do not match', async () => {
    const none = await queryRelay(RELAY_A, { kinds: [1063], '#t': ['task:no-such-capability-xyz'], limit: 50 });
    expect(none).toEqual([]);
  });
});

describe('A02 publication outcomes', () => {
  it('republishing the same signed event is reported per relay and creates no new release', async () => {
    const ev = JSON.parse(readFileSync(join(DATA, 'releases/story-base/event.json'), 'utf8')) as NostrEvent;
    const results = await publishToRelays(ev, [RELAY_A, RELAY_B]);
    expect(results.map((r) => r.relay)).toEqual([RELAY_A, RELAY_B]);
    for (const r of results) expect(['duplicate', 'accepted']).toContain(r.outcome);
    for (const relay of [RELAY_A, RELAY_B]) {
      const got = await queryRelay(relay, { ids: [ev.id] });
      expect(got.map((e) => e.id)).toEqual([ev.id]);
    }
  });

  it('an unreachable relay is reported as such, separately from a working one', async () => {
    const ev = JSON.parse(readFileSync(join(DATA, 'releases/story-base/event.json'), 'utf8')) as NostrEvent;
    const results = await publishToRelays(ev, [RELAY_A, 'ws://127.0.0.1:9'], 3000);
    expect(results[0]!.outcome).toMatch(/duplicate|accepted/);
    expect(results[1]!.outcome).toBe('disconnected');
  });
});
