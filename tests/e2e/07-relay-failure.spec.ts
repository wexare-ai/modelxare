// A16 relay failure. Runs last: it stops the relay containers (data kept) and
// always starts them again.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DATA, RELAY_A, RELAY_B, evidence, runDir } from '../support/env.ts';
import { cli, infra } from '../support/procs.ts';
import { importArchive, openApp, search } from '../support/app.ts';
import { publishNewRelease } from '../support/releases.ts';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await infra('start', 'relay-a', 'relay-b');
});

test('A16: with relay A down, relay B still supports publication and live discovery', async ({ browser }) => {
  await infra('stop', 'relay-a');
  const r = await publishNewRelease('a16-relay-a-down');
  expect(r.outcomes[RELAY_A]).toMatch(/disconnected|timed-out/);
  expect(r.outcomes[RELAY_B]).toBe('accepted');

  const app = await openApp(browser, { path: 'discover' });
  const { page } = app;
  await expect.poll(async () => (await search(page, { mode: 'Live', text: r.name })).ids, { timeout: 30_000 }).toEqual([r.eventId]);
  await page.evaluate(() => (location.hash = '#/sources'));
  await expect(page.locator(`[data-testid="relay-row"][data-relay="${RELAY_B}"]`)).toHaveAttribute('data-state', 'live');
  await expect(page.locator(`[data-testid="relay-row"][data-relay="${RELAY_A}"]`)).not.toHaveAttribute('data-state', 'live');
  evidence('A16', { relay_a_down: { event_id: r.eventId, outcomes: r.outcomes, discovered_via: RELAY_B } });
  await app.context.close();
});

test('A16: with both relays down, archived records stay searchable', async ({ browser }) => {
  await infra('start', 'relay-a');
  // A snapshot built directly from preserved signed event files (no indexer involved).
  const dir = join(runDir(), 'archives-events');
  const releases = join(DATA, 'releases');
  const events = readdirSync(releases)
    .filter((n) => !n.startsWith('_'))
    .flatMap((n) => ['--events', join(releases, n, 'event.json')]);
  const key = join(runDir(), 'builder-events.key.json');
  await cli(['keygen', '--out', key, '--label', 'e2e-builder-events']);
  const mirror = `e2e-ev-${(process.env.WEXARE_E2E_RUN ?? 'run').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  const out = (await cli(['archive', 'build', ...events, '--builder-key', key, '--out', dir, '--publish', '--mirror-name', mirror])).out;
  const annPath = /saved (\S+\.announcement\.json)/.exec(out)![1]!;

  const app = await openApp(browser);
  const { page } = app;
  await importArchive(page, readFileSync(annPath, 'utf8'), { zipPath: annPath.replace(/\.announcement\.json$/, '.zip') });

  await infra('stop', 'relay-a', 'relay-b');
  await page.reload();
  await expect(page.getByText('catalog: OPFS')).toBeVisible({ timeout: 30_000 });
  const found = await search(page, { mode: 'Archives', text: 'Community message assistant' });
  expect(found.total).toBeGreaterThan(0);
  const tagged = await search(page, { mode: 'Archives', capabilities: ['text-classification', 'summarization'] });
  expect(tagged.total).toBeGreaterThan(0);
  evidence('A16', { both_down: { archive_announcement: annPath, archive_hits: found.total, capability_hits: tagged.total } });
  await app.context.close();
});
