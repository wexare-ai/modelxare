// modelXare's "Xare your model" page offers apps/simple/public/starter-model.json
// as the file to fill in. It must stay a definition the CLI turns into a valid
// release manifest.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { validateManifestSchema } from '@wexare/protocol';
import { prepareRelease, type ReleaseDefinition } from '../src/release.ts';

const STARTER = new URL('../../simple/public/starter-model.json', import.meta.url);

it("the simple app's starter file makes a valid release manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wexare-starter-'));
  // Stand-in bytes: this checks the definition's shape, not a model.
  const bytes = 'stand-in bytes, not a model';
  // Plays the publisher's file host (Hugging Face in the starter file).
  const server = createServer((_req, res) => res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end(bytes));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await writeFile(join(dir, 'model.gguf'), bytes);
    const def = JSON.parse(await readFile(STARTER, 'utf8')) as ReleaseDefinition;
    expect(def.files.map((f) => f.source)).toEqual(['./model.gguf']);
    expect(def.files[0]!.urls?.[0]).toMatch(/^https:\/\/huggingface\.co\/.*\/resolve\/.*\/model\.gguf$/);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`;
    def.files = def.files.map((f) => ({ ...f, source: join(dir, f.source), urls: [url] }));
    const p = await prepareRelease(def, {});
    expect(p.manifest.capabilities).toEqual(['summarization']);
    expect(p.manifest.operations.map((o) => [o.id, o.category, o.output.type])).toEqual([['summarization', 'messages', 'text']]);
    expect(validateManifestSchema(p.manifest)).toEqual([]);
    expect(p.manifest.files.map((f) => f.locations)).toEqual([[{ transport: 'http', uri: url }]]);
    expect(p.manifestLocations).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
