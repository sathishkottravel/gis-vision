import { describe, expect, it } from 'vitest';
import type { RegisteredDetector } from '../detectors/detector-registry.js';
import { UnprocessableError } from '../errors.js';
import { AttributeValidator } from './attribute-validator.js';

const trafficLight: RegisteredDetector = {
  id: 'traffic-light',
  name: 'Traffic light',
  version: 1,
  kind: 'ml',
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['red', 'amber', 'green'] },
      heads: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      checkedAt: { type: 'string', format: 'date-time' },
    },
    required: ['state'],
    additionalProperties: false,
  },
};

const manual: RegisteredDetector = {
  id: 'manual',
  name: 'Manual annotation',
  version: 1,
  kind: 'manual',
  outputSchema: { type: 'object', additionalProperties: true },
};

/** Runs the validator and returns the 422 issues, or `[]` when the attributes are valid. */
function issues(
  validator: AttributeValidator,
  detector: RegisteredDetector,
  attributes: Record<string, unknown>,
): { path: string }[] {
  try {
    validator.validate(detector, attributes);
    return [];
  } catch (error) {
    if (!(error instanceof UnprocessableError)) {
      throw error;
    }
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('invalid_attributes');
    return (error.issues ?? []).map(({ path }) => ({ path }));
  }
}

describe('AttributeValidator', () => {
  const validator = new AttributeValidator();

  it('accepts attributes that match the schema', () => {
    expect(
      issues(validator, trafficLight, {
        state: 'red',
        heads: 3,
        tags: ['pedestrian'],
        checkedAt: '2026-03-01T10:00:00Z',
      }),
    ).toEqual([]);
  });

  it('accepts any attributes for the free-form manual detector', () => {
    expect(issues(validator, manual, {})).toEqual([]);
    expect(issues(validator, manual, { note: 'faded', nested: { ok: true } })).toEqual([]);
  });

  it('rejects a value outside the enum and names the field', () => {
    expect(issues(validator, trafficLight, { state: 'blue' })).toEqual([
      { path: 'attributes.state' },
    ]);
  });

  it('names a missing required property', () => {
    expect(issues(validator, trafficLight, {})).toEqual([{ path: 'attributes.state' }]);
  });

  it('names an undeclared property', () => {
    expect(issues(validator, trafficLight, { state: 'red', colour: 'x' })).toEqual([
      { path: 'attributes.colour' },
    ]);
  });

  it('lists every violation, including array items and formats', () => {
    expect(
      issues(validator, trafficLight, {
        state: 'blue',
        heads: 0,
        tags: ['ok', 7],
        checkedAt: 'yesterday',
      }),
    ).toEqual([
      { path: 'attributes.state' },
      { path: 'attributes.heads' },
      { path: 'attributes.tags.1' },
      { path: 'attributes.checkedAt' },
    ]);
  });

  it('caches the compiled schema per detector version', () => {
    const cached = new AttributeValidator();
    cached.validate(trafficLight, { state: 'red' });
    const changedSchema = { ...trafficLight, outputSchema: manual.outputSchema };

    // Same id and version: the first compiled schema still applies.
    expect(issues(cached, changedSchema, { state: 'blue' })).toEqual([
      { path: 'attributes.state' },
    ]);
    // A new version compiles the new schema.
    expect(issues(cached, { ...changedSchema, version: 2 }, { state: 'blue' })).toEqual([]);
  });
});
