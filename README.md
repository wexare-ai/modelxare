# weXare micro-model marketplace: proof of concept

Small AI models published as signed Nostr releases, stored on IPFS, torrents and HTTP mirrors,
collected by independent indexers into signed catalog snapshots, then searched, verified and run
entirely inside the browser.

- **Publish.** A CLI writes a manifest for real model files, signs a NIP-94 release event, and publishes it to two relays. Each relay's acknowledgment is reported separately.
- **Collect.** A restartable indexer watches several relays and deduplicates. It never claims coverage it did not get.
- **Archive.** A builder freezes the collected signed events into a ZIP, signs an announcement, and distributes it over IPFS, an HTTP mirror and a WebRTC-capable torrent.
- **Discover.** The browser app reads relays directly (Live), imports archives (Archives), or both (Combined), into SQLite WASM + FTS5 on OPFS. Searches stay on the device.
- **Run.** The browser downloads model files with source fallback, verifies every byte against the signed manifest, and runs GGUF models locally with wllama. It composes classification → summarization, and can apply a LoRA adapter at runtime.

There is no central registry, account, search API or remote inference. See [docs/protocol.md](docs/protocol.md)
for the data contract and [docs/acceptance.md](docs/acceptance.md) for what has been verified, and how.

![The publisher, catalog operator and browser exchange signed metadata through Nostr relays and bytes through storage](docs/architecture.svg)

## Prerequisites

- Node.js 22.12 or later, below 23 (`.nvmrc` pins 22.22.2), and pnpm 11 (`corepack enable`). With
  nvm, run `nvm install && nvm use` in the repository. Newer Node versions print an "Unsupported
  engine" warning and are untested.
- Docker with Compose v2, for the two strfry relays, two Kubo nodes and the tracker. It must be
  running before `pnpm infra:up`.
  - macOS: Docker Desktop, OrbStack or Colima. The pinned images support Apple Silicon.
  - Ubuntu: `sudo apt-get install -y docker.io docker-compose-v2 && sudo usermod -aG docker $USER`.
    The infra script falls back to `sg docker` until you log in again.
- About 5 GB of free disk. The four pinned model fixtures total 0.97 GB, and they are copied into
  IPFS, the mirror and the browser.
- Network access the first time, to download the pinned fixtures from Hugging Face. No accounts are needed.
- Chrome or Chromium for the app; other browsers are untested. `pnpm --filter @wexare/tests exec playwright install chromium` provides one for tests.

## Quick start

```sh
pnpm install
pnpm infra:up          # relays A/B, Kubo A/B, tracker (docker compose; data volumes persist)
pnpm demo:prepare      # keys, fixture download + verification, releases, IPFS pins, torrents, synthetic catalog
pnpm dev               # web app :5173, indexer (operator A) :8791, artifacts mirror/seeder :8790
pnpm demo:publish      # in another terminal: publish to both relays, per-relay outcomes
pnpm catalog:build     # freeze operator A's indexer into a signed, seeded snapshot
```

Open <http://localhost:5173>. Releases appear under **Discover → Live**. To import the snapshot, go to
**Sources & diagnostics** and paste the announcement JSON that `catalog:build` printed (saved under
`.data/operators/a/archives/`), or look it up by event ID. To run the classification → summarization
workflow, use **Playground**. [docs/demo-script.md](docs/demo-script.md) walks through the full
demonstration, including relay failure, offline reload and a second operator.

The first `demo:prepare` downloads 0.97 GB and signs 10,000 synthetic records, which takes about 90 s.
Later runs reuse everything: unchanged manifests keep their signed events.

`pnpm dev` does not start the docker services. If the indexer logs `connection failed (is the relay
running? pnpm infra:up)`, start Docker, then run `pnpm infra:up`. It is safe to repeat, and it
prints a ✓ for each service once it answers. Relay and IPFS data live in docker volumes, so events
you published earlier are still there after a restart.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the pinned workspace dependencies |
| `pnpm infra:up` / `pnpm infra:down` | Start, or stop, the docker services. `down` keeps volumes. |
| `pnpm demo:prepare` | Generate demo keys, fetch and verify fixtures, and populate the mirror, IPFS (with replicas on Kubo B) and torrents |
| `pnpm dev` | Web app, indexer and artifacts mirror/seeder, with live logs |
| `pnpm demo:publish` | Publish every fixture release (and the negative fixture) to both relays |
| `pnpm catalog:build` | Build, sign, publish and seed a snapshot from operator A's indexer database |
| `pnpm test` | Fast unit tests: protocol, catalog and golden queries, storage, runtime, orchestrator, collector |
| `pnpm test:e2e` | Browser and service acceptance tests against the real services (see below) |
| `pnpm test:models` | Opt-in real-model browser tests. They download about 0.9 GB into the browser. |
| `pnpm build` | Static web build (`apps/web/dist`) and bundled operator programs (`apps/*/dist`) |
| `pnpm demo:reset --force` | Delete the demo data under `.data/`. `--volumes` also deletes relay and IPFS data, and `--downloads` the fixture models. Without `--force` it only lists what it would delete. |
| `pnpm cli <args>` | The publisher/builder CLI (`wexare --help`) |

### Tests

- `pnpm test` needs nothing running.
- `pnpm test:e2e` and `pnpm test:models` need `pnpm infra:up` and `pnpm demo:prepare`. Playwright
  starts the artifacts server (reusing one on :8790) and a production build served by `vite preview`
  on :4173, with the service worker. Tests start their own indexers on :8793 to :8795, with data under
  `.data/e2e/<run>/`. Evidence is written as JSON to `tests/results/`. The e2e run stops and restarts the
  relay containers for A16, and publishes labeled synthetic records to both relays for A17.
- `pnpm vitest run --project integration` runs the Node-side checks against the same services. The
  mirror and torrent checks also need the artifacts server on :8790, which `pnpm dev` starts.
  `WEXARE_TEST_ARWEAVE=1` adds the public Arweave gateway test, which needs internet access.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | Schemas, canonical JSON, event and manifest verification, tag rules, operation contracts, test vectors |
| `packages/catalog` | Shared SQLite schema, FTS5 queries, source membership, archive build/read, operator state |
| `packages/storage` | Source resolution, verified downloads (Node and browser), IPFS client, mirror layout, torrents |
| `packages/runtime` | Capability detection, wllama runtime wrapper (including the LoRA adapter path), GGUF header reader |
| `packages/orchestrator` | Release selection, two-stage workflow planning and execution, LoRA dependency resolution |
| `apps/cli` | `wexare`: keys, `release prepare/publish`, `archive build/verify/publish`, `demo …` |
| `apps/indexer` | Persistent multi-relay collector with a read-only status endpoint |
| `apps/artifacts` | Static HTTP mirror (range, CORS, immutable caching) and WebRTC torrent seeder |
| `apps/web` | The browser app: Discover, Model library, Playground, Sources & diagnostics |
| `infra/` | Docker Compose for strfry ×2, Kubo ×2 and the WebSocket tracker, with images pinned by digest |
| `fixtures/` | Pinned upstream model fixtures, release definitions, sample messages, the Arweave fixture |
| `tests/` | Playwright acceptance (`e2e/`, `models/`), integration tests, the runtime compatibility spike |
| `docs/` | Protocol, demo script, acceptance checklist, runtime compatibility report |

## Running components separately

Every component reads its endpoints from flags. The defaults are in `infra/dev-endpoints.json`, and
none of them is required by the protocol.

- **Web app only:** run `pnpm --filter @wexare/web build` and serve `apps/web/dist` from any static host
  that sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
  require-corp`; those headers enable multithreaded inference. Relays, gateways, trackers and
  trusted catalog builders are configured in **Sources & diagnostics** and can be exported or imported
  as public JSON.
- **Publisher CLI only:** `pnpm cli keygen --out my.key.json`, then `pnpm cli release prepare --definition
  def.json --key my.key.json --out out/ --ipfs-api http://… --mirror-url https://…`, then
  `pnpm cli release publish --event out/event.json --relay wss://…`.
- **Indexer only:** `node apps/indexer/dist/main.js run --data /srv/wexare/op --name my-operator
  --relay wss://… --port 8791`.
- **Archive build only:** `pnpm cli archive build --indexer-db /srv/wexare/op/indexer.sqlite --builder-key
  builder.key.json --relay wss://… --out archives/`, then optionally `pnpm cli archive publish --zip …`.
  `--events <file>` builds from preserved signed event files, with no indexer.
- **Mirror and seeder only:** `node apps/artifacts/dist/main.js --roots-dir /srv/wexare/artifacts --port
  8790` (add `--no-seed` for HTTP only).

## Ports (local demo)

| Service | Port |
| --- | --- |
| Relay A (strfry, limit 500) / relay B (strfry, limit 50) | 7777 / 7778 |
| Kubo A API / gateway | 5001 / 8080 |
| Kubo B API / gateway | 5002 / 8081 |
| WebSocket tracker | 8000 |
| Artifacts mirror + seeder | 8790 |
| Indexer operator A / B (status only) | 8791 / 8792 |
| Web app (dev / preview) | 5173 / 4173 |

## Data and keys

All runtime state is under `.data/`, which is ignored by git. That covers keys (mode 0600), fixture
models, published releases, artifact roots, indexer databases, archives and synthetic data. Model
binaries, private keys, archives and databases never belong in the repository. The demo keys are
disposable. Private keys stay in the CLI and never reach the browser.

## Known limitations

- The app should be open in one tab at a time: the OPFS SQLite VFS holds an exclusive handle.
- The indexer resumes from a `created_at` cursor. A running indexer receives every new event, but if
  an event signed long before it is published arrives while the indexer is stopped, only a rescan
  collects it: `curl -X POST http://127.0.0.1:8791/rescan`.
- Peers-first torrent transfer needs a seeder that has finished hashing. The HTTP web-seed fallback,
  4 s by default and configurable, keeps imports usable meanwhile.
- Runtime LoRA execution relies on a wllama 3.8.1 internal. Any other version shows "Adapter execution
  unavailable in this runtime"; see [docs/runtime-compatibility.md](docs/runtime-compatibility.md).
- Gateway availability, storage retention and browser P2P connectivity are separate concerns. A pinned
  CID or a seeded torrent says nothing about whether a particular gateway or peer is reachable.
- P1 items that are not implemented: Arweave uploads (only `ar://` resolution is implemented),
  incremental or sharded catalogs, and browser publishing with a Nostr signer.

## License

Apache-2.0. Model fixtures keep their upstream licenses; see `fixtures/models.json`.
