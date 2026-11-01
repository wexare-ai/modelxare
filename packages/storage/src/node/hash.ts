import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Streaming SHA-256 and byte count of a local file. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  const st = await stat(path);
  if (st.size !== size) throw new Error(`${path} changed while hashing`);
  return { sha256: h.digest('hex'), size };
}
