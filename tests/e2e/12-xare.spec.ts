// modelXare's "Xare your model" page: reached from the catalog, it shows the
// four publishing steps with the relays the app listens to, and hands out the
// starter file (apps/cli/test checks the CLI accepts it).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { SIMPLE, endpoints, runDir } from '../support/env.ts';

test('Xare your model: from the catalog to the publishing steps and the starter file', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-xare-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, acceptDownloads: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${SIMPLE}/`);
    await page.getByRole('link', { name: /Xare your model/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Xare your model');
    const steps = page.locator('.xare-step');
    await expect(steps).toHaveCount(4);
    for (const relay of endpoints.relays) await expect(steps.nth(3)).toContainText(`--relay ${relay}`);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('starter').click()]);
    expect(download.suggestedFilename()).toBe('model.json');
    const def = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(def.manifest.capabilities).toEqual(['summarization']);

    await page.getByRole('button', { name: 'All models' }).click();
    await expect(page.getByRole('link', { name: /Xare your model/ })).toBeVisible();
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
