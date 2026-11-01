// Fresh publishers and releases created through the real CLI.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, runDir } from './env.ts';
import { cli } from './procs.ts';

export interface PublishedRelease {
  name: string;
  eventId: string;
  manifestSha256: string;
  keyPath: string;
  pubkey: string;
  eventPath: string;
  /** Raw CLI output of `release publish` (per-relay outcome lines). */
  publishOutput: string;
  outcomes: Record<string, string>;
}

const story = () => JSON.parse(readFileSync(join(ROOT, 'fixtures/releases/story-base.json'), 'utf8'));
const storyModel = () => (JSON.parse(readFileSync(join(ROOT, 'fixtures/models.json'), 'utf8')).models as { id: string; file: string; license: unknown }[]).find((m) => m.id === 'stories15m-moe-f16')!;

/** Parse `✓ ws://… accepted …` lines printed by the CLI. */
export function parseOutcomes(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const m of out.matchAll(/^\s+[✓✗] (wss?:\/\/\S+)\s+(\S+)/gm)) r[m[1]!] = m[2]!;
  return r;
}

/**
 * Generate a brand-new publisher key, prepare a release whose weights are the
 * stories15M fixture bytes (served by the local mirror), sign and publish it.
 */
export async function publishNewRelease(label: string, opts: { relays?: string[] } = {}): Promise<PublishedRelease> {
  const dir = join(runDir(), 'publishers', label);
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'publisher.key.json');
  await cli(['keygen', '--out', keyPath, '--label', `e2e-${label}`]);
  const pubkey = JSON.parse(readFileSync(keyPath, 'utf8')).pubkey as string;
  const base = story();
  const model = storyModel();
  const run = process.env.WEXARE_E2E_RUN ?? 'run';
  const definition = {
    manifest: {
      ...base.manifest,
      model_id: `e2e-${label}`,
      name: `E2E ${label} ${run}`,
      description: `Release created by the acceptance suite (${label}, ${run}) from a freshly generated publisher key. Same bytes as the story base fixture.`,
      license: model.license,
    },
    files: [{ role: 'weights', path: model.file, source: join(DATA, 'fixtures/models', model.file) }],
    locations: ['mirror'],
  };
  const defPath = join(dir, 'definition.json');
  writeFileSync(defPath, JSON.stringify(definition, null, 2));
  const out = join(dir, 'release');
  const prep = await cli(['release', 'prepare', '--definition', defPath, '--key', keyPath, '--out', out, '--no-ipfs']);
  const eventId = /release ([0-9a-f]{64})/.exec(prep.out)![1]!;
  const manifestSha256 = /manifest sha256 ([0-9a-f]{64})/.exec(prep.out)![1]!;
  const eventPath = join(out, 'event.json');
  const relayArgs = (opts.relays ?? []).flatMap((r) => ['--relay', r]);
  const pub = await cli(['release', 'publish', '--event', eventPath, ...relayArgs], { allowFail: true });
  return { name: definition.manifest.name, eventId, manifestSha256, keyPath, pubkey, eventPath, publishOutput: pub.out, outcomes: parseOutcomes(pub.out) };
}
