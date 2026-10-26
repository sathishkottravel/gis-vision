import { describe, expect, it } from 'vitest';
import { checkDetectorSchema } from './detectors.js';

/** Paths of the subset violations, e.g. `properties.size`. */
function violations(schema: unknown): string[] {
  return checkDetectorSchema(schema).map((issue) => issue.path);
}

describe('detector output schema subset', () => {
  it('accepts a free-form attributes object', () => {
    expect(
      checkDetectorSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Manual annotation',
        type: 'object',
        additionalProperties: true,
      }),
    ).toEqual([]);
  });

  it('accepts primitives, enums and arrays of primitives', () => {
    expect(
      checkDetectorSchema({
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['red', 'amber', 'green'], title: 'Light state' },
          price: { type: 'number', minimum: 0 },
          heads: { type: 'integer', enum: [1, 2, 3] },
          flashing: { type: 'boolean', default: false },
          tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        required: ['state'],
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it.each([
    ['a non-object root', { type: 'string' }, 'type'],
    ['a root $ref', { type: 'object', $ref: '#/$defs/x' }, ''],
    [
      'a property $ref',
      { type: 'object', properties: { a: { $ref: '#/$defs/a' } } },
      'properties.a',
    ],
    [
      'a nested object',
      { type: 'object', properties: { a: { type: 'object', properties: {} } } },
      'properties.a',
    ],
    [
      'an array of objects',
      { type: 'object', properties: { a: { type: 'array', items: { type: 'object' } } } },
      'properties.a',
    ],
    [
      'an array of arrays',
      {
        type: 'object',
        properties: { a: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
      },
      'properties.a',
    ],
    [
      'a combinator',
      { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } },
      'properties.a',
    ],
    [
      'a type union',
      { type: 'object', properties: { a: { type: ['string', 'null'] } } },
      'properties.a',
    ],
    [
      'an enum value of the wrong type',
      { type: 'object', properties: { a: { type: 'string', enum: ['x', 1] } } },
      'properties.a',
    ],
    [
      'additionalProperties as a schema',
      { type: 'object', additionalProperties: { type: 'string' } },
      'additionalProperties',
    ],
    [
      'an unknown $schema dialect',
      { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' },
      '$schema',
    ],
    [
      'a required property that is not declared',
      { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
      'required.0',
    ],
  ])('rejects %s', (_, schema, path) => {
    expect(violations(schema)).toEqual([path]);
  });

  it.each([null, 'object', []])('rejects a schema that is not an object: %j', (schema) => {
    expect(violations(schema)).toEqual(['']);
  });
});
