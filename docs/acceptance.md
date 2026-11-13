# Acceptance checks

These are the checks that show modelXare works end to end: publishing, indexing, archives,
downloads, search, running models, routing and the local API. Each one says what must hold, which
automated test checks it, and the latest recorded result.

The platform checks have IDs, A01 to A18. Test names use them (for example
`test('A10: …')`), and each test run writes its evidence to `tests/results/<ID>.json`.

Model quality is outside these checks. They check that models run and that answers fit the declared
output, not whether an answer is right. [Message sorting](#message-sorting-2026-11-09) reports how
often the current sorting model picks the right topic.

## Test machine

Unless a row says otherwise, results were recorded on a Linux virtual machine: Ubuntu 24.04, x86_64,
4 vCPU, 7.8 GiB RAM, no GPU. The services run in Docker 29.1.3: two strfry relays
(`1.1.2-148-g4cd3cf6`), two Kubo nodes (0.43.1) and the WebSocket tracker from `infra/`. Browser
tests use Chromium headless shell 156.0.8078.4 (Playwright 1.64.1), with Node 22.22.2 and wllama
3.8.1.

Not yet recorded: a clean clone on a second machine, and the real-model checks on other hardware,
such as an Apple Silicon Mac. See [Recording a run on other hardware](#recording-a-run-on-other-hardware).

## Platform checks

Full run on 2026-11-01: `pnpm test` (85 unit tests), `pnpm vitest run --project integration` (10
tests, Arweave included), `pnpm test:e2e` (19 tests) and `pnpm test:models` (6 tests). All passed.
Rows with a later date were run again since.

| ID | Check | Automated check | Latest result |
| --- | --- | --- | --- |
| A01 | **One-repo setup.** Following the README's quick start on a clone installs everything, starts the services, publishes the demo releases and builds a catalog, with no other steps. | README quick start | ✅ Followed literally: `pnpm install`, `infra:up` (relays, Kubo and tracker healthy; Kubo B connected to A), `demo:prepare` (4 min 35 s, including 10,000 synthetic signatures), `pnpm dev`, `demo:publish`, and `catalog:build`. The indexer collected 99 releases and rejected the altered manifest. The snapshot of 99 records was pinned, mirrored, seeded and announced to both relays. Relay B's coverage is `possibly-incomplete` because of the A17 records the e2e run leaves there. `build` and every test command also ran. ⏳ Not yet run from a clean clone on a second machine. |
| A02 | **Real signed publication.** A new publisher's release is signed and sent to every configured relay, and each relay's answer is reported separately. | [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts), [`integration/relays`](../tests/integration/relays.test.ts) | ✅ A freshly generated publisher's release was `accepted` by relay A and relay B, reported separately. A republish returned `duplicate` from both. A clean browser verified the signature and manifest hash and showed "2 relays". |
| A03 | **Correct tag queries.** Asking for several capabilities returns only releases that have all of them, even though a relay's tag filter returns releases with any of them. | Unit (20 golden queries), [`integration/relays`](../tests/integration/relays.test.ts), [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts) | ✅ A real relay returns the union for one `#t` filter (tiny-summarizer matches a classification+summarization OR query). Locally, classification ∩ summarization = 1 release, summarization = 4, and an impossible pair = 0. |
| A04 | **Durable indexing.** The indexer stores each release once, with every relay it was seen on, rejects invalid events, and neither loses nor duplicates anything across a restart. | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts), unit collector tests | ✅ Each fixture release is one row with observations `relay:…7777` and `relay:…7778`. The altered-manifest event was rejected (`manifest_hash_mismatch`). Restart: 95 releases and 95 events before and after; the reconnect overlap only produced duplicates. |
| A05 | **Archive round trip.** A signed catalog snapshot built from the indexer imports into a clean browser with exactly the same releases, and the browser never calls an indexer. | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) | ✅ A snapshot of 92 records was built from the indexer, signed by a fresh builder key, and published with IPFS, mirror and torrent locations. A clean browser recovered exactly the indexer's release-ID set. Browser calls to an indexer API: none. |
| A06 | **Real torrent transfer.** A snapshot can travel to a browser from WebRTC peers alone, with HTTP web seeds turned off. | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) (web seeds disabled) | ✅ Transport `torrent`: 159,677 bytes from WebRTC peers and 0 from HTTP web seeds. The seeder reported 159,677 bytes uploaded over `webrtc`. |
| A07 | **IPFS retrieval.** A model file can come from IPFS alone, and is verified against its manifest. | [`e2e/03`](../tests/e2e/03-downloads.spec.ts), [`integration/storage`](../tests/integration/storage.test.ts) | ✅ With the HTTP mirrors unreachable, story-base (70.1 MiB) came from `http://127.0.0.1:8080/ipfs/bafybeigg2m7…` and was verified in the browser. In Node, the bytes matched the manifest through Kubo A and through Kubo B's pinned replica. |
| A08 | **Local search.** Search over 10,000 records runs in the browser, works offline after a reload, and answers in under 500 ms. | [`e2e/04`](../tests/e2e/04-search-offline.spec.ts) | ✅ 10,000 records: verification 20.5 s, commit 6.8 s, database 54.0 MiB. After a reload, with networking off, the warm queries were: all records 120 ms, FTS "heron" 23 ms, prefix "summar" 55 ms, capability intersection 16 ms, FTS + capability 23 ms. |
| A09 | **Invalid data.** Tampered events and archives are rejected with a clear reason and never change the catalog. | Unit vectors, [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts), [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) | ✅ Live: `manifest_hash_mismatch` was shown and the release was never stored. Archives rejected: `archive_hash_mismatch` (one flipped byte), `archive_path_traversal` (`../evil.txt`), `archive_too_large` (declared size), `archive_malformed`, and a forged announcement. Catalog statistics were identical before and after. |
| A10 | **File fallback.** A file that fails its hash is rejected and the next source is tried, and a cached file is checked again before it loads. | [`e2e/03`](../tests/e2e/03-downloads.spec.ts) | ✅ The corrupted primary (368.5 MiB) was rejected with `SHA-256 mismatch`, then the next source verified. A cached file altered after verification failed re-verification before loading: nothing was loaded and the file was evicted. |
| A11 | **Real inference.** Two different real models run in the browser and sort and summarize a message, and a Spanish message goes to models that declare Spanish. | [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ 2026-11-01, with the earlier sample messages (building complaints): Qwen2.5-0.5B Q4_K_M (`74a4da8c…`) gave `maintenance` and SmolLM2-360M Q8_0 (`48ab3034…`) gave "Water leak near entrance.", in 54 s. The Spanish sample went to Qwen for both steps, because SmolLM2 declares only `en`. Runtime: wllama 3.8.1, multithreaded (3 threads), CPU/WASM. ⏳ Not yet run in the browser with the current everyday samples; the same models handle them through the local runtime (see [Message sorting](#message-sorting-2026-11-09)). |
| A12 | **Dynamic composition.** Choosing another model for a step changes the plan and what runs, and models that can't run are listed with the reason. | [`e2e/06`](../tests/e2e/06-composition.spec.ts), [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ Choosing Qwen for summarization changed the plan and the executed trace (`0db4e379…` → `7331bb53…`). Both stage outputs appear in the result. The unknown-runtime release is listed but disabled, with its reason. Missing stages are shown as "missing" and the Run button is disabled. |
| A13 | **LoRA handling.** An adapter downloads with its exact base model, and an adapter whose declared base doesn't match is blocked. | [`e2e/03`](../tests/e2e/03-downloads.spec.ts) | ✅ The adapter and its exact base were downloaded and verified. The wrong-base adapter was blocked: "declared base weights c7aa6863… are not part of the base release". Adapter execution is reported as supported only on wllama 3.8.1, where A18 passes. |
| A14 | **Offline reload.** After a reload with no network, search and saved models still work. | [`e2e/04`](../tests/e2e/04-search-offline.spec.ts), [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ Offline reload with networking off: search worked, the stories15M run worked, and the two-stage workflow completed. 17 requests, all served by the service worker; 0 external, 0 failed. |
| A15 | **Operator replacement.** A second operator, with its own key, can run an indexer and builder, and browsers can switch to its snapshots. | [`e2e/05`](../tests/e2e/05-operator-b.spec.ts) | ✅ A second indexer and builder ran with its own key, data directory, port 8794 and mirror root. A clean browser found the announcement by event ID on the relays, verified it and imported 95 records. The exported configuration names the new builder and holds no key material, and a second browser imported that file. |
| A16 | **Relay failure.** With one relay down, publishing and discovery go through the other. With every relay down, the saved catalog still works, and the app reconnects when relays come back. | [`e2e/07`](../tests/e2e/07-relay-failure.spec.ts) | ✅ With relay A stopped, its publish outcome was `disconnected` and relay B's `accepted`; a clean browser discovered the release through relay B. With both relays stopped, archive search still found the records after a reload. 2026-11-07: opened with both relays down, the app showed both live once they started, with no reload. After both were stopped and started again while it was open, it found a release published in the meantime. |
| A17 | **Bounded collection.** When a relay caps its answers, the indexer says its collection may be incomplete instead of claiming it has everything. | [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts), unit collector tests | ✅ Relay B (limit 50) held 60 records sharing one timestamp. An indexer watching only relay B collected 70 of 80 and recorded "response limit (50) reached with every event at created_at=1767225600; more may exist". With both relays it recovered 80 of 80, with coverage relay A `caught-up` and relay B `possibly-incomplete`, never claiming completeness. |
| A18 | **Runtime LoRA.** An adapter runs on top of its base model without merging them, and changes the output. | [`models/lora`](../tests/models/lora.spec.ts) | ✅ The base `1240dfc1…` and the adapter `d1e0617d…` were both re-verified, then loaded unmerged. Scale 1 produced " in love of the eye: That's when when the eye see thy on the sun's shining bright"; scale 0 produced " was a little girl. She was only three years old…". The native log shows `llama_adapter_lora_init: loading lora adapter from '/models/wexare-adapter-0.gguf'`. |
| — | **Prompts and outputs stay local.** Nothing a person types, and nothing a model answers, leaves the browser. | [`models/workflow`](../tests/models/workflow.spec.ts) | ✅ None of the 3 sample inputs or 3 summaries appeared in any of 25 HTTP requests or any WebSocket frame. HTTP hosts: `localhost:4173` (the app) and `127.0.0.1:8790` (the mirror). WebSocket hosts: the two relays. |
| — | **Arweave `ar://` resolution.** An `ar://` file location resolves through a gateway and is verified. | [`integration/arweave`](../tests/integration/arweave.test.ts) | ✅ `ar://Edj83od3…` resolved through arweave.net: 1,047 bytes, SHA-256 verified, CORS present. |

## System 1 routing

The Ask box and the `auto` model send each part of a request to the model that covers it. System 1,
the router, decides which task each part asks for.

| Check | Automated check | Latest result |
| --- | --- | --- |
| Routing rules | [`packages/router`](../packages/router/test/router.test.ts) (unit, 31) | ✅ The tasks System 1 chooses among come from the catalog's releases (models only), each once, in its release's words, plus the general requests no release covers; a release offering a general task's ID replaces it, and a task appears the moment a release offers it, with no change to the router. Every question has at most 10 options: tasks compete in groups, the winners in a final. An instruction that names several tasks is read part by part (a bare verb borrows what a later part acts on), so a request for two things runs both, in the order asked, and the message is never read. A part that isn't a task is skipped. Without an instruction, or with no clear part, the whole request is read. When nothing is clear, the person picks. When several models do a task in different words, System 1 picks one if it clearly prefers it; otherwise the catalog order decides. A model that declines hands the step to the next likeliest task, then to online help, or the step says why it is unavailable. Planned steps show as waiting before the first runs. Local models get the whole request and their prompt picks what they read; online help gets the whole request. Covered steps go to a local model even with online help on, and a model an earlier step downloaded is reused. A step no local model covers goes online only when allowed, otherwise it is reported unavailable and the rest still run. Models download without a question unless the host adds a confirmation step, and a failed download is explained in its step. At most three steps run, the first ones asked for. The OpenAI-compatible request has the task's instruction as its system message, and errors never contain the key. |
| Router release | `pnpm demo:prepare` / `demo:publish` | ✅ `laya-router`: four files verified against hashes pinned to `wexare/laya-onnx@2ac71766`, mirrored, pinned on Kubo A and B, and seeded as torrents. Accepted by both relays. Existing releases kept their event IDs. |
| Ask and online-help screens | [`e2e/10`](../tests/e2e/10-ask.spec.ts) | ✅ The first request starts the router download (904 MB) without a question; **Stop** cancels it and nothing is saved. The test holds the download and blocks the router's worker, so it never loads the router itself. Online help is off by default, survives a reload in the same browser, never shows the key, changes the footer and tagline, and saving it contacts no online service. |
| Real routing decisions | [`integration/router-laya`](../tests/integration/router-laya.test.ts) (opt-in) | ✅ **39 of 39** with native ONNX Runtime: the real router release (Laya fp16) and the real `route()`, choosing among the tasks of a catalog made of the sample releases' manifests in `fixtures/releases`, the git, ffmpeg and ImageMagick command add-ons included. That includes "Categorize and Summarize this message: …", two requests whose message names other tasks, one asking for three things, the front page's example ("Categorize this message" → sort 1.00, "summarize this message" → summarize 1.00), and 11 command requests ("Convert and resize this video: clip.mov to 720p mp4" → ffmpeg). Last run 2026-11-13 with `WEXARE_TEST_LAYA=native` (`apps/local/src/laya.ts`) under a 4 GB memory cap. ⏳ Not run in WebAssembly (`WEXARE_TEST_LAYA=1`): loading the router there needs more than 4.6 GB, more than the test machine can spare. |
| Ask end to end with real models | [`models/router`](../tests/models/router.spec.ts) (opt-in) | ⏳ **Not run automatically**, for the same memory reason. A manual run on a Mac worked (2026-11-02). |
| Front page | [`e2e/13`](../tests/e2e/13-landing.spec.ts) | ✅ The front page (`#/`) plays the before and after as the page scrolls (today, what if, with modelXare) and plays one request through System 1 and System 2 (the router's real verdicts for it, then the two catalog models that sort and summarize), and leads to the app (`#/try`) and back. With reduced motion it shows the before and after side by side, and nothing stays hidden. Last run 2026-11-09. |
| Space for saved models | [`packages/storage`](../packages/storage/test/eviction.test.ts) (unit, 9), [`e2e/11`](../tests/e2e/11-space.spec.ts) | ✅ The least recently used models are removed first, one model's files together, never kept files, and nothing for a download that wouldn't fit anyway. A model larger than the limit still downloads after everything else is removed. A lower limit trims saved models down to it (the rule; choosing a lower limit in Settings isn't checked in the browser). In the browser, with a 400 MB limit, the story model (73 MB) was used, then the summarizer (386 MB): the story model was removed ("73 MB download"), the summarizer stayed ready, and Settings showed "Saved models take 386 MB". A new limit survives a reload. With a real storage limit set through Chrome DevTools: when the browser overstates its room, the refused download made the least used model go and the retry succeeded. When the browser understates its room (10 MB reported), the 73 MB download still went ahead. With no model to remove, the app said how much the browser had really allowed. Out-of-space errors stop the download instead of trying the next source. |

## Message sorting (2026-11-09)

The sort task puts a message into one of nine everyday topics: family, friends, work, money,
shopping, travel, health, home and other. The prompt lists each topic with what it covers. Measured
with the real Qwen2.5 0.5B release file (native llama.cpp, CPU, the same choice grammar as the
browser):

| Check | Result |
| --- | --- |
| 24 everyday messages, three per topic, one of them in Spanish | 12 of 24. Without the topic descriptions in the prompt, 4 to 5 of 16. |
| Where it errs | Family, friends and health messages often come out as travel or work. |
| The pages' examples through `auto` (real router, the published releases) | Front page: "Categorize" sort 0.99, "summarize this message" summarize 0.99, then **Travel** and "Your flight to Lisbon on Friday will leave two hours late at 16:40. Your seat and bags stay the same." Try examples: the bill → **Money** plus a summary; the shoes → **Shopping**. The Spanish flight message gets a Spanish summary. |
| Releases whose answer shape this client doesn't know | They stay in the catalog as metadata and never run (protocol unit tests), so newer clients can add output types. |
| Browser | e2e/01, 05, 06, 07, 09, 10, 12 and 13 pass (16 tests) against the demo catalog. Unit tests: 180 pass. |

## Command add-ons (2026-11-13)

The git, ffmpeg and ImageMagick command writers are LoRA add-ons (5.9 MB each) on the Message
assistant's Qwen2.5 0.5B Q4_K_M weights, published at `wexare/command-loras`. Each was run natively
(`apps/local`'s llama.cpp, CPU, 4 threads) through the same execution code the apps use: the
add-on's own prompt on its base's weights, and the answer checked against its output shape. The
requests are the first 40 of each tool's test set from the training data, which the models did not
train on.

| Add-on | Same command as expected | Same except an output file name the request never gave | Well-formed (starts with the tool) | "Can't do that" requests | Time per request |
| --- | --- | --- | --- | --- | --- |
| git | 31 of 40 | 31 of 40 | 39 of 40 | none in the set | 1.1 s |
| ffmpeg | 13 of 40 | 26 of 40 | 40 of 40 | none in the set | 1.8 s |
| ImageMagick | 25 of 40 | 26 of 40 | 39 of 40 | 1 of 2 declined | 1.2 s |

- The expected commands invent output names when a request names none (`resized.jpg`, `final.mp4`),
  while the models write `output.<ext>` as their prompts ask. That is most of the gap between the
  first two columns.
- Other misses are real: wrong flags (`git diff --staged` for unstaged changes, an audio map for a
  volume change), a value off (`-crf 26` for 30), and two degenerate answers: a commit hash repeated
  until the token limit, and a stray `!!` line in a git sequence.
- The apps show these answers as code, with a reminder to read a command before running it.

With these releases in the demo catalog (format 0.2), the browser suite passes: 33 of 34 tests in
one run, and A09 once releases in an older format were counted apart from rejected ones (e2e/01, 02
and 07 rerun). Unit tests: 197 pass.

## Local runtime and OpenAI-compatible API (2026-11-09)

`apps/local` (`pnpm modelxare`, [docs/local.md](local.md)) runs the releases with native llama.cpp
(node-llama-cpp 3.22.2) and native ONNX Runtime (1.30.0). On the test machine it ran on the CPU
(llama.cpp found Vulkan but no device to offload to).

| Check | Automated check | Latest result |
| --- | --- | --- |
| Rules, shapes and guards | [`apps/local/test`](../apps/local/test) (unit, 38) | ✅ OpenAI requests map onto runtime calls and back:<br>• messages, tools, `tool_choice`, `response_format`, sampling, and refusals that name the parameter;<br>• tool results go back inside the turn that called them;<br>• tool schemas become grammar schemas, with local `$ref`s resolved and nothing narrowed to `null`.<br>Catalog: newest version per model, approved publishers only, distinct ids for a shared `model_id`, `auto` reserved, adapters on their exact base, the router only from a key approved for it.<br>Downloads: kept only when size and SHA-256 match, the next location tried after a bad one, resumed with a range request, and a file changed on disk is removed.<br>Server: JSON 404 for unknown paths and other servers' probes; 415 for non-JSON bodies; 403 for foreign origins and non-localhost `Host`; the API key required (except `/health`); preflight only for an allowed origin. |
| Public catalog, real downloads | `pnpm modelxare list` / `pull` | ✅ With `infra/deploy/app.env.example`, `list` read the public relays and found all five weXare releases (nos.lol answered; relay.damus.io refused the connection). `pull tiny-summarizer shakespeare-lora` downloaded 476 MB from Hugging Face. `sha256sum` agreed with every stored file's name. |
| Real models through the API | [`apps/local/test/real-models.test.ts`](../apps/local/test/real-models.test.ts) (opt-in, `WEXARE_TEST_LOCAL`) | ✅ 8 of 8 in 42.7 s under a 4.5 GB memory cap:<br>• `/v1/models` lists `auto` and five models with their context (32,768 / 8,192 / 256).<br>• SmolLM2 summarized the flight-delay message.<br>• Qwen streamed "¡Hola! ¿Cómo estás?" with `finish_reason` `stop`, a usage chunk and `[DONE]`.<br>• Qwen called `get_weather {"city":"Paris"}`, then answered "The current temperature in Paris is 18°C, and it is cloudy." from the tool's result.<br>• A `json_schema` title parsed.<br>• The Shakespeare adapter continued "Look in thy glass".<br>• **`auto`**: System 1 read "Categorize" → sort 0.99 and "summarize this message" → summarize 0.99, then Qwen and SmolLM2 answered "Topic: Travel / Summary: …". "What is the capital of France?" read as answer (0.77); no specialist does that, so the general model answered "The capital of France is Paris." |
| Official OpenAI SDK as the client | a one-off script, not in the repo (`openai` 7.43.0) | ✅ `models.list`, `chat.completions.create`, a streamed `auto` request with usage, tool calls, and `runTools` running a real tool function to a final answer. An unknown model raised `NotFoundError` 404 `model_not_found`. |
| Memory and speed | `serve` under `systemd-run -p MemoryMax=4500M` | ✅ Peak 3.7 GB with the router and three models loaded. The router loads in 6.8 s and reads in 1.6 to 1.9 s. `auto` with sort and summarize takes 13 to 21 s on a first request (two model loads, files hashed once) and 4.0 s once they are loaded. A client that disconnects mid-stream stops its generation, and the next request was answered 0.4 s later. |
| Agents | none | ⏳ The OpenCode, Hermes Agent and OpenClaw settings in docs/local.md follow their documentation; none of the three has been run against the server yet. Hermes needs 64K of context for its main model, more than any catalog model has. |

## Observations

- **Why tasks come from the catalog, and how they are asked about (2026-11-13).** Measured with the
  real router over the sample tasks, three command-writing tasks and the three general requests:
  - Yes/no questions per task or per category were unreliable: "Summarize this: …" scored 0.23 for
    summarize, and "squash the last three commits" 0.78 for the ffmpeg task. Asking "what else?" after
    the first choice picked the sibling task almost every time ("resize photo.png" → ffmpeg 0.99).
    Choosing a category first, then a task, did worse than one choice over all the tasks.
  - One choice over every task, with general requests next to them, was right for 17 of 18 one-task
    message requests and 50 of 60 real command requests from the training data's test sets.
  - Keys and wording matter. Options keyed by task ID read better than by title. A `when` with
    concrete actions and file types ("for a video or audio file (mp4, mov, mkv, mp3): convert, cut,
    compress, extract the sound or make a gif") raised the command requests to 55 of 60; the misses
    left are typos ("show satatus") and requests that don't name the tool ("show remotes").
- **Why the router reads each part of the instruction.** An earlier design asked the router one
  yes/no question per task about the whole request. That missed "summarize" in "Categorize and
  Summarize this message: …" (0.16), and added "continue the story" (0.67) and "answer" (0.57) to
  "Write a reply to this tenant: …". Asking about the whole request at once also fails, because the
  message sways it: "Summarize this: Can you translate the notice…" read as translate (0.75). The
  router's main-task choice on one short instruction is sharp (0.95 to 1.00 for every task part
  measured, except "Classify this complaint").
- **Bugs these checks caught, all fixed:**
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

The README's [Tests](../README.md#tests) section lists the opt-in checks and what they need.

## Recording a run on other hardware

On another machine, such as an Apple Silicon Mac, run `pnpm test:models` with a headed browser
(`pnpm --filter @wexare/tests exec playwright test --project models --headed`), or follow
[demo-script.md](demo-script.md) steps 7 and 9 by hand. Then add the browser version, the hardware,
`tests/results/A11.json`, `A14.json` and `A18.json`, and the exact files and timings from the
execution trace to this page.

What isn't implemented yet is listed under [Known limitations](../README.md#known-limitations) in the
README.
