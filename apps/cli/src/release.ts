import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  OPERATION_CONTRACTS,
  RELEASE_SCHEMA,
  buildReleaseEventTemplate,
  checkManifestSemantics,
  serializeManifest,
  sha256Hex,
  validateManifestSchema,
  verifyReleaseEvent,
  type FileLocation,
  type FileRole,
  type ManifestFile,
  type NostrEvent,
  type ReleaseManifest,
} from '@wexare/protocol';
import { ArtifactRoot, KuboClient, createSingleFileTorrent, hashFile, mirrorUrl, torrentUrl } from '@wexare/storage/node';
import type { LoadedKey } from './keys.ts';

export type LocationKind = 'mirror' | 'corrupt-mirror' | 'missing-mirror' | 'ipfs' | 'torrent';

/** Publisher-facing definition: manifest fields plus local files to publish. */
export interface ReleaseDefinition {
  manifest: Omit<ReleaseManifest, 'schema' | 'files' | 'base' | 'operations' | 'license'> & {
    license: ReleaseManifest['license'];
    operations: (Omit<ReleaseManifest['operations'][number], 'input_schema' | 'output_schema'> & Partial<ReleaseManifest['operations'][number]>)[];
  };
  files: { role: FileRole; path: string; source: string; declareWrongSha256?: boolean }[];
  /** LoRA only: the base release's saved event file, or its state directory. */
  base?: { event: NostrEvent; override?: Partial<NonNullable<ReleaseManifest['base']>> };
  locations: LocationKind[];
}

export interface StorageTargets {
  mirror?: { root: ArtifactRoot; name: string; baseUrl: string };
  corruptMirror?: { root: ArtifactRoot; name: string };
  ipfs?: KuboClient;
  trackers?: string[];
}

export interface PreparedFile {
  path: string;
  sha256: string;
  size: number;
  cid?: string;
  infoHash?: string;
  magnet?: string;
}

export interface PreparedRelease {
  manifest: ReleaseManifest;
  manifestJson: string;
  manifestSha256: string;
  manifestLocations: string[];
  files: PreparedFile[];
}

const log = (s: string) => console.log(`    ${s}`);

/** Copy a file with one byte flipped in the middle (negative fixture for A10). */
async function writeCorruptCopy(src: string, dest: string): Promise<void> {
  await writeFile(dest, await readFile(src));
  const fh = await open(dest, 'r+');
  try {
    const { size } = await fh.stat();
    const pos = Math.floor(size / 2);
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, pos);
    b[0] = b[0]! ^ 0xff;
    await fh.write(b, 0, 1, pos);
  } finally {
    await fh.close();
  }
}

/** Hash files, publish bytes to the configured storage, and assemble the manifest. */
export async function prepareRelease(def: ReleaseDefinition, storage: StorageTargets): Promise<PreparedRelease> {
  const files: ManifestFile[] = [];
  const prepared: PreparedFile[] = [];
  for (const f of def.files) {
    const actual = await hashFile(f.source);
    const declared = f.declareWrongSha256 ? sha256Hex(`not the bytes of ${actual.sha256}`) : actual.sha256;
    log(`${f.path}: ${actual.size} bytes, sha256 ${actual.sha256.slice(0, 16)}…${f.declareWrongSha256 ? ` (DECLARED ${declared.slice(0, 16)}…, deliberately wrong)` : ''}`);
    const p: PreparedFile = { path: f.path, sha256: declared, size: actual.size };
    const locations: FileLocation[] = [];
    let mirrorHttp: string | undefined;
    if (storage.mirror) {
      await storage.mirror.root.putFile(f.source, actual);
      mirrorHttp = mirrorUrl(storage.mirror.baseUrl, storage.mirror.name, actual.sha256);
    }
    for (const kind of def.locations) {
      if (kind === 'mirror' && mirrorHttp) locations.push({ transport: 'http', uri: mirrorHttp });
      if (kind === 'missing-mirror' && storage.mirror) locations.push({ transport: 'http', uri: mirrorUrl(storage.mirror.baseUrl, 'missing', declared) });
      if (kind === 'corrupt-mirror' && storage.corruptMirror && storage.mirror) {
        const dest = storage.corruptMirror.root.blobPath(declared);
        await mkdir(join(storage.corruptMirror.root.dir, 'sha256'), { recursive: true });
        if (!(await stat(dest).catch(() => null))) await writeCorruptCopy(f.source, dest);
        locations.push({ transport: 'http', uri: mirrorUrl(storage.mirror.baseUrl, storage.corruptMirror.name, declared) });
      }
      if (kind === 'ipfs' && storage.ipfs) {
        const { cid } = await storage.ipfs.addFile(f.source, { name: basename(f.path) });
        p.cid = cid;
        locations.push({ transport: 'ipfs', uri: `ipfs://${cid}` });
        log(`ipfs: ${cid} (pinned)`);
      }
      if (kind === 'torrent' && storage.mirror && storage.trackers?.length) {
        const name = basename(f.path);
        const t = await createSingleFileTorrent(f.source, { name, trackers: storage.trackers, webSeeds: [mirrorHttp!] });
        // The .torrent URL (magnet `xs`) lets clients fetch metadata even before peers appear.
        t.magnet += `&xs=${encodeURIComponent(torrentUrl(storage.mirror.baseUrl, storage.mirror.name, t.infoHash))}`;
        await storage.mirror.root.putTorrent(t.infoHash, t.torrent, actual.sha256, name);
        p.infoHash = t.infoHash;
        p.magnet = t.magnet;
        locations.push({ transport: 'torrent', uri: t.magnet, path: t.path });
        log(`torrent: ${t.infoHash}`);
      }
    }
    files.push({ role: f.role, path: f.path, size: actual.size, sha256: declared, locations });
    prepared.push(p);
  }

  const m = def.manifest;
  const manifest: ReleaseManifest = {
    schema: RELEASE_SCHEMA,
    model_id: m.model_id,
    name: m.name,
    description: m.description,
    version: m.version,
    kind: m.kind,
    capabilities: m.capabilities,
    languages: m.languages,
    license: m.license,
    runtime: m.runtime,
    files,
    operations: m.operations.map((op) => ({
      ...op,
      input_schema: op.input_schema ?? OPERATION_CONTRACTS[op.id]?.input_schema ?? {},
      output_schema: op.output_schema ?? OPERATION_CONTRACTS[op.id]?.output_schema ?? {},
    })),
    requirements: m.requirements,
    ...(m.labels ? { labels: m.labels } : {}),
  };
  if (def.base) {
    const r = verifyReleaseEvent(def.base.event);
    if (!r.ok) throw new Error(`base release is invalid: ${r.errors.map((e) => e.code).join(', ')}`);
    manifest.base = {
      release_id: r.value.event.id,
      manifest_sha256: r.value.manifestSha256,
      files: r.value.manifest.files.filter((f) => f.role === 'weights').map((f) => ({ sha256: f.sha256, size: f.size })),
      ...def.base.override,
    };
  }
  const errors = [...validateManifestSchema(manifest), ...checkManifestSemantics(manifest)];
  if (errors.length) throw new Error(`manifest is invalid:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join('\n')}`);

  const manifestJson = serializeManifest(manifest);
  const manifestLocations: string[] = [];
  const bytes = new TextEncoder().encode(manifestJson);
  if (storage.ipfs) manifestLocations.push(`ipfs://${(await storage.ipfs.addBytes(bytes, 'manifest.json')).cid}`);
  if (storage.mirror) {
    const { sha256 } = await storage.mirror.root.putBytes(bytes);
    manifestLocations.push(mirrorUrl(storage.mirror.baseUrl, storage.mirror.name, sha256));
  }
  return { manifest, manifestJson, manifestSha256: sha256Hex(manifestJson), manifestLocations, files: prepared };
}

export function signRelease(p: PreparedRelease, key: LoadedKey, createdAt?: number): NostrEvent {
  const [url, ...fallbacks] = p.manifestLocations;
  const template = buildReleaseEventTemplate({
    manifestJson: p.manifestJson,
    ...(url ? { url } : {}),
    fallbacks,
    ...(createdAt ? { createdAt } : {}),
  });
  const event = finalizeEvent(template, key.secretKey) as unknown as NostrEvent;
  const check = verifyReleaseEvent(event);
  if (!check.ok) throw new Error(`signed event failed verification: ${check.errors.map((e) => e.message).join('; ')}`);
  return event;
}

export interface ReleaseState {
  name: string;
  publisher: string;
  event_id: string;
  manifest_sha256: string;
  created_at: number;
  files: PreparedFile[];
  manifest_locations: string[];
  publications: { at: string; results: { relay: string; outcome: string; message: string }[] }[];
}

export async function saveRelease(dir: string, name: string, publisher: string, p: PreparedRelease, event: NostrEvent): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), p.manifestJson);
  await writeFile(join(dir, 'event.json'), JSON.stringify(event, null, 2) + '\n');
  const prev = await loadReleaseState(dir).catch(() => null);
  const state: ReleaseState = {
    name,
    publisher,
    event_id: event.id,
    manifest_sha256: p.manifestSha256,
    created_at: event.created_at,
    files: p.files,
    manifest_locations: p.manifestLocations,
    publications: prev?.event_id === event.id ? prev.publications : [],
  };
  await writeFile(join(dir, 'release.json'), JSON.stringify(state, null, 2) + '\n');
}

export async function loadReleaseState(dir: string): Promise<ReleaseState> {
  return JSON.parse(await readFile(join(dir, 'release.json'), 'utf8'));
}

export async function loadEvent(path: string): Promise<NostrEvent> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return (raw.event ?? raw) as NostrEvent;
}

export async function recordPublication(dir: string, results: { relay: string; outcome: string; message: string }[]): Promise<void> {
  const s = await loadReleaseState(dir);
  s.publications.push({ at: new Date().toISOString(), results });
  await writeFile(join(dir, 'release.json'), JSON.stringify(s, null, 2) + '\n');
}
