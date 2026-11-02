# Acceptance checklist (spec §14)

Each criterion links to the automated test that checks it. The status records what has actually been
run, where and when. Machine-readable evidence from each run is written to `tests/results/<ID>.json`.

**Environment of the runs below (2026-11-01):** Ubuntu 24.04 VM, x86_64, 4 vCPU, 7.8 GiB RAM, no
GPU; Docker 29.1.3 running strfry `1.1.2-148-g4cd3cf6` ×2, Kubo 0.43.1 ×2 and the WebSocket tracker
from `infra/`; Chromium headless shell 156.0.8078.4 (Playwright 1.64.1); Node 22.22.2; wllama 3.8.1.
This is **not** the reference Apple Silicon laptop. Real-model evidence on that hardware is still
required before P0 can be declared complete (spec §14).

Final runs: `pnpm test` (85 unit tests), `pnpm vitest run --project integration` (10 tests, Arweave
included), `pnpm test:e2e` (19 tests) and `pnpm test:models` (6 tests). All passed.

| ID | Criterion | Automated check | Status and evidence |
| --- | --- | --- | --- |
| A01 | One-repo setup | README quick start | ✅ On this VM, following the README literally: `pnpm install`, `infra:up` (relays, Kubo and tracker healthy; Kubo B connected to A), `demo:prepare` (4 min 35 s, including 10,000 synthetic signatures), `pnpm dev`, `demo:publish`, and `catalog:build`. The indexer collected 99 releases and rejected the altered manifest. The snapshot of 99 records was pinned, mirrored, seeded and announced to both relays. Relay B's coverage is `possibly-incomplete` because of the A17 records the e2e run leaves there. `build` and every test command also ran. **Clean-clone run on a second machine ⏳** |
| A02 | Real signed publication | [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts), [`integration/relays`](../tests/integration/relays.test.ts) | ✅ A freshly generated publisher's release was `accepted` by relay A and relay B, reported separately. A republish returned `duplicate` from both. A clean browser verified the signature and manifest hash and showed "2 relays". |
| A03 | Correct tag queries | Unit (20 golden queries), [`integration/relays`](../tests/integration/relays.test.ts), [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts) | ✅ A real relay returns the union for one `#t` filter (tiny-summarizer matches a classification+summarization OR query). Locally, classification ∩ summarization = 1 release, summarization = 4, and an impossible pair = 0. |
| A04 | Durable indexing | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts), unit collector tests | ✅ Each fixture release is one row with observations `relay:…7777` and `relay:…7778`. The altered-manifest event was rejected (`manifest_hash_mismatch`). Restart: 95 releases and 95 events before and after; the reconnect overlap only produced duplicates. |
| A05 | Archive round trip | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) | ✅ A snapshot of 92 records was built from the indexer, signed by a fresh builder key, and published with IPFS, mirror and torrent locations. A clean browser recovered exactly the indexer's release-ID set. Browser calls to an indexer API: none. |
| A06 | Real torrent transfer | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) (web seeds disabled) | ✅ Transport `torrent`: 159,677 bytes from WebRTC peers and 0 from HTTP web seeds. The seeder reported 159,677 bytes uploaded over `webrtc`. |
| A07 | IPFS retrieval | [`e2e/03`](../tests/e2e/03-downloads.spec.ts), [`integration/storage`](../tests/integration/storage.test.ts) | ✅ With the HTTP mirrors unreachable, story-base (70.1 MiB) came from `http://127.0.0.1:8080/ipfs/bafybeigg2m7…` and was verified in the browser. In Node, the bytes matched the manifest through Kubo A and through Kubo B's pinned replica. |
| A08 | Local search | [`e2e/04`](../tests/e2e/04-search-offline.spec.ts) | ✅ 10,000 records: verification 20.5 s, commit 6.8 s, database 54.0 MiB. After a reload, with networking off, the warm queries were: all records 120 ms, FTS "heron" 23 ms, prefix "summar" 55 ms, capability intersection 16 ms, FTS + capability 23 ms. The target is under 500 ms. |
| A09 | Invalid data | Unit vectors, [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts), [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) | ✅ Live: `manifest_hash_mismatch` was shown and the release was never stored. Archives rejected: `archive_hash_mismatch` (one flipped byte), `archive_path_traversal` (`../evil.txt`), `archive_too_large` (declared size), `archive_malformed`, and a forged announcement. Catalog statistics were identical before and after. |
| A10 | File fallback | [`e2e/03`](../tests/e2e/03-downloads.spec.ts) | ✅ The corrupted primary (368.5 MiB) was rejected with `SHA-256 mismatch`, then the next source verified. A cached file altered after verification failed re-verification before loading: nothing was loaded and the file was evicted. |
| A11 | Real inference | [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ on the VM: Qwen2.5-0.5B Q4_K_M (`74a4da8c…`) gave `maintenance` and SmolLM2-360M Q8_0 (`48ab3034…`) gave "Water leak near entrance.", in 54 s. The Spanish sample was routed to Qwen for both stages, because SmolLM2 declares only `en`. Runtime: wllama 3.8.1, multithreaded (3 threads), CPU/WASM. **Reference laptop ⏳** |
| A12 | Dynamic composition | [`e2e/06`](../tests/e2e/06-composition.spec.ts), [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ Choosing Qwen for summarization changed the plan and the executed trace (`0db4e379…` → `7331bb53…`). Both stage outputs appear in the result. The unknown-runtime release is listed but disabled, with its reason. Missing stages are shown as "missing" and the Run button is disabled. |
| A13 | LoRA handling | [`e2e/03`](../tests/e2e/03-downloads.spec.ts) | ✅ The adapter and its exact base were downloaded and verified. The wrong-base adapter was blocked: "declared base weights c7aa6863… are not part of the base release". Adapter execution is reported as supported only on wllama 3.8.1, where A18 passes. |
| A14 | Offline reload | [`e2e/04`](../tests/e2e/04-search-offline.spec.ts), [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ Offline reload with networking off: search worked, the stories15M run worked, and the two-stage workflow completed. 17 requests, all served by the service worker; 0 external, 0 failed. |
| A15 | Operator replacement | [`e2e/05`](../tests/e2e/05-operator-b.spec.ts) | ✅ A second indexer and builder ran with its own key, data directory, port 8794 and mirror root. A clean browser found the announcement by event ID on the relays, verified it and imported 95 records. The exported configuration names the new builder and holds no key material, and a second browser imported that file. |
| A16 | Relay failure | [`e2e/07`](../tests/e2e/07-relay-failure.spec.ts) | ✅ With relay A stopped, its publish outcome was `disconnected` and relay B's `accepted`; a clean browser discovered the release through relay B. With both relays stopped, archive search still found the records after a reload. |
| A17 | Bounded collection | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts), unit collector tests | ✅ Relay B (limit 50) held 60 records sharing one timestamp. An indexer watching only relay B collected 70 of 80 and recorded "response limit (50) reached with every event at created_at=1767225600; more may exist". With both relays it recovered 80 of 80, with coverage relay A `caught-up` and relay B `possibly-incomplete`, never claiming completeness. |
| A18 | Runtime LoRA (P1) | [`models/lora`](../tests/models/lora.spec.ts) | ✅ The base `1240dfc1…` and the adapter `d1e0617d…` were both re-verified, then loaded unmerged. Scale 1 produced " in love of the eye: That's when when the eye see thy on the sun's shining bright"; scale 0 produced " was a little girl. She was only three years old…". The native log shows `llama_adapter_lora_init: loading lora adapter from '/models/wexare-adapter-0.gguf'`. |
| — | Prompts and outputs stay local | [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ None of the 3 sample inputs or 3 summaries appeared in any of 25 HTTP requests or any WebSocket frame. HTTP hosts: `localhost:4173` (the app) and `127.0.0.1:8790` (the mirror). WebSocket hosts: the two relays. |
| — | Arweave `ar://` resolution | [`integration/arweave`](../tests/integration/arweave.test.ts) | ✅ `ar://Edj83od3…` resolved through arweave.net: 1,047 bytes, SHA-256 verified, CORS present. |

## Beyond the spec: System 1 routing (2026-11-02)

| Check | Automated check | Status and evidence |
| --- | --- | --- |
| Routing rules | [`packages/router`](../packages/router/test/router.test.ts) (unit, 19) | ✅ Covered steps go to a local model even with online help on. A step no local model covers goes online only when allowed, otherwise it is reported unavailable and the loop continues. An unsure first step is confirmed with the person; an unsure later step is not started. Models download without a question unless the host adds a confirmation step, and a failed download is explained in its step. Steps never repeat, and the loop stops at three. The OpenAI-compatible request has the intent as its system message, and errors never contain the key. |
| Router release | `pnpm demo:prepare` / `demo:publish` | ✅ `laya-router`: four files verified against hashes pinned to `wexare/laya-onnx@2ac71766`, mirrored, pinned on Kubo A and B, and seeded as torrents. Accepted by both relays. Existing releases kept their event IDs. |
| Ask and online-help screens | [`e2e/10`](../tests/e2e/10-ask.spec.ts) | ✅ The first request starts the router download (904 MB) without a question; **Stop** cancels it and nothing is saved. The test holds the download and blocks the router's worker, so the router never loads on the build VM. Online help is off by default, survives a reload in the same browser, never shows the key, changes the footer and tagline, and saving it contacts no online service. |
| Real routing decisions | [`integration/router-laya`](../tests/integration/router-laya.test.ts) (opt-in) | ⏳ **Not run.** Laya fp16 needs more than 3 GB in ONNX Runtime's WebAssembly heap. On the 8 GB build VM, an uncapped attempt exhausted memory, and capped attempts were stopped at 3 GB (fp16) and 2.5 GB (8-bit export). Run with `WEXARE_TEST_LAYA=1` on a larger machine. |
| Ask end to end with real models | [`models/router`](../tests/models/router.spec.ts) (opt-in) | ⏳ **Not run**, for the same reason. The user reported a manual run working on a Mac (2026-11-02). |
| Space for saved models | [`packages/storage`](../packages/storage/test/eviction.test.ts) (unit, 9), [`e2e/11`](../tests/e2e/11-space.spec.ts) | ✅ The least recently used models are removed first, one model's files together, never kept files, and nothing for a download that wouldn't fit anyway. A model larger than the limit still downloads after everything else is removed. A lower limit trims saved models down to it (the rule; choosing a lower limit in Settings isn't checked in the browser). In the browser, with a 400 MB limit, the story model (73 MB) was used, then the summarizer (386 MB): the story model was removed ("73 MB download"), the summarizer stayed ready, and Settings showed "Saved models take 386 MB". A new limit survives a reload. |

## Observations

- **Model quality is not evaluated.** The tests check execution and the output contracts, not the
  model's judgement (spec §14). Qwen2.5-0.5B classified the loud-music sample as `maintenance`;
  the fixture lists `noise` as representative. Its summary of that sample was close to a copy of the
  input.
- **Bugs found by these runs and fixed:**
  - after a reload, the catalog fell back to memory, and sqlite's default deletes the OPFS pool when it
    fails to open;
  - warm searches over 10,000 records were slow;
  - built operator binaries didn't start;
  - a browser that announced a torrent before the seeder registered never connected;
  - offline, the service worker missed every asset because of `Vary: Origin`;
  - an approved plan switched releases mid-download.

## Running the checks

```sh
pnpm test                                    # unit
pnpm infra:up && pnpm demo:prepare           # once
pnpm test:e2e                                # A02–A10, A12–A17 (tiny real model only)
pnpm vitest run --project integration        # Node-side checks against the same services
pnpm test:models                             # A11, A12 execution, A14 two-stage, A18, privacy
```

## Recording a reference-hardware run

On the reference laptop, run `pnpm test:models` with a headed browser
(`pnpm --filter @wexare/tests exec playwright test --project models --headed`), or follow
[demo-script.md](demo-script.md) steps 7 and 9 by hand. Then copy the browser version, the hardware,
`tests/results/A11.json`, `A14.json` and `A18.json`, and the exact files and timings from the
execution trace into this table.

## Not implemented (P1)

- Arweave uploads and funding. Only the resolution of `ar://` references is implemented.
- Incremental or sharded catalog updates. Each snapshot is a full archive.
- Browser publishing with a Nostr signer. Publishing is CLI-only.
- Additional runtimes and formats (ONNX, MLC). These releases are listed but marked unsupported.
