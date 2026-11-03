// modelXare's "Xare your model" page: reached from the catalog, it shows the
// steps from training to publishing (with the relays the app listens to),
// hands out the starter file (apps/cli/test checks the CLI accepts it), and
// links to the nine-stage training guide.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { SIMPLE, endpoints, runDir } from '../support/env.ts';

test('Xare your model: from the catalog to the training guide, the publishing steps and the starter file', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-xare-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, acceptDownloads: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${SIMPLE}/`);
    await page.getByRole('link', { name: /Xare your model/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Xare your model');
    const steps = page.locator('.xare-step');
    await expect(steps).toHaveCount(5);
    for (const relay of endpoints.relays) await expect(steps.nth(4)).toContainText(`--relay ${relay}`);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('starter').click()]);
    expect(download.suggestedFilename()).toBe('model.json');
    const def = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(def.manifest.capabilities).toEqual(['summarization']);

    // Step 1 opens the training guide: nine stages, then back to publishing.
    await page.getByRole('link', { name: /Open the training guide/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Train your own model');
    await expect(page.getByTestId('stage')).toHaveCount(9);
    await expect(page.getByTestId('stage').nth(5)).toContainText('convert_hf_to_gguf.py');
    await page.getByRole('link', { name: /Xare it/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Xare your model');

    await page.getByRole('button', { name: 'All models' }).click();
    await expect(page.getByRole('link', { name: /Xare your model/ })).toBeVisible();
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
