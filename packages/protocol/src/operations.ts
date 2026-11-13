/**
 * Operations: the tasks a release does. Each one says how the router finds it
 * (category, when), how to prompt it, and the shape of its answer. The client
 * knows answer shapes, not tasks: any task whose output type it knows can run,
 * and every answer is checked against that shape before anyone sees it.
 */
import type { LabelOutput, OperationConfig, OutputSpec, TextOutput } from './types.ts';

/** Longest text answer accepted when an operation doesn't say. */
export const DEFAULT_MAX_CHARS = 2000;

/** The operation's output, when it is a type this client knows and is well formed. */
export function knownOutput(op: Pick<OperationConfig, 'output'>): OutputSpec | null {
  const o = op.output as unknown as { type?: unknown; labels?: unknown } | undefined;
  if (o?.type === 'text') return o as TextOutput;
  if (o?.type === 'label' && Array.isArray(o.labels) && o.labels.length >= 2) return o as unknown as LabelOutput;
  return null;
}

/** Can this client run the operation? It needs to know the shape of the answer. */
export const operationExecutable = (op: Pick<OperationConfig, 'output'>): boolean => knownOutput(op) !== null;

/** "Command line" from `command-line`: how a category reads to a person. */
export function categoryName(slug: string): string {
  const words = slug.replace(/[._-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
}

/** A prompt's `{{labels}}`: "family (parents, children, partners and relatives), friends (…), …". */
export function labelList(output: LabelOutput): string {
  return output.labels.map((l) => (l.description ? `${l.id} (${l.description})` : l.id)).join(', ');
}

/** Longest instruction looked for at the start of a request. */
const INSTRUCTION_MAX = 120;

/**
 * Splits "Summarize this message: There is a leak." into its instruction and
 * its text, for prompts that work on the text alone (`{{text}}`). The
 * instruction ends at a colon near the start, or with a first sentence that is
 * a question followed by more text ("Can you sort this? There is a leak.").
 * Without either, the text is the whole request. Routing never depends on it.
 */
export function splitInstruction(request: string): { instruction: string | null; text: string } {
  const s = request.trim();
  const colon = s.search(/:(\s|$)/);
  if (colon > 0 && colon <= INSTRUCTION_MAX) return { instruction: s.slice(0, colon).trim(), text: s.slice(colon + 1).trim() || s };
  const question = s.indexOf('?') + 1;
  if (question > 1 && question <= INSTRUCTION_MAX && s.slice(question).trim()) return { instruction: s.slice(0, question).trim(), text: s.slice(question).trim() };
  return { instruction: null, text: s };
}

/** The placeholder values for one request: {{input}}, {{text}}, {{labels}}, {{language}}. */
export function promptVars(op: Pick<OperationConfig, 'output'>, request: string, language: string): Record<string, string> {
  const out = knownOutput(op);
  return {
    input: request.trim(),
    text: splitInstruction(request).text,
    language,
    ...(out?.type === 'label' ? { labels: labelList(out) } : {}),
  };
}

/** Substitute {{placeholders}} as plain text. Unknown placeholders are left as-is. */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

export type OperationOutput = { text: string } | { label: string };

export interface ParsedOutput {
  value?: OperationOutput;
  /** The model answered with the operation's `decline`: the request is outside what it does. */
  declined?: boolean;
  error?: string;
}

/** Remove what models wrap answers in: a code fence, shell prompts, backticks or quotes around the whole answer. */
function unwrap(raw: string): string {
  let s = raw.trim();
  const fence = /^```[\w-]*[ \t]*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1]!.trim();
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length && lines.every((l) => /^\s*\$\s/.test(l))) s = lines.map((l) => l.replace(/^\s*\$\s+/, '')).join('\n');
  for (const [a, b] of [['`', '`'], ['"', '"'], ["'", "'"], ['“', '”']] as const) {
    if (s.length >= 2 && s.startsWith(a) && s.endsWith(b) && !s.slice(1, -1).includes(b)) s = s.slice(1, -1).trim();
  }
  return s;
}

const bare = (s: string) => s.trim().toLowerCase().replace(/^["'`\s]+|["'`.,;:!\s]+$/g, '');

/** Check a model's raw answer against the operation's output shape. Nothing is invented: a bad answer is an error. */
export function parseOperationOutput(op: Pick<OperationConfig, 'output'>, raw: string): ParsedOutput {
  const out = knownOutput(op);
  if (!out) return { error: `unknown output type ${String((op.output as { type?: unknown })?.type)}` };
  const s = unwrap(raw);
  if (out.decline && bare(s) === bare(out.decline)) return { declined: true };
  if (out.type === 'label') {
    const label = bare(s);
    if (!out.labels.some((l) => l.id === label)) return { error: `"${label}" is not one of ${out.labels.map((l) => l.id).join(', ')}`, value: { label } };
    return { value: { label } };
  }
  if (!s) return { error: 'the answer is empty' };
  const max = out.max_chars ?? DEFAULT_MAX_CHARS;
  if (s.length > max) return { error: `the answer is longer than ${max} characters`, value: { text: s } };
  if (out.single_line && s.includes('\n')) return { error: 'the answer is not on one line', value: { text: s } };
  return { value: { text: s } };
}

/** A reminder added to the prompt when the first answer didn't fit the shape. */
export function retryHint(op: Pick<OperationConfig, 'output'>): string {
  const out = knownOutput(op);
  if (out?.type === 'label') return `\n\nAnswer with exactly one word from: ${out.labels.map((l) => l.id).join(', ')}.`;
  if (out?.single_line) return '\n\nAnswer on one line only.';
  return '\n\nAnswer briefly.';
}

/** The words a constrained-decoding grammar admits for a label output (its labels, and its decline). */
export function labelChoices(output: LabelOutput): string[] {
  return [...output.labels.map((l) => l.id), ...(output.decline ? [output.decline] : [])];
}
