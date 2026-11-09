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
| A16 | Relay failure | [`e2e/07`](../tests/e2e/07-relay-failure.spec.ts) | ✅ With relay A stopped, its publish outcome was `disconnected` and relay B's `accepted`; a clean browser discovered the release through relay B. With both relays stopped, archive search still found the records after a reload. The app reconnects on its own (2026-11-07): opened with both relays down, both turned live once started, with no reload; after both were stopped and started again while it was open, it found a release published in the meantime. |
| A17 | Bounded collection | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts), unit collector tests | ✅ Relay B (limit 50) held 60 records sharing one timestamp. An indexer watching only relay B collected 70 of 80 and recorded "response limit (50) reached with every event at created_at=1767225600; more may exist". With both relays it recovered 80 of 80, with coverage relay A `caught-up` and relay B `possibly-incomplete`, never claiming completeness. |
| A18 | Runtime LoRA (P1) | [`models/lora`](../tests/models/lora.spec.ts) | ✅ The base `1240dfc1…` and the adapter `d1e0617d…` were both re-verified, then loaded unmerged. Scale 1 produced " in love of the eye: That's when when the eye see thy on the sun's shining bright"; scale 0 produced " was a little girl. She was only three years old…". The native log shows `llama_adapter_lora_init: loading lora adapter from '/models/wexare-adapter-0.gguf'`. |
| — | Prompts and outputs stay local | [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ None of the 3 sample inputs or 3 summaries appeared in any of 25 HTTP requests or any WebSocket frame. HTTP hosts: `localhost:4173` (the app) and `127.0.0.1:8790` (the mirror). WebSocket hosts: the two relays. |
| — | Arweave `ar://` resolution | [`integration/arweave`](../tests/integration/arweave.test.ts) | ✅ `ar://Edj83od3…` resolved through arweave.net: 1,047 bytes, SHA-256 verified, CORS present. |

## Beyond the spec: System 1 routing (2026-11-02)

| Check | Automated check | Status and evidence |
| --- | --- | --- |
| Routing rules | [`packages/router`](../packages/router/test/router.test.ts) (unit, 25) | ✅ The instruction is split off the message (a colon near the start, or a first question followed by more text; not times or links), and split into the tasks it names. System 1 reads each task on its own, so a request for two things runs both, in the order asked, and the message is never read. A part that isn't a task is skipped. Without an instruction, or with no clear part, the whole request is read. When nothing is clear, the person picks. Planned steps show as waiting before the first runs. Local models get the message, online help gets the whole request. Covered steps go to a local model even with online help on, and a model an earlier step downloaded is reused. A step no local model covers goes online only when allowed, otherwise it is reported unavailable and the rest still run. Models download without a question unless the host adds a confirmation step, and a failed download is explained in its step. At most three steps run, the first ones asked for. The OpenAI-compatible request has the intent as its system message, and errors never contain the key. |
| Router release | `pnpm demo:prepare` / `demo:publish` | ✅ `laya-router`: four files verified against hashes pinned to `wexare/laya-onnx@2ac71766`, mirrored, pinned on Kubo A and B, and seeded as torrents. Accepted by both relays. Existing releases kept their event IDs. |
| Ask and online-help screens | [`e2e/10`](../tests/e2e/10-ask.spec.ts) | ✅ The first request starts the router download (904 MB) without a question; **Stop** cancels it and nothing is saved. The test holds the download and blocks the router's worker, so the router never loads on the build VM. Online help is off by default, survives a reload in the same browser, never shows the key, changes the footer and tagline, and saving it contacts no online service. |
| Real routing decisions | [`integration/router-laya`](../tests/integration/router-laya.test.ts) (opt-in) | ✅ **27 of 27 with native ONNX Runtime**, ⏳ not run in WebAssembly. The real router release (Laya fp16) and the real `route()` planned all 27 requests correctly (2026-11-02), including the reported "Categorize and Summarize this message: …" ("Categorize" → sort 0.99, "Summarize this message" → summarize 1.00), two requests whose message names other tasks, and one asking for three things. A 28th request is a known miss and isn't in the test: "Classify this complaint" reads as summarize (0.78), not sort. The test itself loads Laya in WebAssembly, which needs more than 4.6 GB (stopped by the memory cap on the 8 GB build VM), so the numbers come from the same files run with `onnxruntime-node` in a scratch script, one sequence at a time (2.5 GB peak). Run the test with `WEXARE_TEST_LAYA=1` on a larger machine. 2026-11-09: **27 of 27 again with `WEXARE_TEST_LAYA=native`**, the local runtime's own native router (`apps/local/src/laya.ts`), in 49 s under a 3.5 GB cap. Then 27 of 27 once more (48 s) after sort's description changed to everyday topics and the two Try examples changed (see [Everyday examples](#everyday-examples-2026-11-09)). |
| Ask end to end with real models | [`models/router`](../tests/models/router.spec.ts) (opt-in) | ⏳ **Not run**, for the same reason. The user reported a manual run working on a Mac (2026-11-02). |
| Front page | [`e2e/13`](../tests/e2e/13-landing.spec.ts) | ✅ The front page (`#/`) plays the before and after as the page scrolls (today, what if, with modelXare) and plays one request through System 1 and System 2 (the router's real verdicts for it, then the two catalog models that sort and summarize), and leads to the app (`#/try`) and back. With reduced motion it shows the before and after side by side, and nothing stays hidden. 2026-11-08: 6 of 6 passed with `e2e/09`, `10` and `12`, which now start from `#/try`, and `e2e/11` 4 of 4. |
| Space for saved models | [`packages/storage`](../packages/storage/test/eviction.test.ts) (unit, 9), [`e2e/11`](../tests/e2e/11-space.spec.ts) | ✅ The least recently used models are removed first, one model's files together, never kept files, and nothing for a download that wouldn't fit anyway. A model larger than the limit still downloads after everything else is removed. A lower limit trims saved models down to it (the rule; choosing a lower limit in Settings isn't checked in the browser). In the browser, with a 400 MB limit, the story model (73 MB) was used, then the summarizer (386 MB): the story model was removed ("73 MB download"), the summarizer stayed ready, and Settings showed "Saved models take 386 MB". A new limit survives a reload. With a real storage limit set through Chrome DevTools: when the browser overstates its room, the refused download made the least used model go and the retry succeeded. When the browser understates its room (10 MB reported), the 73 MB download still went ahead. With no model to remove, the app said how much the browser had really allowed. Out-of-space errors stop the download instead of trying the next source. |

## Everyday examples (2026-11-09)

The pages' examples moved from building complaints to the texts and emails anyone gets. Sorting now
picks one of nine everyday topics: family, friends, work, money, shopping, travel, health, home and
other. Each prompt lists them with what they cover. Measured with the real Qwen2.5 0.5B release file
(native llama.cpp, CPU, the same choice grammar as the browser):

| Check | Result |
| --- | --- |
| Before: 15 building messages, the published prompt, the six building categories | 3 of 15. It answered "maintenance" every time. |
| After: 24 everyday messages (three per topic, one in Spanish), each topic described | 12 of 24, with the published prompt and with the new one. Without the descriptions, 4 to 5 of 16. |
| Where it still errs | Family, friends and health messages often come out as travel or work. That is a model-quality question, outside acceptance. |
| The pages' examples through `auto` (real router, the published releases, this client) | Front page: "Categorize" sort 0.99, "summarize this message" summarize 0.99, then **Travel** and "Your flight to Lisbon on Friday will leave two hours late at 16:40. Your seat and bags stay the same." Try examples: the bill → **Money** plus a summary; the shoes → **Shopping**. The Spanish flight message gets a Spanish summary. |
| Releases signed with the first category list | They still run. The client accepts that declared output and builds the grammar and checks answers from the current list (protocol unit tests). The published sorting release runs this way until its 1.1.0 definition (`fixtures/releases/community-assistant.json`) is published. |
| Real models through the API | 8 of 8 (`WEXARE_TEST_LOCAL`, 42.7 s). |
| Browser | e2e/01, 05, 06, 07, 09, 10, 12 and 13 pass, 16 tests, against the demo catalog re-signed with the new definition. Unit tests: 180 pass. |

## Local runtime and OpenAI-compatible API (2026-11-09)

`apps/local` (`pnpm modelxare`, [docs/local.md](local.md)) runs the releases with native llama.cpp
(node-llama-cpp 3.22.2) and native ONNX Runtime (1.30.0) on the 8 GB build VM, 4 cores, CPU only
(llama.cpp found Vulkan but no device to offload to).

| Check | Automated check | Status and evidence |
| --- | --- | --- |
| Rules, shapes and guards | [`apps/local/test`](../apps/local/test) (unit, 38) | ✅ OpenAI requests map onto runtime calls and back:<br>• messages, tools, `tool_choice`, `response_format`, sampling, and refusals that name the parameter;<br>• tool results go back inside the turn that called them;<br>• tool schemas become grammar schemas, with local `$ref`s resolved and nothing narrowed to `null`.<br>Catalog: newest version per model, approved publishers only, distinct ids for a shared `model_id`, `auto` reserved, adapters on their exact base, the router only from a key approved for it.<br>Downloads: kept only when size and SHA-256 match, the next location tried after a bad one, resumed with a range request, and a file changed on disk is removed.<br>Server: JSON 404 for unknown paths and other servers' probes; 415 for non-JSON bodies; 403 for foreign origins and non-localhost `Host`; the API key required (except `/health`); preflight only for an allowed origin. |
| Public catalog, real downloads | `pnpm modelxare list` / `pull` | ✅ With `infra/deploy/app.env.example`, `list` read the public relays and found all five weXare releases (nos.lol answered; relay.damus.io refused the connection). `pull tiny-summarizer shakespeare-lora` downloaded 476 MB from Hugging Face. `sha256sum` agreed with every stored file's name. |
| Real models through the API | [`apps/local/test/real-models.test.ts`](../apps/local/test/real-models.test.ts) (opt-in, `WEXARE_TEST_LOCAL`) | ✅ 8 of 8 in 38 s under a 4.5 GB cap:<br>• `/v1/models` lists `auto` and five models with their context (32,768 / 8,192 / 256).<br>• SmolLM2 summarized the elevator message.<br>• Qwen streamed "¡Hola! ¿Cómo estás?" with `finish_reason` `stop`, a usage chunk and `[DONE]`.<br>• Qwen called `get_weather {"city":"Paris"}`, then answered "The current temperature in Paris is 18°C, and it is cloudy." from the tool's result.<br>• A `json_schema` title parsed.<br>• The Shakespeare adapter continued "Look in thy glass".<br>• **`auto`**: System 1 read "Categorize" → sort 0.99 and "summarize this message" → summarize 0.99, then Qwen and SmolLM2 answered "Topic: Maintenance / Summary: …". "What is the capital of France?" read as answer (0.73); no specialist does that, so the general model answered "The capital of France is Paris." |
| Official OpenAI SDK as the client | scratch script (`openai` 7.43.0) | ✅ `models.list`, `chat.completions.create`, a streamed `auto` request with usage, tool calls, and `runTools` running a real tool function to a final answer. An unknown model raised `NotFoundError` 404 `model_not_found`. |
| Memory and speed | `serve` under `systemd-run -p MemoryMax=4500M` | ✅ Peak 3.7 GB with the router and three models loaded. The router loads in 6.8 s and reads in 1.6 to 1.9 s. `auto` with sort and summarize takes 13 to 21 s on a first request (two model loads, files hashed once) and 4.0 s once they are loaded. A client that disconnects mid-stream stops its generation, and the next request was answered 0.4 s later. |
| Agents | none | ⏳ The OpenCode, Hermes Agent and OpenClaw settings in docs/local.md follow their documentation; none of the three was run here. Hermes needs 64K of context for its main model, more than any catalog model has. |

## Observations

- **Model quality is not evaluated.** The tests check execution and the output contracts, not the
  model's judgement (spec §14). Qwen2.5-0.5B classified the loud-music sample as `maintenance`;
  the fixture lists `noise` as representative. Its summary of that sample was close to a copy of the
  input.
- **The router can't be asked yes/no about each task.** An earlier plan asked one yes/no question per
  task about the whole request. On the real router that missed "summarize" in "Categorize and
  Summarize this message: …" (0.16), and added "continue the story" (0.67) and "answer" (0.57) to
  "Write a reply to this tenant: …". Asking about the whole request at once also fails: the
  message sways it ("Summarize this: Can you translate the notice…" read as translate, 0.75). Its
  main-task choice on one short instruction is sharp (0.95 to 1.00 for every task part measured,
  except "Classify this complaint"), which is why the plan reads each part of the instruction.
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
