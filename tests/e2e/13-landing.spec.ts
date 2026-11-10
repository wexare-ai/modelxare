// modelXare's front page: what it is for, told with a scroll-played before and
// after, with the working app one click away (#/try). Without motion, the
// before and after show side by side and nothing waits for an animation.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { SIMPLE, runDir } from '../support/env.ts';

test('the front page tells the story by scrolling and leads to the app', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-landing-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 800 } });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${SIMPLE}/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI, back in your hands.');
    // The front page doesn't show the app's connection state; it offers to try it.
    await expect(page.locator('.connection')).toHaveCount(0);

    // Scrolling through the story moves it from today to the alternative.
    const story = page.locator('.l-story');
    const box = await story.evaluate((el) => ({ top: el.getBoundingClientRect().top + scrollY, height: el.getBoundingClientRect().height }));
    const at = async (p: number) => {
      await page.evaluate((y) => scrollTo(0, y), box.top + p * (box.height - 800));
      return page.locator('.l-cap[aria-current="step"] .l-cap-text');
    };
    await expect(await at(0.02)).toHaveText('A few labs run the world’s AI.');
    await expect(await at(0.47)).toHaveText('AI didn’t need them?');
    await expect(await at(0.95)).toHaveText('People share models, never their data.');
    await expect(page.locator('.l-middle')).toHaveText('nobody in the middle');

    // System 1 + System 2: the router's real verdicts, then two catalog models answer.
    await page.locator('.l-browser').scrollIntoViewIfNeeded();
    await expect(page.locator('.l-model.done')).toHaveCount(2);
    await expect(page.locator('.l-verdict-out').first()).toHaveText('Sort 0.99');
    await expect(page.locator('.l-model.idle .l-model-head strong')).toHaveText('Write');

    // The sections below land as they come into view.
    await page.locator('.l-final').scrollIntoViewIfNeeded();
    await expect(page.locator('.l-final .l-h2')).toHaveClass(/\bin\b/);

    // Who backs weXare, at the foot of the page, each logo loaded and linked.
    const backers = page.getByRole('region', { name: 'Backed by' });
    await backers.scrollIntoViewIfNeeded();
    await expect(backers.getByRole('link', { name: 'Mozilla Ventures' })).toHaveAttribute('href', 'https://mozilla.vc/');
    const logos = backers.getByRole('img');
    expect(await logos.evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => i.alt))).toEqual(['Mozilla Ventures', 'Betaworks', 'White Star Capital', 'Offline Ventures']);
    for (const logo of await logos.all()) {
      await expect(logo).toBeVisible();
      expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), (await logo.getAttribute('alt')) ?? 'logo').toBe(true);
    }

    // Try it: the working app, then back to the front page from the logo.
    await page.getByRole('link', { name: 'Try modelXare' }).last().click();
    await expect(page).toHaveURL(/#\/try$/);
    await expect(page.getByTestId('ask-input')).toBeVisible();
    await page.locator('a.brand').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI, back in your hands.');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('without motion, the front page shows the before and after side by side', async () => {
  const profile = mkdtempSync(join(runDir(), 'profile-landing-still-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, reducedMotion: 'reduce' });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${SIMPLE}/`);
    const still = page.locator('.l-story-still figure');
    await expect(still).toHaveCount(2);
    await expect(still.nth(0)).toContainText('Your questions and your data all flow into their data centers.');
    await expect(still.nth(1)).toContainText('Small models run on your own laptop. Your data stays with you.');
    await expect(page.locator('.l-story')).toHaveCount(0);
    // System 1 + System 2 shows its end state: the whole request and both answers.
    await expect(page.locator('.l-model.done')).toHaveCount(2);
    await expect(page.locator('.l-typed')).toContainText('Your seat and bags stay the same.');
    // Nothing is left hidden waiting for an animation.
    await page.locator('.l-final').scrollIntoViewIfNeeded();
    await expect(page.locator('.l-final .l-h2')).toHaveCSS('opacity', '1');
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
