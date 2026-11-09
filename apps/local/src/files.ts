// Model files on this machine, stored by content hash. A file is written under
// its final name only after its size and SHA-256 matched the signed release,
// and it is hashed again the first time this process loads it. Downloads
// resume from where they stopped.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openAsBlob, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHttpUrls, type FileLocation } from '@wexare/protocol';

export interface FileSpec {
  sha256: string;
  size: number;
  path: string;
  locations: FileLocation[];
}

export interface Gateways {
  ipfs: string[];
  arweave: string[];
}

export type Progress = (sha256: string, bytes: number, total: number) => void;

/** A verified file handed to the orchestrator: a Blob that also says where it is on disk. */
export type PathBlob = Blob & { path: string };

const USER_AGENT = 'modelxare-local/0.1';

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20, ...(signal ? { signal } : {}) })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class FileStore {
  /** Hashed again by this process: loading them doesn't re-read them. */
  private readonly checked = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'sha256'), { recursive: true });
  }

  path(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('not a SHA-256 hex digest');
    return join(this.dir, 'sha256', sha256);
  }

  /** Downloaded and verified (a file only gets its final name after that). */
  has(sha256: string, size: number): boolean {
    try {
      return statSync(this.path(sha256)).size === size;
    } catch {
      return false;
    }
  }

  /** Every complete file, for `list` and space accounting. */
  list(): { sha256: string; size: number }[] {
    const dir = join(this.dir, 'sha256');
    return readdirSync(dir)
      .filter((n) => /^[0-9a-f]{64}$/.test(n))
      .map((sha256) => ({ sha256, size: statSync(join(dir, sha256)).size }));
  }

  remove(sha256: string): void {
    rmSync(this.path(sha256), { force: true });
    rmSync(`${this.path(sha256)}.part`, { force: true });
    this.checked.delete(sha256);
  }

  /** Hash the stored bytes again (once per process); a file that no longer matches is removed. */
  async verify(sha256: string, size: number): Promise<string> {
    const path = this.path(sha256);
    if (this.checked.has(sha256)) return path;
    if (!this.has(sha256, size)) throw new Error(`file ${sha256.slice(0, 12)}… is not downloaded`);
    if ((await sha256File(path)) !== sha256) {
      this.remove(sha256);
      throw new Error(`file ${sha256.slice(0, 12)}… changed on disk and was removed; pull the model again`);
    }
    this.checked.add(sha256);
    return path;
  }

  /** For the orchestrator's getVerifiedFile: the verified file as a path-carrying Blob. */
  async verifiedBlob(sha256: string, size: number): Promise<PathBlob> {
    const path = await this.verify(sha256, size);
    return Object.assign(await openAsBlob(path), { path });
  }

  /** Download one file (once, however many callers ask), trying each location in turn. */
  download(file: FileSpec, gateways: Gateways, onProgress?: Progress, signal?: AbortSignal): Promise<void> {
    if (this.has(file.sha256, file.size)) return Promise.resolve();
    const running = this.running.get(file.sha256);
    if (running) return running;
    const job = this.fetchFile(file, gateways, onProgress, signal).finally(() => this.running.delete(file.sha256));
    this.running.set(file.sha256, job);
    return job;
  }

  private async fetchFile(file: FileSpec, gateways: Gateways, onProgress: Progress | undefined, signal: AbortSignal | undefined): Promise<void> {
    const urls = file.locations.flatMap((l) => resolveHttpUrls(l, gateways));
    if (!urls.length) throw new Error(`${file.path}: no location this runtime can download from (it reads https, ipfs and ar locations)`);
    const problems: string[] = [];
    for (const url of urls) {
      signal?.throwIfAborted();
      try {
        await this.fetchFrom(url, file, onProgress, signal);
        this.checked.add(file.sha256);
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        problems.push(`${new URL(url).host}: ${(e as Error).message}`);
      }
    }
    throw new Error(`${file.path} could not be downloaded (${problems.join('; ')})`);
  }

  private async fetchFrom(url: string, file: FileSpec, onProgress: Progress | undefined, signal: AbortSignal | undefined): Promise<void> {
    const final = this.path(file.sha256);
    const part = `${final}.part`;
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > file.size) {
      rmSync(part);
      have = 0;
    }
    const hash = createHash('sha256');
    if (have > 0) for await (const chunk of createReadStream(part, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...(have > 0 ? { range: `bytes=${have}-` } : {}) }, redirect: 'follow', ...(signal ? { signal } : {}) });
    if (have > 0 && res.status === 200) {
      // The server ignored the range: start over.
      rmSync(part);
      return this.fetchFrom(url, file, onProgress, signal);
    }
    if (res.status === 416 && have === file.size) {
      // Already complete; fall through to the hash check below.
    } else if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      const length = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(length) && have + length !== file.size) throw new Error(`size ${have + length} bytes, expected ${file.size}`);
      const out = await open(part, have > 0 ? 'a' : 'w');
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          have += chunk.byteLength;
          if (have > file.size) throw new Error(`more than the expected ${file.size} bytes`);
          hash.update(chunk);
          await out.write(chunk);
          onProgress?.(file.sha256, have, file.size);
        }
      } finally {
        await out.close();
      }
    }
    if (have !== file.size) throw new Error(`got ${have} of ${file.size} bytes`);
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      rmSync(part, { force: true });
      throw new Error(`SHA-256 mismatch (got ${digest.slice(0, 12)}…)`);
    }
    renameSync(part, final);
  }
}
