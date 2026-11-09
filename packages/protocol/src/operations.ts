/**
 * Operation contracts bundled with the client. A manifest may configure the
 * prompt for an operation, but its declared input/output schemas must equal
 * the bundled contract: published metadata cannot widen what the client
 * accepts as a valid stage result.
 */
import { canonicalJson } from './canonical-json.ts';
import type { OperationConfig } from './types.ts';

/** Topics the message-sorting stage picks from: the everyday texts and emails anyone gets. */
export const MESSAGE_CATEGORIES = ['family', 'friends', 'work', 'money', 'shopping', 'travel', 'health', 'home', 'other'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

/** What each topic covers. Small models sort far better when the prompt says. */
export const CATEGORY_HINTS: Record<MessageCategory, string> = {
  family: 'parents, children, partners and relatives',
  friends: 'plans, invitations and greetings from friends',
  work: 'colleagues, managers, clients, meetings and deadlines',
  money: 'bills, banks, cards and payments',
  shopping: 'orders, deliveries, returns and refunds',
  travel: 'flights, trains, hotels and trips',
  health: 'doctors, dentists, appointments and prescriptions',
  home: 'repairs, utilities, rent and chores',
  other: 'anything else',
};

/** A prompt's `{{categories}}`: "family (parents, children, partners and relatives), friends (…), …". */
export const categoryList = (): string => MESSAGE_CATEGORIES.map((c) => `${c} (${CATEGORY_HINTS[c]})`).join(', ');

/**
 * Categories of the first version of the sorting contract (building issues).
 * Releases signed then declare them; they still run, under the current contract.
 */
const FIRST_CATEGORIES = ['maintenance', 'safety', 'security', 'noise', 'cleanliness', 'other'];

const categoryOutput = (categories: readonly string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { enum: [...categories] } },
});

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
    description: `Sort an everyday message, such as a text or an email, into exactly one topic: ${MESSAGE_CATEGORIES.join(', ')}.`,
    input_schema: textInput,
    output_schema: categoryOutput(MESSAGE_CATEGORIES),
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

/**
 * Output schemas of a contract's earlier versions. A release that declares one
 * runs under the current contract: the client builds the grammar and checks
 * every output from the current one, so this never widens what it accepts.
 */
const EARLIER_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>[]> = {
  'text-classification': [categoryOutput(FIRST_CATEGORIES)],
};

/** True when the manifest's operation declares exactly the bundled contract's schemas (or an earlier version's output). */
export function operationMatchesContract(op: OperationConfig): boolean {
  const contract = OPERATION_CONTRACTS[op.id];
  if (!contract) return false;
  const output = canonicalJson(op.output_schema);
  return (
    canonicalJson(op.input_schema) === canonicalJson(contract.input_schema) &&
    [contract.output_schema, ...(EARLIER_OUTPUT_SCHEMAS[op.id] ?? [])].some((schema) => canonicalJson(schema) === output)
  );
}

/** Substitute {{placeholders}} as plain text. Unknown placeholders are left as-is. */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}
