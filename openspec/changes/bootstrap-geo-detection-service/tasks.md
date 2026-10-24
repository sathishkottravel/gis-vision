# Tasks

Implement **one feature group at a time**, in order (`/opsx:apply bootstrap-geo-detection-service only F0.1`). Each group must leave lint, typecheck and tests green and be committed before the next one starts.

Prerequisites: current Node LTS, pnpm, Docker Desktop running (Compose and Testcontainers need it).

## 1. F0.1 Monorepo & tooling

- [x] 1.1 Create a `feature/bootstrap` branch from `main` (which already has README, `.gitignore` and planning docs); verify `git branch --show-current` prints `feature/bootstrap`
- [x] 1.2 Create the pnpm workspace (`pnpm-workspace.yaml`, root `package.json` with `lint`, `typecheck`, `test`, `test:integration` scripts) and package stubs `apps/api`, `apps/web`, `packages/schemas`; verify `pnpm install` succeeds and `pnpm -r exec pwd` lists all three
- [x] 1.3 Add a shared strict `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM) with per-package tsconfigs; verify `pnpm typecheck` passes on a placeholder `src/index.ts` in each package
- [x] 1.4 Configure ESLint (typescript-eslint, type-aware) and Prettier with `.editorconfig`; verify `pnpm lint` passes and fails on a deliberately unused variable
- [x] 1.5 Configure Vitest workspace with separate unit and integration projects (`*.test.ts` vs `*.int.test.ts`); verify `pnpm test` runs a trivial passing test in `packages/schemas`

## 2. F0.2 Local infrastructure

- [x] 2.1 Add `docker-compose.yml` with pinned `postgis/postgis` (PG17) image, named volume and healthcheck; verify `docker compose up -d` makes the DB container healthy and `SELECT postgis_full_version()` works via `docker compose exec`
- [x] 2.2 Add RustFS with a one-shot init container that creates the captures bucket (private); verify the bucket exists in the RustFS console
- [x] 2.3 Add `.env.example` documenting every variable (DB URL, S3 endpoint, bucket, credentials, region, upload limits); verify copying it to `.env` is enough for later features
- [x] 2.4 Add a root `README.md` "Local setup" section (prerequisites, `docker compose up -d`, ports) and verify the steps work from a clean checkout

## 3. F0.3 API skeleton

- [x] 3.1 Add a Zod-validated config module in `apps/api` that fails fast with the names of invalid/missing settings and never prints secret values; verify with unit tests for valid, missing and malformed config
- [x] 3.2 Implement the `buildApp(deps)` Fastify factory with structured logging (pino, with request ids) and a server entry `src/server.ts`; verify `pnpm --filter api dev` starts and logs JSON
- [x] 3.3 Implement `GET /health` with timed database and object-storage checks behind small health-check interfaces, returning 200/503 per the `service-health` spec without leaking internals; verify unit tests with fake checks cover ok, db-down, storage-down and timeout
- [x] 3.4 Verify manually against Compose: `curl localhost:<port>/health` returns 200, and after `docker compose stop rustfs` returns 503 with `objectStorage: "error"`

## 4. F0.4 Integration test harness

- [ ] 4.1 Add Testcontainers global setup that starts the PostGIS and RustFS containers once per integration run, creates the bucket and exposes connection config; verify the containers start and stop with `pnpm test:integration`
- [ ] 4.2 Add a helper that builds the app against the containers and uses `app.inject`; verify the first integration test `health.int.test.ts` gets 200 with all dependencies `ok`

## 5. F0.5 Continuous integration

- [ ] 5.1 Add a GitHub Actions workflow (pnpm cache, current Node LTS) running lint, typecheck, unit and integration tests on push and pull request; verify the workflow file passes `actionlint` (or a local dry run), and is green on the first push
- [ ] 5.2 Add a CI status badge and a "Running tests" section to the README; verify the documented commands run as written

## 6. F0.6 Roadmap document

- [ ] 6.1 Write `docs/ROADMAP.md` with every phase (0-8 and 2.5), its feature list, exit criteria, the deployment decision, and the rule that each phase is a separate OpenSpec change applied one feature at a time; verify it matches the Milestones table in this change's proposal and lists every skeleton change in `openspec/changes/`
- [ ] 6.2 Link the roadmap from the README; verify the link resolves

## 7. F1.1 Database foundation

- [ ] 7.1 Add Drizzle ORM and drizzle-kit to `apps/api` with a DB client module that sets `search_path` to include `extensions`; verify typecheck passes and a unit test checks the client config
- [ ] 7.2 Add the first custom SQL migration: `CREATE SCHEMA extensions`, `CREATE EXTENSION postgis SCHEMA extensions`; verify an integration test runs migrations on a fresh container and `ST_MakePoint` works without schema qualification
- [ ] 7.3 Add a `db:migrate` script and run migrations in the integration global setup; verify running migrations twice is a no-op and `drizzle-kit check` reports no drift (no `spatial_ref_sys` in `public`)

## 8. F1.2 Core tables

- [ ] 8.1 Define the `detector` and `capture` tables in the Drizzle schema (capture: status, blob_key, content_type, byte_size, unique nullable idempotency_key, captured_at, geometry Point 4326, meta, created_at) with a GiST index on `capture.geom`; generate the migration and verify an integration test inserts and reads a capture with a point
- [ ] 8.2 Add a custom SQL migration for the `detection` table partitioned by range on `observed_at` (PK `(id, observed_at)`), monthly partitions for the past 12 and next 12 months plus a DEFAULT partition, GiST on `geom`, BRIN on `observed_at`, B-tree on `capture_id` and `(detector_id, observed_at)`; verify an integration test checks the partitions and indexes exist in `pg_catalog`
- [ ] 8.3 Map `detection` in the Drizzle schema for typed queries (without letting drizzle-kit manage its DDL); verify integration tests insert rows at 2026-01-31T23:59:59Z, 2026-02-01T00:00:00Z and three years ago, and that each lands in the expected partition (or DEFAULT)

## 9. F1.3 BlobStore port

- [ ] 9.1 Define the `BlobStore` port (`presignPut`, `presignGet`, `head`, `put`, `delete`) and an in-memory fake; verify typecheck passes
- [ ] 9.2 Write a shared contract test suite (put/head/delete round trip, head on missing key, presigned PUT then head, presigned GET downloads bytes, expired URL rejected); verify it passes against the in-memory fake
- [ ] 9.3 Implement the S3-API adapter (configurable endpoint, path-style for RustFS, presigned PUT bound to content type); verify the same contract suite passes against RustFS in integration tests
- [ ] 9.4 Switch the `/health` object-storage check to use the BlobStore adapter; verify the health integration test still passes

## 10. F1.4 Capture upload (presigned)

- [ ] 10.1 Add shared Zod request/response schemas for captures in `packages/schemas` (allowed content types, size limit from config, GeoJSON Point in WGS84 range); verify unit tests cover valid input and each rejection in the `capture-ingest` spec
- [ ] 10.2 Implement `POST /captures` (pending capture + presigned PUT + `expiresAt`) with `Idempotency-Key` handling (same key returns the same capture, different payload returns 409); verify integration tests for 201, 400 cases, retry and 409
- [ ] 10.3 Implement `POST /captures/:id/complete` (HEAD the object, check size and type, set `ready`, idempotent); verify integration tests that upload through the presigned URL to RustFS and cover ready, missing object, size mismatch, repeat and 404
- [ ] 10.4 Implement `GET /captures/:id` (GeoJSON location, presigned `imageUrl` only when ready) and `GET /captures` (newest first, bounded page size); verify integration tests that the image downloads from `imageUrl`, plus pending, 404 and ordering
- [ ] 10.5 Document the upload flow (sequence and example `curl` commands) in `apps/api/README.md`; verify the documented commands work against Compose

## 11. F1.5 Detector registry

- [ ] 11.1 Define the supported JSON Schema subset and a checker in `packages/schemas`; verify unit tests accept conforming schemas and reject unsupported constructs (e.g. `$ref`, nested objects)
- [ ] 11.2 Seed the `manual` detector through a migration (output schema: free-form attributes object) and implement the `DetectorRegistry` backed by the `detector` table; verify integration tests that `manual` exists after migrating a fresh DB and its schema passes the subset checker
- [ ] 11.3 Implement `GET /detectors` and `GET /detectors/:id/schema`; verify integration tests for the list, the known schema and 404

## 12. F1.6 Detections

- [ ] 12.1 Add shared Zod schemas for detection input (bbox x,y >= 0, w,h > 0; confidence 0..1; optional GeoJSON Point and observation time); verify unit tests cover the 400 cases in the `detection-records` spec
- [ ] 12.2 Implement attribute validation with Ajv against the detector's output schema (compiled and cached per detector version), returning 422 with paths; verify unit tests with a test detector whose schema has a `state` enum
- [ ] 12.3 Implement `POST /captures/:id/detections` (404 missing, 409 pending, 422 unknown detector or invalid attributes, defaults for observation time and location from the capture); verify integration tests for each scenario
- [ ] 12.4 Implement `GET /captures/:id/detections` (ordered by observation time, effective location as GeoJSON); verify integration tests including the month-boundary and old-observation scenarios

## 13. F1.7 Minimal UI

- [ ] 13.1 Scaffold `apps/web` with Vite + React + TypeScript and a dev proxy to the API; verify `pnpm --filter web dev` serves a page that shows the `/health` status
- [ ] 13.2 Build one plain page: choose an image and optional lat/lon, then run the three-step upload (create, PUT, complete) and show the capture list with thumbnails; verify manually against Compose that an uploaded image appears in the list
- [ ] 13.3 Add a capture detail view listing its detections, plus a simple form (label, bbox numbers, attributes JSON) that posts a `manual` detection and shows validation errors; verify manually that a valid detection appears and an invalid one shows its error
- [ ] 13.4 End-to-end check of Phase 0+1: from a clean clone, follow the README to run Compose, migrate, start the API and web, upload, annotate and see the detection; verify `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` are all green and CI passes

## Workflow follow-up

- Review all feature commits, then archive with `/opsx:archive bootstrap-geo-detection-service`, which moves the four specs into `openspec/specs/`.
- Then plan the next phase: `/opsx:propose phase-2-graphql-geo-queries`.
