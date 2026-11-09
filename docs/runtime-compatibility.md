# Runtime compatibility report

Which browser runtime modelXare uses to run models, and whether it can run a LoRA adapter on top of
its base model without merging them. These results come from a small spike page that loads real
models in the runtime before the app depended on it. Raw spike output lives in
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
| OS / hardware | Ubuntu 24.04 virtual machine, x86_64, 4 vCPU, 7.8 GiB RAM, virtio GPU (no WebGPU adapter) |
| Isolation | COOP `same-origin` + COEP `require-corp` → `crossOriginIsolated = true`, SharedArrayBuffer available |
| Threads | wllama default `n_threads = hardwareConcurrency / 2` = 2; `isMultithread() = true` |
| GPU | `n_gpu_layers: 0` (CPU). WebGPU `requestAdapter()` returned null on this machine. |

Results on other hardware, such as an Apple Silicon Mac, are still to be recorded; see
[acceptance.md](acceptance.md#recording-a-run-on-other-hardware).

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

**Passed, with the private-API workaround above.** Browser adapter execution is implemented for
wllama 3.8.1 only. Upgrading wllama requires rerunning `pnpm --filter @wexare/tests spike lora`.

## App-level results (2026-11-01, same machine)

These are measured inside the developer app through `pnpm test:models`, not in the spike page. Files come
from the verified OPFS cache and are re-hashed before every load.

| Run | Releases (classification → summarization) | Result | Wall time |
| --- | --- | --- | --- |
| English water-leak sample (earlier building-complaint samples) | Qwen2.5-0.5B Q4_K_M → SmolLM2-360M Q8_0 | `maintenance`; "Water leak near entrance." | 54.0 s, including both model loads |
| Spanish water-leak sample | Qwen → Qwen (SmolLM2 declares only `en`) | `maintenance`; "La residente ha notado una fuga de agua en la entrada." | 45.4 s |
| English sample, summarization switched to Qwen | Qwen → Qwen (resident model reused) | `maintenance`; "A water leak has been found near the entrance." | 19.5 s |
| Loud-music sample, offline after reload | Qwen → SmolLM2 | `maintenance`, where `noise` was expected; summary close to a copy of the input | 57.6 s |
| LoRA (one-model mode) | stories15M MoE F16 + Shakespeare adapter, scale 1 / 0 | Matches upstream for both scales; native adapter log captured | load 3.1 s, generate 2.0 s |

The runtime loaded with 3 threads (multithreaded, cross-origin isolated) on 4 logical cores. It
reports `webgpu ✓` as a browser feature, but runs CPU/WASM only (`n_gpu_layers: 0`). Classification
uses the bundled contract's choice grammar, so the output is always a valid category; whether that
category is right is a model-quality question, outside the acceptance checks.
