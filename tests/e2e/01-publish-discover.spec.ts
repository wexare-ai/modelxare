// A02 real signed publication, A03 tag intersection, A09 (live) rejection of an
// altered inline manifest. Everything goes through the real relays.
import { expect, test } from '@playwright/test';
import { RELAY_A, RELAY_B, demoState, evidence } from '../support/env.ts';
import { gotoPage, openApp, search } from '../support/app.ts';
import { cli } from '../support/procs.ts';
import { parseOutcomes, publishNewRelease, type PublishedRelease } from '../support/releases.ts';

test.describe.configure({ mode: 'serial' });

let release: PublishedRelease;

test('A02: a new publisher publishes to both relays with separate acknowledgments', async () => {
  release = await publishNewRelease('a02');
  expect(release.outcomes[RELAY_A]).toBe('accepted');
  expect(release.outcomes[RELAY_B]).toBe('accepted');
  // Republishing the exact same event is a duplicate, not a new release.
  const again = parseOutcomes((await cli(['release', 'publish', '--event', release.eventPath])).out);
  expect(['duplicate', 'accepted']).toContain(again[RELAY_A]);
  evidence('A02', { event_id: release.eventId, manifest_sha256: release.manifestSha256, publisher: release.pubkey, relay_outcomes: release.outcomes, republish_outcomes: again });
});

test('A02: a clean browser verifies the signature and manifest hash and shows both relays', async () => {
  const app = await openApp({ path: 'discover' });
  const { page } = app;
  await expect
    .poll(async () => (await search(page, { mode: 'Live', text: release.name })).ids, { timeout: 30_000 })
    .toEqual([release.eventId]);
  const item = page.locator(`[data-testid="result-item"][data-event-id="${release.eventId}"]`);
  await expect(item).toContainText('2 relays', { timeout: 20_000 });
  await item.click();
  await expect(page.getByTestId('release-id')).toHaveText(release.eventId);
  await expect(page.getByText('metadata verified')).toBeVisible();
  await expect(page.getByText(release.manifestSha256, { exact: true })).toBeVisible();
  const provenance = await page.locator('.detail li').allInnerTexts();
  expect(provenance.filter((t) => /relay/.test(t) && (t.includes(RELAY_A) || t.includes(RELAY_B))).length).toBe(2);
  evidence('A02', { browser_verified: true, browser_sources: provenance });
  await app?.close();
});

test('A03: multi-capability filters require the intersection, locally', async () => {
  const state = demoState();
  const id = (n: string) => state.releases[n]!.event_id;
  const app = await openApp({ path: 'discover' });
  const { page } = app;
  // Wait until live discovery holds every fixture release.
  await expect.poll(async () => (await search(page, { mode: 'Live', capabilities: ['summarization'] })).ids.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);

  const both = await search(page, { mode: 'Live', capabilities: ['text-classification', 'summarization'] });
  expect(both.ids).toContain(id('community-assistant'));
  expect(both.ids).not.toContain(id('tiny-summarizer'));
  expect(both.ids).not.toContain(id('future-runtime-model'));

  const summ = await search(page, { mode: 'Live', capabilities: ['summarization'] });
  for (const n of ['community-assistant', 'tiny-summarizer', 'future-runtime-model', 'wrong-file-hash']) expect(summ.ids).toContain(id(n));

  // A capability nobody declares matches nothing (no OR-filter leakage).
  const none = await search(page, { mode: 'Live', capabilities: ['summarization', 'translation'] });
  expect(none.ids).not.toContain(id('community-assistant'));
  evidence('A03', { intersection: both.ids, summarization_only: summ.ids, impossible_pair_total: none.total });
  await app?.close();
});

test('A09: the browser rejects a validly signed event whose inline manifest was altered', async () => {
  const bad = demoState().releases['_invalid-manifest-hash']!.event_id;
  const app = await openApp({ path: 'sources' });
  const { page } = app;
  const rejected = page.locator('details', { hasText: 'Recently rejected events' });
  await expect(rejected).toBeVisible({ timeout: 30_000 });
  await rejected.locator('summary').click();
  await expect(rejected).toContainText(bad.slice(0, 16));
  const line = (await rejected.locator('li', { hasText: bad.slice(0, 16) }).first().innerText()).trim();
  expect(line).toMatch(/manifest/i);
  await gotoPage(page, `model/${bad}`);
  await expect(page.getByText('is not in the local catalog')).toBeVisible();
  evidence('A09', { live_rejection: line });
  await app?.close();
});
