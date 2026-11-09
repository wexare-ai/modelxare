// A15 operator replacement: a second indexer/builder with its own key, data
// directory, port and artifact root. The browser imports its catalog through
// Sources & diagnostics; nothing is registered anywhere and no code changes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { RELAY_A, RELAY_B, endpoints, evidence, runDir } from '../support/env.ts';
import { Indexer, cli, waitSeeding } from '../support/procs.ts';
import { gotoPage, openApp, search } from '../support/app.ts';

test('A15: a second operator exports a catalog the browser imports through settings', async () => {
  const dir = join(runDir(), 'operators/b');
  const key = join(dir, 'builder-b.key.json');
  await cli(['keygen', '--out', key, '--label', 'e2e-builder-b']);
  const builder = JSON.parse(readFileSync(key, 'utf8')).pubkey as string;
  const indexer = await new Indexer('e2e-operator-b', join(dir, 'indexer'), 8794, [RELAY_A, RELAY_B]).start();
  let out: string;
  try {
    await indexer.waitCaughtUp(120_000);
    const mirror = `e2e-b-${(process.env.WEXARE_E2E_RUN ?? 'run').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    out = (await cli(['archive', 'build', '--indexer-db', indexer.db, '--builder-key', key, '--out', join(dir, 'archives'), '--relay', RELAY_A, '--relay', RELAY_B, '--policy', 'e2e.operator-b.all-valid/0.1', '--publish', '--mirror-name', mirror])).out;
  } finally {
    await indexer.stop();
  }
  const announcementId = /announcement ([0-9a-f]{64})/.exec(out)![1]!;
  const announcement = JSON.parse(readFileSync(/saved (\S+\.announcement\.json)/.exec(out)![1]!, 'utf8')) as { tags: string[][] };
  const records = Number(/(\d+) records/.exec(out)![1]);
  const infoHash = /urn:btih:([0-9a-f]{40})/i.exec(announcement.tags.find((t) => t[0] === 'magnet')![1]!)![1]!.toLowerCase();
  await waitSeeding(endpoints.artifacts, infoHash);

  // Clean browser: look the announcement up by event ID on the configured relays.
  const app = await openApp();
  const { page } = app;
  await page.getByTestId('announcement-id').fill(announcementId);
  await page.getByTestId('lookup-announcement').click();
  await expect(page.getByTestId('announcement-verified')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('builder-pubkey')).toHaveText(builder);
  await page.getByTestId('fetch-archive').click();
  await expect(page.getByTestId('staged')).toBeVisible({ timeout: 180_000 });
  expect(Number(await page.getByTestId('staged-count').textContent())).toBe(records);
  await expect(page.getByTestId('staged')).toContainText('e2e.operator-b.all-valid/0.1');
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('import-done')).toBeVisible({ timeout: 120_000 });
  const row = page.locator(`[data-testid="source-row"][data-source="catalog:${builder}"]`);
  await expect(row).toHaveAttribute('data-count', String(records));

  const archived = await search(page, { mode: 'Archives', text: 'Message assistant' });
  expect(archived.total).toBeGreaterThan(0);

  // The exported public configuration names the trusted builder and holds no secrets.
  await gotoPage(page, 'sources');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-config').click()]);
  const exported = readFileSync((await download.path())!, 'utf8');
  const cfg = JSON.parse(exported) as { catalogs: { builderPubkey: string }[] };
  expect(cfg.catalogs.map((c) => c.builderPubkey)).toContain(builder);
  // No key material: no secret-key field and no bech32 private key.
  expect(exported).not.toMatch(/"[^"]*(secret|private)[^"]*"\s*:|nsec1/i);

  // A second clean browser adopts that configuration file as-is.
  const other = await openApp();
  await other.page.getByTestId('import-config').setInputFiles({ name: 'wexare-client-config.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect.poll(() => other.page.evaluate(() => JSON.parse(localStorage.getItem('wexare.settings.v1') ?? '{}').catalogs?.length ?? 0)).toBeGreaterThan(0);
  evidence('A15', { builder_b: builder, announcement_id: announcementId, records, operator_data: dir, status_port: 8794, exported_catalogs: cfg.catalogs.map((c) => c.builderPubkey) });
  await other?.close();
  await app?.close();
});
