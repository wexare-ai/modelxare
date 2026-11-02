// One browser, several tabs. Only one context can hold the catalog's OPFS files:
// the newest tab takes the catalog over, a holder that never answers or storage
// that stalls ends in a visible in-memory fallback, and "Reset local data"
// recovers without touching browser settings.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { WEB, runDir } from '../support/env.ts';
import { openApp } from '../support/app.ts';

const catalogBadge = (page: Page) => page.getByText(/^catalog: /);

test('a new tab takes the catalog over, and "Use here" takes it back', async () => {
  const app = await openApp({ path: 'discover' });
  const first = app.page;
  const second = await app.context.newPage();
  await second.goto(`${WEB}/#/discover`);
  await expect(catalogBadge(second)).toHaveText('catalog: OPFS', { timeout: 15_000 });
  await expect(first.getByTestId('stepped-aside')).toBeVisible();

  await first.getByRole('button', { name: 'Use here' }).click();
  await expect(catalogBadge(first)).toHaveText('catalog: OPFS', { timeout: 15_000 });
  await expect(second.getByTestId('stepped-aside')).toBeVisible();
  await app.close();
});

test('a holder that never lets go ends in an explained in-memory catalog', async () => {
  const app = await openApp({ path: 'discover' });
  const holder = app.page;
  // A same-origin page that holds the catalog lock and ignores takeover requests.
  await holder.goto(`${WEB}/favicon.svg`);
  await holder.evaluate(() => new Promise<void>((held) => void navigator.locks.request('wexare-catalog', () => (held(), new Promise(() => {})))));
  const page = await app.context.newPage();
  await page.goto(`${WEB}/#/discover`);
  await expect(catalogBadge(page)).toHaveText('catalog: memory only', { timeout: 15_000 });
  await expect(page.getByTestId('memory-only')).toContainText('did not release it');
  await app.close();
});

test('storage that stalls falls back to memory after the time limit instead of "opening…" forever', async () => {
  // A browser without service workers: a cached copy would bypass the stalled download.
  const profile = mkdtempSync(join(runDir(), 'profile-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block' });
  // Never answer the first catalog worker's SQLite download: its open stalls.
  let stalled = false;
  await context.route(/sqlite3[^/]*\.wasm/, (route) => (stalled ? route.continue() : void (stalled = true)));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${WEB}/#/discover`);
  await expect(catalogBadge(page)).toHaveText('catalog: opening…');
  await expect(catalogBadge(page)).toHaveText('catalog: memory only', { timeout: 40_000 });
  await expect(page.getByTestId('memory-only')).toContainText('did not respond within 20 s');
  expect(stalled).toBe(true);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

test('Reset local data deletes the catalog and model cache, keeps settings, and reopens persistently', async () => {
  const app = await openApp({ path: 'sources', settings: { networkSync: false } });
  const { page } = app;
  const opfs = () =>
    page.evaluate(async () => {
      const names: string[] = [];
      const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
      for await (const n of root.keys()) names.push(n);
      return names.sort();
    });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const w = await (await root.getFileHandle('left-over.bin', { create: true })).createWritable();
    await w.write('stale');
    await w.close();
  });
  expect(await opfs()).toContain('left-over.bin');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('reset-local-data').click();
  await page.waitForEvent('load');
  await expect(catalogBadge(page)).toHaveText('catalog: OPFS', { timeout: 15_000 });
  expect(await opfs()).not.toContain('left-over.bin');
  await expect(page.getByText('network sync OFF')).toBeVisible(); // settings survived
  await app.close();
});
