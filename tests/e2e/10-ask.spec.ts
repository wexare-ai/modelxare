// The Ask box and online-help settings in the plain-language app, without
// loading the router: it needs ~3 GB of memory, so the routed run itself is in
// tests/models/router.spec.ts (opt-in, WEXARE_TEST_LAYA=1).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { DATA, SIMPLE, runDir } from '../support/env.ts';

const routerFiles = () => {
  const ev = JSON.parse(readFileSync(join(DATA, 'releases/laya-router/event.json'), 'utf8')) as { tags: string[][] };
  const manifest = JSON.parse(ev.tags.find((t) => t[0] === 'wexare-manifest')![1]!) as { files: { sha256: string }[] };
  return manifest.files.map((f) => f.sha256);
};

async function simpleApp() {
  const profile = mkdtempSync(join(runDir(), 'profile-ask-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  const urls: string[] = [];
  context.on('request', (r) => urls.push(r.url()));
  await page.goto(`${SIMPLE}/`);
  return { page, urls, close: async () => (await context.close(), rmSync(profile, { recursive: true, force: true })) };
}

test('Ask: the router download is asked for first, and nothing downloads when the person cancels', async () => {
  const app = await simpleApp();
  const { page } = app;
  await expect(page.locator('.ask-box .hint')).toContainText('downloads a 904 MB router', { timeout: 30_000 });
  await page.getByTestId('ask-input').fill('Sort this message and summarize it: there is a water leak near the entrance.');
  await page.getByTestId('ask-go').click();
  const consent = page.getByTestId('router-consent');
  await expect(consent).toContainText('one-time 904 MB download');
  await consent.getByRole('button', { name: 'Cancel' }).click();
  await expect(consent).toHaveCount(0);
  await expect(page.getByTestId('ask-go')).toBeEnabled();
  const hashes = routerFiles();
  expect(app.urls.filter((u) => hashes.some((h) => u.includes(h)))).toEqual([]);
  await app.close();
});

test('Settings: online help is off by default, stays in this browser, and the app says when it is on', async () => {
  const app = await simpleApp();
  const { page } = app;
  await expect(page.locator('footer')).toHaveText('Models run in this browser. What you type is never sent anywhere.');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('router-status')).toContainText('Not downloaded (904 MB)');

  await page.getByTestId('help-enabled').check();
  await page.getByTestId('help-save').click();
  await expect(page.getByRole('status').filter({ hasText: 'API key' })).toHaveText('Add your API key to turn online help on.');

  const key = 'sk-or-test-not-a-real-key';
  await page.getByTestId('help-key').fill(key);
  await page.getByTestId('help-save').click();
  await expect(page.getByText('Saved. Online help is on.')).toBeVisible();
  await expect(page.locator('footer')).toContainText('only steps no model here can do are sent to OpenRouter');
  expect(await page.locator('body').innerText()).not.toContain(key);

  await page.reload();
  await expect(page.getByTestId('help-key')).toHaveValue(key); // kept in this browser
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.lede')).toHaveText('Small AI models that run on this device, with online help when they can’t.');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByTestId('help-enabled').uncheck();
  await page.getByTestId('help-save').click();
  await expect(page.locator('footer')).toHaveText('Models run in this browser. What you type is never sent anywhere.');
  // Saving settings contacts no online service.
  expect(app.urls.filter((u) => /openrouter|openai/.test(u))).toEqual([]);
  await app.close();
});
