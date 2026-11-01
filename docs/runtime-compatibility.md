# Runtime compatibility report

Spec §2 (LoRA compatibility gate) and §15 step 1. Raw spike output lives in
[`docs/compat/`](compat/); rerun with `pnpm --filter @wexare/tests spike [lora|smollm|qwen]`.

## Selected runtime

| Item | Value |
| --- | --- |
| Runtime | `@wllama/wllama` **3.8.1** (llama.cpp compiled to WASM; single build with optional pthreads and WebGPU) |
| WASM asset | `@wllama/wllama/esm/wasm/wllama.wasm`, bundled into the web build (no CDN) |
| Format | GGUF only. Other formats (ONNX, safetensors, MLC) are not supported. |

## Spike environment (2026-10-31)

| Item | Value |
| --- | --- |
| Browser | Chromium headless shell 156.0.8078.4 (Playwright 1.64.1) |
| OS / hardware | Ubuntu 24.04 VM, x86_64, 4 vCPU, 7.8 GiB RAM, virtio GPU (no WebGPU adapter) |
| Isolation | COOP `same-origin` + COEP `require-corp` → `crossOriginIsolated = true`, SharedArrayBuffer available |
| Threads | wllama default `n_threads = hardwareConcurrency / 2` = 2; `isMultithread() = true` |
| GPU | `n_gpu_layers: 0` (CPU). WebGPU `requestAdapter()` returned null on this VM. |

This is **not** the spec's reference Apple Silicon laptop. Real-model acceptance there is still
outstanding; see the acceptance checklist.

## Results

### Standalone inference

| Model file (SHA-256 prefix) | Probe | Result |
| --- | --- | --- |
| `smollm2-360m-instruct-q8_0.gguf` (`48ab3034…`) | chat, 55 prompt + 16 completion tokens, greedy | OK. Load 4.3 s, generate 12.0 s. Embedded ChatML template used. |
| `qwen2.5-0.5b-instruct-q4_k_m.gguf` (`74a4da8c…`) | chat + `response_format: json_schema` enum | OK: `{"category": "maintenance"}`. Load 6.1 s, generate 21.4 s. Embedded Qwen template used. |

Both models load from in-memory `Blob`s that the page fetched itself, so wllama's own downloader and
cache are bypassed. Constrained decoding (`response_format.json_schema` and `grammar`) is available.

### LoRA gate: base `stories15M_MOE-F16.gguf` (`1240dfc1…`) + adapter `moe_shakespeare15M.gguf` (`d1e0617d…`)

Prompt `Look in thy glass`, greedy (`temperature: 0, top_k: 1`), 24 tokens:

| Mode | Output | Matches upstream README |
| --- | --- | --- |
| Base only | ` was a little girl. She was only three years old and she was three years old. …` | yes ("Original model generates") |
| Adapter applied at load (`lora_adapters`, scale 1) | ` in love of the eye:\nThat's when when the eye see thy on the sun's shining bright` | yes ("LoRA adapter generates") |
| Loaded with `lora_init_without_apply`, request `lora: [{id: 0, scale: 0}]` | base text | yes |
| Same context, request `lora: [{id: 0, scale: 1}]` | adapter text | yes |
| Same context, request without `lora` field (after a scale-1 request) | adapter text: the previous per-request scale persists | n/a |

The native log confirms activation:
`llama_adapter_lora_init: loading lora adapter from '/models/wexare-adapter-0.gguf'`, followed by the
adapter's GGUF metadata (`general.type = adapter`, `adapter.type = lora`).

### What wllama 3.8.1 exposes, and what it does not

- **Exposed:** `LoadModelParams.lora_adapters: {path, scale}[]` and `lora_init_without_apply`, passed
  through to llama.cpp `common_params.lora_adapters`.
- **Undeclared but working:** the per-request `lora: [{id, scale}]` field. wllama forwards request
  options as JSON to the embedded llama.cpp server context. It is not in wllama's TypeScript types.
- **Missing:** no public way to place an adapter file in the WASM filesystem. `loadModel(blobs)` mounts
  every non-mmproj blob as a model shard (`model-0000i-of-0000N.gguf`) and passes all of them to llama.cpp
  as a split model.
- **Workaround used by `@wexare/runtime`:** intercept assignment of the private `Wllama#proxy` field and
  wrap `ProxyToWorker#moduleInit` to append the adapter blob as `/models/wexare-adapter-<n>.gguf`. This
  depends on wllama internals, so the runtime package checks the exact wllama version and the presence of
  the interception point before enabling adapter execution. If the check fails, verified adapters show
  **"Adapter execution unavailable in this runtime"**.

### Gate decision

**Passed, with the private-API workaround above.** P1 browser adapter execution is implemented for
wllama 3.8.1 only. Upgrading wllama requires rerunning `pnpm --filter @wexare/tests spike lora`.
