import SchemaBuilder from '@pothos/core';
import type { GeoJsonPoint } from '@gis-vision/schemas';
import type { GraphQLContext } from './context.js';

/**
 * Code-first schema builder (design D1). Relations are batched by the per-request loaders in
 * the context (`loaders.ts`); search results use forward-only connection types (`types/search.ts`).
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date };
    JSON: { Input: unknown; Output: unknown };
    GeoJSONPoint: { Input: GeoJsonPoint; Output: GeoJsonPoint };
  };
  // Fields are non-null unless declared `nullable: true`.
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});
