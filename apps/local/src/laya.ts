// System 1 on this machine: the Laya decision model on native ONNX Runtime.
// The request rendering, softmax and calibration come from @wexare/laya-web
// (the browser build's own code), so a decision here is the decision the
// browser makes; only the session (native instead of WebAssembly/WebGPU) and
// the tensor plumbing differ. One forward pass per question; no text is
// generated.
import { readFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import { buildSequence, confidenceFromProbs, QTYPES, renderOptions, softmax, tempBucket, toInternal, type BuiltSequence, type InternalQ } from '@wexare/laya-web';
import type { ChoiceAnswer, NoulAnswer, Question, System1, System1Result } from '@wexare/router';
import * as ort from 'onnxruntime-node';

export interface LayaFiles {
  weights: string;
  tokenizer: string;
  tokenizerConfig: string;
  config: string;
}

interface LayaConfig {
  max_len: number;
  head_max_len: number;
  temperature: Record<string, number>;
  temperature_by_options: Record<string, number>;
}

/** The checkpoint's special tokens; a tokenizer whose ids moved would give garbage, so it is refused. */
const EXPECTED_IDS = { cls: 50281, sep: 50282, pad: 50283, mask: 50284 };

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** IEEE half-precision bits to float32 (the fp16 export's outputs). */
function fromFloat16(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    const h = bits[i]!;
    const sign = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[i] = e === 0 ? sign * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : sign * Infinity) : sign * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}

function toFloat32(t: ort.Tensor | undefined): Float32Array {
  if (!t) throw new Error('the router returned no logits');
  if (t.data instanceof Float32Array) return t.data;
  if (t.type === 'float16' && t.data instanceof Uint16Array) return fromFloat16(t.data);
  return Float32Array.from(t.data as ArrayLike<number>, Number);
}

export interface LayaLoadOptions {
  threads?: number;
  /** ONNX Runtime graph optimization: 'disabled' keeps peak memory lowest while loading. */
  optimization?: 'disabled' | 'basic' | 'extended' | 'all';
}

export class NativeLaya implements System1 {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly encode: (text: string) => number[],
    private readonly ids: { cls: number; sep: number; mask: number; pad: number; maskTok: string },
    private readonly config: LayaConfig,
    private readonly logits: string,
  ) {}

  static async load(files: LayaFiles, opts: LayaLoadOptions = {}): Promise<NativeLaya> {
    const config = JSON.parse(readFileSync(files.config, 'utf8')) as LayaConfig;
    const tokenizer = new Tokenizer(JSON.parse(readFileSync(files.tokenizer, 'utf8')), JSON.parse(readFileSync(files.tokenizerConfig, 'utf8')));
    const id = (token: string) => {
      const v = tokenizer.token_to_id(token);
      if (v === undefined || v === null) throw new Error(`special token ${token} missing from the router's tokenizer`);
      return v;
    };
    const ids = { cls: id('[CLS]'), sep: id('[SEP]'), mask: id('[MASK]'), pad: id('[PAD]'), maskTok: '[MASK]' };
    for (const [name, expected] of Object.entries(EXPECTED_IDS)) {
      if (ids[name as keyof typeof EXPECTED_IDS] !== expected) throw new Error(`router tokenizer mismatch: [${name.toUpperCase()}] is ${ids[name as keyof typeof EXPECTED_IDS]}, expected ${expected}`);
    }
    const session = await ort.InferenceSession.create(files.weights, {
      graphOptimizationLevel: opts.optimization ?? 'disabled',
      intraOpNumThreads: opts.threads ?? 0,
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    const names = session.outputNames;
    const logits = names.find((n) => n.toLowerCase().includes('logit') && !n.toLowerCase().startsWith('act')) ?? names[0];
    if (!logits) throw new Error('the router graph has no outputs');
    return new NativeLaya(session, (text) => tokenizer.encode(text, { add_special_tokens: false }).ids, ids, config, logits);
  }

  /** Each question in its own pass: the same numbers as one padded batch, a fraction of the memory. */
  async predict(state: unknown, questions: Record<string, Question>): Promise<System1Result> {
    const answers: System1Result['answers'] = {};
    let latency = 0;
    for (const [qid, question] of Object.entries(questions)) {
      const q = toInternal(question as never) as InternalQ;
      const options = renderOptions(q);
      if (options.length < 2) throw new Error(`question ${qid}: needs at least 2 options`);
      const seq = buildSequence(this.encode, this.ids, state, q, this.config.max_len, this.config.head_max_len);
      if (seq.markers.length !== options.length) throw new Error(`question ${qid}: ${options.length} options do not fit in ${this.config.head_max_len} tokens`);
      const t0 = performance.now();
      const out = await this.session.run(feeds(seq, QTYPES[q.t]));
      latency += performance.now() - t0;
      const logits = toFloat32(out[this.logits]);
      const qtype = QTYPES[q.t];
      const k = seq.markers.length;
      const temp = this.config.temperature_by_options[tempBucket(qtype, k)] ?? this.config.temperature[qtype] ?? 1;
      const p = softmax(Array.from({ length: k }, (_, i) => (logits[i] ?? 0) / Math.max(1e-3, temp)));
      answers[qid] = decode(q, p, k);
    }
    return { answers, latency_ms: Math.round(latency), device: 'native-cpu' };
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}

/** One sequence as the graph's inputs (laya-web's collate, for a batch of one). */
function feeds(seq: BuiltSequence, qtype: number): Record<string, ort.Tensor> {
  const L = seq.ids.length;
  const K = seq.markers.length;
  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(seq.ids, (v) => BigInt(v)), [1, L]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(L).fill(1n), [1, L]),
    marker_pos: new ort.Tensor('int64', BigInt64Array.from(seq.markers, (v) => BigInt(v)), [1, K]),
    marker_mask: new ort.Tensor('bool', new Uint8Array(K).fill(1), [1, K]),
    qtype: new ort.Tensor('int64', BigInt64Array.from([BigInt(qtype)]), [1]),
  };
}

function decode(q: InternalQ, p: number[], k: number): ChoiceAnswer | NoulAnswer {
  const confidence = round4(confidenceFromProbs(p, k));
  if (q.t === 'choice') {
    const keys = Object.keys((q.crit ?? {}) as Record<string, unknown>);
    let best = 0;
    for (let i = 1; i < p.length; i++) if ((p[i] ?? 0) > (p[best] ?? 0)) best = i;
    return { type: 'choice', choice: keys[best] ?? String(best), probabilities: Object.fromEntries(keys.map((key, i) => [key, round4(p[i] ?? 0)])), confidence, action: { act_probability: null } };
  }
  const yes = p[1] ?? 0;
  return { type: 'noul', noul: round4(yes), confidence: round4(Math.max(yes, 1 - yes)), action: { act_probability: null } };
}
