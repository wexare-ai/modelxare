# Protocol profile: `wexare.micromodel.release/0.2`

An experimental application profile on top of Nostr NIP-01 and NIP-94. It is not an official Nostr
standard. The JSON Schemas are normative:

- [`packages/protocol/schemas/release-manifest-0.2.schema.json`](../packages/protocol/schemas/release-manifest-0.2.schema.json)
- [`packages/protocol/schemas/catalog-inventory-0.1.schema.json`](../packages/protocol/schemas/catalog-inventory-0.1.schema.json)

Valid and invalid test vectors, signed with public, test-only keys, are in
[`packages/protocol/vectors/`](../packages/protocol/vectors/). Every component (CLI, indexer, archive
builder, browser) verifies with the same code in `@wexare/protocol`.

## Identities

| Concept | Identity |
| --- | --- |
| Publisher | Nostr public key (secp256k1, BIP-340). Displayed as a fingerprint and `npub`. Names are labels, never identity. |
| Model family | publisher pubkey + `model_id`. |
| Release | The signed event ID. A release is immutable: changing any manifest byte means a new event. |
| File | SHA-256 + size of the exact bytes. Locations (IPFS, HTTP, torrent, Arweave) are interchangeable hints. |
| Catalog snapshot | SHA-256 of the exact ZIP bytes, bound to the builder key by a signed announcement. |

Two releases signed by the same key for the same `model_id` and `version`, with different manifests,
are a **conflict**. Clients show both separately and never merge them.

## Release announcement (kind 1063)

| Tag | Value |
| --- | --- |
| `t` | `wexare-micromodel` (the one tag relays are asked to match) |
| `t` | Derived discovery tags: `task:<capability>`, `category:<category>`, `lang:<bcp47>`, `runtime:<family>`, `artifact:<model\|lora>` |
| `m` | `application/json` |
| `x` | SHA-256 of the exact `wexare-manifest` string (UTF-8 bytes) |
| `size` | Byte length of that string |
| `url`, `fallback` | Optional retrieval locations for the manifest file itself |
| `alt` | Human-readable summary (NIP-31) |
| `wexare-manifest` | The manifest JSON, inline, serialized canonically (RFC 8785-style key ordering) |

`content` is a short description, at most 280 characters, for generic Nostr clients.

A verifier accepts a release only if every check passes. Rejection codes are listed in parentheses.

1. Structure and size (`malformed_event`, `event_too_large`, default 32 KiB), kind 1063 (`wrong_kind`).
2. The event ID is the NIP-01 hash (`bad_id`), and the Schnorr signature is valid (`bad_signature`).
3. Exactly one `wexare-manifest` tag (`manifest_missing`, `manifest_multiple`).
4. `x` equals the SHA-256 of that exact string, and `size` equals its length (`manifest_hash_mismatch`). The
   verifier hashes the string as received; it never re-serializes before hashing.
5. The string parses (`manifest_parse_error`), is canonical (`manifest_not_canonical`) and validates
   against the schema. Semantic checks follow (`manifest_inconsistent`): operations ⊆ capabilities,
   `base` only for LoRAs, and so on.
6. The derived `t` tags equal what the manifest implies (`tag_inconsistent`). Tags are an index, never
   a second source of truth.
7. An operation whose answer shape (`output.type`) this client doesn't know stays as metadata and never
   runs (warning `unknown_output_type`). Newer clients can add output types without breaking older ones.

Events carrying `t=wexare-micromodel-catalog` are catalog announcements (`catalog_announcement`). They
are never indexed as models.

### Querying relays (A03)

Values inside one `#t` filter are alternatives (OR). Collectors and browsers therefore request
`{"kinds":[1063],"#t":["wexare-micromodel"]}` and apply required intersections locally
(`matchesTagQuery`). Optional narrowing requests (`narrowingRelayFilters`) send one filter per required
tag. Their union is a superset that must still pass the local check.

## Manifest (`schema: wexare.micromodel.release/0.2`)

Key fields. The schema has the full definition.

- `model_id`, `name`, `description`, `version` (strict semver), `kind` (`model` | `lora`), `labels`.
  `synthetic` marks generated, non-runnable test records.
- `capabilities`: the IDs of the tasks the release does (its operations). `languages`: BCP 47 tags
  (`und` when unknown).
- `license`: `{id, url?, attribution?}`. The id is SPDX where possible.
- `runtime`: `{format, family, requirement, browser_features, chat_template?}`. Clients treat unknown
  families as unsupported, and the release stays visible.
- `files[]`: `{role, path, size, sha256, locations[]}`, where each location is `{transport, uri, path?}`:
  - transports `ipfs` (`ipfs://<cid>`), `https`, `http` (loopback only, for development),
    `torrent` (magnet with `xt=urn:btih:`; `path` names the file inside the torrent), and `arweave`
    (`ar://<tx>`);
  - unknown transports are ignored, and every source is checked against `sha256` and `size`.
- `operations[]`: the tasks the release does. Each one carries everything a client needs to find it,
  run it and check its answer, so a new task or category needs no change to any client:
  - `id`: the task ID. Releases doing the same task share it (`summarization`, `text-classification`,
    `git-command`): reuse an ID from the catalog when your model does the same thing.
  - `title`: a short label people read, such as `Summarize`.
  - `category`: where the task is filed, such as `messages`, `writing` or `command-line`; reuse a
    category from the catalog when one fits. It becomes a `category:<slug>` discovery tag.
  - `when`: one plain sentence, under 200 characters, saying which requests the task is for. The
    router reads it to decide (see [Routing](#routing)). Concrete actions and nouns route best.
  - `examples` (optional): requests apps offer people to try.
  - `prompt: {mode, system?, template}` and `generation?`. Templates are plain text, never evaluated
    as code, with these placeholders: `{{input}}` (the whole request), `{{text}}` (the request
    without a leading instruction such as `Summarize this:`), `{{labels}}` and `{{language}}`.
  - `output`: the shape of the answer, which the client enforces before anyone sees it:
    - `{type: "text", max_chars?, single_line?, code?, decline?}`: text, at most `max_chars` (default
      2000), on one line when `single_line`. `code` says the answer is code or a command line: apps
      show it as code and remind people to read it before running it;
    - `{type: "label", labels: [{id, description?}], decline?}`: exactly one label ID. The client
      builds a grammar from the IDs so the model can answer nothing else, and `{{labels}}` lists them
      with their descriptions: `family (parents, children, partners and relatives), friends (…), …`;
    - `decline`: what the model answers when a request is outside what it does, such as
      `UNSUPPORTED`. The step then goes to the next likeliest task, then to online help when the
      person allowed it.
- `requirements`: `{context_length, memory_mb?: {value, basis: measured|estimated, context_length},
  hardware_profiles?}`. A missing `memory_mb` means unknown, never "fits".
- `base` (LoRA only): `{release_id, manifest_sha256, files: [{sha256, size}]}`. Clients execute an
  adapter only over that exact base: release ID, manifest hash, and every weight hash must match. A
  GGUF header check additionally compares architectures. An adapter runs its own `operations` (its
  prompt is the one it was trained with) on the base's weights and chat template.

### Router releases (System 1)

A router decides what a request needs; it never generates text. It is published like any model, with:

- `capabilities: ["intent-routing"]` and `operations: []`, because routing has no prompt template;
- `runtime: {format: "onnx", family: "laya", requirement: <semver range of @wexare/laya-web>}`;
- four files: `weights` (`*.onnx`), two `tokenizer` files (`tokenizer.json`, `tokenizer_config.json`),
  and `config` (`rl_agent_config.json`, the calibration temperatures).

`packages/router` accepts a release only when all four files are present and the runtime range admits
the bundled `@wexare/laya-web` version. It prefers a release that is already downloaded, then the
newest version. Clients without that runtime list router releases as unsupported, like any unknown
family.

### Routing

What a request can ask for comes from the catalog, not from the client: every operation an approved
publisher's models offer is a task, described in its own `when` sentence. System 1 (the router
release) answers one multiple-choice question, "What does the person mainly want done with
`request`?", whose options are those tasks plus three general requests no model is assumed to do:
`answer`, `translation` and `reply` (a release offering a task with the same ID replaces the general
one). A general request runs on online help when the person allowed it, and is otherwise reported as
not possible on this device.

- System 1 is calibrated for up to 10 options per question. With more tasks, they compete in groups of
  at most 10, kept in category order, and the winners meet the general requests in a final question.
- A request that opens with an instruction naming several tasks ("Categorize and summarize this
  message: …") has each part read on its own; one choice finds one task, and System 1's yes/no and
  "what else?" questions proved unreliable for finding a second one. A part that is a bare verb
  borrows what a later part acts on ("Convert and resize this video" reads "Convert this video").
  Without an instruction, or when no part is clear, the whole request is read.
- A task is chosen at a probability of 0.5 or more; below that, the person picks from the three
  likeliest.
- When several models offer the chosen task with different `when` sentences, System 1 picks the one
  that fits the request, if it clearly prefers one (0.5 or more, and twice the runner-up). Otherwise,
  and when they say the same, the catalog order decides: a model already downloaded, then the smallest.
- When a model answers its `decline`, the step moves to the next likeliest task from the same reading
  (0.15 or more) that a model here offers, then to online help.

`packages/router` implements this, and `tests/integration/router-laya.test.ts` runs it against the real
router release.

## Catalog archive (`schema: wexare.micromodel.catalog/0.1`)

A ZIP whose member names are restricted to the following:

| Member | Content |
| --- | --- |
| `catalog.json` | Inventory: `builder_pubkey`, `build_time`, `collection_policy`, `release_schema_versions`, `record_count`, `coverage`, and `files[]` (path, size, sha256 of each other member) |
| `releases.jsonl` | Original signed events, one canonical envelope per line, sorted by event ID |
| `catalog.sqlite` | Optional convenience database generated from exactly those records. Clients may ignore it. |

`coverage.relays[]` states, per relay, `caught-up`, `possibly-incomplete` (with notes),
`unavailable` or `never-connected`, plus `events` and `last_success_at`. The statement never claims
global completeness.

### Archive announcement (kind 1063)

Tags: `t=wexare-micromodel-catalog`, `m=application/zip`, `x` (ZIP SHA-256), `size`, `url` / `fallback`
(IPFS, HTTP), `magnet` (torrent, with `ws=` web seeds and `xs=` metadata), `wexare-catalog=0.1`, and `alt`.

### Import rules (A05, A09)

1. Verify the announcement signature. Show the builder key, which the user decides whether to trust.
2. Fetch from any location, then verify the exact ZIP size and SHA-256.
3. Enforce limits before inflating: 64 MiB ZIP, 256 MiB declared uncompressed, 200,000 records. Reject
   unexpected, duplicate or traversal entry names.
4. Validate the inventory schema, check that every member's hash matches it, and check that
   `builder_pubkey` matches the announcement signer.
5. Verify every release event exactly as if it came from a relay.
6. Stage, then commit atomically. A rejected archive changes nothing.

## Publisher definition (CLI input)

`wexare release prepare --definition <file> --key <key> --out <dir>` reads:

```json
{
  "manifest": {
    "model_id": "story-base",
    "name": "Bedtime story base (stories15M MoE F16)",
    "description": "…",
    "version": "1.0.0",
    "kind": "model",
    "capabilities": ["text-generation"],
    "languages": ["en"],
    "license": { "id": "MIT", "attribution": "…" },
    "runtime": { "format": "gguf", "family": "wllama", "requirement": ">=3.8.1 <3.9.0", "browser_features": ["wasm-simd"], "chat_template": { "source": "none" } },
    "operations": [{
      "id": "text-generation", "title": "Continue the text", "category": "writing", "when": "continue a story or a piece of text",
      "prompt": { "mode": "completion", "template": "{{text}}" }, "generation": { "max_tokens": 24, "temperature": 0, "top_k": 1 },
      "output": { "type": "text" }
    }],
    "requirements": { "context_length": 256, "hardware_profiles": ["cpu-wasm"] }
  },
  "files": [
    {
      "role": "weights",
      "path": "stories15M_MOE-F16.gguf",
      "source": "./models/stories15M_MOE-F16.gguf",
      "urls": ["https://huggingface.co/…/resolve/<commit>/stories15M_MOE-F16.gguf"]
    }
  ],
  "locations": ["mirror", "ipfs", "torrent"]
}
```

- `schema`, file sizes, hashes and locations are filled in by the CLI from the real bytes. `source` is
  resolved relative to the definition file.
- `urls` (optional, per file) lists addresses that already serve the exact bytes over HTTPS, such as a
  Hugging Face `resolve/<commit>/` link (a commit, not a branch, so the bytes never change). They come
  first among the file's locations, as `https` (or loopback `http` in development). Before signing, the
  CLI downloads each one and refuses it unless the size and SHA-256 match the local file and the response
  allows cross-origin reads (`Access-Control-Allow-Origin`); `--no-check-urls` skips the download.
- `locations` (optional) chooses where the CLI publishes the bytes itself: `mirror` (an artifact root
  served by `apps/artifacts` or any static host, at `<mirror>/<name>/sha256/<hash>`), `ipfs` (Kubo add +
  pin), and `torrent` (`.torrent` + magnet, web-seeded from the mirror). `missing-mirror` and
  `corrupt-mirror` exist for failure fixtures only. A file needs at least one `url` or location. Only the
  storage a definition names is used, and the manifest copies (`url`/`fallback` tags) go to that same
  storage; the manifest itself always travels inside the event.
- Defaults for `--mirror-url`, `--mirror-root`, `--ipfs-api`, `--tracker` and `release publish --relay`
  come from `WEXARE_*` variables when any is set (see `infra/deploy/publisher.env.example`), and from the
  local development services otherwise.
- LoRAs pass `--base-event <base event.json>`. The CLI copies the base's release ID, manifest hash and
  weight hashes into `base`.

The demo fixtures in [`fixtures/releases/`](../fixtures/releases/) use a shorter form that
`pnpm demo:prepare` expands, naming a pinned fixture model instead of a file path.

## Keys

- Keys are generated locally (`wexare keygen`) and stored as JSON with mode 0600. The CLI never prints
  the secret.
- Private keys never enter manifests, events, archives, browser bundles, exported browser
  configuration, or logs.
- The demo keys under `.data/keys/` are disposable local credentials.
