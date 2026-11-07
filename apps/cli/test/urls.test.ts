// A release can point at files someone already serves over HTTPS (e.g. Hugging
// Face). The CLI downloads each one before signing: same bytes, readable by browsers.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publishDefaults } from '../src/paths.ts';
import { prepareRelease, type ReleaseDefinition } from '../src/release.ts';

const BYTES = 'the exact bytes of a small model';
let server: Server;
let base: string;
let dir: string;
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/model.gguf') return void res.writeHead(200, cors).end(BYTES);
    // Hugging Face answers resolve/ links with a redirect to its CDN.
    if (req.url === '/resolve/model.gguf') return void res.writeHead(302, { ...cors, Location: '/model.gguf' }).end();
    if (req.url === '/other.gguf') return void res.writeHead(200, cors).end(`${BYTES}, changed`);
    if (req.url === '/no-cors.gguf') return void res.writeHead(200).end(BYTES);
    res.writeHead(404, cors).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), 'wexare-urls-'));
  await writeFile(join(dir, 'model.gguf'), BYTES);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const definition = (urls: string[]): ReleaseDefinition => ({
  manifest: {
    model_id: 'tiny',
    name: 'Tiny',
    description: 'A test model.',
    version: '1.0.0',
    kind: 'model',
    capabilities: ['text-generation'],
    languages: ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: 'wllama', requirement: '>=3.8.1 <3.9.0', browser_features: [], chat_template: { source: 'none' } },
    operations: [{ id: 'text-generation', prompt: { mode: 'completion', template: '{{input}}' } }],
    requirements: { context_length: 256 },
  },
  files: [{ role: 'weights', path: 'model.gguf', source: join(dir, 'model.gguf'), urls }],
});

describe('file addresses in a release', () => {
  it('records an address that serves the same bytes, following redirects', async () => {
    const p = await prepareRelease(definition([`${base}/resolve/model.gguf`]), {});
    expect(p.manifest.files[0]!.locations).toEqual([{ transport: 'http', uri: `${base}/resolve/model.gguf` }]);
  });

  it('refuses an address that serves other bytes', async () => {
    await expect(prepareRelease(definition([`${base}/other.gguf`]), {})).rejects.toThrow(/serves different bytes/);
  });

  it('refuses an address browsers on another site cannot read', async () => {
    await expect(prepareRelease(definition([`${base}/no-cors.gguf`]), {})).rejects.toThrow(/Access-Control-Allow-Origin/);
  });

  it('refuses a missing file, and plain http beyond this machine', async () => {
    await expect(prepareRelease(definition([`${base}/missing.gguf`]), {})).rejects.toThrow(/answered 404/);
    await expect(prepareRelease(definition(['http://models.example.org/model.gguf']), {})).rejects.toThrow(/must be an https:\/\/ address/);
  });

  it('needs somewhere to download each file from', async () => {
    await expect(prepareRelease(definition([]), {})).rejects.toThrow(/nowhere to download it from/);
  });

  it('can skip the download check when asked', async () => {
    const before = requests;
    const p = await prepareRelease(definition(['https://models.example.org/model.gguf']), {}, { checkUrls: false });
    expect(requests).toBe(before);
    expect(p.manifest.files[0]!.locations).toEqual([{ transport: 'https', uri: 'https://models.example.org/model.gguf' }]);
  });
});

it('describes a public mirror as https', async () => {
  const { ArtifactRoot } = await import('@wexare/storage/node');
  const def = { ...definition([]), locations: ['mirror' as const] };
  const p = await prepareRelease(def, { mirror: { root: new ArtifactRoot(join(dir, 'mirror')), name: 'main', baseUrl: 'https://models.example.org' } });
  const sha256 = p.manifest.files[0]!.sha256;
  expect(p.manifest.files[0]!.locations).toEqual([{ transport: 'https', uri: `https://models.example.org/main/sha256/${sha256}` }]);
  expect(p.manifestLocations).toEqual([`https://models.example.org/main/sha256/${p.manifestSha256}`]);
});

describe('publishing defaults', () => {
  it('use the local development services when no WEXARE_* variable is set', () => {
    const d = publishDefaults({});
    expect(d.relays.every((r) => r.startsWith('ws://127.0.0.1'))).toBe(true);
    expect(d.mirrorUrl).toMatch(/^http:\/\/127\.0\.0\.1/);
  });

  it('never fall back to this machine once a deployment is configured', () => {
    const d = publishDefaults({ WEXARE_RELAYS: 'wss://relay.example.org' });
    expect(d.relays).toEqual(['wss://relay.example.org']);
    expect(d.mirrorUrl).toBeUndefined();
    expect(d.trackers).toEqual([]);
    expect(d.ipfsApi).toBeUndefined();
    expect(d.mirrorRoot).toMatch(/deploy-mirror$/);
  });
});
