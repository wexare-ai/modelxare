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
