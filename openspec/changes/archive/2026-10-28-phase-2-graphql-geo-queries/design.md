# Design

## Context

See `proposal.md` (Why) and the specs (`graphql-api`, `geo-temporal-query`) for the required behavior. This document covers how to build it on what Phase 0+1 left in place:

- **API:** Fastify 5 app built by `buildApp(deps)` (`apps/api/src/app.ts`), with `createAppDeps` wiring infrastructure in `infrastructure.ts`.
  - Domain services: `CaptureService` (with exported `findCapture`), `DetectionService`, and the `PgDetectorRegistry` port.
  - `BlobStore` (S3/RustFS) signs image URLs locally.
  - Errors are `RequestError` subclasses with `issues` (`errors.ts`), rendered by `http/error-handler.ts`.
- **Data:** Drizzle ORM **0.45.4** with `pg`. PostGIS lives in the `extensions` schema.
  - `capture.geom` and `detection.geom` are `geometry(Point, 4326)`, read and written through the `pointGeometry` custom type (`db/geometry.ts`).
  - `detection` is range-partitioned by month on `observed_at`: 25 partitions around the migration date plus `detection_default`, PK `(id, observed_at)`. It is mapped in `db/detection.ts`, outside drizzle-kit's schema path.
- **Existing indexes:**
  - GiST on `capture.geom` and `detection.geom` (geometry, so usable for bounding boxes).
  - BRIN on `detection.observed_at`.
  - btree on `detection.capture_id` and on `(detector_id, observed_at)`.
  - There is **no** geography index.
- **Effective location rule (Phase 1):** a detection created without a location stores `geom = NULL`, and its effective location is the capture's (`detection-records` spec; asserted by F1.6 tests).
- **Shared Zod schemas:** `packages/schemas` already has `geoJsonPointSchema`.
- **Web:** `apps/web` is Vite 8 + React 19 with hash routing (`#/`, `#/captures/:id`), and calls the API through the Vite `/api` proxy.
- **Delivery:** one feature per branch and PR, conventional-commit titles, CI with lint/typecheck/unit/integration jobs.

## Goals / Non-Goals

**Goals:**
- One code-first schema module that the Lambda entry in Phase 2.5 can reuse unchanged, because it lives inside `buildApp`.
- Spatial search that uses the existing indexes for bounding boxes and new geography indexes for radius, without changing how Phase 1 stores detections.
- Tests that prove the claims: SQL query counts (no N+1), `EXPLAIN` partition lists (pruning), and keyset paging over equal timestamps.

**Non-Goals:**
- Mutations and subscriptions. Writes stay on REST (spec: Read-only schema).
- Authentication, query depth and complexity limits, and rate limiting. These are Phase 8; the bounded `first` is the only cost guard for now.
- Vector tiles, clustering, HTTP or app caching. These are Phase 6; the map draws up to 500 points.
- Backward pagination (`last`/`before`), `totalCount`, persisted queries, a GraphQL client library in the web app (Phase 3 brings the app shell and client), and text search on labels.

## Decisions

### D1. Pothos core + per-request DataLoaders on Drizzle 0.45, not plugin-drizzle
`@pothos/plugin-drizzle` 0.20 requires `drizzle-orm >= 1.0.0-rc.2`. That is a pre-release, and it changes the relational query API and drizzle-kit too. The schema is instead built with `@pothos/core`, with small hand-written forward-only connection types (D8). Relations are batched by plain `dataloader` instances created per request in the GraphQL context (D5), and resolvers call plain Drizzle queries. Batching is then explicit and testable, which is what F2.2 must demonstrate anyway. (F2.1 also installed `@pothos/plugin-dataloader`; F2.2 removed it, because the explicit context loaders cover the same batching with a visible per-request lifecycle.) F2.3 likewise removed `@pothos/plugin-relay`: its `t.connection` always adds `before`/`last` arguments and backward `PageInfo` fields, but this API pages forward only.
- *Alternative:* upgrade to drizzle-orm 1.0 RC as an extra feature (F2.0) and use plugin-drizzle's automatic relation loading. Rejected for now: it puts a pre-release ORM under every existing table and migration. Revisit when drizzle-orm 1.0 is stable.
- *Alternative:* SDL-first with hand-written resolvers. Rejected: it loses the type safety between resolvers and schema that design D3 of Phase 0+1 chose Pothos for.
- **`graphql` major:** **16.x**. Yoga 6 and Pothos 4 support 16 and 17, but 16 is what most tooling (codegen, GraphiQL plugins) still targets. Moving to 17 later is a dependency bump.
- **Dependency versions:** each is pinned to a release at least two weeks old when F2.1 starts.

### D2. GraphQL Yoga mounted as a Fastify route
A `graphqlRoutes` plugin registers `GET`/`POST /graphql`, and the handler is `yoga.handleNodeRequestAndResponse(request, reply, context)`, using the documented Yoga-on-Fastify pattern. Fastify keeps its logging, request ids and lifecycle. Yoga is told Fastify's logger, and its own body parsing reads `request.body`.
- **Per-request context:** `{ db, blobStore, loaders, log, imageUrlTtlSeconds }`. Loaders are created per request, so nothing is cached across requests.
- **GraphiQL** is enabled only when `NODE_ENV !== 'production'` (it is served on `GET /graphql`). Introspection stays on everywhere until Phase 8 decides on auth.
- **Shape:** batching (arrays of operations) is disabled, and the schema has no `Mutation` type. A mutation therefore fails validation with GraphQL's standard "not configured for mutations" error, as the spec requires.
- The route is registered like the REST plugins, from an optional `AppDeps.graphql`, so health-only tests stay unchanged.
- *Alternative:* `mercurius`, which is Fastify-native. Rejected: design D3 already chose Yoga, and Yoga's fetch-API core runs the same way in Lambda.

### D3. Module layout
`apps/api/src/graphql/` contains:
- `builder.ts`: the Pothos builder with plugins and scalar typings.
- `scalars.ts`: `DateTime`, `JSON` and `GeoJSONPoint`.
- `types/{capture,detection,detector}.ts`.
- `loaders.ts`.
- `errors.ts`: the error mapping (D9).
- `schema.ts`: builds `GraphQLSchema` and exports it.
- `routes.ts`.

Search SQL lives in `apps/api/src/search/` (`detection-search.ts`, `capture-search.ts`, `cursor.ts`). It is plain functions over `Database`, so it can later back REST or the tile endpoint (Phase 6) without GraphQL. GraphQL resolvers stay thin: parse the arguments with the shared Zod schemas, call search or loaders, then map rows to nodes.

### D4. Scalars and inputs
- **`DateTime`:** ISO 8601 with offset on input, normalized to UTC `...Z` with milliseconds on output (same as REST).
- **`JSON`:** used for `attributes` and `Detector.outputSchema`.
- **`GeoJSONPoint`:** parsed with the existing `geoJsonPointSchema`, so out-of-range coordinates become `BAD_USER_INPUT`.
- **Inputs:**
  - `BoundingBoxInput { west south east north }`
  - `NearInput { center: GeoJSONPoint, radiusMeters: Float }`
  - `DetectionFilter { bbox, near, observedFrom, observedTo, detectorId }`
  - `CaptureFilter { bbox, capturedFrom, capturedTo }`
- **Validation rules** live as Zod schemas in `packages/schemas/src/geo.ts` (`boundingBoxSchema`, `nearSchema`, `timeRangeSchema`): bounds, `south <= north`, radius between 0 and 50 km, `from < to`, and only one of `bbox`/`near`. The map page uses the same schemas.

### D5. Node mapping, effective location and batching
- **`Detection` node:** built from a row that already carries its **effective** point and `locationSource`. That holds whichever way the detection was reached:
  - The search SQL computes them (D6).
  - `Capture.detections` computes them from the capture already in hand.
  
  So `location` never needs an extra lookup.
- **Loaders (per request, `dataloader` 2):**
  - `captureById`: one `SELECT ... WHERE id = ANY($1)`. Invalid UUIDs are filtered out first, and unknown ids resolve to `null`.
  - `detectorById`: same pattern.
  - `detectionsByCaptureId`: one query for all requested captures, ordered by `(observed_at, id)`, then grouped.
- **Image URLs:** `Capture.imageUrl` is presigned locally by `blobStore.presignGet`, with no I/O and only when `status = 'ready'`.
- **N+1 proof:** `createDatabase` gains an optional Drizzle `logger`. The integration test builds the app with a counting logger, runs the same query for 5 and for 50 detections (each with `capture` and `detector`), and asserts equal query counts.

### D6. Effective-location search as `UNION ALL` of two index-friendly branches
A detection's effective point is `COALESCE(d.geom, c.geom)`. That spans two tables, so no single index can serve it. The search is therefore built as two branches, with the same time, detector and keyset predicates in both:
- **A:** `detection d WHERE d.geom IS NOT NULL AND <spatial(d.geom)>`. Uses the detection GiST (bbox) or the geography GiST (radius), per partition.
- **B:** `detection d JOIN capture c ON c.id = d.capture_id WHERE d.geom IS NULL AND <spatial(c.geom)>`. Uses the capture GiST, then `detection_capture_id_idx`.

Each branch selects the detection columns plus `effective_geom` and `location_source` (`'DETECTION'` or `'CAPTURE'`). The outer query applies `ORDER BY observed_at, id LIMIT first + 1`. Without a spatial filter, a single `LEFT JOIN capture` query with `COALESCE` is used, and `location_source` can then be `'NONE'`.
- **Bounding box:** `geom && ST_MakeEnvelope(w, s, e, n, 4326)`. For points, `&&` is exact and edge-inclusive. When `west > east` (antimeridian), the predicate is an `OR` of two envelopes, `[west, 180]` and `[-180, east]`, which the planner serves with a BitmapOr over the same index.
- **Radius:** `ST_DWithin(geom::geography, ST_MakePoint(lon, lat)::geography, r)`. This is geodesic, boundary-inclusive, and spheroid by default. A new custom migration adds expression indexes `USING gist ((geom::geography))` on `capture` and on the `detection` parent; parent indexes cascade to all partitions, including the default. The predicate text must match the index expression exactly, so both live in one helper.
- *Alternative:* denormalize at write time by copying the capture's point into `detection.geom` when omitted. That would allow one GiST and no union. Rejected: it changes Phase 1 behavior. `detection-records` says the detection stores no own location, the F1.6 test asserts `geom IS NULL`, and `locationSource` would become unknowable.
- *Alternative:* a single query with `OR` across the join. Rejected: the planner can't use either GiST for `COALESCE`/`OR` across tables and falls back to scanning every partition.

### D7. Time filters and partition pruning
- **Predicates:** `observed_at >= $from` and `observed_at < $to` go into **every** branch, applied to the `detection` relation itself, so pruning applies per branch.
- **Plan-time pruning:** node-pg sends parameters on an unnamed statement. Postgres plans it with the actual values (a custom plan), so pruning happens at plan time and `EXPLAIN` shows only the overlapping partitions.
- **Pruning test:** the integration test runs `EXPLAIN (FORMAT JSON)` on the exact query object the search builds, through `db.execute(sql\`EXPLAIN (FORMAT JSON) ${query}\`)`. It collects every `Relation Name` and asserts the set:
  - `{ detection_y2026m03 }` for a March 2026 range (plus `capture` for branch B).
  - `{ detection_default }` for a range five years back.
- **Capture time:** `capturedFrom`/`capturedTo` filter `capture.captured_at` (no partitioning). That table's existing indexes suffice at demo scale.

### D8. Keyset pagination with full-precision opaque cursors
- **Order and keyset:** detections are ordered by `(observed_at ASC, id ASC)`, with keyset `(observed_at, id) > ($t, $id)` inside each branch. Captures are ordered by `(created_at DESC, id DESC)`, with `(created_at, id) < ($t, $id)`.
- **Page size:** fetch `first + 1` rows; `hasNextPage` is whether the extra row exists. `first` is 1–100, default 50 (Zod).
- **Cursor:** base64url of JSON `{ "v": 1, "k": "detection" | "capture", "t": "<timestamp>", "id": "<uuid>" }`, validated with Zod on decode. `k` (added in F2.5) makes a detections cursor invalid for `captures` and vice versa. Anything else is `BAD_USER_INPUT` on `after`.
- **Partition pruning with a cursor:** besides the row comparison `(observed_at, id) > ($t, $id)`, each branch also gets `observed_at >= $t`, a plain bound the planner can use to skip partitions before the cursor.
- **Precision:** `t` must be **microsecond-precise**. `created_at` and `captured_at` default to `now()`, which has microseconds, and a millisecond JS `Date` would make keyset comparisons skip or repeat rows. The search selects `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` as `cursor_ts`, and the cursor compares with `$t::timestamptz`. Tests create rows with identical `now()` timestamps across a page boundary.
- **Connection types:** hand-written `DetectionConnection`/`CaptureConnection` (`edges { node cursor }`, `pageInfo { hasNextPage endCursor }`) with forward-only arguments `first`/`after`. Pothos relay's `t.connection` was not used because it always adds `before`/`last`.
- *Alternative:* offset pagination. Rejected: it repeats or skips rows when new rows are inserted during paging (spec: Stable ordering), and it gets slower deeper into the results.

### D9. Error mapping
- **Bad input:** resolvers parse arguments with Zod. On failure they throw a `GraphQLError` with `extensions: { code: 'BAD_USER_INPUT', issues: [{ path, message }] }`, where `path` is relative to the argument (e.g. `filter.bbox.south`, `first`, `after`). Existing `RequestError`s map to the same shape, using their `code`.
- **Everything else:** Yoga's `maskedErrors` reports `INTERNAL_SERVER_ERROR` with a generic message. The original error is logged with the request id through Fastify's logger.
- **Syntax and validation errors:** reported as standard GraphQL errors.

### D10. Committed SDL with a drift test
- **Generation:** `pnpm --filter @gis-vision/api graphql:schema` writes `apps/api/schema.graphql` from `printSchema(lexicographicSortSchema(schema))`.
- **Drift test:** a unit test (no DB needed) rebuilds the SDL and compares it with the file. On mismatch it fails with the command to run.
- **Formatting:** the file is listed in `.prettierignore`, so the generated output is the single source.
- *Alternative:* serve introspection only. Rejected: a committed SDL makes schema changes visible in PR diffs.

### D11. Map page
- **Map:** `maplibre-gl` 6 on a new `#/map` route, with a nav link on every page.
- **Basemap:** OpenFreeMap's `liberty` style (no API key, OSM data, attribution shown). It can be overridden with `VITE_MAP_STYLE_URL`.
  - *Alternative:* MapLibre demo tiles, too coarse for city-level data.
  - *Alternative:* MapTiler, which needs a key.
- **Data:** a plain `fetch` POST to `/api/graphql` with the query text in `apps/web/src/graphql.ts`. There is no client library until Phase 3.
- **Fetching:**
  - On `moveend`, wait 300 ms (debounce), then abort the previous request and fetch detections for the normalized bounds.
  - Normalization: `LngLatBounds.wrap()` brings longitudes into ±180, and `west > east` is passed through as an antimeridian box. A view spanning ≥ 360° sends no bbox.
  - The page follows `endCursor` up to 500 points and shows a "showing first 500" notice when there are more.
- **Rendering:** a GeoJSON source with a circle layer, styled by `locationSource` (own point vs capture fallback). Clicking a point opens a popup with label, detector, observation time and a link to `#/captures/:id`.
- **Time control:** presets (24 h, 7 days, 30 days, all) plus two `datetime-local` inputs. Changing the range refetches.

### D12. Demo seed
- **Command:** `pnpm --filter @gis-vision/api db:seed-demo` (`src/db/seed-demo.ts`). It refuses to run when `NODE_ENV=production`.
- **What it creates:**
  - About 40 ready captures around three cities, spread over the past six months, each with a small generated PNG stored via `blobStore.put`.
  - About 200 `manual` detections, roughly half with their own point (jittered around the capture) and half without.
  - Some detections a few years back, so data lands in the default partition: each city's last capture (and so its detections) is dated three years back. Each city also has captures from the last day and week, so every time preset shows points.
  - Data is generated by a seeded PRNG (`src/db/demo-data.ts`), so the layout is the same on every run; Taveuni (Fiji) points straddle the antimeridian.
- **Re-runs:** rows are tagged `meta.seed = 'demo'` (captures) and the label prefix `demo:` (detections), so a re-run first deletes the earlier demo rows and their blobs.

## Risks / Trade-offs

- **[`UNION ALL` search is more SQL to maintain than a COALESCE query]** → Both branches come from one builder with shared predicate helpers. Every spec scenario (own vs capture location, edge, antimeridian, radius boundary, no location) has an integration test.
- **[Index use isn't asserted on tiny test data; the planner may prefer sequential scans]** → Tests assert semantics and partition pruning, not index choice. The API README documents an `EXPLAIN ANALYZE` check against the demo seed for each spatial filter.
- **[The radius predicate silently stops using the geography index if its expression drifts from the index definition]** → One helper owns the expression. An integration test asserts the index exists with that definition, via `pg_indexes`.
- **[Cursor timestamps lose precision through JS `Date`]** → Microsecond text cursors (D8), plus a test with equal `now()` timestamps across a page boundary.
- **[Cyclic types (capture → detections → capture) allow deep, expensive queries; there are no depth limits yet]** → Lists are bounded by `first` and loaders keep each level to one query. Depth and complexity limits are Phase 8. They are listed as a Deploy v0 risk, since the endpoint becomes public there.
- **[GraphiQL and introspection on a public deploy]** → GraphiQL is off in production. Introspection stays on until auth (Phase 8), which is acceptable for a read-only demo.
- **[Third-party basemap availability or limits]** → Configurable style URL. Detection points still render on a blank background if tiles fail.
- **[Fresh dependency releases (Yoga 6, Pothos 4.16 are days old at planning time)]** → Pin versions at least two weeks old when F2.1 starts (D1).

## Migration Plan

- **One new custom migration** (F2.3): geography GiST expression indexes on `capture` and on the `detection` parent.
  - It runs with `pnpm db:migrate` like the earlier ones. `CREATE INDEX` on a partitioned parent can't use `CONCURRENTLY`, which is fine at current data sizes. On a large production table it would be built per partition first.
  - Rollback is `DROP INDEX`. No data changes.
- **Everything else is additive:** a new route, a new web page, new dependencies. REST endpoints and their tests are untouched. Phase 2.5 deploys the result through the same `buildApp`.

## Open Questions

- Marker clustering at low zoom: deferred to Phase 6 (vector tiles), where clustering belongs server-side. It doesn't affect these specs or tasks.
