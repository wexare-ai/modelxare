// The plain-language app (apps/simple) on the same real services: discover
// models by task, then one button downloads, verifies and runs a real model.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { SIMPLE, evidence, runDir } from '../support/env.ts';

const TECHNICAL = /sha-?256|relay|ipfs|torrent|magnet|opfs|nostr|manifest|gguf|wasm|npub|hash|catalog/i;

test('simple app: find a model by task, then one button downloads, checks and runs it', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-simple-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const hosts = new Set<string>();
  context.on('request', (r) => /^https?:/.test(r.url()) && hosts.add(new URL(r.url()).host));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${SIMPLE}/#/try`);

  const names = page.locator('.model-name');
  await expect(names.filter({ hasText: 'Message assistant' })).toBeVisible({ timeout: 30_000 });
  await expect(names.filter({ hasText: 'Bedtime story base' })).toHaveCount(1); // re-published copies are merged
  expect(await page.locator('main').innerText()).not.toMatch(TECHNICAL);

  // The task words filter the list.
  await page.getByRole('button', { name: /^Continue the text/ }).click();
  await expect(names.filter({ hasText: 'Tiny summarizer' })).toHaveCount(0);
  await page.locator('.model', { hasText: 'Bedtime story base' }).click();

  await expect(page.locator('.hint')).toContainText('downloads 73 MB');
  await page.getByRole('button', { name: 'Try an example' }).click();
  const prompt = await page.getByTestId('input').inputValue();
  const t0 = Date.now();
  await page.getByTestId('run').click();
  const answer = page.getByTestId('answer');
  await expect(answer).toBeVisible({ timeout: 300_000 });
  const text = await answer.locator('p').innerText();
  expect(text.startsWith(prompt)).toBe(true);
  expect(text.length).toBeGreaterThan(prompt.length + 10);
  expect(await page.locator('main').innerText()).not.toMatch(TECHNICAL);

  await page.getByRole('button', { name: 'All models' }).click();
  await expect(page.locator('.model', { hasText: 'Bedtime story base' }).locator('.model-status')).toHaveText('Ready');

  const httpHosts = [...hosts].sort();
  evidence('SIMPLE', { prompt, answer: text, ms: Date.now() - t0, http_hosts: httpHosts });
  for (const h of httpHosts) expect(h).toMatch(/^(localhost|127\.0\.0\.1):\d+$/);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});
