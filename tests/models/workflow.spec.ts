// Opt-in real-model acceptance (pnpm test:models): downloads ~0.9 GB of real
// GGUF weights into the browser and runs them locally with wllama.
// A11 real inference, A12 execution trace follows the chosen release, A14 full
// offline two-stage run, and the network capture for prompt/output privacy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ROOT, WEB, demoState, evidence } from '../support/env.ts';
import { gotoPage, openApp, search, type AppHandle } from '../support/app.ts';

test.describe.configure({ mode: 'serial' });

const fixtures = JSON.parse(readFileSync(join(ROOT, 'fixtures/messages.json'), 'utf8')) as { categories: string[]; messages: { id: string; text: string; language: string }[] };
const CATEGORIES = fixtures.categories;
const samples = fixtures.messages;
let app: AppHandle;
const runs: Record<string, unknown>[] = [];

test.beforeAll(async () => {
  app = await openApp({ path: 'discover' });
  await expect.poll(async () => (await search(app.page, { mode: 'Live', capabilities: ['summarization'] })).total, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
});
test.afterAll(async () => {
  evidence('A11', { runs });
  await app?.close();
});

async function runWorkflow(page: Page, label: string) {
  const plan = {
    classification: await page.getByTestId('plan-text-classification').getAttribute('data-release'),
    summarization: await page.getByTestId('plan-summarization').getAttribute('data-release'),
  };
  if (await page.getByTestId('approve-download').count()) {
    await page.getByTestId('approve-download').click();
    await expect(page.getByTestId('download-approval')).toHaveCount(0, { timeout: 1_200_000 });
  }
  const t0 = Date.now();
  await page.getByTestId('run-workflow').click();
  const result = page.getByTestId('result');
  await expect(result).toBeVisible({ timeout: 1_200_000 });
  const status = await result.getAttribute('data-status');
  const category = ((await page.getByTestId('result-category').textContent()) ?? '').trim();
  const summary = ((await page.getByTestId('result-summary').textContent()) ?? '').trim();
  await page.getByTestId('trace').locator('summary').click();
  const trace = {
    classification: (await page.getByTestId('trace-release-text-classification').textContent())?.trim(),
    summarization: (await page.getByTestId('trace-release-summarization').textContent())?.trim(),
    raw: {
      classification: await page.getByTestId('trace-raw-text-classification').allTextContents(),
      summarization: await page.getByTestId('trace-raw-summarization').allTextContents(),
    },
    files: await page.getByTestId('trace-file').allTextContents(),
  };
  const r = { label, status, category, summary, plan, trace, wall_ms: Date.now() - t0 };
  runs.push(r);
  return r;
}

test('A11: two distinct real models classify and summarize a message locally', async () => {
  const { page } = app;
  await gotoPage(page, 'playground');
  await page.getByTestId('sample-en-flight-delay').click();
  const r = await runWorkflow(page, 'en-flight-delay');
  expect(r.status).toBe('completed');
  expect(CATEGORIES).toContain(r.category);
  expect(r.summary.length).toBeGreaterThan(0);
  expect(r.summary.length).toBeLessThanOrEqual(400);
  expect(r.trace.classification).toBe(r.plan.classification);
  expect(r.trace.summarization).toBe(r.plan.summarization);
  expect(r.plan.classification).not.toBe(r.plan.summarization); // two distinct artifacts
  await gotoPage(page, 'sources');
  const runtime = (await page.getByTestId('runtime-info').innerText()).replace(/\s+/g, ' ');
  evidence('A11', { runtime, user_agent: await page.evaluate(() => navigator.userAgent), hardware_concurrency: await page.evaluate(() => navigator.hardwareConcurrency) });
});

test('A11: the Spanish sample runs with releases that declare Spanish', async () => {
  const { page } = app;
  await gotoPage(page, 'playground');
  await page.getByTestId('sample-es-flight-delay').click();
  const r = await runWorkflow(page, 'es-flight-delay');
  expect(r.status).toBe('completed');
  expect(CATEGORIES).toContain(r.category);
  expect(r.summary.length).toBeGreaterThan(0);
});

test('A12: choosing another compatible release changes the execution trace', async () => {
  const { page } = app;
  const ids = demoState().releases;
  await gotoPage(page, 'playground');
  await page.getByTestId('sample-en-flight-delay').click();
  const auto = await page.getByTestId('plan-summarization').getAttribute('data-release');
  const alternative = auto === ids['community-assistant']!.event_id ? ids['tiny-summarizer']!.event_id : ids['community-assistant']!.event_id;
  await page.getByTestId('choose-summarization').selectOption(alternative);
  const r = await runWorkflow(page, 'en-flight-delay, summarization switched');
  expect(r.status).toBe('completed');
  expect(r.trace.summarization).toBe(alternative);
  expect(r.trace.summarization).not.toBe(auto);
  expect(r.category.length).toBeGreaterThan(0);
  expect(r.summary.length).toBeGreaterThan(0);
  evidence('A12', { execution: { auto_summarization: auto, switched_to: alternative, trace: r.trace, category: r.category, summary: r.summary } });
  await page.getByTestId('choose-summarization').selectOption('');
});

test('privacy: prompts and outputs never leave the browser', async () => {
  const outputs = runs.flatMap((r) => [r.summary as string]).filter((s) => s.length > 12);
  const secrets = [...samples.map((s) => s.text), ...outputs];
  const bodies = [
    ...app.requests.map((r) => `${r.url()}\n${r.postData() ?? ''}`),
    ...app.wsSent.map((f) => `${f.url}\n${f.payload}`),
  ];
  const leaks = secrets.filter((s) => bodies.some((b) => b.includes(s) || b.includes(encodeURIComponent(s))));
  // blob:/data: URLs are in-memory and never leave the browser.
  const hosts = [...new Set(app.requests.map((r) => r.url()).filter((u) => /^https?:/.test(u)).map((u) => new URL(u).host))];
  const wsHosts = [...new Set(app.wsSent.map((f) => new URL(f.url).host))];
  evidence('PRIVACY', { checked_strings: secrets.length, requests: app.requests.length, ws_frames_sent: app.wsSent.length, http_hosts: hosts, ws_hosts: wsHosts, leaks });
  expect(leaks).toEqual([]);
  expect(hosts.filter((h) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h))).toEqual([]);
});

test('A14: offline reload, local search and the two-stage workflow with no network', async () => {
  const { page, context } = app;
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 60_000 });
  await gotoPage(page, 'sources');
  await page.getByTestId('network-toggle').uncheck();
  await context.setOffline(true);
  const offline: string[] = [];
  page.on('request', (r) => offline.push(r.url()));
  await page.reload();
  await expect(page.getByText('catalog: OPFS')).toBeVisible({ timeout: 30_000 });
  expect((await search(page, { mode: 'Combined', text: 'Message assistant' })).total).toBeGreaterThan(0);
  await gotoPage(page, 'playground');
  await page.getByTestId('sample-en-package').click();
  const r = await runWorkflow(page, 'en-package, offline');
  expect(r.status).toBe('completed');
  expect(CATEGORIES).toContain(r.category);
  await context.setOffline(false);
  const external = offline.filter((u) => !u.startsWith(WEB) && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  evidence('A14', { variant: 'models (two-stage workflow offline)', offline_requests: offline.length, external_requests: external, result: r });
});
