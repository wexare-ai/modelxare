// Verified artifact cache in the Origin Private File System, keyed by SHA-256.
// Bytes enter `verified/` only after a full length + hash check; partial
// downloads live in `tmp/` and are discarded on failure.
import { createSHA256 } from 'hash-wasm';

const HEX64 = /^[0-9a-f]{64}$/;

export class OpfsArtifactCache {
  private constructor(
    private readonly verified: FileSystemDirectoryHandle,
    private readonly tmp: FileSystemDirectoryHandle,
    private readonly root: FileSystemDirectoryHandle,
  ) {}

  static async open(name = 'wexare-artifacts'): Promise<OpfsArtifactCache> {
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle(name, { create: true });
    const verified = await root.getDirectoryHandle('verified', { create: true });
    const tmp = await root.getDirectoryHandle('tmp', { create: true });
    return new OpfsArtifactCache(verified, tmp, root);
  }

  async getFile(sha256: string): Promise<File | null> {
    if (!HEX64.test(sha256)) return null;
    try {
      return await (await this.verified.getFileHandle(sha256)).getFile();
    } catch {
      return null;
    }
  }

  /** Cheap presence check: exists with the expected byte length. */
  async has(sha256: string, size?: number): Promise<boolean> {
    const f = await this.getFile(sha256);
    return !!f && (size === undefined || f.size === size);
  }

  async createTemp(): Promise<{ name: string; writable: FileSystemWritableFileStream }> {
    const name = `${Date.now()}-${crypto.randomUUID()}`;
    const handle = await this.tmp.getFileHandle(name, { create: true });
    return { name, writable: await handle.createWritable({ keepExistingData: false }) };
  }

  async discardTemp(name: string): Promise<void> {
    await this.tmp.removeEntry(name).catch(() => undefined);
  }

  /** Move a fully verified temp file into the verified store under its hash. */
  async promote(tempName: string, sha256: string): Promise<void> {
    if (!HEX64.test(sha256)) throw new Error('invalid sha256');
    const handle = await this.tmp.getFileHandle(tempName);
    const movable = handle as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
    if (typeof movable.move === 'function') {
      await this.verified.removeEntry(sha256).catch(() => undefined);
      await movable.move(this.verified, sha256);
      return;
    }
    const src = await handle.getFile();
    const dest = await (await this.verified.getFileHandle(sha256, { create: true })).createWritable();
    await src.stream().pipeTo(dest);
    await this.discardTemp(tempName);
  }

  async remove(sha256: string): Promise<void> {
    await this.verified.removeEntry(sha256).catch(() => undefined);
  }

  async list(): Promise<{ sha256: string; size: number }[]> {
    const out: { sha256: string; size: number }[] = [];
    for await (const [name, h] of (this.verified as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === 'file' && HEX64.test(name)) out.push({ sha256: name, size: (await (h as FileSystemFileHandle).getFile()).size });
    }
    return out;
  }

  /** Remove leftover partial downloads (e.g. after a crash or closed tab). */
  async clearTemp(): Promise<number> {
    let n = 0;
    for await (const [name] of (this.tmp as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      await this.tmp.removeEntry(name).catch(() => undefined);
      n++;
    }
    return n;
  }

  async clearAll(): Promise<void> {
    for (const n of ['verified', 'tmp']) await this.root.removeEntry(n, { recursive: true }).catch(() => undefined);
  }

  /** Full re-hash of a cached file. */
  async verify(sha256: string, size: number): Promise<boolean> {
    const f = await this.getFile(sha256);
    if (!f || f.size !== size) return false;
    return (await hashBlob(f)) === sha256;
  }
}

export async function hashBlob(blob: Blob, onProgress?: (bytes: number) => void): Promise<string> {
  const h = await createSHA256();
  h.init();
  let n = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    n += value.length;
    onProgress?.(n);
  }
  return h.digest('hex');
}
