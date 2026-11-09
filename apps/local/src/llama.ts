// System 2 on this machine: GGUF language models on native llama.cpp (through
// node-llama-cpp, which picks Metal, CUDA, Vulkan or the CPU). One model is
// loaded at a time; callers take turns (see engine.ts). It is also the
// orchestrator's runtime, so catalog operations run exactly as in the browser.
import {
  getLlama,
  JinjaTemplateChatWrapper,
  LlamaChat,
  LlamaCompletion,
  LlamaLogLevel,
  type ChatHistoryItem,
  type ChatModelFunctionCall,
  type ChatModelFunctions,
  type ChatModelResponse,
  type Llama,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaGrammar,
  type LlamaModel,
} from 'node-llama-cpp';
import type { ChatTemplateConfig } from '@wexare/protocol';
import type { GenerateRequest, GenerateResult, LoadInfo, LoadRequest } from '@wexare/runtime';
import { toGrammarSchema } from './schema.ts';

export interface LlamaOptions {
  /** 'auto' picks Metal, CUDA or Vulkan when there is one; false runs on the CPU only. */
  gpu: 'auto' | 'metal' | 'cuda' | 'vulkan' | false;
  /** Most tokens of context a model gets; its trained size when that is smaller. */
  contextSize: number;
  threads?: number;
  /** Models kept loaded at once (the least recently used is unloaded first). */
  maxLoaded?: number;
  log?: (line: string) => void;
}

export interface LoadSpec {
  /** Identity of what is loaded: the base release's file hashes, then `lora:<hash>` per adapter. */
  key: string;
  /** The GGUF weights file. */
  weights: string;
  adapters: { path: string; sha256: string; scale: number }[];
  chatTemplate?: ChatTemplateConfig | undefined;
}

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant: the tools it called. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** tool: which call this answers. */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface Sampling {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
}

export interface ChatRun extends Sampling {
  messages: ChatMessageIn[];
  tools?: ToolSpec[];
  /** One call at most per turn when false. */
  parallelToolCalls?: boolean;
  /** Constrain the answer to JSON: 'object' for any JSON object, or a JSON Schema. */
  json?: 'object' | { schema: unknown };
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface CompleteRun extends Sampling {
  prompt: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls';

export interface Output {
  text: string;
  toolCalls: { name: string; arguments: string }[];
  finishReason: FinishReason;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

interface Loaded {
  spec: LoadSpec;
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
  chat: LlamaChat | null;
  info: LoadInfo;
}

export class CanceledError extends Error {
  readonly code = 'canceled';
  constructor() {
    super('canceled');
  }
}

const pathOf = (blob: Blob): string => {
  const path = (blob as Blob & { path?: unknown }).path;
  if (typeof path !== 'string') throw new Error('the native runtime loads files from disk; got bytes without a path');
  return path;
};

/** Function call arguments as the model's history needs them: parsed when they are JSON. */
const parseArgs = (s: string): unknown => {
  try {
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return s;
  }
};

/**
 * OpenAI-style messages as node-llama-cpp history. A tool result becomes the
 * result of the call it answers, inside the assistant turn that made it; the
 * model then continues that turn, as chat templates expect.
 */
export function toHistory(messages: ChatMessageIn[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];
  const calls = new Map<string, ChatModelFunctionCall>();
  for (const m of messages) {
    if (m.role === 'system') history.push({ type: 'system', text: m.content });
    else if (m.role === 'user') history.push({ type: 'user', text: m.content });
    else if (m.role === 'assistant') {
      const response: ChatModelResponse['response'] = m.content ? [m.content] : [];
      for (const c of m.toolCalls ?? []) {
        const call: ChatModelFunctionCall = { type: 'functionCall', name: c.name, params: parseArgs(c.arguments), result: '' };
        calls.set(c.id, call);
        response.push(call);
      }
      history.push({ type: 'model', response });
    } else {
      const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
      if (call) call.result = parseArgs(m.content);
      else history.push({ type: 'user', text: `Tool result:\n${m.content}` });
    }
  }
  // The model answers next: an empty turn to write, unless the last turn is its own (to continue).
  if (history.at(-1)?.type !== 'model') history.push({ type: 'model', response: [] });
  return history;
}

const finishOf = (stop: string): FinishReason => (stop === 'maxTokens' ? 'length' : stop === 'functionCalls' ? 'tool_calls' : 'stop');

const repeatPenalty = (s: Sampling) =>
  s.frequencyPenalty || s.presencePenalty ? { repeatPenalty: { ...(s.frequencyPenalty ? { frequencyPenalty: s.frequencyPenalty } : {}), ...(s.presencePenalty ? { presencePenalty: s.presencePenalty } : {}) } } : {};

const sampling = (s: Sampling) => ({
  maxTokens: s.maxTokens,
  temperature: s.temperature ?? 0.7,
  ...(s.topP !== undefined ? { topP: s.topP } : {}),
  ...(s.topK !== undefined ? { topK: s.topK } : {}),
  ...(s.minP !== undefined ? { minP: s.minP } : {}),
  ...(s.seed !== undefined ? { seed: s.seed } : {}),
  ...(s.stop?.length ? { customStopTriggers: s.stop } : {}),
  ...repeatPenalty(s),
});

export class NativeLlama {
  private llama: Llama | null = null;
  /** Loaded models, least recently used first; the last one is in use. */
  private readonly resident = new Map<string, Loaded>();
  private current: Loaded | null = null;
  private readonly grammars = new Map<string, Promise<LlamaGrammar>>();

  constructor(readonly options: LlamaOptions) {}

  /** What is loaded (the orchestrator reuses a loaded model with the same key). */
  get loaded(): LoadInfo | null {
    return this.current?.info ?? null;
  }

  get contextSize(): number | null {
    return this.current?.context.contextSize ?? null;
  }

  /** Which backend llama.cpp uses here: 'metal', 'cuda', 'vulkan' or false (CPU). */
  async backend(): Promise<string> {
    const llama = await this.instance();
    return llama.gpu === false ? 'cpu' : llama.supportsGpuOffloading ? llama.gpu : `cpu (${llama.gpu} without offloading)`;
  }

  private async instance(): Promise<Llama> {
    if (!this.llama) {
      const log = this.options.log;
      this.llama = await getLlama({
        gpu: this.options.gpu,
        // Warnings are mostly about quirks of a model's vocabulary; errors are what people need.
        logLevel: LlamaLogLevel.error,
        logger: (level, message) => {
          if (log && (level === LlamaLogLevel.error || level === LlamaLogLevel.fatal)) log(`llama.cpp: ${message.trim()}`);
        },
      });
    }
    return this.llama;
  }

  /** Load a model (and its adapters), unless it already is. */
  async ensure(spec: LoadSpec): Promise<LoadInfo> {
    const kept = this.resident.get(spec.key);
    if (kept) {
      this.resident.delete(spec.key);
      this.resident.set(spec.key, kept);
      this.current = kept;
      return kept.info;
    }
    this.current = null;
    while (this.resident.size >= Math.max(1, this.options.maxLoaded ?? 1)) await this.release(this.resident.keys().next().value!);
    const t0 = performance.now();
    const llama = await this.instance();
    const model = await llama.loadModel({ modelPath: spec.weights, gpuLayers: this.options.gpu === false ? 0 : 'auto' });
    let context: LlamaContext;
    try {
      context = await model.createContext({
        contextSize: { max: Math.min(this.options.contextSize, model.trainContextSize || this.options.contextSize) },
        ...(this.options.threads ? { threads: this.options.threads } : {}),
        ...(spec.adapters.length ? { lora: { adapters: spec.adapters.map((a) => ({ filePath: a.path, scale: a.scale })) } } : {}),
      });
    } catch (e) {
      await model.dispose();
      throw e;
    }
    const sequence = context.getSequence();
    const template = spec.chatTemplate;
    const chat =
      template?.source === 'none'
        ? null
        : new LlamaChat({ contextSequence: sequence, autoDisposeSequence: false, chatWrapper: template?.source === 'inline' ? new JinjaTemplateChatWrapper({ template: template.template }) : 'auto' });
    const architecture = model.fileInfo.metadata?.general?.architecture ?? null;
    const loaded: Loaded = {
      spec,
      model,
      context,
      sequence,
      chat,
      info: {
        key: spec.key,
        ms: Math.round(performance.now() - t0),
        multithread: true,
        threads: context.currentThreads,
        architecture: typeof architecture === 'string' ? architecture : null,
        adapterEvidence: spec.adapters.length ? [`loaded ${spec.adapters.length} LoRA adapter(s) into the context`] : [],
        adapters: spec.adapters.map((a) => ({ sha256: a.sha256, path: a.path, scale: a.scale })),
      },
    };
    this.resident.set(spec.key, loaded);
    this.current = loaded;
    return loaded.info;
  }

  /** Keys of the models loaded now. */
  get residentKeys(): string[] {
    return [...this.resident.keys()];
  }

  private async release(key: string): Promise<void> {
    const c = this.resident.get(key);
    this.resident.delete(key);
    if (this.current === c) this.current = null;
    if (!c) return;
    c.chat?.dispose({ disposeSequence: false });
    await c.context.dispose();
    await c.model.dispose();
  }

  /** Unload every model. */
  async unload(): Promise<void> {
    for (const key of [...this.resident.keys()]) await this.release(key);
  }

  /** Release llama.cpp itself (on shutdown). */
  async close(): Promise<void> {
    await this.unload();
    this.grammars.clear();
    await this.llama?.dispose();
    this.llama = null;
  }

  private loadedOrThrow(): Loaded {
    if (!this.current) throw new Error('no model loaded');
    return this.current;
  }

  private grammar(key: string, make: (llama: Llama) => Promise<LlamaGrammar>): Promise<LlamaGrammar> {
    let g = this.grammars.get(key);
    if (!g) {
      g = this.instance().then(make);
      g.catch(() => this.grammars.delete(key));
      if (this.grammars.size > 64) this.grammars.clear();
      this.grammars.set(key, g);
    }
    return g;
  }

  /** Token counts around one generation: the prompt as it sits in the context, and what was written. */
  private async measured<T>(seq: LlamaContextSequence, run: () => Promise<T>): Promise<{ value: T; promptTokens: number; completionTokens: number; ms: number }> {
    const before = seq.tokenMeter.getState();
    const t0 = performance.now();
    const value = await run();
    const completionTokens = seq.tokenMeter.diff(before).usedOutputTokens;
    return { value, promptTokens: Math.max(0, seq.contextTokens.length - completionTokens), completionTokens, ms: Math.round(performance.now() - t0) };
  }

  /** One chat turn: text, or calls to the tools offered. */
  async chat(r: ChatRun): Promise<Output> {
    const c = this.loadedOrThrow();
    if (!c.chat) throw new Error('this model has no chat format');
    const chat = c.chat;
    const tools = r.tools?.length ? r.tools : undefined;
    const functions: ChatModelFunctions | undefined = tools
      ? Object.fromEntries(tools.map((t) => [t.name, { ...(t.description ? { description: t.description } : {}), params: t.parameters === undefined ? undefined : toGrammarSchema(t.parameters) }]))
      : undefined;
    const grammar =
      !functions && r.json
        ? await this.grammar(r.json === 'object' ? 'json:object' : `json:${JSON.stringify(r.json.schema)}`, (llama) =>
            r.json === 'object' || r.json === undefined ? llama.createGrammarForJsonSchema({ type: 'object', additionalProperties: true }) : llama.createGrammarForJsonSchema(toGrammarSchema(r.json.schema) as never),
          )
        : undefined;
    const history = toHistory(r.messages);
    const { value: res, promptTokens, completionTokens, ms } = await this.measured(c.sequence, () =>
      chat.generateResponse(history, {
        ...sampling(r),
        ...(r.signal ? { signal: r.signal, stopOnAbortSignal: true } : {}),
        ...(r.onText ? { onTextChunk: r.onText } : {}),
        ...(functions ? { functions, documentFunctionParams: true, ...(r.parallelToolCalls === false ? { maxParallelFunctionCalls: 1 } : {}) } : grammar ? { grammar } : {}),
      } as never),
    );
    if (r.signal?.aborted) throw new CanceledError();
    const calls = (res.functionCalls ?? []) as { functionName: string; params: unknown }[];
    return {
      text: res.response,
      toolCalls: calls.map((f) => ({ name: f.functionName, arguments: JSON.stringify(f.params ?? {}) })),
      finishReason: calls.length ? 'tool_calls' : finishOf(res.metadata.stopReason),
      promptTokens,
      completionTokens,
      ms,
    };
  }

  /** Continue a text (models without a chat format, and /v1/completions). */
  async complete(r: CompleteRun): Promise<Output> {
    const c = this.loadedOrThrow();
    const completion = new LlamaCompletion({ contextSequence: c.sequence, autoDisposeSequence: false });
    try {
      const { value: res, promptTokens, completionTokens, ms } = await this.measured(c.sequence, () =>
        completion.generateCompletionWithMeta(r.prompt, {
          ...sampling(r),
          ...(r.signal ? { signal: r.signal, stopOnAbortSignal: true } : {}),
          ...(r.onText ? { onTextChunk: r.onText } : {}),
        }),
      );
      if (r.signal?.aborted) throw new CanceledError();
      return { text: res.response, toolCalls: [], finishReason: finishOf(res.metadata.stopReason), promptTokens, completionTokens, ms };
    } finally {
      completion.dispose({ disposeSequence: false });
    }
  }

  // The orchestrator's runtime interface (RuntimeLike): catalog operations, as in the browser.

  async load(req: LoadRequest): Promise<LoadInfo> {
    if (req.weights.length !== 1) throw new Error('models split into several GGUF files are not supported by the native runtime yet');
    return this.ensure({
      key: req.key,
      weights: pathOf(req.weights[0]!),
      adapters: (req.adapters ?? []).map((a) => ({ path: pathOf(a.blob), sha256: a.sha256, scale: a.scale })),
      chatTemplate: req.chatTemplate,
    });
  }

  async generate(r: GenerateRequest): Promise<GenerateResult> {
    let text = '';
    const onText = (delta: string) => {
      text += delta;
      r.onToken?.(text);
    };
    const common: Sampling = {
      maxTokens: r.maxTokens,
      temperature: r.temperature ?? 0,
      ...(r.topK !== undefined ? { topK: r.topK } : {}),
      ...(r.topP !== undefined ? { topP: r.topP } : {}),
      ...(r.stop?.length ? { stop: r.stop } : {}),
    };
    let out: Output;
    if (r.mode === 'completion' || !this.current?.chat) {
      out = await this.complete({ ...common, prompt: r.prompt, onText, ...(r.signal ? { signal: r.signal } : {}) });
    } else {
      const c = this.loadedOrThrow();
      const history: ChatHistoryItem[] = [...(r.system ? [{ type: 'system' as const, text: r.system }] : []), { type: 'user', text: r.prompt }, { type: 'model', response: [] }];
      const grammar = r.grammar ? await this.grammar(`gbnf:${r.grammar}`, (llama) => llama.createGrammar({ grammar: r.grammar! })) : undefined;
      const { value: res, promptTokens, completionTokens, ms } = await this.measured(c.sequence, () =>
        c.chat!.generateResponse(history, { ...sampling(common), ...(grammar ? { grammar } : {}), onTextChunk: onText, ...(r.signal ? { signal: r.signal, stopOnAbortSignal: true } : {}) }),
      );
      if (r.signal?.aborted) throw new CanceledError();
      out = { text: res.response, toolCalls: [], finishReason: finishOf(res.metadata.stopReason), promptTokens, completionTokens, ms };
    }
    return { text: out.text, promptTokens: out.promptTokens, completionTokens: out.completionTokens, ms: out.ms, finishReason: out.finishReason };
  }
}

