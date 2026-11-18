// modelXare's "Xare your model" page: reached from the catalog, it shows the
// steps from training to publishing (where to get the code, the relays the app listens to),
// hands out the starter file (apps/cli/test checks the CLI accepts it), and
// links to the nine-stage training guide.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { SIMPLE, SOURCE_CODE, endpoints, runDir } from '../support/env.ts';

test('Xare your model: from the catalog to the training guide, the publishing steps and the starter file', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-xare-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, acceptDownloads: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${SIMPLE}/#/try`);
    await page.getByRole('link', { name: /Xare your model/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Xare your model');
    const steps = page.locator('.xare-step');
    await expect(steps).toHaveCount(6);
    // Step 2: modelXare is open source, and its command line tool comes from the repository.
    await expect(steps.nth(1).locator('h2')).toHaveText('2 Get the code');
    await expect(steps.nth(1)).toContainText(`git clone ${SOURCE_CODE}.git`);
    await expect(steps.nth(1).getByRole('link', { name: /modelXare on GitHub/ })).toHaveAttribute('href', SOURCE_CODE);
    for (const relay of endpoints.relays) await expect(steps.nth(5)).toContainText(`--relay ${relay}`);
    await expect(page.getByRole('link', { name: /Every field and option/ })).toHaveAttribute('href', `${SOURCE_CODE}/blob/main/docs/protocol.md#publisher-definition-cli-input`);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('starter').click()]);
    expect(download.suggestedFilename()).toBe('model.json');
    const def = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(def.manifest.capabilities).toEqual(['summarization']);

    // Step 1 opens the training guide: nine stages, then back to publishing.
    await page.getByRole('link', { name: /Open the training guide/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Train your own model');
    await expect(page.getByTestId('stage')).toHaveCount(9);
    await expect(page.getByTestId('stage').nth(1).getByTestId('distill')).toContainText('Generate them');
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
