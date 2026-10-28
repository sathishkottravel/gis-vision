# Tasks

## 1. F2.1 GraphQL server

- [x] 1.1 Add `graphql@16`, `graphql-yoga`, `@pothos/core`, `@pothos/plugin-relay`, `@pothos/plugin-dataloader` and `dataloader@2` to `apps/api` (versions at least two weeks old, design D1), and create `src/graphql/builder.ts` with the plugins and the `DateTime`, `JSON` and `GeoJSONPoint` scalars (GeoJSON parsed with `geoJsonPointSchema`); verify unit tests for scalar parsing and serialization (valid point, latitude 95 rejected, offsets normalized to UTC)
- [x] 1.2 Mount Yoga as a Fastify plugin at `GET`/`POST /graphql` with a per-request context, GraphiQL only outside production, batching off and no `Mutation` type (design D2), registered from optional `AppDeps.graphql` and wired in `createAppDeps`; verify integration tests that `{ __typename }` returns 200, a syntax error returns a GraphQL error, a `mutation` is rejected, and GraphiQL is served in development but not with `NODE_ENV=production`
- [x] 1.3 Implement error mapping (design D9): Zod/`ValidationError` → `BAD_USER_INPUT` with `extensions.issues` paths, other `RequestError`s keep their code, everything else masked as `INTERNAL_SERVER_ERROR` and logged with the request id; verify unit tests for each mapping and an integration test that a failing resolver returns no SQL or stack trace
- [x] 1.4 Add `graphql:schema` (prints the sorted SDL to `apps/api/schema.graphql`), add the file to `.prettierignore`, and add a unit test that fails with the regenerate command when the committed SDL differs (design D10); verify the test fails after adding a field without regenerating and passes after regenerating
- [x] 1.5 Document the endpoint in `apps/api/README.md` (URL, GraphiQL, read-only scope, error shape, `graphql:schema`) and update the F2.1 wording in `docs/ROADMAP.md` (Pothos + DataLoader, not plugin-drizzle); verify the documented `curl` query runs as written against Compose

## 2. F2.2 Core types

- [x] 2.1 Add the `Detector`, `Capture` and `Detection` object types and the root fields `detectors`, `detector(id)` and `capture(id)`, with REST-equal values, `imageUrl` only for ready captures, `null` for unknown or non-UUID ids, and `Detection.location` plus `locationSource` from the effective location (design D5); verify integration tests for the nested read, REST equality, unknown id → null, pending → `imageUrl: null`, and the `CAPTURE`/`NONE` fallback cases
- [x] 2.2 Add per-request loaders `captureById`, `detectorById` and `detectionsByCaptureId` and use them for `Detection.capture`, `Detection.detector` and `Capture.detections` (ordered by observation time); give `createDatabase` an optional query logger; verify the integration test that 5 and 50 detections with capture and detector issue the same number of SQL queries
- [x] 2.3 Regenerate `schema.graphql` and add example queries for the core types to the API README; verify the SDL drift test passes and the README examples run in GraphiQL

## 3. F2.3 Spatial queries

- [x] 3.1 Add `geoBoundingBoxSchema` (ranges, `south <= north`, antimeridian when `west > east`) and `nearSchema` (center point, radius > 0 and ≤ 50,000 m) to `packages/schemas/src/geo.ts`; verify unit tests for each accepted and rejected case in the `geo-temporal-query` spec
- [x] 3.2 Add a custom migration with `GIST ((geom::geography))` expression indexes on `capture` and on the `detection` parent (design D6); verify `db:check` passes and an integration test reads both index definitions from `pg_indexes`, including on a detection partition and `detection_default`
- [x] 3.3 Implement `src/search/detection-search.ts`: a `UNION ALL` of the own-point branch and the capture-fallback branch for bbox (one envelope, or two for the antimeridian) and radius, plus the single `LEFT JOIN` query when no spatial filter is given, each returning the effective point and its source, ordered `(observed_at, id)` with a limit (design D6); verify integration tests for own point inside, capture fallback inside, own outside with capture inside (excluded), edge point, antimeridian box, radius 500 m vs 1,500 m, and no-location rows never matching a spatial filter
- [x] 3.4 Expose `detections(filter: DetectionFilter, first)` as a connection (first page only; `after` comes in 4.x/5.x), rejecting both `bbox` and `near` together; verify integration tests through GraphQL, including `BAD_USER_INPUT` issue paths for an inverted box and a 60 km radius
- [x] 3.5 Implement `src/search/capture-search.ts` and `captures(filter: CaptureFilter, first)` for bbox over the capture location (antimeridian included, no location never matches); verify the "Captures in view" integration test
- [x] 3.6 Document the spatial filters in the API README, with example queries and an `EXPLAIN ANALYZE` recipe for checking index use on demo data; verify the examples run in GraphiQL

## 4. F2.4 Temporal filters

- [x] 4.1 Add `timeRangeSchema` (half-open, either bound optional, `from < to`) to `packages/schemas`, and apply `observedFrom`/`observedTo` to every branch of the detection search and `capturedFrom`/`capturedTo` to the capture search, combined with the spatial and `detectorId` filters (logical AND); verify unit tests for the schema, and integration tests for the month-boundary, three-years-ago, empty-range and space+time+detector scenarios
- [x] 4.2 Add the partition-pruning integration test (design D7): `EXPLAIN (FORMAT JSON)` of the search's own query object collects relation names and expects only that month's partition (plus `capture` for the fallback branch) for a one-month range, and only `detection_default` for a month five years back; verify it passes, and fails when the time predicate is removed from one branch
- [x] 4.3 Document the time filters and the pruning guarantee in the API README; verify the example query runs in GraphiQL

## 5. F2.5 Pagination

- [x] 5.1 Implement `src/search/cursor.ts` (base64url JSON `{v, t, id}` with a microsecond-precision timestamp string, Zod-validated decode) and `first` bounds (1–100, default 50); verify unit tests for round trip, tampered or foreign cursors → `BAD_USER_INPUT` on `after`, and `first: 0`/`101` rejected
- [x] 5.2 Add keyset `after` to `detections` (`(observed_at, id) >` in every branch) and `captures` (`(created_at, id) <`), with `hasNextPage` from `first + 1` and `endCursor` from the last edge (design D8); verify integration tests that 120 matches arrive exactly once over three pages, rows with identical `now()` timestamps split across a page boundary appear once, and a detection inserted earlier in the order after page 1 causes no repeats
- [x] 5.3 Regenerate `schema.graphql` and document pagination (connection shape, cursors, limits) in the API README; verify the SDL drift test passes and the paging example runs in GraphiQL

## 6. F2.6 Map page

- [ ] 6.1 Add `src/db/seed-demo.ts` and the `db:seed-demo` script (design D12: about 40 ready captures with generated PNGs, about 200 detections with and without own points, some in the default partition, re-runnable, refuses in production); verify that running it twice against Compose leaves one demo set and that `GET /captures` shows thumbnails
- [ ] 6.2 Add `maplibre-gl` to `apps/web`, a `#/map` route with a nav link, and the OpenFreeMap basemap (overridable with `VITE_MAP_STYLE_URL`) (design D11); verify `pnpm --filter web build` succeeds and, manually, the map renders with attribution
- [ ] 6.3 Fetch detections for the normalized viewport on `moveend` (300 ms debounce, abort the previous request, antimeridian and whole-world handling, at most 500 points with a notice) via `src/graphql.ts`, and render them as a circle layer styled by `locationSource`, with a popup linking to `#/captures/:id`; verify unit tests for bounds normalization and, manually against the demo seed, that panning updates the points and the popup link opens the capture
- [ ] 6.4 Add the time-range control (24 h, 7 days, 30 days, all, custom) that refetches; verify manually that narrowing the range removes older points and "all" shows the points in the default partition
- [ ] 6.5 Document the map page and the demo seed in the root README ("Run the web app"); verify the documented steps work as written

## 7. Phase 2 end-to-end check

- [ ] 7.1 From a clean clone, follow the README (Compose, migrate, seed demo data, start the API and web), open the map, pan and change the time range, open a capture from a popup, and run the README's GraphQL examples; verify `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` are all green and CI passes

## Workflow follow-up

- Review the feature PRs, then archive with `/opsx:archive phase-2-graphql-geo-queries`, which adds `graphql-api` and `geo-temporal-query` to `openspec/specs/`.
- Then plan Deploy v0 in detail: `/opsx:propose phase-2-5-deploy-v0` (its skeleton assumes Phases 0-2 are done).
