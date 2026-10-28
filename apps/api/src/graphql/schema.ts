import { lexicographicSortSchema, printSchema, type GraphQLSchema } from 'graphql';
import { builder } from './builder.js';
import './scalars.js';
// Each type module adds its object type and root fields (`builder.queryFields`).
import './types/capture.js';
import './types/detection.js';
import './types/detector.js';

builder.queryType({});

/** The read-only schema (no Mutation type): writes stay on REST. */
export const schema: GraphQLSchema = builder.toSchema();

/** Sorted SDL, as committed in `apps/api/schema.graphql` (design D10). */
export function printSortedSchema(target: GraphQLSchema = schema): string {
  return `${printSchema(lexicographicSortSchema(target))}\n`;
}
