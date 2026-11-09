# Demo script

Follows the end-to-end demonstration in the spec (§5), with the commands to run and what to look
for. Every step uses real relays, IPFS, torrents and models. The only synthetic data is the
10,000-record scale catalog and the A17 bounded-collection set. Both are labeled `synthetic`, hidden
by default, and never runnable.

Setup, once: `pnpm install && pnpm infra:up && pnpm demo:prepare`. Then keep `pnpm dev` running in
its own terminal.

Use two separate browser profiles for "browser 1" and "browser 2", for example a normal window and a
guest window. Each profile has its own OPFS catalog and model cache. Within one profile, use one tab.

## 1. Publisher A prepares two runnable releases and a LoRA with an exact base

`pnpm demo:prepare` already did this. It prints, for each fixture, whether the release was newly
signed or kept as-is, because manifests are immutable. The results are in `.data/releases/<name>/`
(`manifest.json`, `event.json`, `release.json`).

| Release | What it shows |
| --- | --- |
| `community-assistant` | Qwen2.5 0.5B Q4_K_M; classification + summarization; en, es |
| `tiny-summarizer` | SmolLM2 360M Q8_0; summarization; the primary location is a one-byte-corrupted copy |
| `story-base` | stories15M MoE F16; text generation; the primary location returns 404 |
| `shakespeare-lora` | Real LoRA adapter whose `base` pins `story-base` (release, manifest and weight hashes) |
| `shakespeare-lora-wrong-base` | Same adapter declared for a different base file. It must be blocked. |
| `future-runtime-model` | Unknown runtime (`onnx-web`). Visible, marked unsupported. |
| `wrong-file-hash` | Declared hash that no location serves. Every download fails verification. |
| `_invalid-manifest-hash` | Validly signed event with an altered inline manifest. Relays store it; every verifier rejects it. |

To publish your own release with a fresh key, see the publisher definition in
[protocol.md](protocol.md#publisher-definition-cli-input).

## 2. The same signed events go to relay A and relay B

```sh
pnpm demo:publish
```

Each release prints one line per relay: `accepted`, `duplicate`, `rejected`, `timed-out` or
`disconnected`. The retry step republishes `community-assistant`. Its event ID is unchanged, and
the relays answer `duplicate`.

## 3. The indexer collects and deduplicates

The operator A indexer is part of `pnpm dev`. Open <http://127.0.0.1:8791/status>:

- `relays[]` shows per-relay state, cursor, `acceptedNew`, `duplicates` and `rejected`.
- `totals.rejectedByCode` includes `manifest_hash_mismatch` for the negative fixture.
- Each release has one row with two observations. To check:
  `sqlite3 .data/operators/a/indexer.sqlite "select source_id from source_memberships where event_id='<id>'"`.

To show bounded collection, publish more tied-timestamp records than relay B returns per query. Relay
B is configured to return at most 50 events. Then restart the indexer:

```sh
pnpm cli demo bounded-fixture --relay ws://127.0.0.1:7778   # 60 records share one created_at
# restart pnpm dev (or POST http://127.0.0.1:8791/rescan)
```

Relay B now reports `possiblyIncomplete: true` with the reason `response limit (50) reached with
every event at created_at=…`. Archive coverage then lists relay B as `possibly-incomplete`. To let
operator A recover the full set from the other relay, publish the same records to relay A
(`--relay ws://127.0.0.1:7777`). Relay B's coverage still reports `possibly-incomplete`.

## 4. An archive builder freezes, signs and distributes a snapshot

```sh
pnpm catalog:build
```

The command does the following:

1. Reads the indexer database in one transaction.
2. Writes `.data/operators/a/archives/<sha256>.zip`, containing `catalog.json`, `releases.jsonl`
   (the original signed events) and `catalog.sqlite`.
3. Pins the ZIP on Kubo A.
4. Writes it to the `operator-a` mirror root.
5. Creates a torrent with a WebSocket tracker and a web seed. `apps/artifacts` seeds it over WebRTC.
6. Signs an announcement with `builder-a` and publishes it to both relays.

The output prints the per-relay coverage and the announcement event ID.

## 5. A clean browser discovers releases live

Browser 1: open <http://localhost:5173>, then **Discover → Live**.

- Results show the publisher fingerprint, the relays that delivered each event (`2 relays`), size,
  memory, license and support badges.
- Open a release. It shows `metadata verified` (event ID, signature, manifest hash, schema and tags,
  checked in the browser), the exact manifest bytes, the original event, and provenance.
- **Sources & diagnostics → Relays** shows per-relay counters. **Recently rejected events** lists the
  altered-manifest fixture with its rejection code.
- Tick `text-classification` and `summarization` together. Only the community assistant matches,
  because the intersection is evaluated locally, not by the relays.

## 6. A second clean browser imports the archive and searches locally

Browser 2: open **Sources & diagnostics → Import a catalog archive**.

1. Paste the announcement JSON from `.data/operators/a/archives/*.announcement.json`, or enter its
   event ID and press **Look up**.
2. Review the builder key, then press **Fetch & verify archive**.
3. To prove a pure peer-to-peer transfer, first set **HTTP web-seed fallback delay** to `-1`. The
   status line then reads `Received via torrent: N from WebRTC peers, 0 B from HTTP web seeds`.
4. Press **Trust this builder & import**. **Discover → Archives** now searches the snapshot locally.

The 10,000-record synthetic catalog imports the same way. Use the announcement and ZIP under
`.data/synthetic/`, or choose the ZIP as a local file. Tick **include synthetic test records**.
Queries report their local time in milliseconds.

## 7. Download, verify and run the composition workflow

Open **Playground**, which defaults to the English flight-delay sample.

1. The plan picks a classification release and a summarization release from the verified catalog
   and explains why. You can choose another compatible release per stage. Incompatible releases are
   listed disabled, with the reason.
2. **Approve download** fetches the files with fallback. `tiny-summarizer` first hits its corrupted
   mirror: SHA-256 mismatch, rejected, then the next source. **Sources & diagnostics → Downloads**
   counts the hash mismatches.
3. **Run locally** runs classification, then summarization. The result shows the category and the
   summary. The execution trace lists, per stage: release ID, publisher, manifest hash, file hashes,
   timings, the raw output and the contract check.
4. Choose the Spanish sample. Language detection switches the summarization stage to a release that
   declares `es`.
5. LoRA: in **One-model mode**, choose "Shakespeare style adapter". This downloads the adapter and its
   exact base. Run with scale 1.0, then 0.0. The two outputs differ, and **Runtime adapter evidence**
   shows llama.cpp's own log of the loaded adapter. The wrong-base adapter's detail page shows
   **Blocked**.

## 8. Stop relays and the indexer; archive discovery and cached inference continue

```sh
node scripts/infra.mjs stop relay-a relay-b    # and stop pnpm dev's indexer
```

Reload browser 2. **Archives** search still works, and cached models still run. In **Sources &
diagnostics**, both relays show errors. Bring them back with
`node scripts/infra.mjs start relay-a relay-b`.

## 9. Offline

Run the production build so the service worker caches the app shell and the runtime:
`pnpm --filter @wexare/web build && pnpm --filter @wexare/web exec vite preview`, then open
<http://localhost:4173>.

1. Warm it up: import a catalog, download the workflow's models, and run the workflow once.
2. Turn off **Network synchronization**, then disconnect the network. In DevTools you can use
   **Network → Offline**.
3. Reload. Search, then run the workflow again.

The DevTools network panel shows only same-origin requests served by the service worker: no CDN, no
relay and no inference endpoint.

## 10. Another operator, without code changes or registration

On this machine, operator B uses its own key, data directory, status port and mirror root:

```sh
pnpm indexer:b                                  # .data/operators/b, status on :8792
pnpm catalog:build --operator b                 # signs with .data/keys/builder-b.key.json
```

In either browser, import operator B's announcement through **Sources & diagnostics**, as in step 6.
The catalog sources table now lists both builders with their coverage. Records present in both
catalogs are stored once, with two memberships. **Export configuration** writes the public settings,
trusted builders included, as JSON that another browser can import. It contains no keys.

### Running operator B on another machine

The same repository runs each component separately.

1. Clone, then run `pnpm install && pnpm build`. Docker is not needed unless that operator also wants
   their own relay or IPFS node.
2. Generate an operator key: `node apps/cli/dist/main.js keygen --out builder.key.json`.
3. Run an indexer against any relays:
   `node apps/indexer/dist/main.js run --data /srv/wexare --name operator-b --relay wss://relay.example --port 8791`.
4. Build and publish snapshots, pointing the announcement at that operator's own public endpoints:
   ```sh
   node apps/cli/dist/main.js archive build --indexer-db /srv/wexare/indexer.sqlite \
     --builder-key builder.key.json --relay wss://relay.example --out /srv/wexare/archives --publish \
     --mirror-name operator-b --mirror-root /srv/wexare/artifacts/operator-b \
     --mirror-url https://mirror.example --tracker wss://tracker.example \
     --ipfs-api http://127.0.0.1:5001     # or --no-ipfs when this operator runs no Kubo node
   ```
5. Serve the artifact roots over HTTPS, and seed the torrents:
   `node apps/artifacts/dist/main.js --roots-dir /srv/wexare/artifacts --host 0.0.0.0`. Put a TLS
   proxy in front of it. Browser peers find the seeder through the tracker named in the magnet.
6. Share the announcement event ID, or let browsers find it on the relays.

Users decide whether to trust a builder's key. No weXare service is involved.

One computer running several processes proves that the components are independent. It does not prove
independent ownership.
