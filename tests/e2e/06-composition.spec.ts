// A12 dynamic composition, plan level: release choice is data, not code, and a
// missing stage is visible. Execution with real models is in tests/models.
import { expect, test } from '@playwright/test';
import { demoState, evidence } from '../support/env.ts';
import { gotoPage, openApp, search } from '../support/app.ts';

test('A12: changing the chosen compatible release changes the plan; incompatible releases are shown disabled', async () => {
  const s = demoState();
  const id = (n: string) => s.releases[n]!.event_id;
  const app = await openApp({ path: 'discover' });
  const { page } = app;
  await expect.poll(async () => (await search(page, { mode: 'Live', capabilities: ['summarization'] })).total, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await gotoPage(page, 'playground');
  const cls = page.getByTestId('plan-text-classification');
  const sum = page.getByTestId('plan-summarization');
  await expect(cls).toHaveAttribute('data-release', id('community-assistant'));
  const auto = await sum.getAttribute('data-release');
  expect(auto).toBeTruthy();

  const alternative = auto === id('community-assistant') ? id('tiny-summarizer') : id('community-assistant');
  await page.getByTestId('choose-summarization').selectOption(alternative);
  await expect(sum).toHaveAttribute('data-release', alternative);

  // A release for an unbundled runtime is listed, with the reason, but cannot be chosen.
  const future = page.getByTestId('choose-summarization').locator(`option[value="${id('future-runtime-model')}"]`);
  await expect(future).toHaveAttribute('disabled', '');
  const reason = await future.textContent();
  evidence('A12', { plan_auto: { classification: id('community-assistant'), summarization: auto }, plan_after_choice: { summarization: alternative }, disabled_option: reason });
  await app?.close();
});

test('A12: a missing stage fails visibly instead of running', async () => {
  // Clean browser with network sync off: no releases at all.
  const app = await openApp({ path: 'playground', settings: { networkSync: false } });
  const { page } = app;
  await expect(page.getByTestId('plan-text-classification')).toContainText('missing');
  await expect(page.getByTestId('plan-summarization')).toContainText('missing');
  await expect(page.getByTestId('plan-problems')).toBeVisible();
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  evidence('A12', { missing_stage_problems: await page.getByTestId('plan-problems').innerText() });
  await app?.close();
});
