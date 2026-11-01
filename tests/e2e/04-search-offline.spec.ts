// A08 local search over 10,000 synthetic records, and A14 offline reload with a
// cached real model (the two-stage variant runs in the `models` project).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DATA, WEB, demoState, evidence } from '../support/env.ts';
import { catalogStats, downloadRelease, gotoPage, importArchive, openApp, search, type AppHandle } from '../support/app.ts';

test.describe.configure({ mode: 'serial' });

let app: AppHandle;

test.afterAll(async () => app?.close());

test('A08: 10,000 synthetic records import, survive reload, and search locally with networking disabled', async () => {
  const synth = JSON.parse(readFileSync(join(DATA, 'synthetic/count-10000.json'), 'utf8')) as { zip: string; announcement: string };
  app = await openApp();
  const { page, context } = app;
  const t0 = Date.now();
  const r = await importArchive(page, readFileSync(synth.announcement, 'utf8'), { zipPath: synth.zip, timeoutMs: 300_000 });
  const importMs = Date.now() - t0;
  expect(r.staged).toBe(10_000);
  const verifyMs = Number(/verified in (\d+) ms/.exec(r.stagedText)?.[1]);
  const commitMs = Number(/in (\d+) ms/.exec(r.done)?.[1]);

  await page.reload();
  await expect(page.getByText('catalog: OPFS')).toBeVisible({ timeout: 30_000 });
  const stats = await catalogStats(page);
  // Live discovery may add the labeled A17 records too; the archive alone holds 10,000.
  expect(Number(/\((\d+) synthetic\)/.exec(stats.text)?.[1])).toBeGreaterThanOrEqual(10_000);

  // Networking off: the app's sync switch and the browser itself.
  await page.getByTestId('network-toggle').uncheck();
  await context.setOffline(true);
  const queries: Record<string, { total: number; ms: number }> = {};
  const run = async (name: string, q: Parameters<typeof search>[1]) => {
    await search(page, q); // cold
    // Same query again (a trailing space changes the input, not the query) so it actually re-runs.
    const warm = await search(page, { ...q, text: `${q?.text ?? ''} ` });
    queries[name] = { total: warm.total, ms: warm.ms };
    return warm;
  };
  expect((await run('all synthetic', { mode: 'Archives', synthetic: true })).total).toBe(10_000);
  expect((await run('fts "heron"', { mode: 'Archives', synthetic: true, text: 'heron' })).total).toBeGreaterThan(0);
  expect((await run('fts prefix "summar"', { mode: 'Archives', synthetic: true, text: 'summar' })).total).toBeGreaterThan(0);
  const both = await run('capabilities summarization ∩ translation', { mode: 'Archives', synthetic: true, capabilities: ['summarization', 'translation'] });
  expect(both.total).toBeGreaterThan(0);
  expect(both.total).toBeLessThan(10_000);
  expect((await run('fts + capability', { mode: 'Archives', synthetic: true, text: 'otter', capabilities: ['text-generation'] })).total).toBeGreaterThan(0);
  await context.setOffline(false);

  const worst = Math.max(...Object.values(queries).map((q) => q.ms));
  evidence('A08', {
    records: 10_000,
    import_total_ms: importMs,
    verify_ms: verifyMs,
    commit_ms: commitMs,
    db_size: stats.dbBytes,
    warm_queries_ms: queries,
    worst_warm_query_ms: worst,
    under_500ms_target: worst < 500,
    user_agent: await page.evaluate(() => navigator.userAgent),
    hardware_concurrency: await page.evaluate(() => navigator.hardwareConcurrency),
  });
  // Target on the reference laptop is <500 ms; this guard only catches regressions.
  expect(worst).toBeLessThan(2000);
});

test('A14: offline reload, local search and a cached real model run with no network calls', async () => {
  const { page, context } = app;
  await gotoPage(page, 'sources');
  await page.getByTestId('network-toggle').check();
  // Live discovery fills in the fixtures; then cache one real model.
  await expect.poll(async () => (await search(page, { mode: 'Live', text: 'Bedtime story' })).total, { timeout: 30_000 }).toBeGreaterThan(0);
  const story = demoState().releases['story-base']!;
  await downloadRelease(page, story.event_id);
  // The service worker must control the page so the shell and runtime reload offline.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 60_000 });
  await gotoPage(page, 'sources');
  await page.getByTestId('network-toggle').uncheck();

  await context.setOffline(true);
  const offline: string[] = [];
  const failed: string[] = [];
  page.on('request', (r) => offline.push(r.url()));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  await page.reload();
  await expect(page.getByText('catalog: OPFS')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('network sync OFF')).toBeVisible();

  const found = await search(page, { mode: 'Archives', synthetic: true, text: 'heron' });
  expect(found.total).toBeGreaterThan(0);
  const live = await search(page, { mode: 'Combined', text: 'Bedtime story' });
  expect(live.ids).toContain(story.event_id);

  await gotoPage(page, 'playground');
  await page.getByTestId('single-release').selectOption(story.event_id);
  await page.getByTestId('single-input').fill('Once upon a time');
  await page.getByTestId('single-run').click();
  const out = page.getByTestId('single-output');
  await expect(out).toHaveAttribute('data-state', 'completed', { timeout: 180_000 });
  const text = (await page.getByTestId('single-text').textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);
  await context.setOffline(false);

  const external = offline.filter((u) => !u.startsWith(WEB) && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  expect(failed).toEqual([]);
  evidence('A14', {
    variant: 'e2e (one cached real model; the two-stage run is in tests/models)',
    release: story.event_id,
    offline_requests: offline.length,
    external_requests: external,
    failed_requests: failed,
    output_chars: text.length,
  });
});
