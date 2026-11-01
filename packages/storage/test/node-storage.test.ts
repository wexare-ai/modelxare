import { mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { magnetInfoHash, sha256Hex } from '@wexare/protocol';
import { ArtifactRoot, createSingleFileTorrent, hashFile, mirrorUrl } from '../src/node/index.ts';
import { resolveSources } from '../src/index.ts';

describe('node storage', () => {
  it('stores blobs by content hash and creates reproducible torrents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wx-art-'));
    const src = join(dir, 'model.gguf');
    const bytes = new TextEncoder().encode('fake weights for a storage test '.repeat(5000));
    await writeFile(src, bytes);
    expect(await hashFile(src)).toEqual({ sha256: sha256Hex(bytes), size: bytes.length });

    const root = new ArtifactRoot(join(dir, 'root'));
    const h = await root.putFile(src);
    expect(new Uint8Array(await readFile(root.blobPath(h.sha256)))).toEqual(bytes);
    await expect(root.putFile(src, { sha256: '0'.repeat(64), size: 1 })).rejects.toThrow(/does not match/);

    const opts = { name: 'model.gguf', trackers: ['ws://127.0.0.1:8000'], webSeeds: [mirrorUrl('http://127.0.0.1:8790', 'main', h.sha256)], torrentUrl: 'http://127.0.0.1:8790/main/torrents/x.torrent' };
    const t1 = await createSingleFileTorrent(src, opts);
    const t2 = await createSingleFileTorrent(src, { ...opts, trackers: ['ws://other'] });
    expect(t1.infoHash).toBe(t2.infoHash);
    expect(magnetInfoHash(t1.magnet)).toBe(t1.infoHash);
    expect(t1.magnet).toContain('ws=');
    expect(t1.magnet).toContain('xs=');
    await root.putTorrent(t1.infoHash, t1.torrent, h.sha256, 'model.gguf');
    expect(await readlink(join(root.dir, 'seed', t1.infoHash, 'model.gguf'))).toContain('sha256');
    expect((await root.listTorrents()).map((t) => t.infoHash)).toEqual([t1.infoHash]);
  });

  it('resolves sources through configured gateways in manifest order', () => {
    const s = resolveSources(
      [
        { transport: 'http', uri: 'http://127.0.0.1:8790/broken/sha256/aa' },
        { transport: 'ipfs', uri: 'ipfs://bafyexample' },
        { transport: 'torrent', uri: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', path: 'm.gguf' },
        { transport: 'gopher', uri: 'gopher://x' },
      ],
      { ipfsGateways: ['http://127.0.0.1:8080', 'http://127.0.0.1:8081'], arweaveGateways: [] },
    );
    expect(s.map((x) => (x.kind === 'http' ? x.url : x.magnet.slice(0, 20)))).toEqual([
      'http://127.0.0.1:8790/broken/sha256/aa',
      'http://127.0.0.1:8080/ipfs/bafyexample',
      'http://127.0.0.1:8081/ipfs/bafyexample',
      'magnet:?xt=urn:btih:',
    ]);
  });
});
