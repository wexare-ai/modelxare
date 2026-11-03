// modelXare's "Xare your model" page offers apps/simple/public/starter-model.json
// as the file to fill in. It must stay a definition the CLI turns into a valid
// release manifest.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ArtifactRoot } from '@wexare/storage/node';
import { prepareRelease, type ReleaseDefinition } from '../src/release.ts';

const STARTER = new URL('../../simple/public/starter-model.json', import.meta.url);

it("the simple app's starter file makes a valid release manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wexare-starter-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    // Stand-in bytes: this checks the definition's shape, not a model.
    await writeFile(join(dir, 'model.gguf'), 'stand-in bytes, not a model');
    const def = JSON.parse(await readFile(STARTER, 'utf8')) as ReleaseDefinition;
    expect(def.files.map((f) => f.source)).toEqual(['./model.gguf']);
    def.files = def.files.map((f) => ({ ...f, source: join(dir, f.source) }));
    // IPFS and torrents need running services; the mirror alone exercises the same manifest.
    def.locations = ['mirror'];
    const p = await prepareRelease(def, { mirror: { root: new ArtifactRoot(join(dir, 'mirror')), name: 'main', baseUrl: 'http://127.0.0.1:8790' } });
    expect(p.manifest.capabilities).toEqual(['summarization']);
    expect(p.manifest.operations.map((o) => o.id)).toEqual(['summarization']);
    expect(p.manifest.files).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
