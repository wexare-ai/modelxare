// Tool parameters and response formats arrive as full JSON Schema; llama.cpp's
// grammars (through node-llama-cpp) take a subset. This keeps what the subset
// can enforce, resolves local $refs, and widens the rest to "any JSON value",
// so a schema is never rejected and never silently narrowed to `null` (what an
// unrecognized schema means to node-llama-cpp).
import type { GbnfJsonSchema } from 'node-llama-cpp';

type Json = Record<string, unknown>;

const BASIC = ['string', 'number', 'integer', 'boolean', 'null'] as const;
const FORMATS = ['date-time', 'time', 'date'];
const MAX_DEPTH = 12;

/** Any JSON value. */
export const ANY_JSON: GbnfJsonSchema = { oneOf: [{ type: ['string', 'number', 'boolean', 'null'] }, { type: 'object', additionalProperties: true }, { type: 'array' }] };

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Resolve "#/$defs/x" and "#/definitions/x" against the root schema. */
function resolveRef(ref: string, root: Json): unknown {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const defs = root[m[1]!];
  return isObject(defs) ? defs[decodeURIComponent(m[2]!).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
}

export function toGrammarSchema(schema: unknown, root: unknown = schema, depth = 0): GbnfJsonSchema {
  if (!isObject(schema) || depth > MAX_DEPTH) return ANY_JSON;
  const description = typeof schema.description === 'string' ? { description: schema.description } : {};
  const nullable = schema.nullable === true;
  const withNull = (s: GbnfJsonSchema): GbnfJsonSchema => (nullable ? { oneOf: [s, { type: 'null' }] } : s);
  const next = (s: unknown) => toGrammarSchema(s, root, depth + 1);

  if (typeof schema.$ref === 'string') {
    const target = isObject(root) ? resolveRef(schema.$ref, root) : undefined;
    return target === undefined ? ANY_JSON : withNull(next(target));
  }
  if ('const' in schema && isScalar(schema.const)) return { const: schema.const, ...description } as GbnfJsonSchema;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(isScalar);
    return values.length ? withNull({ enum: values, ...description } as GbnfJsonSchema) : ANY_JSON;
  }
  const alternatives = (Array.isArray(schema.oneOf) && schema.oneOf) || (Array.isArray(schema.anyOf) && schema.anyOf);
  if (alternatives && alternatives.length) return withNull({ oneOf: alternatives.map(next), ...description } as GbnfJsonSchema);
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) return withNull(next(schema.allOf[0]));
  if (Array.isArray(schema.allOf) && schema.allOf.length > 1) return ANY_JSON;

  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t): t is string => typeof t === 'string');
  if (!types.length) {
    if (isObject(schema.properties)) types.push('object');
    else if (schema.items !== undefined) types.push('array');
    else return ANY_JSON;
  }
  if (nullable && !types.includes('null')) types.push('null');

  const variants: GbnfJsonSchema[] = [];
  const basic = types.filter((t): t is (typeof BASIC)[number] => (BASIC as readonly string[]).includes(t));
  for (const t of types) {
    if (t === 'object') variants.push(objectSchema(schema, next, description));
    else if (t === 'array') variants.push(arraySchema(schema, next, description));
  }
  if (basic.length === 1 && basic[0] === 'string') {
    const format = typeof schema.format === 'string' && FORMATS.includes(schema.format) ? schema.format : undefined;
    variants.push(
      format
        ? ({ type: 'string', format, ...description } as GbnfJsonSchema)
        : ({ type: 'string', ...num('minLength', schema.minLength), ...num('maxLength', schema.maxLength), ...description } as GbnfJsonSchema),
    );
  } else if (basic.length) {
    variants.push({ type: basic.length === 1 ? basic[0]! : basic, ...description } as GbnfJsonSchema);
  }
  if (!variants.length) return ANY_JSON;
  return variants.length === 1 ? variants[0]! : { oneOf: variants };
}

function objectSchema(schema: Json, next: (s: unknown) => GbnfJsonSchema, description: Json): GbnfJsonSchema {
  const properties = isObject(schema.properties) ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, next(v)])) : undefined;
  const extra = schema.additionalProperties;
  // Without properties, an object may hold anything unless the schema says otherwise.
  const additionalProperties = extra === false ? false : isObject(extra) ? next(extra) : properties && Object.keys(properties).length ? false : true;
  return { type: 'object', ...(properties ? { properties } : {}), additionalProperties, ...description } as GbnfJsonSchema;
}

function arraySchema(schema: Json, next: (s: unknown) => GbnfJsonSchema, description: Json): GbnfJsonSchema {
  return {
    type: 'array',
    items: schema.items === undefined || schema.items === true ? ANY_JSON : next(schema.items),
    ...num('minItems', schema.minItems),
    ...num('maxItems', schema.maxItems),
    ...description,
  } as GbnfJsonSchema;
}

const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const num = (key: string, v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { [key]: v } : {});
