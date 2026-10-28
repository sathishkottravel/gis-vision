# Proposal

## Why

Phase 1 stores captures and detections, but they can only be read by id or as one capture's detection list. This phase makes the data explorable: typed, nested reads over GraphQL, plus the spatial and temporal queries that are the reason for using PostGIS with time-partitioned detections. It ends with a map page showing the detections in the current viewport, filtered by time, so the phase has a visible result before Deploy v0.

## What Changes

Each feature is delivered on its own branch with its own PR (see `docs/ROADMAP.md`).

- **F2.1 GraphQL server:**
  - A GraphQL endpoint at `/graphql` in the existing Fastify app, with a code-first schema.
  - Errors are reported in a consistent shape.
  - The schema file is committed (SDL) and CI fails when it is out of date.
  - The endpoint is read-only: all writes stay on REST.
- **F2.2 Core types:**
  - `Capture`, `Detection` and `Detector` types with their relations.
  - A `GeoJSONPoint` scalar for locations.
  - Each detection exposes its *effective* location (its own, or else its capture's) and where that location came from.
  - Relations are loaded in batches, and a test proves the number of database queries doesn't grow with the result size (no N+1).
- **F2.3 Spatial queries:**
  - Detections within a bounding box, including boxes that cross the antimeridian.
  - Detections within a radius in meters (geodesic).
  - Both use the effective location, so detections without their own point are found by their capture's location.
  - Captures are also searchable by bounding box.
- **F2.4 Temporal filters:**
  - A half-open time range on a detection's observation time, and on a capture's capture time.
  - It combines with the spatial and detector filters.
  - `EXPLAIN` tests prove that a time-bounded query only scans the monthly partitions that overlap the range.
- **F2.5 Pagination:**
  - Cursor-based pagination of detection and capture results, with a stable order and opaque cursors.
  - A bounded page size, and no duplicates or gaps while paging.
- **F2.6 Map page:**
  - A MapLibre page in `apps/web` that queries the visible bounding box when the map moves.
  - A time-range control and a popup linking to the capture.
  - A demo-data seed script so the map has something to show locally.

## Capabilities

### New Capabilities
- `graphql-api`: the GraphQL endpoint's contract. It covers the types and their relations, how locations are represented, null results for unknown ids, error reporting, cursor pagination, the read-only scope and the published schema.
- `geo-temporal-query`: searching detections and captures by space (bounding box, radius) and time (observation or capture time range). It covers the effective-location rule, input bounds and partition-pruned time queries.

### Modified Capabilities
None. REST behavior (`capture-ingest`, `detection-records`, `detector-registry`) is unchanged. GraphQL reuses the effective-location rule already in `detection-records` ("Location and time default from the capture") without changing it.

## Impact

- **`apps/api`:**
  - A new GraphQL module (schema, resolvers, per-request data loaders, search queries) mounted in `buildApp`.
  - A migration adding geography expression indexes for radius search.
  - A committed `schema.graphql`.
  - A demo seed script.
- **`packages/schemas`:** shared Zod schemas for the bounding box, radius and time-range inputs.
- **`apps/web`:** a map route next to the existing upload and annotation page.
- **New dependencies:**
  - `graphql`, `graphql-yoga`, `@pothos/core` and `dataloader` (API).
  - `maplibre-gl` (web).
  - The skeleton's `@pothos/plugin-drizzle` is **not** used: it needs a pre-release drizzle-orm 1.0 (see design D1).
- **Docs:** API README (GraphQL section with example queries), root README (map page), and `docs/ROADMAP.md` (the F2.1 wording changes to drop plugin-drizzle).
