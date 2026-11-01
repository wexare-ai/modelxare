import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { hashFile } from './hash.ts';

/**
 * A content-addressed artifact root served by apps/artifacts:
 *   sha256/<hex>                exact immutable bytes
 *   torrents/<infohash>.torrent torrent metadata
 *   seed/<infohash>/<name>      symlink to the bytes, the seeder's data path
 */
export class ArtifactRoot {
  constructor(readonly dir: string) {}

  blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
    return join(this.dir, 'sha256', sha256);
  }

  async has(sha256: string): Promise<boolean> {
    return !!(await stat(this.blobPath(sha256)).catch(() => null));
  }

  /** Add a file by content hash (hard link when possible), verifying the stored bytes. */
  async putFile(path: string, expected?: { sha256: string; size: number }): Promise<{ sha256: string; size: number }> {
    const h = expected ?? (await hashFile(path));
    if (expected) {
      const actual = await hashFile(path);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`${path} does not match expected hash/size`);
    }
    const dest = this.blobPath(h.sha256);
    if (await this.has(h.sha256)) return h;
    await mkdir(join(this.dir, 'sha256'), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    await link(path, tmp).catch(() => copyFile(path, tmp));
    await rename(tmp, dest);
    return h;
  }

  async putBytes(bytes: Uint8Array): Promise<{ sha256: string; size: number }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!(await this.has(sha256))) {
      await mkdir(join(this.dir, 'sha256'), { recursive: true });
      const tmp = `${this.blobPath(sha256)}.tmp-${process.pid}`;
      await writeFile(tmp, bytes);
      await rename(tmp, this.blobPath(sha256));
    }
    return { sha256, size: bytes.length };
  }

  async getBytes(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.blobPath(sha256)));
  }

  /** Store torrent metadata and the seeder's data path for an existing blob. */
  async putTorrent(infoHash: string, torrent: Uint8Array, sha256: string, name: string): Promise<void> {
    await mkdir(join(this.dir, 'torrents'), { recursive: true });
    await writeFile(join(this.dir, 'torrents', `${infoHash}.torrent`), torrent);
    const seedDir = join(this.dir, 'seed', infoHash);
    await mkdir(seedDir, { recursive: true });
    const target = join(seedDir, name);
    await rm(target, { force: true });
    await symlink(relative(seedDir, this.blobPath(sha256)), target);
  }

  async listTorrents(): Promise<{ infoHash: string; torrentPath: string; seedDir: string }[]> {
    const files = await readdir(join(this.dir, 'torrents')).catch(() => [] as string[]);
    return files
      .filter((f) => f.endsWith('.torrent'))
      .map((f) => {
        const infoHash = f.slice(0, -'.torrent'.length);
        return { infoHash, torrentPath: join(this.dir, 'torrents', f), seedDir: join(this.dir, 'seed', infoHash) };
      });
  }

  async list(): Promise<string[]> {
    return (await readdir(join(this.dir, 'sha256')).catch(() => [] as string[])).filter((f) => /^[0-9a-f]{64}$/.test(f));
  }
}

/** Public URL of a blob on an artifacts server root. */
export const mirrorUrl = (base: string, root: string, sha256: string) => `${base.replace(/\/+$/, '')}/${root}/sha256/${sha256}`;
export const torrentUrl = (base: string, root: string, infoHash: string) => `${base.replace(/\/+$/, '')}/${root}/torrents/${infoHash}.torrent`;
