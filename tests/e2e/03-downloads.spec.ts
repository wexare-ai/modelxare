// A07 IPFS retrieval, A10 file fallback and pre-load re-verification, A13 LoRA
// dependency handling. Real gateways, real mirror, real verification in the browser.
import { expect, test, type Page } from '@playwright/test';
import { demoState, endpoints, evidence } from '../support/env.ts';
import { downloadRelease, fileAttempts, gotoPage, openApp, search, type AppHandle } from '../support/app.ts';

test.describe.configure({ mode: 'serial' });

let app: AppHandle;
const rel = (n: string) => demoState().releases[n]!;

test.beforeAll(async () => {
  app = await openApp({ path: 'discover' });
  // Live discovery fills the local catalog from both relays.
  await expect.poll(async () => (await search(app.page, { mode: 'Live', text: '' })).total, { timeout: 30_000 }).toBeGreaterThanOrEqual(7);
});
test.afterAll(async () => app?.close());

test('A07: a fixture model is fetched through the IPFS gateway and verified against the manifest', async () => {
  const { page, context } = app;
  const story = rel('story-base');
  const sha = story.files![0]!.sha256;
  // Make the HTTP mirrors unreachable for this download so the IPFS location is used.
  await context.route(/127\.0\.0\.1:8790\/[a-z0-9-]+\/sha256\//, (r) => r.abort('connectionrefused'));
  try {
    await downloadRelease(page, story.event_id);
  } finally {
    await context.unroute(/127\.0\.0\.1:8790\/[a-z0-9-]+\/sha256\//);
  }
  const attempts = await fileAttempts(page, sha);
  const ok = attempts.find((a) => a.startsWith('✓'))!;
  expect(ok).toMatch(/^✓ ipfs/);
  const gateways = [endpoints.kubo.a.gateway, endpoints.kubo.b.gateway];
  const ipfsRequests = app.requests.map((r) => r.url()).filter((u) => gateways.some((g) => u.startsWith(g)));
  expect(ipfsRequests.length).toBeGreaterThan(0);
  evidence('A07', { release: story.event_id, sha256: sha, cid: story.files![0]!.cid, attempts, gateway_requests: [...new Set(ipfsRequests)] });
});

test('A10: a one-byte-corrupted primary is rejected and the exact bytes come from the next source', async () => {
  const { page } = app;
  const tiny = rel('tiny-summarizer');
  const sha = tiny.files![0]!.sha256;
  await downloadRelease(page, tiny.event_id, 600_000);
  const attempts = await fileAttempts(page, sha);
  expect(attempts[0]).toMatch(/^✗ .*SHA-256 mismatch/);
  expect(attempts.at(-1)).toMatch(/^✓/);
  await gotoPage(page, 'sources');
  await expect(page.getByTestId('transfer-stats')).toContainText(/[1-9]\d* hash mismatches/);
  evidence('A10', { release: tiny.event_id, sha256: sha, attempts });
});

test('A10: a cached file altered after verification never reaches the inference loader', async () => {
  const { page } = app;
  const story = rel('story-base');
  const sha = story.files![0]!.sha256;
  await flipCachedByte(page, sha, 4096);
  await gotoPage(page, 'playground');
  await page.getByTestId('single-release').selectOption(story.event_id);
  await page.getByTestId('single-run').click();
  const out = page.getByTestId('single-output');
  await expect(out).toHaveAttribute('data-state', 'failed', { timeout: 60_000 });
  await expect(out).toContainText('failed re-verification and was removed');
  const error = (await out.locator('.error').first().textContent()) ?? '';
  await gotoPage(page, 'sources');
  await expect(page.getByTestId('runtime-info')).toContainText(/Resident model\s*none/);
  await gotoPage(page, `model/${story.event_id}`);
  await expect(page.locator(`[data-testid="file-row"][data-sha="${sha}"] [data-testid="file-status"]`)).toContainText('not cached');
  evidence('A10', { altered_cache: { sha256: sha, run_error: error, resident_model: 'none', file_status: 'not cached (evicted)' } });
});

test('A13: the real adapter resolves its exact base and verifies; the wrong-base adapter is blocked', async () => {
  const { page } = app;
  const lora = rel('shakespeare-lora');
  await gotoPage(page, `model/${lora.event_id}`);
  await expect(page.getByTestId('lora-dependency')).toHaveAttribute('data-ok', 'true');
  const files = await downloadRelease(page, lora.event_id);
  expect(files.length).toBe(2); // adapter + exact base weights
  await expect(page.getByTestId('run')).toBeVisible();

  const wrong = rel('shakespeare-lora-wrong-base');
  await gotoPage(page, `model/${wrong.event_id}`);
  const dep = page.getByTestId('lora-dependency');
  await expect(dep).toHaveAttribute('data-ok', 'false');
  await expect(dep).toContainText('Blocked');
  await expect(page.getByTestId('run')).toHaveCount(0);
  const problems = await dep.locator('li').allInnerTexts();

  await gotoPage(page, 'sources');
  const runtime = (await page.getByTestId('runtime-info').innerText()).replace(/\s+/g, ' ');
  evidence('A13', { adapter: lora.event_id, adapter_files: files, wrong_base: wrong.event_id, wrong_base_problems: problems, runtime });
});

/** Flip one byte of a verified file in the browser's OPFS cache (simulates later corruption). */
async function flipCachedByte(page: Page, sha256: string, offset: number): Promise<void> {
  await page.evaluate(
    async ({ sha256, offset }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('wexare-artifacts')).getDirectoryHandle('verified');
      const handle = await dir.getFileHandle(sha256);
      const old = new Uint8Array(await (await handle.getFile()).slice(offset, offset + 1).arrayBuffer());
      const w = await handle.createWritable({ keepExistingData: true });
      await w.write({ type: 'write', position: offset, data: new Uint8Array([old[0]! ^ 0xff]) });
      await w.close();
    },
    { sha256, offset },
  );
}
