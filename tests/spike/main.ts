// Compatibility spike page (spec §15 step 1). Driven by run-spike.ts through
// Playwright; exposes a few probes on window.spike and records native logs.
import { Wllama } from '@wllama/wllama';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';

const logs: string[] = [];
const fmt = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
const logger = {
  debug: (...a: unknown[]) => logs.push('D ' + fmt(a)),
  log: (...a: unknown[]) => logs.push('I ' + fmt(a)),
  warn: (...a: unknown[]) => logs.push('W ' + fmt(a)),
  error: (...a: unknown[]) => logs.push('E ' + fmt(a)),
};

async function fetchBlob(name: string): Promise<Blob> {
  const res = await fetch(`/fixture-models/${name}`);
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
  return await res.blob();
}

/**
 * wllama's public loadModel() mounts every blob as a model shard, so an adapter
 * cannot be placed in the WASM filesystem through the public API. This probe
 * intercepts the private worker proxy to append extra files to moduleInit().
 */
function mountExtraFiles(w: Wllama, extra: { name: string; blob: Blob }[]) {
  let proxy: any = (w as any).proxy;
  Object.defineProperty(w, 'proxy', {
    configurable: true,
    enumerable: true,
    get: () => proxy,
    set: (v: any) => {
      if (v && !v.__extraFilesPatched) {
        const orig = v.moduleInit.bind(v);
        v.moduleInit = (files: { name: string; blob: Blob }[]) => orig([...files, ...extra]);
        v.__extraFilesPatched = true;
      }
      proxy = v;
    },
  });
}

function newWllama() {
  return new Wllama({ default: wasmUrl }, { logger, suppressNativeLog: false });
}

const spike = {
  env() {
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hardwareConcurrency: navigator.hardwareConcurrency,
      webgpu: 'gpu' in navigator,
      opfs: typeof navigator.storage?.getDirectory === 'function',
    };
  },

  async chat(file: string, messages: any[], opts: Record<string, unknown>, load: Record<string, unknown> = {}) {
    const w = newWllama();
    const blob = await fetchBlob(file);
    const t0 = performance.now();
    await w.loadModel([blob], { n_ctx: 1024, n_gpu_layers: 0, ...load });
    const t1 = performance.now();
    const res: any = await w.createChatCompletion({ messages, ...opts } as any);
    const t2 = performance.now();
    const out = {
      text: res.choices[0].message.content as string,
      usage: res.usage,
      loadMs: Math.round(t1 - t0),
      genMs: Math.round(t2 - t1),
      multithread: w.isMultithread(),
      chatTemplate: (w as any).getChatTemplate?.() ?? null,
    };
    await w.exit();
    return out;
  },

  async loraProbe(mode: 'base' | 'load-applied' | 'per-request', prompt: string) {
    const w = newWllama();
    const base = await fetchBlob('stories15M_MOE-F16.gguf');
    const adapterName = 'wexare-adapter-0.gguf';
    if (mode !== 'base') {
      mountExtraFiles(w, [{ name: adapterName, blob: await fetchBlob('moe_shakespeare15M.gguf') }]);
    }
    const lora =
      mode === 'base'
        ? {}
        : {
            lora_adapters: [{ path: `/models/${adapterName}`, scale: 1.0 }],
            lora_init_without_apply: mode === 'per-request',
          };
    const before = logs.length;
    await w.loadModel([base], { n_ctx: 256, n_gpu_layers: 0, ...lora });
    const run = async (extra: Record<string, unknown>) => {
      const r: any = await w.createCompletion({ prompt, max_tokens: 24, temperature: 0, top_k: 1, ...extra } as any);
      return r.choices[0].text as string;
    };
    const result: Record<string, string> = {};
    if (mode === 'per-request') {
      result.scale0 = await run({ lora: [{ id: 0, scale: 0 }] });
      result.scale1 = await run({ lora: [{ id: 0, scale: 1 }] });
      result.noField = await run({});
    } else {
      result.text = await run({});
    }
    const loraLogs = logs.slice(before).filter((l) => /lora|adapter/i.test(l));
    await w.exit();
    return { mode, result, loraLogs };
  },

  logs: () => logs.splice(0),
};

(globalThis as any).spike = spike;
document.body.dataset.ready = '1';
