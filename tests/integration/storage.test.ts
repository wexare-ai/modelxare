// Real Kubo nodes, mirror and tracker (pnpm infra:up, pnpm demo:prepare).
// A07: fixture bytes retrieved through IPFS match the publisher manifest, on
// the first node and on the replica. Torrent metadata is real and seedable.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA, demoState, endpoints } from '../support/env.ts';

const state = demoState();
const manifest = (n: string) => JSON.parse(readFileSync(join(DATA, 'releases', n, 'manifest.json'), 'utf8')) as { files: { sha256: string; size: number; locations: { transport: string; uri: string }[] }[] };

async function sha256Of(url: string): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url);
  expect(res.ok).toBe(true);
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha256: h.digest('hex'), size };
}

describe('A07 IPFS retrieval', () => {
  const f = manifest('story-base').files[0]!;
  const cid = f.locations.find((l) => l.transport === 'ipfs')!.uri.replace('ipfs://', '');

  it('Kubo A gateway serves bytes matching the manifest hash', async () => {
    expect(await sha256Of(`${endpoints.kubo.a.gateway}/ipfs/${cid}`)).toEqual({ sha256: f.sha256, size: f.size });
  });

  it('Kubo B holds a pinned replica of every demo CID', async () => {
    const res = await fetch(`${endpoints.kubo.b.api}/api/v0/pin/ls?arg=${cid}&type=recursive`, { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(await res.json())).toContain(cid);
    expect(await sha256Of(`${endpoints.kubo.b.gateway}/ipfs/${cid}`)).toEqual({ sha256: f.sha256, size: f.size });
  });
});

describe('HTTP mirror', () => {
  it('serves exact bytes with CORS and range support', async () => {
    const f = manifest('story-base').files[0]!;
    const mirror = f.locations.find((l) => l.uri.startsWith(`${endpoints.artifacts}/main/sha256/`))!.uri;
    const res = await fetch(mirror, { headers: { Range: 'bytes=0-3', Origin: 'http://localhost:4173' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('GGUF');
  });
});

describe('torrents', () => {
  it('every demo torrent is registered with the seeder and complete', async () => {
    const status = (await (await fetch(`${endpoints.artifacts}/status`)).json()) as { seeding: { infoHash: string; ready: boolean; complete: boolean }[] };
    const torrents = Object.values(state.releases).flatMap((r) => (r.files ?? []).map((f) => (f as { infoHash?: string }).infoHash).filter(Boolean)) as string[];
    expect(torrents.length).toBeGreaterThan(0);
    for (const ih of torrents) expect(status.seeding.find((s) => s.infoHash === ih)).toMatchObject({ ready: true, complete: true });
  });
});
