// Runs the runtime compatibility spike in headless Chromium and writes the raw
// results to docs/compat/spike-results.json. Usage: pnpm --filter @wexare/tests spike
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const repo = resolve(import.meta.dirname, '../..');
const modelsDir = join(repo, '.data/fixtures/models');
const isolated = process.env.SPIKE_ISOLATED !== '0';

const server = await createServer({
  root: import.meta.dirname,
  logLevel: 'warn',
  server: {
    port: 5199,
    strictPort: true,
    headers: isolated
      ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
      : {},
  },
  plugins: [
    {
      name: 'fixture-models',
      configureServer(s) {
        s.middlewares.use('/fixture-models', (req, res) => {
          const file = join(modelsDir, decodeURIComponent((req.url ?? '/').slice(1)));
          if (!file.startsWith(modelsDir)) return void res.writeHead(400).end();
          const st = statSync(file, { throwIfNoEntry: false });
          if (!st) return void res.writeHead(404).end();
          res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' });
          createReadStream(file).pipe(res);
        });
      },
    },
  ],
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e));
await page.goto('http://localhost:5199/');
await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });

const results: Record<string, unknown> = { date: new Date().toISOString(), isolated };
const step = async (name: string, fn: () => Promise<unknown>) => {
  process.stdout.write(`- ${name} ... `);
  try {
    results[name] = await fn();
    console.log('ok');
    console.log(JSON.stringify(results[name], null, 2).slice(0, 1500));
  } catch (e) {
    results[name] = { error: String(e) };
    console.log('FAILED', String(e).slice(0, 500));
  }
};

const call = (fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => (globalThis as any).spike[fn as string](...(args as unknown[])), [fn, args] as const);

await step('env', () => call('env'));
await step('browserVersion', async () => browser.version());

const only = process.argv[2];
const want = (n: string) => !only || only.split(',').includes(n);

if (want('lora')) {
  const prompt = 'Look in thy glass';
  await step('lora.base', () => call('loraProbe', 'base', prompt));
  await step('lora.loadApplied', () => call('loraProbe', 'load-applied', prompt));
  await step('lora.perRequest', () => call('loraProbe', 'per-request', prompt));
}
if (want('smollm')) {
  await step('smollm.chat', () =>
    call(
      'chat',
      'smollm2-360m-instruct-q8_0.gguf',
      [{ role: 'user', content: 'Summarize in one sentence: There has been a water leak near the entrance since this morning. Can someone inspect it?' }],
      { max_tokens: 48, temperature: 0 },
    ),
  );
}
if (want('qwen')) {
  await step('qwen.classifyJsonSchema', () =>
    call(
      'chat',
      'qwen2.5-0.5b-instruct-q4_k_m.gguf',
      [
        { role: 'system', content: 'Classify the community message. Categories: maintenance, safety, security, noise, cleanliness, other.' },
        { role: 'user', content: 'There has been a water leak near the entrance since this morning. Can someone inspect it?' },
      ],
      {
        max_tokens: 24,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'classification',
            schema: {
              type: 'object',
              properties: { category: { type: 'string', enum: ['maintenance', 'safety', 'security', 'noise', 'cleanliness', 'other'] } },
              required: ['category'],
              additionalProperties: false,
            },
          },
        },
      },
    ),
  );
}

results.logsTail = (await call('logs') as string[]).slice(-60);
await browser.close();
await server.close();

mkdirSync(join(repo, 'docs/compat'), { recursive: true });
const out = join(repo, `docs/compat/spike-results${only ? '-' + only.replace(/,/g, '-') : ''}.json`);
writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
console.log('wrote', out);
