/**
 * Operation contracts bundled with the client. A manifest may configure the
 * prompt for an operation, but its declared input/output schemas must equal
 * the bundled contract: published metadata cannot widen what the client
 * accepts as a valid stage result.
 */
import { canonicalJson } from './canonical-json.ts';
import type { OperationConfig } from './types.ts';

/** Documented category set for the community-message classification stage. */
export const MESSAGE_CATEGORIES = ['maintenance', 'safety', 'security', 'noise', 'cleanliness', 'other'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export const SUMMARY_MAX_CHARS = 400;

const textInput = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
};

export interface OperationContract {
  id: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export const OPERATION_CONTRACTS: Record<string, OperationContract> = {
  'text-classification': {
    id: 'text-classification',
    description: `Classify a community message into exactly one of: ${MESSAGE_CATEGORIES.join(', ')}.`,
    input_schema: textInput,
    output_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: { category: { enum: [...MESSAGE_CATEGORIES] } },
    },
  },
  summarization: {
    id: 'summarization',
    description: `Summarize a message in one short sentence (at most ${SUMMARY_MAX_CHARS} characters).`,
    input_schema: textInput,
    output_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: { summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX_CHARS } },
    },
  },
  'text-generation': {
    id: 'text-generation',
    description: 'Continue a text prompt. Used by the LoRA base fixture; not part of the composition workflow.',
    input_schema: textInput,
    output_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
};

/** True when the manifest's operation declares exactly the bundled contract's schemas. */
export function operationMatchesContract(op: OperationConfig): boolean {
  const contract = OPERATION_CONTRACTS[op.id];
  if (!contract) return false;
  return (
    canonicalJson(op.input_schema) === canonicalJson(contract.input_schema) &&
    canonicalJson(op.output_schema) === canonicalJson(contract.output_schema)
  );
}

/** Substitute {{placeholders}} as plain text. Unknown placeholders are left as-is. */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}
