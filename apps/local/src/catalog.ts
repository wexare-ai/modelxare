// What this machine can run, from the verified releases of approved
// publishers: GGUF language models (System 2) on native llama.cpp, and the
// Laya router (System 1) on native ONNX Runtime. Each model gets the id an
// OpenAI client asks for: the release's model_id.
import { resolveLoraDependency, type CandidateRelease } from '@wexare/orchestrator';
import { pickRouter, routerSupport, ROUTING_CAPABILITY } from '@wexare/router';
import { operationExecutable, type ManifestFile, type ReleaseManifest, type VerifiedRelease } from '@wexare/protocol';
import type { SupportResult } from '@wexare/runtime/support';
import type { Trust } from './config.ts';

/** The model id that sends each request through System 1 first. */
export const AUTO_ID = 'auto';

/**
 * Runtime families whose GGUF files native llama.cpp runs: wllama is llama.cpp
 * built for WebAssembly, so a release checked there runs here too. The
 * release's wllama version range describes the browser build and is not
 * applied to the native one.
 */
export const NATIVE_GGUF_FAMILIES = ['wllama', 'llama.cpp'];

/** Transports this runtime downloads over (torrents are browser-only for now). */
const downloadable = (f: ManifestFile) => f.locations.some((l) => l.transport === 'https' || l.transport === 'http' || l.transport === 'ipfs' || l.transport === 'arweave');

/** Can native llama.cpp run this release? Operations are the tasks it can do by itself (for `auto`). */
export function nativeSupport(m: ReleaseManifest): SupportResult {
  const reasons: string[] = [];
  if (m.labels?.includes('synthetic')) reasons.push('synthetic record: never runnable');
  if (m.runtime.format !== 'gguf') reasons.push(`format ${m.runtime.format} is not gguf`);
  if (!NATIVE_GGUF_FAMILIES.includes(m.runtime.family)) reasons.push(`runtime family ${m.runtime.family} is not llama.cpp-compatible`);
  if (m.kind !== 'model' && m.kind !== 'lora') reasons.push(`kind ${m.kind} is not a model or adapter`);
  if (m.files.some((f) => !downloadable(f))) reasons.push('a file has no location this runtime downloads from (https, ipfs, ar)');
  if (m.kind === 'model' && !m.files.some((f) => f.role === 'weights')) reasons.push('no weights file');
  if (m.kind === 'lora' && !m.files.some((f) => f.role === 'adapter')) reasons.push('no adapter file');
  const executableOperations = m.operations.filter(operationExecutable).map((op) => op.id);
  return { supported: reasons.length === 0, reasons, executableOperations };
}

export function toCandidate(r: VerifiedRelease, support: SupportResult = nativeSupport(r.manifest)): CandidateRelease {
  return { eventId: r.event.id, pubkey: r.event.pubkey, modelId: r.manifest.model_id, name: r.manifest.name, version: r.manifest.version, manifestSha256: r.manifestSha256, manifest: r.manifest, support };
}

export interface LocalModel {
  /** What an OpenAI client sends as `model`. */
  id: string;
  name: string;
  description: string;
  publisher: string;
  /** The release that runs: the model itself, or an adapter applied to `base`. */
  release: CandidateRelease;
  base?: CandidateRelease;
  /** Every file it needs, base weights included. */
  files: ManifestFile[];
  /** Tasks it does by itself in `auto` (operations whose answer shape this client knows). */
  tasks: string[];
  /** False: no chat format, so chat requests continue the text instead. */
  chat: boolean;
  license: string;
  createdAt: number;
}

export interface Catalog {
  models: LocalModel[];
  /** The System 1 router `auto` uses, when an approved one is published. */
  router: CandidateRelease | null;
  /** Approved releases this runtime can't run, and why. */
  skipped: { name: string; reasons: string[] }[];
}

const newer = (a: CandidateRelease, b: CandidateRelease) => a.version.localeCompare(b.version, undefined, { numeric: true }) > 0;

/** Laya's browser features have native equivalents (ONNX Runtime on the CPU). */
const nativeFeatures = (m: ReleaseManifest) => Object.fromEntries(m.runtime.browser_features.map((f) => [f, true]));

export function buildCatalog(releases: VerifiedRelease[], trust: Trust, isCached: (sha256: string) => boolean): Catalog {
  const all = releases.map((r) => toCandidate(r));
  const created = new Map(releases.map((r) => [r.event.id, r.event.created_at]));
  const byId = new Map(all.map((c) => [c.eventId, c]));
  const skipped: Catalog['skipped'] = [];

  const routers = all.filter((c) => c.manifest.capabilities.includes(ROUTING_CAPABILITY) && trust.allows(c.pubkey, 'router'));
  for (const c of routers) {
    const s = routerSupport(c.manifest, nativeFeatures(c.manifest));
    if (!s.supported) skipped.push({ name: c.name, reasons: s.reasons });
  }
  const router = pickRouter(routers, Object.assign({}, ...routers.map((c) => nativeFeatures(c.manifest))), isCached);

  // One entry per model: the newest version a publisher released.
  const latest = new Map<string, CandidateRelease>();
  for (const c of all) {
    if (c.manifest.capabilities.includes(ROUTING_CAPABILITY) || !trust.allows(c.pubkey, 'models')) continue;
    const key = `${c.pubkey}:${c.modelId}`;
    const seen = latest.get(key);
    if (!seen || newer(c, seen)) latest.set(key, c);
  }

  const models: LocalModel[] = [];
  for (const c of latest.values()) {
    if (!c.support.supported) {
      skipped.push({ name: c.name, reasons: c.support.reasons });
      continue;
    }
    let base: CandidateRelease | undefined;
    let files: ManifestFile[] = c.manifest.files;
    if (c.manifest.kind === 'lora') {
      const dep = resolveLoraDependency(c, (id) => byId.get(id) ?? null, isCached);
      if (!dep.ok || !dep.base) {
        skipped.push({ name: c.name, reasons: dep.problems });
        continue;
      }
      if (!dep.base.support.supported) {
        skipped.push({ name: c.name, reasons: dep.base.support.reasons.map((r) => `base: ${r}`) });
        continue;
      }
      base = dep.base;
      const known = new Map([...dep.base.manifest.files, ...c.manifest.files].map((f) => [f.sha256, f]));
      files = dep.files.map((f) => known.get(f.sha256)!).filter(Boolean);
    }
    const runs = base ?? c;
    models.push({
      id: c.modelId,
      name: c.name,
      description: c.manifest.description,
      publisher: trust.label(c.pubkey),
      release: c,
      ...(base ? { base } : {}),
      files,
      tasks: c.support.executableOperations.filter((t) => c.manifest.capabilities.includes(t)),
      chat: (runs.manifest.runtime.chat_template?.source ?? 'embedded') !== 'none',
      license: c.manifest.license.id,
      createdAt: created.get(c.eventId) ?? 0,
    });
  }
  return { models: assignIds(mergeIdentical(models)), router, skipped };
}

/** Byte-identical models that do the same tasks are one model, whoever re-published them. */
function mergeIdentical(models: LocalModel[]): LocalModel[] {
  const seen = new Map<string, LocalModel>();
  for (const m of [...models].sort((a, b) => a.createdAt - b.createdAt || (a.release.eventId < b.release.eventId ? -1 : 1))) {
    const key = `${m.files.map((f) => f.sha256).sort().join()}|${m.tasks.join()}|${m.release.manifest.kind}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

/** model_id, unless two publishers use the same one (or it's `auto`): then model_id@publisher-key-start. */
function assignIds(models: LocalModel[]): LocalModel[] {
  const count = new Map<string, number>();
  for (const m of models) count.set(m.id, (count.get(m.id) ?? 0) + 1);
  return models
    .map((m) => ((count.get(m.id) ?? 0) > 1 || m.id === AUTO_ID ? { ...m, id: `${m.id}@${m.release.pubkey.slice(0, 8)}` } : m))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Bytes still to download for these files. */
export const missingBytes = (files: { sha256: string; size: number }[], has: (sha256: string, size: number) => boolean) =>
  files.filter((f) => !has(f.sha256, f.size)).reduce((n, f) => n + f.size, 0);

export const totalBytes = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);
