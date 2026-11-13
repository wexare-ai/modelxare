import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  RELEASE_SCHEMA,
  buildReleaseEventTemplate,
  checkManifestSemantics,
  inferTransport,
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
    operations: ReleaseManifest['operations'];
  };
  files: {
    role: FileRole;
    path: string;
    source: string;
    /**
     * Addresses that already serve these exact bytes over HTTPS, e.g. a
     * Hugging Face `resolve/<commit>/` link. Listed first; checked byte for
     * byte before the release is signed.
     */
    urls?: string[];
    declareWrongSha256?: boolean;
  }[];
  /** LoRA only: the base release's saved event file, or its state directory. */
  base?: { event: NostrEvent; override?: Partial<NonNullable<ReleaseManifest['base']>> };
  /** Where the CLI publishes the bytes itself; none when every file has `urls`. */
  locations?: LocationKind[];
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

/** A location browsers can fetch from an HTTPS page: https, or this machine (development and tests). */
function webLocation(uri: string): FileLocation {
  const transport = inferTransport(uri);
  if (transport !== 'https' && transport !== 'http') throw new Error(`${uri} must be an https:// address`);
  return { transport, uri };
}

/**
 * Download `url` and check it is exactly these bytes, and that a browser on
 * another site may read it (CORS). Streams: memory stays flat for any size.
 */
export async function checkUrl(url: string, expected: { size: number; sha256: string }): Promise<void> {
  const res = await fetch(url, { headers: { Origin: 'https://modelxare.invalid' }, redirect: 'follow' }).catch((e: Error) => {
    throw new Error(`${url}: can't download it (${e.message})`);
  });
  if (!res.ok || !res.body) throw new Error(`${url}: the server answered ${res.status}`);
  const cors = res.headers.get('access-control-allow-origin');
  if (cors !== '*' && cors !== 'https://modelxare.invalid') {
    await res.body.cancel();
    throw new Error(`${url}: browsers can't read it from another site (no Access-Control-Allow-Origin header)`);
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  const sha256 = hash.digest('hex');
  if (size !== expected.size || sha256 !== expected.sha256)
    throw new Error(`${url}: serves different bytes (${size} bytes, sha256 ${sha256.slice(0, 16)}…) than the local file (${expected.size} bytes, sha256 ${expected.sha256.slice(0, 16)}…)`);
}

export interface PrepareOptions {
  /** Download each `urls` entry to check its bytes (default true). */
  checkUrls?: boolean;
}

/** Hash files, publish bytes to the storage the definition asks for, and assemble the manifest. */
export async function prepareRelease(def: ReleaseDefinition, storage: StorageTargets, opts: PrepareOptions = {}): Promise<PreparedRelease> {
  const kinds = def.locations ?? [];
  // The mirror also holds what torrents need (the .torrent file and the web seed).
  const mirror = kinds.some((k) => k !== 'ipfs') ? storage.mirror : undefined;
  const ipfs = kinds.includes('ipfs') ? storage.ipfs : undefined;
  const files: ManifestFile[] = [];
  const prepared: PreparedFile[] = [];
  for (const f of def.files) {
    const actual = await hashFile(f.source);
    const declared = f.declareWrongSha256 ? sha256Hex(`not the bytes of ${actual.sha256}`) : actual.sha256;
    log(`${f.path}: ${actual.size} bytes, sha256 ${actual.sha256.slice(0, 16)}…${f.declareWrongSha256 ? ` (DECLARED ${declared.slice(0, 16)}…, deliberately wrong)` : ''}`);
    const p: PreparedFile = { path: f.path, sha256: declared, size: actual.size };
    const locations: FileLocation[] = [];
    for (const url of f.urls ?? []) {
      const location = webLocation(url);
      if (opts.checkUrls === false) log(`url: ${url} (not checked)`);
      else {
        await checkUrl(url, actual);
        log(`url: ${url} (same bytes, readable by browsers)`);
      }
      locations.push(location);
    }
    let mirrorHttp: string | undefined;
    if (mirror) {
      await mirror.root.putFile(f.source, actual);
      mirrorHttp = mirrorUrl(mirror.baseUrl, mirror.name, actual.sha256);
    }
    for (const kind of kinds) {
      if (kind === 'mirror' && mirrorHttp) locations.push(webLocation(mirrorHttp));
      if (kind === 'missing-mirror' && mirror) locations.push(webLocation(mirrorUrl(mirror.baseUrl, 'missing', declared)));
      if (kind === 'corrupt-mirror' && storage.corruptMirror && mirror) {
        const dest = storage.corruptMirror.root.blobPath(declared);
        await mkdir(join(storage.corruptMirror.root.dir, 'sha256'), { recursive: true });
        if (!(await stat(dest).catch(() => null))) await writeCorruptCopy(f.source, dest);
        locations.push(webLocation(mirrorUrl(mirror.baseUrl, storage.corruptMirror.name, declared)));
      }
      if (kind === 'ipfs' && ipfs) {
        const { cid } = await ipfs.addFile(f.source, { name: basename(f.path) });
        p.cid = cid;
        locations.push({ transport: 'ipfs', uri: `ipfs://${cid}` });
        log(`ipfs: ${cid} (pinned)`);
      }
      if (kind === 'torrent' && mirror && storage.trackers?.length) {
        const name = basename(f.path);
        const t = await createSingleFileTorrent(f.source, { name, trackers: storage.trackers, webSeeds: [mirrorHttp!] });
        // The .torrent URL (magnet `xs`) lets clients fetch metadata even before peers appear.
        t.magnet += `&xs=${encodeURIComponent(torrentUrl(mirror.baseUrl, mirror.name, t.infoHash))}`;
        await mirror.root.putTorrent(t.infoHash, t.torrent, actual.sha256, name);
        p.infoHash = t.infoHash;
        p.magnet = t.magnet;
        locations.push({ transport: 'torrent', uri: t.magnet, path: t.path });
        log(`torrent: ${t.infoHash}`);
      }
    }
    if (!locations.length) throw new Error(`${f.path}: nowhere to download it from: give it urls, or add "mirror" or "ipfs" to locations`);
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
    operations: m.operations,
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
  // The manifest travels inside the signed event; these copies are optional extras.
  if (ipfs) manifestLocations.push(`ipfs://${(await ipfs.addBytes(bytes, 'manifest.json')).cid}`);
  if (mirror) {
    const { sha256 } = await mirror.root.putBytes(bytes);
    manifestLocations.push(mirrorUrl(mirror.baseUrl, mirror.name, sha256));
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
