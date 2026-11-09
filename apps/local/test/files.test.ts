// Downloads keep only bytes that match the signed release: right size, right
// SHA-256, resumed where they stopped, the next location tried when one fails.
// The bytes are stand-ins served from this test, not a model.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/files.ts';

const bytes = Buffer.from('stand-in bytes for a model file, '.repeat(200));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const gateways = { ipfs: [], arweave: [] };

let server: Server;
let base = '';
const ranges: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/broken') return void res.writeHead(500).end();
    if (req.url === '/wrong') return void res.writeHead(200, { 'content-length': bytes.length }).end(Buffer.alloc(bytes.length, 1));
    const range = req.headers.range;
    if (range) {
      ranges.push(range);
      const from = Number(/bytes=(\d+)-/.exec(range)![1]);
      return void res.writeHead(206, { 'content-length': bytes.length - from }).end(bytes.subarray(from));
    }
    res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const fresh = () => new FileStore(mkdtempSync(join(tmpdir(), 'modelxare-files-')));
const spec = (paths: string[]) => ({ sha256, size: bytes.length, path: 'model.gguf', locations: paths.map((p) => ({ transport: 'http' as const, uri: `${base}${p}` })) });

describe('verified downloads', () => {
  it('stores a file under its hash once size and SHA-256 match', async () => {
    const store = fresh();
    await store.download(spec(['/model']), gateways);
    expect(store.has(sha256, bytes.length)).toBe(true);
    expect(await store.verify(sha256, bytes.length)).toBe(store.path(sha256));
    rmSync(store.dir, { recursive: true });
  });

  it('refuses bytes whose hash differs, then tries the next location', async () => {
    const store = fresh();
    await expect(store.download(spec(['/wrong']), gateways)).rejects.toThrow(/SHA-256 mismatch/);
    expect(store.has(sha256, bytes.length)).toBe(false);
    expect(existsSync(`${store.path(sha256)}.part`)).toBe(false);
    await store.download(spec(['/broken', '/wrong', '/model']), gateways);
    expect(store.has(sha256, bytes.length)).toBe(true);
    rmSync(store.dir, { recursive: true });
  });

  it('resumes a partial download with a range request', async () => {
    const store = fresh();
    writeFileSync(`${store.path(sha256)}.part`, bytes.subarray(0, 1000));
    await store.download(spec(['/model']), gateways);
    expect(ranges).toContain('bytes=1000-');
    expect(store.has(sha256, bytes.length)).toBe(true);
    rmSync(store.dir, { recursive: true });
  });

  it('removes a stored file that no longer matches its hash', async () => {
    const store = fresh();
    await store.download(spec(['/model']), gateways);
    const again = new FileStore(store.dir);
    writeFileSync(again.path(sha256), Buffer.alloc(bytes.length, 2));
    await expect(again.verify(sha256, bytes.length)).rejects.toThrow(/changed on disk/);
    expect(again.has(sha256, bytes.length)).toBe(false);
    rmSync(store.dir, { recursive: true });
  });

  it('says so when no location can be downloaded here', async () => {
    const store = fresh();
    await expect(store.download({ sha256, size: 1, path: 'm.gguf', locations: [{ transport: 'torrent', uri: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), path: 'm.gguf' }] }, gateways)).rejects.toThrow(/no location/);
    rmSync(store.dir, { recursive: true });
  });
});
