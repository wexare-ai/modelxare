# Deploying modelXare

How to put the simple app (modelXare) on the internet with your own domains, as weXare does or as
anyone can with their own copy of this repository. No domain or key is written into the code: the app
reads its addresses from build environment variables and its approved publishers from a file, the
publishing CLI reads `WEXARE_*` variables, and the optional server its `.env`. The examples are
weXare's deployment; replace its names and key with yours.

It starts with no server at all:

| Piece | Where it runs | Example address |
| --- | --- | --- |
| The app (`apps/simple`), static files | Vercel, or any static host | `https://modelxare.wexare.com` |
| Relays, where releases are announced | Public Nostr relays | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net` |
| Model files | Hugging Face, at exact commits | `https://huggingface.co/…/resolve/<commit>/…` |

[Later](#later-add-your-own-server), your own relay, IPFS gateway and file mirror can join them, on one
small server. Nothing about the releases or the app's code changes: the new relay is added to the list
and the releases already published are sent to it too.

Public relays are safe to rely on here because they only pass signed releases along: every browser checks
each release's signature and every file's bytes, and a deployed app shows only approved publishers
([`infra/publishers.json`](../infra/publishers.json)) and asks relays only for their releases, so other
people's events on those relays never reach it. The System 1 router is taken only from a publisher
approved for it. The build stops until that file lists at least one key.

What you don't control on a public relay is how long it keeps events, its rules and its uptime. That is
why releases go to several relays, the app reconnects to each one by itself, and the signed releases are
kept so they can be sent again ([Upkeep](#upkeep)). Before choosing relays, these were checked (read only,
2026-11-07): Damus, nos.lol and Primal answer the app's queries (kind 1063, by `t` tag and by author),
store kind 1063 events, run strfry like the development relays, and accept messages far larger than a
release (under 4 KB). Whether each one accepts modelXare's releases is confirmed by the first publish:
`release publish` reports the outcome per relay.

## 1. Keys

On a machine you trust (not a server, not CI):

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

The file in this repository lists weXare's key, for weXare's deployment. For your own, replace that
entry with yours, or add yours next to it to also show weXare's releases. To keep the file untouched,
point `WEXARE_PUBLISHERS` at another list.

## 2. The app on Vercel

1. Import the repository into Vercel. Vercel finds several apps in it and offers to group them as
   **Services** or to import one alone: do neither. Keep the **Root Directory** at `./` and set
   **Application Preset** to **Other**. `vercel.json` there installs only the simple app's packages,
   builds it, and sends the headers it needs (`Cross-Origin-Opener-Policy` and
   `Cross-Origin-Embedder-Policy` for multithreaded inference, and caching); importing `apps/simple`
   alone would leave those headers out.
2. Node.js 22 needs no setting: Vercel follows `engines` in `package.json`.
3. **Environment Variables** (on the import screen, later under Settings; Production and Preview), from
   [`infra/deploy/app.env.example`](../infra/deploy/app.env.example):

   | Variable | Example |
   | --- | --- |
   | `WEXARE_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` |
   | `WEXARE_ARWEAVE_GATEWAYS` | `https://arweave.net` |
   | `WEXARE_APPROVAL_REQUEST` | an `https://` or `mailto:` link where publishers ask for approval |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (Vercel then uses the repository's pnpm version) |

   `WEXARE_IPFS_GATEWAYS` is only needed once releases have `ipfs://` locations. The build checks every
   setting: a non-`wss://` relay, a non-`https://` gateway, or no approved publisher stops it with a list
   of what to fix.
4. **Settings → Domains:** add `modelxare.wexare.com` and create the DNS record Vercel shows.

Any other static host works too: build with the same variables set
(`pnpm install --filter @wexare/simple...` then `pnpm --filter @wexare/simple build`), serve
`apps/simple/dist`, and send the headers listed in `vercel.json`.

To try a deployment build locally first:

```sh
set -a; . infra/deploy/app.env; set +a      # your copy of app.env.example
pnpm --filter @wexare/simple build && pnpm --filter @wexare/simple preview
```

## 3. Publish the models

From the repository root, on the machine with the key, all in one terminal (the settings loaded from
`publisher.env` last only for it):

```sh
cp infra/deploy/publisher.env.example infra/deploy/publisher.env   # the same relays as the app
set -a; . infra/deploy/publisher.env; set +a
pnpm cli demo export --out deploy-releases     # 5 definitions: router, story model, its style add-on, 2 text models
```

Then prepare each release, in this order (the style add-on needs its base first):

```sh
for n in laya-router story-base tiny-summarizer community-assistant; do
  pnpm cli release prepare --definition deploy-releases/$n.json --key wexare.key.json --out deploy-releases/out/$n || break
done
pnpm cli release prepare --definition deploy-releases/shakespeare-lora.json --key wexare.key.json \
  --out deploy-releases/out/shakespeare-lora --base-event deploy-releases/out/story-base/event.json
```

`prepare` downloads each Hugging Face link and checks it serves the exact bytes and lets browsers read
it (1.8 GB in all; `--no-check-urls` skips that), then signs. Publish:

```sh
for n in laya-router story-base shakespeare-lora tiny-summarizer community-assistant; do
  pnpm cli release publish --event deploy-releases/out/$n/event.json || break
done
```

Each relay's answer is printed: `accepted` (or `duplicate`, already there) is what you want. A relay that
rejects the releases should come out of `WEXARE_RELAYS`, in Vercel and in `publisher.env`; one accepting
relay is enough to work, three give room for one to fail.

These are the sample models, linked to their Hugging Face commits. Your own models take the same
`release prepare` and `release publish` steps with your own definitions: the simple app's **Xare your
model** page has a starter file, and [protocol.md](protocol.md#publisher-definition-cli-input) describes every field.

Keep `deploy-releases/out/*/event.json`: they are the signed releases, needed to send them again. The
folder holds no key, and Git ignores it.

## 4. Check it end to end

In a private window on another network: open the app, choose **Try modelXare**, wait for the dot next to the logo to say online,
open a model, run it (the first run downloads and checks it), and try an example request on the home page
(this downloads the 904 MB router). **About this model** names the publisher.

## Upkeep

- **Send releases again, monthly, and after adding a relay.** Public relays may drop old events. Sending
  the same signed release again changes nothing where it is still kept (`duplicate`) and restores it where
  it isn't:

  ```sh
  for f in deploy-releases/out/*/event.json; do pnpm cli release publish --event "$f"; done
  ```

- **Backups:** the key files, offline, and `deploy-releases/out/`.
- **Monitoring:** open the app from outside now and then; the dot next to the logo shows whether it
  reaches at least one relay.
- **Removing a publisher:** delete their entry and push; their releases disappear from the app on its next
  load.

## Later: add your own server

Your own relay keeps releases as long as you decide, and your own mirror and IPFS gateway give the files a
second source next to Hugging Face. [`infra/deploy/server/`](../infra/deploy/server/) runs all three on
one machine, behind Caddy (a web server that gets the HTTPS certificates by itself). Any Linux machine
with Docker Compose works; two CPUs, 4 GB of memory and 40 GB of disk are enough to start.

1. Point DNS at the server: A (and AAAA) records for `relay`, `ipfs` and `models`.
2. Open ports 80 and 443 (TCP, plus UDP for 443) for HTTPS, and 4001 (TCP and UDP) for IPFS peers.
   Nothing else: the IPFS admin API listens on the server's loopback only.
3. Copy `infra/deploy/server/` to the server, then:

   ```sh
   cp .env.example .env     # set RELAY_DOMAIN, IPFS_DOMAIN, MODELS_DOMAIN (hostnames only), RELAY_CONTACT
   docker compose up -d --build
   curl -H 'Accept: application/nostr+json' https://relay.wexare.com   # the relay's name and contact
   ```

What it enforces:

- **Relay:** keeps only modelXare releases (kind 1063, `t=wexare-micromodel` or `t=wexare-micromodel-catalog`)
  and refuses an address sending more than `RELAY_EVENTS_PER_MINUTE` events (30 by default). Anyone may
  publish; the app decides whose releases it shows.
- **IPFS:** the gateway serves only what this node pins (`Gateway.NoFetch`), never other content.
- **Mirror:** serves only `<name>/sha256/<hash>` and `<name>/torrents/<infohash>.torrent` files from
  `MODELS_DIR`, readable from any site, cached as immutable. Everything else is 404.

### Add your own relay

1. Add `wss://relay.wexare.com` to `WEXARE_RELAYS` in Vercel (Vercel redeploys) and in `publisher.env`.
2. Send the existing releases to it: the loop in [Upkeep](#upkeep), or only to the new relay with
   `--relay wss://relay.wexare.com`.

### Add your own copies of the files

A file's locations are part of its signed release, so copies come with a new version of each model.
Raise `version` in each definition (for example to `1.0.1`): the same version with different locations
would be a second, conflicting release.

```sh
# in publisher.env: WEXARE_MIRROR_URL, and WEXARE_IPFS_API for IPFS
ssh -N -L 5101:127.0.0.1:5001 <server> &          # the server's IPFS admin API, for --location ipfs
pnpm cli demo export --out deploy-releases --location mirror --location ipfs
# raise each definition's version, prepare as in step 3, then upload the mirror's files before publishing:
rsync -a --info=progress2 .data/deploy-mirror/sha256 .data/deploy-mirror/torrents <server>:<server dir>/models/main/
```

Set `WEXARE_IPFS_GATEWAYS` in Vercel (e.g. `https://ipfs.wexare.com,https://ipfs.io`) once releases
have `ipfs://` locations. On the server, back up the relay's database (`relay-db` volume) and
`MODELS_DIR`; images are pinned by digest in `docker-compose.yml`, so update them deliberately.

## Not covered yet

- Community approvals: signed approval lists from curators the app trusts, added as another source in
  `apps/simple/src/trust.ts`.
- The PoC app (`apps/web`), the indexer, catalog archives and torrents. They work with the same
  variables but aren't part of this deployment.
