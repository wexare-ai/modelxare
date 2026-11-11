import { describe, expect, it } from 'vitest';
import type { CandidateRelease } from '@wexare/orchestrator';
import { OPERATION_CONTRACTS, sha256Hex, type ReleaseManifest } from '@wexare/protocol';
import { buildModels } from '../src/models.ts';
import { Trust } from '../src/trust.ts';

const WEXARE = '1'.repeat(64);
const ANA = '2'.repeat(64);
const STRANGER = '3'.repeat(64);

const approved = new Trust([
  { pubkey: WEXARE, label: 'weXare', approvedBy: 'weXare', roles: ['models', 'router'] },
  { pubkey: ANA, label: 'Ana', approvedBy: 'weXare', roles: ['models'] },
]);

describe('Trust', () => {
  it('shows every publisher in local development', () => {
    const open = new Trust('any');
    expect(open.allows(STRANGER, 'models')).toBe(true);
    expect(open.allows(STRANGER, 'router')).toBe(true);
    expect(open.authors()).toBeUndefined();
  });

  it('allows each approved publisher only its roles', () => {
    expect(approved.allows(WEXARE, 'router')).toBe(true);
    expect(approved.allows(ANA, 'models')).toBe(true);
    expect(approved.allows(ANA, 'router')).toBe(false);
    expect(approved.allows(STRANGER, 'models')).toBe(false);
    expect(approved.authors()).toEqual([WEXARE, ANA]);
  });

  it('names publishers the way people read them', () => {
    expect(approved.describe(WEXARE)).toBe('weXare');
    expect(approved.describe(ANA)).toBe('Ana, approved by weXare');
    expect(approved.describe(STRANGER)).toBeNull();
  });

  it('takes more approvals from another source, such as a community list', () => {
    const t = new Trust([{ pubkey: WEXARE, label: 'weXare', approvedBy: 'weXare', roles: ['models', 'router'] }]);
    t.add([{ pubkey: STRANGER, label: 'Sam', approvedBy: 'Community curators', roles: ['models'] }]);
    expect(t.allows(STRANGER, 'models')).toBe(true);
    expect(t.allows(STRANGER, 'router')).toBe(false);
    expect(t.describe(STRANGER)).toBe('Sam, approved by Community curators');
  });
});

let n = 0;
function release(pubkey: string, p: { kind?: 'model' | 'lora'; base?: CandidateRelease; caps?: string[] } = {}): CandidateRelease {
  n++;
  const caps = p.caps ?? ['summarization'];
  const manifest: ReleaseManifest = {
    schema: 'wexare.micromodel.release/0.1',
    model_id: `m${n}`,
    name: `Model ${n}`,
    description: '',
    version: '1.0.0',
    kind: p.kind ?? 'model',
    capabilities: caps,
    languages: ['en'],
    license: { id: 'MIT' },
    runtime: { format: 'gguf', family: 'wllama', requirement: '*', browser_features: [] },
    files: [{ role: p.kind === 'lora' ? 'adapter' : 'weights', path: `m${n}.gguf`, size: 100, sha256: sha256Hex(`file ${n}`), locations: [{ transport: 'http', uri: `https://example.org/${n}` }] }],
    operations: caps.map((id) => ({ id, prompt: { mode: 'chat' as const, template: '{{input}}' }, input_schema: OPERATION_CONTRACTS[id]!.input_schema, output_schema: OPERATION_CONTRACTS[id]!.output_schema })),
    requirements: { context_length: 512 },
    ...(p.base
      ? { base: { release_id: p.base.eventId, manifest_sha256: p.base.manifestSha256, files: p.base.manifest.files.map((f) => ({ sha256: f.sha256, size: f.size })) } }
      : {}),
  };
  return {
    eventId: sha256Hex(`event ${n}`),
    pubkey,
    modelId: manifest.model_id,
    name: manifest.name,
    version: '1.0.0',
    manifestSha256: sha256Hex(`manifest ${n}`),
    manifest,
    support: { supported: true, reasons: [], executableOperations: caps },
  };
}

describe('the catalog shows approved publishers only', () => {
  const shown = (c: CandidateRelease) => approved.allows(c.pubkey, 'models');

  it('leaves out releases from publishers nobody approved', () => {
    const ours = release(WEXARE);
    const theirs = release(STRANGER);
    expect(buildModels([ours, theirs], () => false, shown).map((m) => m.id)).toEqual([ours.eventId]);
    expect(buildModels([ours, theirs], () => false)).toHaveLength(2);
  });

  it('still runs an approved style add-on on a base someone else published', () => {
    const base = release(STRANGER, { caps: ['text-generation'] });
    const addOn = release(ANA, { kind: 'lora', base, caps: ['text-generation'] });
    const models = buildModels([base, addOn], () => false, shown);
    expect(models.map((m) => m.id)).toEqual([addOn.eventId]);
    expect(models[0]!.base?.eventId).toBe(base.eventId);
  });

  it('lists an add-on under its own tasks, not its base’s', () => {
    const base = release(WEXARE, { caps: ['summarization', 'text-classification'] });
    const addOn = release(WEXARE, { kind: 'lora', base, caps: ['command-generation'] });
    const models = buildModels([base, addOn], () => false, shown);
    expect(models.find((m) => m.id === addOn.eventId)?.tasks).toEqual(['command-generation']);
  });
});
