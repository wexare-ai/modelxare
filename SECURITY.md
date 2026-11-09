# Security

## Reporting a vulnerability

Email **hello@wexare.com** with "Security" in the subject. Please don't open a public issue, pull
request or discussion for a vulnerability.

Include what you can of:

- what an attacker can do, and against whom: visitors of a deployed app, publishers, or someone running
  the server stack;
- the steps to reproduce it, with the commit you tested;
- any signed event, release definition or file that shows it. Never send a private key you care about:
  make a throwaway one with `pnpm cli keygen`.

We'll confirm we received your report, keep you posted while we fix it, and credit you when the fix is
published if you'd like. Please give us a reasonable time to fix it before you disclose it.

## Supported versions

modelXare is a proof of concept. Only the latest commit on `main` is supported, and fixes land there.

## What modelXare guarantees

A report that breaks any of these is in scope:

- **Every release is signed.** The apps run nothing from a release whose signature, schema or tags
  don't verify (see [docs/protocol.md](docs/protocol.md)).
- **Every byte is checked.** Model files, adapters and catalog snapshots are refused unless their size
  and SHA-256 match the signed manifest, whichever source served them: Hugging Face, a mirror, IPFS, a
  torrent or the browser's own storage.
- **A deployed app shows only approved publishers.** It lists models only from keys in its approved
  publishers list, and takes the router only from a key approved for that role.
- **Private keys stay with the publisher.** The CLI writes key files readable only by their owner and
  prints only public keys. No private key goes into a manifest, an event, an archive, a browser bundle
  or a log.
- **Online help keys stay in the browser.** An API key for online help is kept in that browser's local
  storage, sent only to the service the person chose, only in the `Authorization` header, and never
  shown in errors, logs or exports.
- **Requests stay on the device.** Nothing a person types leaves the browser unless they turn on online
  help, and the apps send no analytics.
- **The local runtime's API stays local.** `modelxare serve` ([docs/local.md](docs/local.md)) listens
  on this machine only unless it is given an API key. It answers no web page from another origin
  unless allowed, accepts only localhost `Host` names on loopback, and never logs requests or answers.
- **The server stack** in [`infra/deploy/server`](infra/deploy/server) keeps only modelXare releases on
  its relay, serves only files it pins or mirrors, and keeps the IPFS admin API off the network.

Also in scope: script injection through release metadata (names, descriptions, links), path traversal
in the CLI, mirror or indexer, and anything that lets one publisher pass as another.

## Out of scope

- **What a model says or does.** A signature proves who published a release and that its bytes are
  intact, not that the model is safe or good. Deployments decide whom to approve.
- **Availability.** Public relays, Hugging Face and IPFS gateways can drop, withhold or rate-limit
  data. The apps keep working from any source left and say when none answers, but they can't make a
  source serve.
- **Third-party services**, such as the public Nostr relays, Hugging Face, Vercel or an online help
  provider. Report their issues to them.
- **Denial of service** by flooding public relays or gateways, and findings that need a compromised
  device or browser.

## If a publisher key is exposed

Tell us at the same address. For weXare's deployment, we remove the key from
[`infra/publishers.json`](infra/publishers.json), and the app stops showing its releases on its next
load. Operators of other deployments do the same in their own list.
