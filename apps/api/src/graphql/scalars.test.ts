import { GraphQLError, Kind, type GraphQLScalarType, type ObjectValueNode } from 'graphql';
import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

function scalar(name: string): GraphQLScalarType {
  return schema.getType(name) as GraphQLScalarType;
}

/** The error a scalar throws when parsing `value`. */
function parseError(name: string, value: unknown): GraphQLError {
  try {
    scalar(name).parseValue(value);
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${name} accepted ${JSON.stringify(value)}`);
}

describe('GeoJSONPoint scalar', () => {
  const point = { type: 'Point', coordinates: [13.4, 52.5] };

  it('accepts a WGS84 point and serializes it unchanged', () => {
    expect(scalar('GeoJSONPoint').parseValue(point)).toEqual(point);
    expect(scalar('GeoJSONPoint').serialize(point)).toEqual(point);
  });

  it('accepts an inline literal', () => {
    const literal: ObjectValueNode = {
      kind: Kind.OBJECT,
      fields: [
        {
          kind: Kind.OBJECT_FIELD,
          name: { kind: Kind.NAME, value: 'type' },
          value: { kind: Kind.STRING, value: 'Point' },
        },
        {
          kind: Kind.OBJECT_FIELD,
          name: { kind: Kind.NAME, value: 'coordinates' },
          value: {
            kind: Kind.LIST,
            values: [
              { kind: Kind.FLOAT, value: '13.4' },
              { kind: Kind.FLOAT, value: '52.5' },
            ],
          },
        },
      ],
    };

    expect(scalar('GeoJSONPoint').parseLiteral(literal)).toEqual(point);
  });

  it('rejects latitude 95 as bad input naming the coordinate', () => {
    const error = parseError('GeoJSONPoint', { type: 'Point', coordinates: [13.4, 95] });

    expect(error.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      issues: [{ path: 'coordinates.1' }],
    });
  });

  it('rejects a geometry that is not a point', () => {
    const error = parseError('GeoJSONPoint', { type: 'LineString', coordinates: [] });

    expect(error.extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('DateTime scalar', () => {
  it('normalizes an offset to UTC with milliseconds', () => {
    const parsed = scalar('DateTime').parseValue('2026-03-01T11:00:00+01:00');

    expect(scalar('DateTime').serialize(parsed)).toBe('2026-03-01T10:00:00.000Z');
  });

  it.each(['2026-03-01T10:00:00', 'yesterday', 42])('rejects %j', (value) => {
    expect(parseError('DateTime', value).extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('JSON scalar', () => {
  it('passes any JSON value through', () => {
    const value = { state: 'red', tags: ['a', 1], nested: { ok: true } };

    expect(scalar('JSON').parseValue(value)).toEqual(value);
    expect(scalar('JSON').serialize(value)).toEqual(value);
  });
});
