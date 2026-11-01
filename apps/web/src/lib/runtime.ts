import wllamaWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
// Compat build for browsers without JSPI/MEMORY64 (e.g. Safari), bundled so no CDN is ever needed.
import compatWorkerUrl from '@wllama/wllama-compat/wasm/wllama.js?url';
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';
import { WllamaRuntime, choiceGrammar, checkReleaseSupport, detectCapabilities, type RuntimeCapabilities } from '@wexare/runtime';
import type { CandidateRelease } from '@wexare/orchestrator';
import type { ReleaseManifest } from '@wexare/protocol';
import type { CandidateRow } from '../workers/catalog-api.ts';

export const capabilities: RuntimeCapabilities = detectCapabilities();
/** One resident model at a time; wllama runs llama.cpp in its own worker. */
export const runtime = new WllamaRuntime(wllamaWasmUrl, { worker: compatWorkerUrl, wasm: compatWasmUrl });
export { choiceGrammar };

export function toCandidate(row: CandidateRow): CandidateRelease {
  const manifest = JSON.parse(row.manifestJson) as ReleaseManifest;
  return {
    eventId: row.eventId,
    pubkey: row.pubkey,
    modelId: manifest.model_id,
    name: manifest.name,
    version: manifest.version,
    manifestSha256: row.manifestSha256,
    manifest,
    support: checkReleaseSupport(manifest, capabilities),
  };
}
