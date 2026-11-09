// Tool parameter schemas from agents become schemas llama.cpp's grammar
// generator enforces, without ever narrowing a value to `null`.
import { describe, expect, it } from 'vitest';
import { ANY_JSON, toGrammarSchema } from '../src/schema.ts';

describe('tool schemas for grammars', () => {
  it('keeps objects, types, enums and descriptions; drops what grammars cannot enforce', () => {
    const s = toGrammarSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path', pattern: '^/', minLength: 1 },
        limit: { type: 'integer', minimum: 1, default: 100 },
        mode: { type: 'string', enum: ['read', 'write'] },
        when: { type: 'string', format: 'date-time' },
        email: { type: 'string', format: 'email' },
      },
      required: ['path'],
      additionalProperties: false,
    });
    expect(s).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'File path' },
        limit: { type: 'integer' },
        mode: { enum: ['read', 'write'] },
        when: { type: 'string', format: 'date-time' },
        email: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it('resolves local $refs and turns anyOf into oneOf', () => {
    const s = toGrammarSchema({
      type: 'object',
      properties: { item: { $ref: '#/$defs/Item' }, list: { type: 'array', items: { $ref: '#/definitions/Tag' } }, either: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      $defs: { Item: { type: 'object', properties: { id: { type: 'string' } } } },
      definitions: { Tag: { type: 'string' } },
    });
    expect(s).toMatchObject({
      properties: {
        item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        list: { type: 'array', items: { type: 'string' } },
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });
  });

  it('widens unknown, empty and recursive schemas to any JSON value', () => {
    expect(toGrammarSchema({})).toEqual(ANY_JSON);
    expect(toGrammarSchema(true)).toEqual(ANY_JSON);
    expect(toGrammarSchema({ $ref: 'https://example.com/schema' })).toEqual(ANY_JSON);
    expect(toGrammarSchema({ type: 'object' })).toEqual({ type: 'object', additionalProperties: true });
    const recursive = { $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } }, $ref: '#/$defs/Node' };
    expect(JSON.stringify(toGrammarSchema(recursive))).toContain(JSON.stringify(ANY_JSON));
  });

  it('handles nullable and type lists', () => {
    expect(toGrammarSchema({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] });
    expect(toGrammarSchema({ type: ['integer', 'null'] })).toEqual({ type: ['integer', 'null'] });
    expect(toGrammarSchema({ type: ['object', 'string'], properties: { a: { type: 'boolean' } } })).toEqual({
      oneOf: [{ type: 'object', properties: { a: { type: 'boolean' } }, additionalProperties: false }, { type: 'string' }],
    });
  });
});
