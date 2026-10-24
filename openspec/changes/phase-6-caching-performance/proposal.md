# Proposal

> **Skeleton.** Planned in detail when Phase 5 is archived. Features are implemented one at a time, in order.

## Why

With real data flowing, map and time-range queries become the hot path. This phase measures first, then adds caching and vector tiles where the measurements justify them, and documents the before/after numbers.

## What Changes

- **F6.1 Baseline:** k6 load scenarios (map pan, time scrub, upload burst) with latency and throughput baselines.
- **F6.2 Vector tiles:** `/tiles/{z}/{x}/{y}.mvt` served with `ST_AsMVT`, and the map switched to tiles.
- **F6.3 HTTP caching:** ETag and Cache-Control on tiles and read endpoints, with CloudFront caching in front of the API.
- **F6.4 Application cache:** cache-aside for hot GraphQL queries behind a `Cache` port (Redis on the droplet or a serverless Redis; decided at planning time).
- **F6.5 Invalidation:** event-driven invalidation when detections are written, plus versioned tile keys.
- **F6.6 Time-series rollups:** pre-aggregated rollups (materialized views refreshed by `pg_cron`), and the native-partitioning-vs-TimescaleDB question revisited.
- **F6.7 Report:** a before/after performance report in `docs/`.

## Capabilities

### New Capabilities
- `vector-tiles`: tile endpoint behaviour, freshness and cache semantics.

### Modified Capabilities
- `geo-temporal-query`: adds aggregated time-series queries and cache freshness guarantees.

## Exit Criteria

A documented before/after report shows measurable improvement, and every cache has a tested invalidation path.

## Impact

`apps/api` (tiles, cache), `apps/web` (tile source), `deploy/` (CloudFront behaviours, Redis). New deps: ioredis, k6.
