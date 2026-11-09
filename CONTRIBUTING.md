# Contributing

Thanks for helping with modelXare. It's a proof of concept of a decentralized AI model platform, so
the code changes quickly. Questions, bug reports and pull requests are all welcome. For anything
larger than a fix, open an issue first so we can agree on the approach before you spend time on it.

Questions that don't fit an issue: **hello@wexare.com**. Security problems: see
[SECURITY.md](SECURITY.md), never a public issue.

## Set up

Follow the [README](README.md#prerequisites): Node.js 22, pnpm through Corepack, and Docker for the
local relays, IPFS nodes and tracker. Then:

```sh
pnpm install
pnpm infra:up       # local relays, IPFS nodes and tracker
pnpm demo:prepare   # demo keys, model fixtures (1.87 GB, from Hugging Face), releases
pnpm dev            # the apps and local services, with live logs
```

Everything runs locally. No account, API key or weXare service is needed.

## Before you open a pull request

```sh
pnpm typecheck
pnpm test           # unit tests, nothing needs to be running
pnpm test:e2e       # browser acceptance tests, after infra:up and demo:prepare
```

Run `pnpm test:e2e` when you change anything a browser sees or that talks to relays, storage or the
indexer. `pnpm test:models` (real models in the browser, about 0.9 GB), the `WEXARE_TEST_LAYA=1`
router checks (4 to 5 GB of free memory) and `WEXARE_TEST_LOCAL=<data folder>` (the local runtime's
API with real models, about 4 GB) are opt-in; say in the pull request if you ran them. In the
description, say what you changed and why, how you checked it, and anything you couldn't check.

## Rules the code keeps

- **No secrets or large files in Git.** Private keys, model files, archives, databases and `.env`
  files stay out of the repository; `.data/` holds them locally and is ignored. Tests use the public
  test keys in `packages/protocol/vectors/` or keys they generate.
- **No hard-coded addresses.** A new endpoint or deployment setting is a `WEXARE_*` variable,
  checked at build or start time with a clear message, with its local default in
  `infra/dev-endpoints.json` and an example in `infra/deploy/*.example` and
  [docs/deployment.md](docs/deployment.md).
- **Real evidence.** Mock events and fake weights belong only in isolated unit tests. Acceptance tests
  and demonstrations use the real services and real model files, and a check that didn't run is
  reported as not run, never as passed.
- **Verify before use.** Nothing from a relay, mirror, gateway or peer is trusted until its signature
  and hashes check out. New download paths go through the same verification.
- **Privacy by default.** No analytics, and nothing a person types leaves the device unless they turn
  on online help with their own key. That key lives only in the browser's local storage and travels
  only in the `Authorization` header.
- **Protocol compatibility.** Event kinds, tags and manifest fields are a contract with releases
  already published. Change them only with [docs/protocol.md](docs/protocol.md), the schemas and the
  test vectors in `packages/protocol`, and in a way existing releases still verify.
- **Pinned dependencies.** Exact versions only, and Docker images pinned by digest. Some pins are
  load-bearing: the LoRA path depends on wllama 3.8.1's internals, and the router on the
  `onnxruntime-web` version in `pnpm-workspace.yaml` (and `onnxruntime-node` in `apps/local` on the
  same version).
- **Plain words in the simple app.** `apps/simple` is for people without a technical background: no
  keys, hashes, relays or storage terms on screen. The PoC app (`apps/web`) can show the machinery.

## Commits

Write the subject as an imperative sentence that says what changes for the person using it, such as
"Check the publisher key before hashing a release's files". Use the body for why. Keep each commit
to one change that builds and passes its tests.

## License

modelXare is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution
is licensed under the same terms (section 5 of the license). Model fixtures keep their own licenses,
listed in `fixtures/models.json`. The weXare and modelXare names and logos aren't covered by the
license; see [NOTICE](NOTICE).
