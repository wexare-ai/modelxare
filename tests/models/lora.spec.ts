// A18 runtime LoRA: an unmerged base plus a separate adapter, both hashes
// re-verified before loading, executed with and without the adapter, and the
// runtime's own (native llama.cpp) log as evidence of the active adapter.
import { expect, test } from '@playwright/test';
import { demoState, evidence } from '../support/env.ts';
import { gotoPage, openApp, search } from '../support/app.ts';

test('A18: the Shakespeare adapter changes generation over the exact stories15M base', async () => {
  const ids = demoState().releases;
  const lora = ids['shakespeare-lora']!;
  const base = ids['story-base']!;
  const app = await openApp({ path: 'discover' });
  const { page } = app;
  await expect.poll(async () => (await search(page, { mode: 'Live', text: 'Shakespeare' })).total, { timeout: 30_000 }).toBeGreaterThan(0);

  await gotoPage(page, 'playground');
  await page.getByTestId('single-release').selectOption(lora.event_id);
  const dl = page.getByRole('button', { name: 'Download', exact: true });
  if (await dl.count()) {
    await dl.click();
    await expect(page.getByTestId('single-run')).toBeEnabled({ timeout: 600_000 });
  }
  await page.getByTestId('single-input').fill('Look in thy glass');
  const outputs: Record<string, { state: string | null; text: string; meta: string }> = {};
  for (const scale of ['1', '0']) {
    await page.getByTestId('adapter-scale').selectOption(scale);
    await page.getByTestId('single-run').click();
    const out = page.getByTestId('single-output');
    await expect(out).toHaveAttribute('data-state', /completed|failed/, { timeout: 300_000 });
    outputs[scale] = { state: await out.getAttribute('data-state'), text: (await page.getByTestId('single-text').textContent()) ?? '', meta: await out.locator('.small').first().innerText() };
    expect(outputs[scale]!.state).toBe('completed');
  }
  expect(outputs['1']!.text.trim().length).toBeGreaterThan(0);
  expect(outputs['1']!.text).not.toBe(outputs['0']!.text);
  const adapterSha = lora.files![0]!.sha256;
  expect(outputs['1']!.meta).toContain(`active adapter ${adapterSha.slice(0, 12)}`);
  await page.getByTestId('single-output').locator('details summary').click();
  const native = (await page.getByTestId('adapter-evidence').textContent()) ?? '';
  expect(native).toMatch(/lora/i);
  evidence('A18', {
    adapter: { release: lora.event_id, sha256: adapterSha },
    base: { release: base.event_id, sha256: base.files![0]!.sha256 },
    input: 'Look in thy glass',
    with_adapter: outputs['1'],
    without_adapter: outputs['0'],
    native_adapter_log: native.split('\n').slice(0, 20),
  });
  await app?.close();
});
