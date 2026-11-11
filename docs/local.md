# Run modelXare on your own machine

`modelxare` runs the catalog's models natively, without the browser's memory limits, and serves them
behind an **OpenAI-compatible API** that agents and apps can use: OpenCode, Hermes Agent, OpenClaw,
the OpenAI SDKs, or anything that takes a base URL.

It uses the same signed releases, the same SHA-256 checks and the same approved publishers as the
app. Only the engines are different:

| | In the browser | `modelxare` |
| --- | --- | --- |
| Language models (System 2) | llama.cpp in WebAssembly (wllama) | native llama.cpp ([node-llama-cpp](https://node-llama-cpp.withcat.ai) 3.22.2), using Metal, CUDA or Vulkan when there is a GPU, else the CPU |
| Router (System 1) | Laya in ONNX Runtime Web | Laya in native ONNX Runtime (`onnxruntime-node` 1.30.0), with the same request rendering and calibration code (`@wexare/laya-web`) |
| Context | Each release's browser budget (1,024 tokens, for example) | The model's trained size, up to 32,768 tokens (`--ctx-size`) |

Your requests and the answers stay on your machine. The only network traffic is reading releases
from relays and downloading model files.

## Set up

You need Node.js 22 and pnpm (see the [README prerequisites](../README.md#prerequisites)), then:

```sh
pnpm install
```

`pnpm install` brings prebuilt llama.cpp and ONNX Runtime binaries for macOS, Linux and Windows:
about 1 GB on Linux x64, where the CUDA and Vulkan builds are included, and less elsewhere.

### Point it at a catalog

The settings are the same `WEXARE_*` variables as a deployed app. `infra/deploy/app.env.example`
holds weXare's public settings: the three public relays and `infra/publishers.json`. Pass it with
`--env`:

```sh
pnpm modelxare --env infra/deploy/app.env.example list
```

Without settings, `modelxare` reads the local development relays (`pnpm infra:up`) and shows every
validly signed release, like the apps. A copy of the file with your own relays and publishers works
the same way. The commands below leave out `--env`; add it to each one, or export the variables first:
`set -a; . infra/deploy/app.env.example; set +a`.

### Download, try, serve

```sh
pnpm modelxare list                  # what the catalog offers, and what is downloaded
pnpm modelxare pull auto             # the System 1 router and every model (about 1.9 GB)
pnpm modelxare run auto "Categorize and summarize this message: Hi Sam, because of a storm your flight to Lisbon on Friday will leave two hours late, at 16:40. Your seat and bags stay the same."
pnpm modelxare serve                 # http://127.0.0.1:8796/v1
```

`pull` takes model ids, `router` (the System 1 router) or `auto` (the router and every model).
Every file is checked against the SHA-256 in its signed release before it gets its final name, and
again the first time a server process loads it. Interrupted downloads resume.

| Command | What it does |
| --- | --- |
| `modelxare list` (`--all` also lists what can't run here, and why) | Reads the relays, then lists the models and the router, with what is downloaded |
| `modelxare pull <model…>` / `--all` | Downloads and verifies |
| `modelxare run <model> [text]` | Prints one answer in the terminal. The text comes from the arguments or stdin. With `auto`, it also prints System 1's verdicts and which model did each step |
| `modelxare serve` | Serves the OpenAI-compatible API |
| `modelxare rm <model…>` | Deletes a model's files, keeping files another downloaded model uses |

Files are kept under `~/.local/share/modelxare` (Linux), `~/Library/Application Support/modelxare`
(macOS) or `%LOCALAPPDATA%\modelxare` (Windows). Set `--home` or `WEXARE_LOCAL_HOME` to change that.
The folder holds `releases.json`, the signed release events (checked again every time they are
read), and `files/sha256/<hash>`.

### `serve` options

| Option | Default | |
| --- | --- | --- |
| `--host`, `--port` | `127.0.0.1`, `8796` (`WEXARE_LOCAL_HOST`, `WEXARE_LOCAL_PORT`) | Any host other than this machine requires `--api-key` |
| `--api-key <key>` | none (`WEXARE_LOCAL_API_KEY`) | Clients must then send `Authorization: Bearer <key>` |
| `--pull` | off | Downloads a catalog model the first time a request needs it. Without it, `/v1/models` lists only downloaded models |
| `--ctx-size <tokens>` | 32768 (`WEXARE_LOCAL_CONTEXT`) | Each model gets the smaller of this and its trained context |
| `--keep-loaded <n>` | 3 (`WEXARE_LOCAL_KEEP_LOADED`) | How many language models stay loaded at once; the least recently used is unloaded first |
| `--idle <minutes>` | 15 | Unloads everything after this long unused (0: never) |
| `--gpu <auto\|off\|metal\|cuda\|vulkan>` | `auto` (`WEXARE_LOCAL_GPU`) | The llama.cpp backend |
| `--general <model>` | the largest downloaded chat model | The model `auto` answers with when no specialist fits |
| `--max-tokens <n>` | 1024 | The longest answer when a request doesn't say |
| `--cors-origin <origin…>` | none | Web page origins allowed to call the API from a browser |
| `--offline` | off | Doesn't read the relays; serves the releases already saved here |

## The API

Base URL `http://127.0.0.1:8796/v1`. Clients that insist on an API key can send any string unless the
server has `--api-key`.

| Endpoint | |
| --- | --- |
| `GET /v1/models`, `GET /v1/models/{id}` | The models served, with `context_length` (also as `max_model_len`) and a `modelxare` block: name, tasks, license, size, release id |
| `POST /v1/chat/completions` | Supports streaming (SSE, with `stream_options.include_usage`), `tools`, `tool_choice` and `parallel_tool_calls`, and `response_format` (`json_object`, or `json_schema`, enforced by a grammar). Sampling: `temperature` (default 0.7), `top_p`, `top_k`, `min_p`, `seed`, `stop`, `max_tokens` or `max_completion_tokens`, `frequency_penalty`, `presence_penalty` |
| `POST /v1/completions` | Plain text continuation, streamed or not |
| `GET /health` | No key needed |

Errors use OpenAI's shape (`{"error": {"message", "type", "param", "code"}}`). A model that isn't
here returns 404 `model_not_found`, and one that isn't downloaded returns 404 `model_not_downloaded`.
Unknown paths return 404 too, so clients that probe for other servers (LM Studio, Ollama) don't
mistake this one for them.

Not supported:
- `n` greater than 1
- image and audio inputs (refused with a 400)
- `logprobs` (ignored)
- `/v1/responses`
- `/v1/embeddings`

Model ids are the releases' `model_id`s: `community-assistant`, `tiny-summarizer`, `story-base`,
`shakespeare-lora`, `git-commands`, `ffmpeg-commands`, `imagemagick-commands`, and `auto`. If two
publishers use the same `model_id`, each gets `@` and the start of its key. The text-only models
(`story-base`, and `shakespeare-lora` on top of it) have no chat format. A chat request to them
continues the last user message.

The command models are add-ons on the `community-assistant` weights, each trained with one system
prompt. When a request to one has no system message, it gets that prompt, so the user message alone
is enough:

```sh
curl http://127.0.0.1:8796/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "git-commands",
  "messages": [{"role": "user", "content": "undo my last commit but keep the changes"}]
}'
```

```sh
curl http://127.0.0.1:8796/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "tiny-summarizer",
  "messages": [{"role": "user", "content": "Summarize: your order of running shoes has shipped and will arrive on Wednesday."}]
}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8796/v1", api_key="local")
print(client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Summarize this message: …"}]).choices[0].message.content)
```

**Tool calls.** The tool's JSON Schema becomes a llama.cpp grammar, so a call always names an
offered tool and its arguments always parse. A few things to know:
- Grammars can't enforce everything in a JSON Schema. Patterns, number ranges and non-date formats
  are dropped, local `$ref`s are resolved, and anything left unclear accepts any JSON value.
- Every listed parameter is filled in, including optional ones.
- How well a model chooses when and what to call depends on the model. Qwen2.5 0.5B handles simple
  calls; don't expect more of it.

## `auto`: System 1 + System 2

`auto` does what the app's Ask box does, behind one model id:

1. System 1, the Laya router, reads the last user message, split into the tasks its instruction
   names (as in the app; see the [README](../README.md#routing-with-system-1)).
2. Each task with a specialist on this machine goes to that model. Sort goes to Qwen2.5 0.5B
   (`community-assistant`), summarize to SmolLM2 360M (`tiny-summarizer`), and write to
   `story-base`. A command goes to whichever command model System 1 picks from the releases'
   `routing` hints (`git-commands`, `ffmpeg-commands` or `imagemagick-commands`), run on its base.
   Each runs its catalog operation (prompt, grammar, output check), exactly as in the browser.
3. In these cases the general model (`--general`) answers the whole conversation instead, with its
   tools:
   - a task has no specialist (reply, translate, answer);
   - System 1 isn't sure;
   - the conversation continues after tool results.

The response carries what was decided, in a `modelxare` field that OpenAI clients ignore. It is in
the last chunk when streaming. A real run on a 4-core, 8 GB Linux machine, CPU only:

```json
"choices": [{"message": {"content": "Topic: Travel\nSummary: Your flight to Lisbon on Friday will leave two hours late at 16:40. Your seat and bags stay the same."}}],
"modelxare": {
  "answered_by": "specialists",
  "system1": {"router": "Laya System 1 router (English, fp16)", "latency_ms": 2832,
    "readings": [{"text": "Categorize", "choice": "sort", "probability": 0.9893},
                 {"text": "summarize this message", "choice": "summarize", "probability": 0.9932}]},
  "steps": [{"task": "sort", "model": "community-assistant", "output": "Travel", "ms": 8341},
            {"task": "summarize", "model": "tiny-summarizer", "output": "Your flight to Lisbon on Friday…", "ms": 7026}]
}
```

`"What is the capital of France?"` gives a different route. System 1 reads it as `answer` (0.77),
no specialist does that, so the response has `"answered_by": "general"`, with the reason and
`"general_model": "community-assistant"`.

## Use it from an agent

**Set expectations first.** Today's catalog models have 15 to 500 million parameters. They are good
at titles, summaries, sorting messages, short answers and simple tool calls. They are not a
replacement for a large model as a coding agent's main model. The best fit is an agent's small-model
slot (titles, recaps), or `auto` for tasks the catalog has specialists for.

Context sizes: `community-assistant` 32,768 tokens, `tiny-summarizer` 8,192, `story-base` 256.
Declare these honestly in agent configs: agents plan compaction around them.

The snippets below follow each project's documentation as of 2026-11-09. They were not run here:
only raw HTTP and the official OpenAI SDK were tested against this server
([acceptance](acceptance.md#local-runtime-and-openai-compatible-api-2026-11-09)).

### OpenCode

`opencode.json` in the project, or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "modelxare": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "modelXare (local)",
      "options": { "baseURL": "http://127.0.0.1:8796/v1" },
      "models": {
        "auto": { "name": "modelXare auto (System 1 + System 2)", "limit": { "context": 32768, "output": 4096 } },
        "tiny-summarizer": { "name": "Tiny summarizer", "limit": { "context": 8192, "output": 1024 } }
      }
    }
  },
  "small_model": "modelxare/tiny-summarizer"
}
```

`small_model` is what OpenCode uses for titles. OpenCode 2 also reads this format, and spells it
natively as `providers`, `package`, `settings` and `agents.title.model`
([providers](https://opencode.ai/docs/providers/)). Always set `limit.context`: without it, OpenCode
assumes 200K and won't compact in time.

### Hermes Agent

Hermes refuses a main model with less than 64K tokens of context, so the catalog's models can't be
its main model. They fit its auxiliary slots. In `~/.hermes/config.yaml`:

```yaml
auxiliary:
  title_generation:
    base_url: http://127.0.0.1:8796/v1
    model: tiny-summarizer
    api_key: local
```

Don't use them for `compression`. Hermes needs a compression model with at least the main model's
context, and drops turns silently otherwise. `hermes model` → "Configure auxiliary models" sets the
same thing interactively.

### OpenClaw

`~/.openclaw/openclaw.json` (JSON5):

```json5
{
  agents: { defaults: { utilityModel: "modelxare/tiny-summarizer" } },
  models: { mode: "merge", providers: { modelxare: {
    baseUrl: "http://127.0.0.1:8796/v1",
    api: "openai-completions",
    apiKey: "local",
    models: [
      { id: "auto", name: "modelXare auto", input: ["text"], contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "tiny-summarizer", name: "Tiny summarizer", input: ["text"], contextWindow: 8192, maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsTools: false } },
    ],
  }}},
}
```

To try `auto` as the main model, set `agents.defaults.model.primary: "modelxare/auto"`, and
`agents.defaults.experimental.localModelLean: true` to leave out OpenClaw's heaviest tools.

### Anything else

Most tools read the standard variables:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8796/v1 OPENAI_API_KEY=local
```

## Safety

- **Who can connect.** The server listens on `127.0.0.1`. Listening on another address requires
  `--api-key`, compared in constant time.
- **Web pages.** Pages in your browser can't use it:
  - Bodies must be `application/json`, so a cross-site request needs a CORS preflight, which is
    refused unless the origin is allowed with `--cors-origin`.
  - On loopback, only localhost `Host` names are answered (no DNS rebinding).
- **Logs.** Requests and answers are never logged, only the model, the route, the token count and
  the time taken.
- **What runs.** Only releases from approved publishers are listed and run. Every file must match
  its signed SHA-256 when it is downloaded, and again when a server first loads a file downloaded
  earlier. A file changed on disk is deleted, not loaded.

## Measured on a 4-core, 8 GB Linux machine without a GPU (2026-11-09)

| | |
| --- | --- |
| Peak memory, router + 3 models loaded | 3.7 GB |
| Router load / one reading | 6.8 s / 1.6–1.9 s |
| `auto`, sort + summarize, first request (loads 2 models, hashes their files once) | 13–21 s |
| Same, models already loaded | 4.0 s |
| `tiny-summarizer`, 28-token summary | 6.1 s, including its first load |
| `community-assistant` tool call / answer after the tool result | 4.5 s / 1.7 s |

## Limits

- Models split into several GGUF files aren't supported yet, and torrent-only file locations aren't
  downloaded here (https, IPFS and Arweave are).
- One request runs at a time; the others wait their turn.
- The router is English only, like in the app.
- Agents' tool loops need a model that chooses tools well. The catalog's models are small, so keep
  them to small jobs.
