import SchemaBuilder from '@pothos/core';
import RelayPlugin from '@pothos/plugin-relay';
import type { GeoJsonPoint } from '@gis-vision/schemas';
import type { GraphQLContext } from './context.js';

/**
 * Code-first schema builder (design D1): Pothos with connection types (relay). Relations are
 * batched by the per-request loaders in the context (`loaders.ts`). Ids are plain UUIDs and
 * slugs, so the relay plugin's global-id `node`/`nodes` fields are turned off.
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
  plugins: [RelayPlugin],
  relay: { nodeQueryOptions: false, nodesQueryOptions: false },
});
