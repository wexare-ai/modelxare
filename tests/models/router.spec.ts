// The Ask box end to end with real models: the System 1 router release
// (Laya fp16, 904 MB) picks each step, local mini-models do them. Opt-in,
// because the router and a mini-model together need about 5 GB of memory:
//
//   WEXARE_TEST_LAYA=1 pnpm test:models -- models/router.spec.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { SIMPLE, evidence, runDir } from '../support/env.ts';

test.skip(process.env.WEXARE_TEST_LAYA !== '1', 'set WEXARE_TEST_LAYA=1 on a machine with about 5 GB of free memory');

/** Answer each prompt as it comes (downloads: yes; unsure: the first option) until the run ends. */
async function askAndFollow(page: Page, request: string): Promise<void> {
  await page.getByTestId('ask-input').fill(request);
  await page.getByTestId('ask-go').click();
  const decisions = page.getByTestId('decisions');
  await expect(decisions).toHaveCount(0); // the previous run's result clears first
  // Whichever shows up first; the waits that lose the race are ignored.
  const shows = <T extends string>(id: string, value: T) => page.getByTestId(id).waitFor({ timeout: 1_800_000 }).then(() => value, () => 'timeout' as const);
  for (;;) {
    const next = await Promise.race([
      shows('decisions', 'done'),
      shows('router-consent', 'router'),
      shows('model-consent', 'model'),
      shows('clarify', 'clarify'),
      shows('ask-problem', 'problem'),
    ]);
    if (next === 'done') return;
    if (next === 'timeout') throw new Error('the Ask run did not finish in 30 minutes');
    if (next === 'problem') throw new Error(await page.getByTestId('ask-problem').innerText());
    const id = next === 'clarify' ? 'clarify' : next === 'router' ? 'router-consent' : 'model-consent';
    const prompt = page.getByTestId(id);
    await (next === 'clarify' ? prompt.getByRole('button').first() : prompt.getByRole('button', { name: 'Download and continue' })).click();
    await expect(prompt).toHaveCount(0);
  }
}

const steps = (page: Page) =>
  page.getByTestId('step').evaluateAll((els) =>
    els.map((e) => ({ intent: e.getAttribute('data-intent'), route: e.getAttribute('data-route'), status: e.getAttribute('data-status'), text: (e as HTMLElement).innerText })),
  );

test('Ask: System 1 routes a two-part request to models on this device', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-router-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const hosts = new Set<string>();
  context.on('request', (r) => /^https?:/.test(r.url()) && hosts.add(new URL(r.url()).host));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${SIMPLE}/`);
  const t0 = Date.now();

  await askAndFollow(page, 'Sort this message and summarize it: There has been a water leak near the entrance since this morning. Can someone inspect it?');
  const ran = await steps(page);
  const decided = await page.getByTestId('decisions').evaluate((e) => (e as HTMLElement).innerText);
  evidence('ROUTER-BROWSER', { steps: ran, decisions: decided, ms: Date.now() - t0, http_hosts: [...hosts].sort() });

  expect(ran.map((s) => s.intent).sort()).toEqual(['sort', 'summarize']);
  for (const s of ran) expect([s.route, s.status]).toEqual(['local', 'done']);
  for (const h of hosts) expect(h).toMatch(/^(localhost|127\.0\.0\.1):\d+$/);

  // Translation: no local model, online help off, so the step is reported, not attempted.
  await askAndFollow(page, 'Translate into French: the swimming pool is closed today.');
  const translate = (await steps(page)).find((s) => s.intent === 'translate');
  expect(translate).toMatchObject({ route: 'none', status: 'unavailable' });
  expect(translate!.text).toContain('No model on this device can translate yet');
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});
