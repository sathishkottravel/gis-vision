import { lexicographicSortSchema, printSchema, type GraphQLSchema } from 'graphql';
import { builder } from './builder.js';
import './scalars.js';

builder.queryType({
  fields: (t) => ({
    ping: t.string({
      description: 'Liveness check for the GraphQL endpoint; always "pong".',
      resolve: () => 'pong',
    }),
  }),
});

/** The read-only schema (no Mutation type): writes stay on REST. */
export const schema: GraphQLSchema = builder.toSchema();

/** Sorted SDL, as committed in `apps/api/schema.graphql` (design D10). */
export function printSortedSchema(target: GraphQLSchema = schema): string {
  return `${printSchema(lexicographicSortSchema(target))}\n`;
}
