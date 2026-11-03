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

/**
 * The app in a fresh browser. With `holdDownloads`, requests to other hosts
 * (the mirror, IPFS gateways) wait until the test ends, and the router's
 * worker is blocked: the router is never downloaded or started here.
 */
async function simpleApp(opts: { holdDownloads?: boolean } = {}) {
  const profile = mkdtempSync(join(runDir(), 'profile-ask-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, ...(opts.holdDownloads ? { serviceWorkers: 'block' as const } : {}) });
  const held: string[] = [];
  if (opts.holdDownloads) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (/laya\.worker/.test(url)) return route.abort();
      if (url.startsWith(SIMPLE)) return route.continue();
      held.push(url); // never answered
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const urls: string[] = [];
  context.on('request', (r) => urls.push(r.url()));
  await page.goto(`${SIMPLE}/`);
  return { page, urls, held, close: async () => (await context.close(), rmSync(profile, { recursive: true, force: true })) };
}

test('Ask: the router downloads without a question, and Stop cancels it with nothing saved', async () => {
  const app = await simpleApp({ holdDownloads: true });
  const { page } = app;
  await expect(page.locator('.ask-box .hint')).toContainText('downloads a 904 MB router', { timeout: 30_000 });
  // An example fills the box; Go runs it.
  await page.getByTestId('ask-example').first().click();
  await expect(page.getByTestId('ask-input')).toHaveValue(/^Summarize and categorize this message: The garage door/);
  await expect(page.getByTestId('ask-input')).toBeFocused();
  await page.getByTestId('ask-go').click();
  await expect(page.locator('.ask-box .progress')).toContainText('Downloading the router');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const hashes = routerFiles();
  await expect.poll(() => app.held.filter((u) => hashes.some((h) => u.includes(h))).length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('ask-go')).toBeEnabled();
  await expect(page.locator('.ask-box .hint')).toContainText('downloads a 904 MB router');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('router-status')).toContainText('Not downloaded (904 MB)');
  await expect(page.getByTestId('space-status')).toHaveText('No models saved yet.');
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
