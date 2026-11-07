# Deploying modelXare

How to put the simple app (modelXare) on the internet with your own domains. No domain is written into
the code: the app reads its addresses from build environment variables, the server from its `.env`, and
the publishing CLI from `WEXARE_*` variables. The examples below use weXare's names; replace them with
yours.

| Piece | Where it runs | Example address |
| --- | --- | --- |
| The app (`apps/simple`), static files | Vercel | `https://modelxare.wexare.com` |
| Relay (strfry), where releases are announced | One small server, behind Caddy | `wss://relay.wexare.com` |
| IPFS gateway (Kubo), weXare's pinned copies | Same server | `https://ipfs.wexare.com` |
| File mirror, weXare's own copies of model files | Same server | `https://models.wexare.com` |
| Model files, first choice | Hugging Face, at exact commits | `https://huggingface.co/…/resolve/<commit>/…` |

Browsers download each file from the first location that answers, and check every byte against the
signed release, so the mirror and IPFS are fallbacks when Hugging Face is unreachable. The indexer,
catalog archives and torrents are not needed: the simple app reads releases straight from the relay.

A deployed app lists only approved publishers ([`infra/publishers.json`](../infra/publishers.json)), and
takes the System 1 router only from a publisher approved for it. The build stops until that file lists
at least one key.

## 1. Keys

On a machine you trust (not the server, not CI):

```sh
pnpm cli keygen --out wexare.key.json --label weXare
```

It prints the public key (`pubkey`, 64 hex characters) and its `npub`. Back the key file up offline:
whoever holds it can publish as weXare, and a lost key can't be recovered. The disposable demo keys in
`.data/keys/` must never be used for a deployment.

Add the public key to `infra/publishers.json`, then commit and push:

```json
{
  "publishers": [{ "pubkey": "<64 hex characters>", "label": "weXare", "approvedBy": "weXare", "roles": ["models", "router"] }]
}
```

`roles`: `models` lists the publisher's models; `router` lets them provide the System 1 router. To approve
another publisher later, they send you the output of `pnpm cli pubkey --key <their key>`, you add an
entry (usually `"roles": ["models"]`), and push. Vercel redeploys on its own.

## 2. Server: relay, IPFS and mirror

Any Linux machine with Docker Compose works. Two CPUs, 4 GB of memory and 40 GB of disk are enough to
start. weXare's own copies of the five demo models take 1.8 GB.

1. Point DNS at the server: A (and AAAA) records for `relay`, `ipfs` and `models`.
2. Open ports 80 and 443 (TCP, plus UDP for 443) for HTTPS, and 4001 (TCP and UDP) for IPFS peers.
   Nothing else: the IPFS admin API listens on the server's loopback only.
3. Copy [`infra/deploy/server/`](../infra/deploy/server/) to the server, then:

   ```sh
   cp .env.example .env     # set RELAY_DOMAIN, IPFS_DOMAIN, MODELS_DOMAIN (hostnames only), RELAY_CONTACT
   docker compose up -d --build
   ```

   Caddy gets the HTTPS certificates on its own once DNS points at the server.
4. Check it:

   ```sh
   curl -H 'Accept: application/nostr+json' https://relay.wexare.com   # the relay's name and contact
   curl -I https://models.wexare.com/main/sha256/<a file's sha256>     # 200 after step 4 of "Publish"
   ```

What the server enforces:

- **Relay:** keeps only modelXare releases (kind 1063, `t=wexare-micromodel` or `t=wexare-micromodel-catalog`)
  and refuses an address sending more than `RELAY_EVENTS_PER_MINUTE` events (30 by default). Anyone may
  publish; the app decides whose releases it shows.
- **IPFS:** the gateway serves only what this node pins (`Gateway.NoFetch`), never other content.
- **Mirror:** serves only `<name>/sha256/<hash>` and `<name>/torrents/<infohash>.torrent` files from
  `MODELS_DIR`, readable from any site, cached as immutable. Everything else is 404.

## 3. The app on Vercel

1. Import the repository into Vercel. Keep the **Root Directory** at the repository root: `vercel.json`
   there installs only the simple app's packages, builds it, and sends the headers it needs
   (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` for multithreaded inference, and
   caching).
2. **Settings → General → Node.js Version:** 22.x.
3. **Settings → Environment Variables** (Production and Preview), from
   [`infra/deploy/app.env.example`](../infra/deploy/app.env.example):

   | Variable | Example |
   | --- | --- |
   | `WEXARE_RELAYS` | `wss://relay.wexare.com` |
   | `WEXARE_IPFS_GATEWAYS` | `https://ipfs.wexare.com,https://ipfs.io` |
   | `WEXARE_ARWEAVE_GATEWAYS` | `https://arweave.net` |
   | `WEXARE_APPROVAL_REQUEST` | an `https://` or `mailto:` link where publishers ask for approval |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (Vercel then uses the repository's pnpm version) |

   The build checks them: a non-`wss://` relay, a non-`https://` gateway, or no approved publisher stops
   it with a list of what to fix.
4. **Settings → Domains:** add `modelxare.wexare.com` and create the DNS record Vercel shows.

To try a deployment build locally first:

```sh
set -a; . infra/deploy/app.env; set +a      # your copy of app.env.example
pnpm --filter @wexare/simple build && pnpm --filter @wexare/simple preview
```

## 4. Publish weXare's models

From the repository root, on the machine with the key:

```sh
cp infra/deploy/publisher.env.example infra/deploy/publisher.env   # set your addresses
set -a; . infra/deploy/publisher.env; set +a
pnpm cli demo export --out deploy-releases           # 5 definitions: router, story model, its style add-on, 2 text models
ssh -N -L 5101:127.0.0.1:5001 <server> &             # the server's IPFS admin API (WEXARE_IPFS_API), for the ipfs copies
```

Then for each release, in this order: `laya-router`, `story-base`, `shakespeare-lora`, `tiny-summarizer`,
`community-assistant`:

```sh
pnpm cli release prepare --definition deploy-releases/<name>.json --key wexare.key.json --out deploy-releases/out/<name>
# shakespeare-lora also takes: --base-event deploy-releases/out/story-base/event.json
```

`prepare` downloads each Hugging Face link and checks it serves the exact bytes (`--no-check-urls`
skips that), pins the files on the server's IPFS node through the tunnel, and puts the mirror's copies in
`WEXARE_MIRROR_ROOT` (`.data/deploy-mirror` by default). Upload those before publishing, so every
location answers when the release appears:

```sh
rsync -a --info=progress2 .data/deploy-mirror/sha256 .data/deploy-mirror/torrents <server>:<server dir>/models/main/
for n in laya-router story-base shakespeare-lora tiny-summarizer community-assistant; do
  pnpm cli release publish --event deploy-releases/out/$n/event.json
done
```

`pnpm cli demo export --location mirror` leaves IPFS out; then the tunnel and `WEXARE_IPFS_API` aren't
needed. The
`deploy-releases` folder holds no key, but keep it out of Git with the rest of the outputs.

## 5. Check it end to end

In a private window on another network: open the app, wait for the dot next to the logo to say online,
open a model, run it (the first run downloads and checks it), and try an example request on the home page
(this downloads the 904 MB router). **About this model** names the publisher.

## Upkeep

- **Backups:** the key files (offline), the relay's database (`relay-db` volume), and `MODELS_DIR`.
  IPFS pins can be redone from the same files.
- **Updates:** images are pinned by digest in `docker-compose.yml`; change them deliberately.
- **Monitoring:** check `https://relay.…` (NIP-11 answer), one known mirror file and one known IPFS CID,
  and the app itself, from outside.
- **Abuse:** the relay accepts any modelXare release but the app shows approved publishers only. Remove a
  publisher by deleting their entry and pushing; their releases disappear from the app on its next load.

## Not covered yet

- Community approvals: signed approval lists from curators the app trusts, added as another source in
  `apps/simple/src/trust.ts`.
- The PoC app (`apps/web`), the indexer, catalog archives and torrents. They work with the same
  variables but aren't part of this deployment.
