// Saved models make room for new ones in the plain-language app: when a new
// model doesn't fit in the space for models, the one used longest ago is
// removed first. Real models, real downloads, real cache.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { SIMPLE, evidence, runDir } from '../support/env.ts';

/** Open a model, run its first example, and come back to the list. */
async function use(page: Page, name: string): Promise<void> {
  await page.locator('.model', { hasText: name }).click();
  await page.getByRole('button', { name: 'Try an example' }).click();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('answer')).toBeVisible({ timeout: 300_000 });
  await page.getByRole('button', { name: 'All models' }).click();
}

test('space: a new model makes room by removing the one used longest ago', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-space-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  // 400 MB for models: the story model (73 MB) and the summarizer (386 MB) don't fit together.
  await context.addInitScript(() => {
    if (!localStorage.getItem('wexare.simple.space.v1')) localStorage.setItem('wexare.simple.space.v1', JSON.stringify({ limit: 400e6 }));
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${SIMPLE}/`);
  const status = (name: string) => page.locator('.model', { hasText: name }).locator('.model-status');
  await expect(page.locator('.model', { hasText: 'Bedtime story base' })).toBeVisible({ timeout: 30_000 });

  await use(page, 'Bedtime story base');
  await expect(status('Bedtime story base')).toHaveText('Ready');

  await use(page, 'Tiny summarizer');
  await expect(status('Tiny summarizer')).toHaveText('Ready');
  await expect(status('Bedtime story base')).toHaveText('73 MB download');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('space-status')).toHaveText('Saved models take 386 MB.');
  await expect(page.getByTestId('space-limit')).toHaveValue('400000000');

  // A new limit is kept in this browser (trimming to a lower one is in the unit tests).
  await page.getByTestId('space-limit').selectOption(String(2e9));
  await page.reload();
  await expect(page.getByTestId('space-limit')).toHaveValue(String(2e9));
  await expect(page.getByTestId('space-status')).toHaveText('Saved models take 386 MB.');

  evidence('SPACE', { limit_bytes: 400e6, kept: 'Tiny summarizer', removed: 'Bedtime story base' });
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

/** A fresh browser where `estimate()` reports `quota` from `fake(realUsage)` instead of the truth. */
async function browser(name: string, fake?: string) {
  const profile = mkdtempSync(join(runDir(), `profile-${name}-`));
  const context = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block' });
  if (fake) {
    await context.addInitScript((body) => {
      const real = navigator.storage.estimate.bind(navigator.storage);
      const quotaFor = new Function('usage', `return ${body}`) as (usage: number) => number;
      navigator.storage.estimate = async () => {
        const e = await real();
        return { ...e, quota: quotaFor(e.usage ?? 0) };
      };
    }, fake);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${SIMPLE}/`);
  await expect(page.locator('.model', { hasText: 'Bedtime story base' })).toBeVisible({ timeout: 30_000 });
  /** Let the browser store only `bytes` more than it holds now (a real limit: writes past it fail). */
  const limitRoom = async (bytes: number) => {
    const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(SIMPLE).origin, quotaSize: usage + bytes });
  };
  const close = async () => (await context.close(), rmSync(profile, { recursive: true, force: true }));
  return { page, limitRoom, close };
}

test('space: when the browser refuses a download for lack of room, the least used model makes way and it retries', async () => {
  // This browser overstates its room, so the app learns of the real limit only from the refused bytes.
  const { page, limitRoom, close } = await browser('refused', '1e12');
  const status = (name: string) => page.locator('.model', { hasText: name }).locator('.model-status');
  await use(page, 'Bedtime story base');
  // The summarizer (386 MB) fits only once the story model (73 MB) is gone.
  await limitRoom(350e6);
  await use(page, 'Tiny summarizer');
  await expect(status('Tiny summarizer')).toHaveText('Ready');
  await expect(status('Bedtime story base')).toHaveText('73 MB download');
  evidence('SPACE-REFUSED', { room_bytes: 350e6, kept: 'Tiny summarizer', removed: 'Bedtime story base' });
  await close();
});

test('space: a browser that understates its room still gets the download', async () => {
  const { page, close } = await browser('understated', 'usage + 10e6');
  await use(page, 'Bedtime story base'); // 73 MB, with 10 MB reported free
  await expect(page.locator('.model', { hasText: 'Bedtime story base' }).locator('.model-status')).toHaveText('Ready');
  await close();
});

test('space: when nothing can make room, it says how much the browser allows', async () => {
  const { page, limitRoom, close } = await browser('full');
  await limitRoom(20e6);
  await page.locator('.model', { hasText: 'Bedtime story base' }).click();
  await page.getByRole('button', { name: 'Try an example' }).click();
  await page.getByTestId('run').click();
  // The room it reports is what the browser really took before refusing, about 20 MB.
  await expect(page.getByRole('alert')).toContainText(/There isn’t enough free space on this device for this model \(73 MB\): this browser lets weXare use only \d{1,2} MB more\./, {
    timeout: 120_000,
  });
  await close();
});
