# Proposal

> **Skeleton.** Planned in detail (specs, design, tasks) when `bootstrap-geo-detection-service` (Phases 0+1) is archived. Features are implemented one at a time, in order.

## Why

Phase 1 stores captures and detections but can only fetch them by id. This phase turns the data into something you can explore: nested, typed reads over GraphQL, and the spatial and temporal queries that are the core reason for using PostGIS. It also adds a first map view.

## What Changes

- **F2.1 GraphQL server:** GraphQL Yoga mounted in the Fastify app, code-first schema with Pothos + `plugin-drizzle`.
- **F2.2 Core types:** `Capture`, `Detection`, `Detector` types with relations, a `GeoJSON` scalar, batched relation loading (with a test that proves there's no N+1).
- **F2.3 Spatial queries:** detections within a bounding box and within a radius (`ST_DWithin`); falls back to the capture location when a detection has no geometry.
- **F2.4 Temporal filters:** time-range filtering on `observed_at`, with partition pruning verified by `EXPLAIN` in integration tests.
- **F2.5 Pagination:** cursor-based pagination with stable ordering for detection queries.
- **F2.6 Map page:** MapLibre page that queries the visible bounding box on map move, plus a time-range control.

## Capabilities

### New Capabilities
- `graphql-api`: the GraphQL endpoint, its types and relation semantics.
- `geo-temporal-query`: spatial (bbox, radius) and temporal (time range) querying of detections and captures.

### Modified Capabilities
<!-- None expected. -->

## Exit Criteria

The map shows detections in the current viewport, filtered by time. Spatial and temporal edge cases are covered by integration tests.

## Impact

`apps/api` (GraphQL module), `apps/web` (map page). New deps: graphql, graphql-yoga, @pothos/core, @pothos/plugin-drizzle, maplibre-gl.
