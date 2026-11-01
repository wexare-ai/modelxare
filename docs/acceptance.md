# Acceptance checklist (spec §14)

Each criterion links to the automated test that checks it. The status records what has actually been
run, where and when. Machine-readable evidence from each run is written to `tests/results/<ID>.json`.

**Environment of the runs below:** Ubuntu 24.04 VM, x86_64, 4 vCPU, 7.8 GiB RAM, no GPU/WebGPU;
Chromium headless shell 156 (Playwright 1.64.1); Node 22.22.2. This is **not** the reference Apple
Silicon laptop. Real-model evidence on that hardware is still required before P0 can be declared
complete (spec §14).

Status legend:
- ✅ passed in the run noted.
- 🟡 the automated test exists, and only part of it has run so far (noted).
- ⏳ the automated test exists but has not yet run against the full services.

| ID | Criterion | Automated check | Status |
| --- | --- | --- | --- |
| A01 | One-repo setup | README quick start, end to end | ⏳ Docker was not available on the build VM. `pnpm install`, `pnpm build`, `pnpm test` and `demo:prepare --no-ipfs` ran. |
| A02 | Real signed publication | [`e2e/01-publish-discover`](../tests/e2e/01-publish-discover.spec.ts), [`integration/relays`](../tests/integration/relays.test.ts) | ⏳ |
| A03 | Correct tag queries | Unit: [`protocol.test.ts`](../packages/protocol/test/protocol.test.ts), 20 golden queries in [`catalog.test.ts`](../packages/catalog/test/catalog.test.ts). Real relay: [`integration/relays`](../tests/integration/relays.test.ts), [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts) | 🟡 unit ✅ (2026-11-01). Relay checks ⏳ |
| A04 | Durable indexing | Unit (mock relay): [`collector.test.ts`](../apps/indexer/test/collector.test.ts). Real: [`e2e/02-indexer-archive`](../tests/e2e/02-indexer-archive.spec.ts) | 🟡 unit ✅. Real relays ⏳ |
| A05 | Archive round trip | [`e2e/02-indexer-archive`](../tests/e2e/02-indexer-archive.spec.ts) | 🟡 manual browser run (2026-10-31): a 7-record archive was imported over the torrent path with no indexer call. The automated test ⏳ |
| A06 | Real torrent transfer | [`e2e/02-indexer-archive`](../tests/e2e/02-indexer-archive.spec.ts) (web seeds disabled) | 🟡 manual run (2026-10-31): 22,701 B from WebRTC peers, 0 B from web seeds. The automated test ⏳ |
| A07 | IPFS retrieval | [`e2e/03-downloads`](../tests/e2e/03-downloads.spec.ts), [`integration/storage`](../tests/integration/storage.test.ts) | ⏳ |
| A08 | Local search | [`e2e/04-search-offline`](../tests/e2e/04-search-offline.spec.ts) | ✅ 2026-11-01. 10,000 records; import verification 37.8 s plus commit 14.8 s; database 53.6 MiB. After a reload, with networking off, the warm queries were: all records 112 ms, FTS "heron" 24 ms, FTS prefix "summar" 49 ms, capability intersection 26 ms, FTS + capability 20 ms. |
| A09 | Invalid data | Unit: protocol vectors and archive rejection tests. Browser: [`e2e/01`](../tests/e2e/01-publish-discover.spec.ts) (altered manifest, live) and [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) (tampered, traversal, oversized, malformed, forged) | 🟡 unit ✅. Browser ⏳ |
| A10 | File fallback | [`e2e/03-downloads`](../tests/e2e/03-downloads.spec.ts), which includes altering a cached file before load | 🟡 manual run (2026-10-31): the corrupt primary was rejected and the next source verified. The automated test ⏳ |
| A11 | Real inference | [`models/workflow`](../tests/models/workflow.spec.ts) | 🟡 manual run on the VM (2026-10-31). Qwen2.5-0.5B Q4_K_M classified `maintenance`, and SmolLM2-360M Q8_0 summarized "Water leak near entrance."; wllama 3.8.1, about 43 s. The automated run ⏳. **Reference laptop ⏳** |
| A12 | Dynamic composition | Plan level: [`e2e/06-composition`](../tests/e2e/06-composition.spec.ts). Execution: [`models/workflow`](../tests/models/workflow.spec.ts) | 🟡 missing stage ✅ (2026-11-01). Release switch and trace ⏳ |
| A13 | LoRA handling | [`e2e/03-downloads`](../tests/e2e/03-downloads.spec.ts) | ⏳ |
| A14 | Offline reload | Tiny model: [`e2e/04-search-offline`](../tests/e2e/04-search-offline.spec.ts). Two-stage: [`models/workflow`](../tests/models/workflow.spec.ts) | ⏳ |
| A15 | Operator replacement | [`e2e/05-operator-b`](../tests/e2e/05-operator-b.spec.ts) | ⏳ |
| A16 | Relay failure | [`e2e/07-relay-failure`](../tests/e2e/07-relay-failure.spec.ts) | ⏳ |
| A17 | Bounded collection | Unit (mock relay with a hidden cap, ties and reconnect overlap): [`collector.test.ts`](../apps/indexer/test/collector.test.ts). Real relay B (limit 50): [`e2e/02`](../tests/e2e/02-indexer-archive.spec.ts) | 🟡 unit ✅. Real relay ⏳ |
| A18 | Runtime LoRA (P1) | [`models/lora`](../tests/models/lora.spec.ts), compatibility spike | 🟡 spike and manual run ✅ (2026-10-31): base sha256 `1240dfc1…` + adapter `d1e0617d…`; scale 1 and scale 0 give different outputs, matching upstream; native llama.cpp adapter log captured. The automated run ⏳ |
| — | Prompts and outputs stay local | [`models/workflow`](../tests/models/workflow.spec.ts) (requests and WebSocket frames) | ⏳ |
| — | Arweave `ar://` resolution | [`integration/arweave`](../tests/integration/arweave.test.ts) (`WEXARE_TEST_ARWEAVE=1`) | ✅ 2026-11-01: `ar://Edj83od3…` through arweave.net; 1,047 bytes, SHA-256 verified, CORS present |

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
