// Runtime capability detection and per-release support checks. Kept free of
// wllama imports so the catalog UI and orchestrator can use it cheaply.
import { OPERATION_CONTRACTS, operationMatchesContract, type ReleaseManifest } from '@wexare/protocol';

export const RUNTIME_FAMILY = 'wllama';
export const RUNTIME_FORMAT = 'gguf';
/** Pinned runtime version; keep in sync with @wllama/wllama in package.json (checked by a unit test). */
export const WLLAMA_VERSION = '3.8.1';
/** Versions on which the adapter-mount workaround was validated (docs/runtime-compatibility.md). */
export const ADAPTER_VALIDATED_VERSIONS = ['3.8.1'];

export interface RuntimeCapabilities {
  runtime: string;
  version: string;
  features: Record<string, boolean>;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  adapterExecution: { supported: boolean; reason: string };
}

const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function detectCapabilities(): RuntimeCapabilities {
  const g = globalThis as typeof globalThis & { crossOriginIsolated?: boolean };
  const wasm = typeof WebAssembly === 'object';
  let simd = false;
  try {
    simd = wasm && WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  const threads = !!g.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const features: Record<string, boolean> = {
    wasm,
    'wasm-simd': simd,
    'wasm-threads': threads,
    webgpu: !!nav && 'gpu' in nav,
    opfs: !!nav?.storage && typeof nav.storage.getDirectory === 'function',
  };
  const adapterOk = ADAPTER_VALIDATED_VERSIONS.includes(WLLAMA_VERSION);
  return {
    runtime: RUNTIME_FAMILY,
    version: WLLAMA_VERSION,
    features,
    crossOriginIsolated: !!g.crossOriginIsolated,
    hardwareConcurrency: nav?.hardwareConcurrency ?? 1,
    adapterExecution: adapterOk
      ? { supported: true, reason: `validated on wllama ${WLLAMA_VERSION} via the adapter-mount workaround` }
      : { supported: false, reason: 'Adapter execution unavailable in this runtime' },
  };
}

/** Minimal semver range check for requirements like ">=3.8.1 <3.9.0", "^3.8.1", "3.8.1" or "*". */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number(n));
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const v = parse(version);
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => {
    if (p === '*' || p === 'x') return true;
    const m = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/.exec(p);
    if (!m) return false;
    const target = parse(m[2]!);
    const c = cmp(v, target);
    switch (m[1]) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '^': return c >= 0 && v[0] === target[0] && (target[0] !== 0 || v[1] === target[1]);
      case '~': return c >= 0 && v[0] === target[0] && v[1] === target[1];
      default: return c === 0;
    }
  });
}

export interface SupportResult {
  supported: boolean;
  reasons: string[];
  /** Operation IDs this client can execute for the release. */
  executableOperations: string[];
}

/** Can this client execute the release? Metadata found ≠ files verified ≠ runtime supported ≠ quality evaluated. */
export function checkReleaseSupport(m: ReleaseManifest, caps: RuntimeCapabilities): SupportResult {
  const reasons: string[] = [];
  if (m.labels?.includes('synthetic')) reasons.push('synthetic record: never runnable');
  if (m.runtime.format !== RUNTIME_FORMAT) reasons.push(`format ${m.runtime.format} is not supported (this client runs ${RUNTIME_FORMAT})`);
  if (m.runtime.family !== caps.runtime) reasons.push(`runtime family ${m.runtime.family} is not supported (this client bundles ${caps.runtime})`);
  else if (!satisfies(caps.version, m.runtime.requirement)) reasons.push(`requires ${caps.runtime} ${m.runtime.requirement}; bundled ${caps.version}`);
  for (const f of m.runtime.browser_features) if (!caps.features[f]) reasons.push(`browser feature ${f} unavailable`);
  if (m.files.some((f) => f.locations.length === 0)) reasons.push('a required file has no retrieval location');
  if (m.kind === 'lora' && !caps.adapterExecution.supported) reasons.push(caps.adapterExecution.reason);
  const executableOperations = m.operations.filter((op) => OPERATION_CONTRACTS[op.id] && operationMatchesContract(op)).map((op) => op.id);
  if (m.operations.length && executableOperations.length === 0) reasons.push('no operation matches a bundled contract');
  if (m.operations.length === 0) reasons.push('no executable operations declared');
  return { supported: reasons.length === 0, reasons, executableOperations };
}
