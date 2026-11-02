// The System 1 model is itself a catalog release: an ONNX export of Laya,
// runnable only by clients that bundle @wexare/laya-web. This decides whether
// a release is one, picks the best available, and maps its verified files
// onto the bundle shape the library loads.
import { satisfies } from '@wexare/runtime/support';
import type { CandidateRelease } from '@wexare/orchestrator';
import type { ManifestFile, ReleaseManifest } from '@wexare/protocol';

export const ROUTING_CAPABILITY = 'intent-routing';
/** The @wexare/laya-web version this client bundles. */
export const LAYA_WEB_VERSION = '0.1.1';

export interface RouterFiles {
  weights: ManifestFile;
  tokenizer: ManifestFile;
  tokenizerConfig: ManifestFile;
  config: ManifestFile;
}

/** The four files a Laya bundle is made of, by role and name. */
export function routerFiles(m: ReleaseManifest): RouterFiles | null {
  const find = (role: ManifestFile['role'], test: (path: string) => boolean) => m.files.find((f) => f.role === role && test(f.path));
  const weights = find('weights', (p) => p.endsWith('.onnx'));
  const tokenizer = find('tokenizer', (p) => p === 'tokenizer.json');
  const tokenizerConfig = find('tokenizer', (p) => p === 'tokenizer_config.json');
  const config = find('config', (p) => p === 'rl_agent_config.json');
  return weights && tokenizer && tokenizerConfig && config ? { weights, tokenizer, tokenizerConfig, config } : null;
}

export function routerSupport(m: ReleaseManifest, features: Record<string, boolean>): { supported: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (m.labels?.includes('synthetic')) reasons.push('synthetic record');
  if (m.kind !== 'model') reasons.push('not a model release');
  if (!m.capabilities.includes(ROUTING_CAPABILITY)) reasons.push(`does not declare ${ROUTING_CAPABILITY}`);
  if (m.runtime.format !== 'onnx') reasons.push(`format ${m.runtime.format} is not onnx`);
  if (m.runtime.family !== 'laya') reasons.push(`runtime family ${m.runtime.family} is not laya`);
  else if (!satisfies(LAYA_WEB_VERSION, m.runtime.requirement)) reasons.push(`requires laya ${m.runtime.requirement}; bundled ${LAYA_WEB_VERSION}`);
  for (const f of m.runtime.browser_features) if (!features[f]) reasons.push(`browser feature ${f} unavailable`);
  if (!routerFiles(m)) reasons.push('missing weights, tokenizer or config file');
  if (m.files.some((f) => f.locations.length === 0)) reasons.push('a required file has no retrieval location');
  return { supported: reasons.length === 0, reasons };
}

const bytes = (r: CandidateRelease) => r.manifest.files.reduce((n, f) => n + f.size, 0);

/** Already downloaded first, then the newest version, then the smaller download. */
export function pickRouter(candidates: CandidateRelease[], features: Record<string, boolean>, isCached: (sha256: string) => boolean): CandidateRelease | null {
  const ready = (r: CandidateRelease) => r.manifest.files.every((f) => isCached(f.sha256));
  const usable = candidates.filter((c) => routerSupport(c.manifest, features).supported);
  usable.sort(
    (a, b) =>
      Number(ready(b)) - Number(ready(a)) ||
      b.version.localeCompare(a.version, undefined, { numeric: true }) ||
      bytes(a) - bytes(b) ||
      (a.eventId < b.eventId ? -1 : 1),
  );
  return usable[0] ?? null;
}

/** Same shape as @wexare/laya-web's `Bundle`. */
export interface LayaBundle {
  id: string;
  label: string;
  devices: ('webgpu' | 'wasm')[];
  url: string;
  bytes: number;
  precision: string;
  tokenizerUrl: string;
  tokenizerConfigUrl: string;
  configUrl: string;
  source: string;
  maxOptions: number | null;
}

/** A Laya bundle whose four files are read from `urlFor(sha256)` (verified local copies). */
export function layaBundle(release: CandidateRelease, urlFor: (sha256: string) => string): LayaBundle {
  const files = routerFiles(release.manifest);
  if (!files) throw new Error('not a Laya release');
  return {
    id: `wexare:${release.eventId}`,
    label: release.name,
    devices: ['webgpu', 'wasm'],
    url: urlFor(files.weights.sha256),
    bytes: files.weights.size,
    precision: 'as published',
    tokenizerUrl: urlFor(files.tokenizer.sha256),
    tokenizerConfigUrl: urlFor(files.tokenizerConfig.sha256),
    configUrl: urlFor(files.config.sha256),
    source: `weXare release ${release.eventId.slice(0, 12)}…`,
    maxOptions: null,
  };
}
