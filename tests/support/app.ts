// Browser helpers for the real web app. Each fresh context is a clean browser:
// empty OPFS, empty localStorage, no service worker.
import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { WEB } from './env.ts';

export interface AppHandle {
  context: BrowserContext;
  page: Page;
  requests: Request[];
  /** Text of every WebSocket frame the page sent, per socket URL. */
  wsSent: { url: string; payload: string }[];
}

/**
 * Open the app in a clean context. `settings` (public client configuration,
 * the same JSON the Sources page imports/exports) is written to localStorage
 * before the app boots.
 */
export async function openApp(browser: Browser, opts: { settings?: Record<string, unknown>; path?: string } = {}): Promise<AppHandle> {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  if (opts.settings) {
    await context.addInitScript((s) => {
      try {
        if (!localStorage.getItem('wexare.settings.v1')) localStorage.setItem('wexare.settings.v1', s);
      } catch {
        // ignore
      }
    }, JSON.stringify(opts.settings));
  }
  const page = await context.newPage();
  const handle: AppHandle = { context, page, requests: [], wsSent: [] };
  page.on('request', (r) => handle.requests.push(r));
  page.on('websocket', (ws) => ws.on('framesent', (f) => handle.wsSent.push({ url: ws.url(), payload: typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8') })));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${WEB}/#/${opts.path ?? 'sources'}`);
  await expect(page.getByText('catalog: OPFS')).toBeVisible({ timeout: 30_000 });
  return handle;
}

export async function gotoPage(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => (location.hash = `#/${p}`), path);
}

/** Paste a signed announcement, verify it, fetch/verify the ZIP, then commit. */
export async function importArchive(page: Page, announcementJson: string, opts: { zipPath?: string; timeoutMs?: number } = {}) {
  await gotoPage(page, 'sources');
  await page.getByTestId('announcement-json').fill(announcementJson);
  await page.getByTestId('inspect-announcement').click();
  await expect(page.getByTestId('announcement-verified')).toBeVisible();
  if (opts.zipPath) await page.getByTestId('zip-file').setInputFiles(opts.zipPath);
  await page.getByTestId('fetch-archive').click();
  await expect(page.getByTestId('staged')).toBeVisible({ timeout: opts.timeoutMs ?? 180_000 });
  const transfer = page.getByTestId('archive-transfer');
  const t = {
    staged: Number(await page.getByTestId('staged-count').textContent()),
    stagedText: await page.getByTestId('staged').innerText(),
    transport: await transfer.getAttribute('data-transport'),
    peerBytes: Number(await transfer.getAttribute('data-peer-bytes')),
    webSeedBytes: Number(await transfer.getAttribute('data-webseed-bytes')),
  };
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('import-done')).toBeVisible({ timeout: opts.timeoutMs ?? 180_000 });
  return { ...t, done: (await page.getByTestId('import-done').textContent()) ?? '' };
}

/** Inspect an announcement and try to stage a (bad) archive; returns the rejection text. */
export async function stageExpectingRejection(page: Page, announcementJson: string, zipPath: string): Promise<string> {
  await gotoPage(page, 'sources');
  await page.getByTestId('announcement-json').fill(announcementJson);
  await page.getByTestId('inspect-announcement').click();
  await expect(page.getByTestId('announcement-verified')).toBeVisible();
  await page.getByTestId('zip-file').setInputFiles(zipPath);
  await page.getByTestId('fetch-archive').click();
  const err = page.locator('.status .error');
  await expect(err).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('staged')).toHaveCount(0);
  return (await err.textContent()) ?? '';
}

export type Mode = 'Live' | 'Archives' | 'Combined';

/** Run a Discover query and return the total plus the visible event IDs. */
export async function search(page: Page, q: { mode?: Mode; text?: string; synthetic?: boolean; capabilities?: string[] } = {}) {
  await gotoPage(page, 'discover');
  if (q.mode) await page.getByRole('tab', { name: q.mode, exact: true }).click();
  const synth = page.getByTestId('include-synthetic');
  if (q.synthetic !== undefined && (await synth.isChecked()) !== q.synthetic) await synth.setChecked(q.synthetic);
  const filters = page.getByRole('form', { name: 'Search filters' });
  for (const c of ['text-classification', 'summarization', 'text-generation', 'translation', 'sentiment-analysis', 'question-answering']) {
    const box = filters.getByLabel(c, { exact: true });
    const want = q.capabilities?.includes(c) ?? false;
    if ((await box.isChecked()) !== want) await box.setChecked(want);
  }
  await page.getByTestId('search-text').fill(q.text ?? '');
  // Queries are debounced by 120 ms; let the last one land.
  await page.waitForTimeout(400);
  await expect(page.getByTestId('result-total')).toBeVisible();
  const total = Number(await page.getByTestId('result-total').textContent());
  const ms = Number(await page.getByTestId('query-ms').textContent());
  const ids = await page.getByTestId('result-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-event-id')!));
  return { total, ms, ids };
}

export async function catalogStats(page: Page): Promise<{ text: string; dbBytes: string }> {
  await gotoPage(page, 'sources');
  return { text: (await page.getByTestId('stat-releases').textContent()) ?? '', dbBytes: (await page.getByTestId('stat-dbbytes').textContent()) ?? '' };
}

/** Download every missing file from a release detail page and wait for verification. */
export async function downloadRelease(page: Page, eventId: string, timeoutMs = 300_000) {
  await gotoPage(page, `model/${eventId}`);
  await expect(page.getByTestId('model-detail')).toBeVisible();
  const btn = page.getByTestId('download');
  if (await btn.count()) await btn.click();
  const rows = page.getByTestId('file-row');
  await expect(async () => {
    const n = await rows.count();
    const ok = await page.locator('[data-testid="file-status"] .badge.ok').count();
    const failed = await page.locator('[data-testid="file-status"] .badge.bad').count();
    if (failed) throw new Error('download failed');
    expect(ok).toBe(n);
  }).toPass({ timeout: timeoutMs, intervals: [1000] });
  return page.getByTestId('file-status').allInnerTexts();
}

/** Attempts recorded for one file (✓/✗ transport bytes message source). */
export async function fileAttempts(page: Page, sha256: string): Promise<string[]> {
  const row = page.locator(`[data-testid="file-row"][data-sha="${sha256}"]`);
  const details = row.locator('details.attempts');
  if (!(await details.count())) return [];
  await details.locator('summary').click();
  return details.locator('li').allInnerTexts();
}

export const readText = (p: string) => readFileSync(p, 'utf8');

/** Requests that left the browser for a non-app origin (relays use WebSockets, listed separately). */
export function externalRequests(h: AppHandle): string[] {
  return h.requests.map((r) => r.url()).filter((u) => !u.startsWith(WEB) && !u.startsWith('blob:') && !u.startsWith('data:'));
}
