// Browser inference through the bundled wllama runtime. wllama runs llama.cpp
// in its own Web Worker; this wrapper only ever receives verified Blobs.
import { Wllama } from '@wllama/wllama/esm/index.js';
import wllamaPkg from '@wllama/wllama/package.json';
import type { ChatTemplateConfig } from '@wexare/protocol';
import { ADAPTER_VALIDATED_VERSIONS, WLLAMA_VERSION } from './support.ts';

export interface AdapterInput {
  /** Verified adapter bytes. */
  blob: Blob;
  sha256: string;
  scale: number;
}

export interface LoadRequest {
  /** Stable identity of what is loaded (e.g. sorted file hashes + adapter hashes). */
  key: string;
  weights: Blob[];
  adapters?: AdapterInput[];
  contextLength: number;
  chatTemplate?: ChatTemplateConfig;
  threads?: number;
}

export interface GenerateRequest {
  mode: 'chat' | 'completion';
  system?: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  stop?: string[];
  /** GBNF grammar the client builds from an operation's labels; never grammar text taken from metadata. */
  grammar?: string;
  /** Per-request adapter scales by adapter index; omitted adapters run at scale 0. */
  adapterScales?: number[];
  signal?: AbortSignal;
  onToken?: (textSoFar: string) => void;
}

export interface GenerateResult {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  ms: number;
  finishReason: string | null;
}

export interface LoadInfo {
  key: string;
  ms: number;
  multithread: boolean;
  threads: number;
  architecture: string | null;
  /** Native llama.cpp log lines confirming adapter initialization. */
  adapterEvidence: string[];
  adapters: { sha256: string; path: string; scale: number }[];
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code: 'load_failed' | 'out_of_memory' | 'unsupported_architecture' | 'adapter_unavailable' | 'generation_failed' | 'canceled',
  ) {
    super(message);
  }
}

function classify(e: unknown, fallback: RuntimeError['code']): RuntimeError {
  const msg = (e as Error)?.message ?? String(e);
  if (/abort/i.test(msg)) return new RuntimeError('canceled', 'canceled');
  if (/memory|OOM|allocation|Cannot enlarge/i.test(msg)) return new RuntimeError(`out of memory: ${msg}`, 'out_of_memory');
  if (/unknown model architecture|unsupported/i.test(msg)) return new RuntimeError(`unsupported model: ${msg}`, 'unsupported_architecture');
  return new RuntimeError(msg, fallback);
}

/**
 * wllama's public loadModel() mounts every blob as a model shard, so there is
 * no public way to place an adapter in the WASM filesystem. On validated
 * versions we intercept the private worker proxy to append adapter files to
 * moduleInit(); see docs/runtime-compatibility.md.
 */
function mountAdapterFiles(w: Wllama, files: { name: string; blob: Blob }[]): void {
  if (!ADAPTER_VALIDATED_VERSIONS.includes(wllamaPkg.version)) {
    throw new RuntimeError(`Adapter execution unavailable in this runtime (wllama ${wllamaPkg.version} not validated)`, 'adapter_unavailable');
  }
  const desc = Object.getOwnPropertyDescriptor(w, 'proxy');
  if (!desc || !('value' in desc) || desc.value !== null) {
    throw new RuntimeError('Adapter execution unavailable in this runtime (interception point not found)', 'adapter_unavailable');
  }
  let proxy: unknown = null;
  let patched = false;
  Object.defineProperty(w, 'proxy', {
    configurable: true,
    enumerable: true,
    get: () => proxy,
    set: (v: { moduleInit?: (f: { name: string; blob: Blob }[]) => Promise<void> } | null) => {
      if (v && !patched) {
        if (typeof v.moduleInit !== 'function') throw new RuntimeError('Adapter execution unavailable in this runtime (moduleInit missing)', 'adapter_unavailable');
        const orig = v.moduleInit.bind(v);
        v.moduleInit = (f) => orig([...f, ...files]);
        patched = true;
      }
      proxy = v;
    },
  });
}

export class WllamaRuntime {
  private w: Wllama | null = null;
  private info: LoadInfo | null = null;
  private readonly logLines: string[] = [];

  /**
   * @param wasmUrl bundled wllama.wasm URL
   * @param compat bundled @wllama/wllama-compat assets for browsers without JSPI/MEMORY64.
   *   wllama otherwise fetches them from a CDN; passing local URLs keeps every runtime asset in the app build.
   */
  constructor(
    private readonly wasmUrl: string,
    private readonly compat: { worker: string; wasm: string },
  ) {
    if (wllamaPkg.version !== WLLAMA_VERSION) console.warn(`wllama ${wllamaPkg.version} differs from pinned ${WLLAMA_VERSION}`);
  }

  get loaded(): LoadInfo | null {
    return this.info;
  }

  private logger() {
    const push = (level: string) => (...a: unknown[]) => {
      const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
      this.logLines.push(`${level} ${line}`);
      if (this.logLines.length > 4000) this.logLines.splice(0, 1000);
    };
    return { debug: push('D'), log: push('I'), warn: push('W'), error: push('E') };
  }

  recentLogs(n = 200): string[] {
    return this.logLines.slice(-n);
  }

  async load(req: LoadRequest): Promise<LoadInfo> {
    if (this.info?.key === req.key) return this.info;
    await this.unload();
    const t0 = performance.now();
    const w = new Wllama({ default: this.wasmUrl }, { logger: this.logger(), suppressNativeLog: false });
    w.setCompat(this.compat);
    const adapters = (req.adapters ?? []).map((a, i) => ({ ...a, name: `wexare-adapter-${i}.gguf` }));
    if (adapters.length) mountAdapterFiles(w, adapters.map((a) => ({ name: a.name, blob: a.blob })));
    const logStart = this.logLines.length;
    const threads = req.threads ?? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
    try {
      await w.loadModel(req.weights, {
        n_ctx: req.contextLength,
        n_gpu_layers: 0,
        n_threads: threads,
        ...(req.chatTemplate?.source === 'inline' ? { chat_template: req.chatTemplate.template } : {}),
        ...(adapters.length
          ? { lora_adapters: adapters.map((a) => ({ path: `/models/${a.name}`, scale: a.scale })), lora_init_without_apply: true }
          : {}),
      });
    } catch (e) {
      await w.exit().catch(() => undefined);
      throw classify(e, 'load_failed');
    }
    this.w = w;
    const evidence = this.logLines.slice(logStart).filter((l) => /llama_adapter_lora_init/.test(l));
    if (adapters.length && !evidence.some((l) => l.includes('loading lora adapter'))) {
      await this.unload();
      throw new RuntimeError('runtime did not confirm adapter initialization', 'adapter_unavailable');
    }
    let architecture: string | null = null;
    try {
      architecture = (w.getModelMetadata().meta['general.architecture'] as string) ?? null;
    } catch {
      architecture = null;
    }
    this.info = {
      key: req.key,
      ms: Math.round(performance.now() - t0),
      multithread: w.isMultithread(),
      threads,
      architecture,
      adapterEvidence: evidence.slice(0, 3),
      adapters: adapters.map((a) => ({ sha256: a.sha256, path: `/models/${a.name}`, scale: a.scale })),
    };
    return this.info;
  }

  async generate(r: GenerateRequest): Promise<GenerateResult> {
    const w = this.w;
    if (!w || !this.info) throw new RuntimeError('no model loaded', 'generation_failed');
    const t0 = performance.now();
    const sampling = {
      max_tokens: r.maxTokens,
      temperature: r.temperature ?? 0,
      ...(r.topK !== undefined ? { top_k: r.topK } : {}),
      ...(r.topP !== undefined ? { top_p: r.topP } : {}),
      ...(r.stop?.length ? { stop: r.stop } : {}),
      ...(r.grammar ? { grammar: r.grammar } : {}),
      // Per-request adapter state persists in llama.cpp when omitted, so always send it.
      ...(this.info.adapters.length ? { lora: this.info.adapters.map((_, i) => ({ id: i, scale: r.adapterScales?.[i] ?? 0 })) } : {}),
      ...(r.signal ? { abortSignal: r.signal } : {}),
    };
    let text = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let finish: string | null = null;
    try {
      if (r.mode === 'chat') {
        const messages = [...(r.system ? [{ role: 'system' as const, content: r.system }] : []), { role: 'user' as const, content: r.prompt }];
        await w.createChatCompletion({
          messages,
          ...sampling,
          stream: true,
          onData: (chunk: { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: typeof usage }) => {
            const c = chunk.choices?.[0];
            if (c?.delta?.content) {
              text += c.delta.content;
              r.onToken?.(text);
            }
            if (c?.finish_reason) finish = c.finish_reason;
            if (chunk.usage) usage = chunk.usage;
          },
        } as never);
      } else {
        await w.createCompletion({
          prompt: r.prompt,
          ...sampling,
          stream: true,
          onData: (chunk: { choices?: { text?: string; finish_reason?: string | null }[]; usage?: typeof usage }) => {
            const c = chunk.choices?.[0];
            if (c?.text) {
              text += c.text;
              r.onToken?.(text);
            }
            if (c?.finish_reason) finish = c.finish_reason;
            if (chunk.usage) usage = chunk.usage;
          },
        } as never);
      }
    } catch (e) {
      if (r.signal?.aborted) throw new RuntimeError('canceled', 'canceled');
      throw classify(e, 'generation_failed');
    }
    if (r.signal?.aborted) throw new RuntimeError('canceled', 'canceled');
    return {
      text,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      ms: Math.round(performance.now() - t0),
      finishReason: finish,
    };
  }

  async unload(): Promise<void> {
    const w = this.w;
    this.w = null;
    this.info = null;
    if (w) await w.exit().catch(() => undefined);
  }
}

/** GBNF grammar that only admits one of the given labels. */
export function choiceGrammar(labels: readonly string[]): string {
  const alts = labels.map((l) => JSON.stringify(l)).join(' | ');
  return `root ::= ${alts}`;
}
