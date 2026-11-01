// ar:// locations resolve through configured gateways and the bytes are
// verified exactly like any other source. Needs internet access to a public
// gateway; opt in with WEXARE_TEST_ARWEAVE=1. Not an Arweave publication.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSources } from '@wexare/storage';
import { ROOT } from '../support/env.ts';

const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/arweave.json'), 'utf8')) as { transaction: string; size: number; sha256: string };
const gateways = (process.env.WEXARE_ARWEAVE_GATEWAYS ?? 'https://arweave.net').split(',');

describe.runIf(process.env.WEXARE_TEST_ARWEAVE === '1')('Arweave gateway adapter', () => {
  it('resolves ar://<tx> through each configured gateway and verifies the exact bytes', async () => {
    const sources = resolveSources([{ transport: 'arweave', uri: `ar://${fixture.transaction}` }], { ipfsGateways: [], arweaveGateways: gateways }, fixture.sha256);
    expect(sources.map((s) => (s.kind === 'http' ? s.url : ''))).toEqual(gateways.map((g) => `${g.replace(/\/$/, '')}/${fixture.transaction}`));
    for (const s of sources) {
      if (s.kind !== 'http') continue;
      const res = await fetch(s.url, { headers: { Origin: 'http://localhost:4173' } });
      expect(res.ok).toBe(true);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBe(fixture.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
    }
  });
});
