import { geoJsonPointSchema } from '@gis-vision/schemas';
import { GraphQLError, valueFromASTUntyped, type ValueNode } from 'graphql';
import { z } from 'zod';
import { builder } from './builder.js';
import { badUserInput } from './errors.js';

const dateTimeSchema = z.iso.datetime({ offset: true });

function parseDateTime(value: unknown): Date {
  const result = dateTimeSchema.safeParse(value);
  if (!result.success) {
    throw new GraphQLError('DateTime must be an ISO 8601 string with an offset', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return new Date(result.data);
}

/** ISO 8601 with offset on input; UTC `...Z` with milliseconds on output, as in REST. */
builder.scalarType('DateTime', {
  description: 'ISO 8601 date-time with offset, returned in UTC, e.g. 2026-03-01T10:00:00.000Z',
  serialize: (value) => value.toISOString(),
  parseValue: parseDateTime,
  parseLiteral: (ast) => parseDateTime(valueFromASTUntyped(ast)),
});

builder.scalarType('JSON', {
  description: 'Any JSON value, e.g. detection attributes or a detector output schema',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast: ValueNode) => valueFromASTUntyped(ast),
});

function parsePoint(value: unknown) {
  const result = geoJsonPointSchema.safeParse(value);
  if (!result.success) {
    throw badUserInput(
      'Invalid GeoJSON Point',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

/** GeoJSON Point in WGS84: `{ "type": "Point", "coordinates": [longitude, latitude] }`. */
builder.scalarType('GeoJSONPoint', {
  description: 'GeoJSON Point in WGS84: { "type": "Point", "coordinates": [longitude, latitude] }',
  serialize: (value) => value,
  parseValue: parsePoint,
  parseLiteral: (ast) => parsePoint(valueFromASTUntyped(ast)),
});
