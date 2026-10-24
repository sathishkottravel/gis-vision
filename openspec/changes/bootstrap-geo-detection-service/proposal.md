# Proposal

## Why

This project is a portfolio service that demonstrates production-grade backend work: Node.js/TypeScript, REST and GraphQL, geospatial and time-series data in PostGIS, IaC/containers, distributed-systems design and disciplined testing. The domain is visual detections (traffic signals, pedestrian crossings, supermarket price tags, ...) located in space and time. The concrete detector and the hosting target are deliberately undecided.

The system is built in phases, each delivered as its own OpenSpec change and implemented one feature at a time. This change covers **Phase 0 (Scaffold)** and **Phase 1 (Captures & detections over REST)**. Together they establish a tested, detector-agnostic, hosting-agnostic core that later phases extend without reshaping.

## What Changes

Features are implemented and verified one at a time, in order. Each feature maps to its own task group in `tasks.md`.

**Phase 0: Scaffold**
- **F0.1 Monorepo & tooling:** pnpm workspaces (`apps/api`, `apps/web`, `packages/schemas`), strict TypeScript, ESLint/Prettier, Vitest.
- **F0.2 Local infrastructure:** Docker Compose with PostgreSQL 17 + PostGIS and MinIO (bucket created on startup).
- **F0.3 API skeleton:** Fastify `buildApp(deps)` factory, Zod-validated env config, structured logging, `GET /health` reporting DB and bucket status.
- **F0.4 Test harness:** Testcontainers setup for PostGIS and MinIO; first integration test against `/health`.
- **F0.5 CI:** GitHub Actions running lint, typecheck, unit and integration tests.
- **F0.6 Roadmap doc:** `docs/ROADMAP.md` holding all phases, feature lists and exit criteria (the durable copy of the milestones below).

**Phase 1: Captures & detections (REST)**
- **F1.1 Database foundation:** Drizzle setup, PostGIS in an `extensions` schema, migration pipeline.
- **F1.2 Core tables:** `detector`, `capture`, and `detection` (monthly range partitions on `observed_at`, plus GiST and BRIN indexes).
- **F1.3 BlobStore port:** interface, in-memory fake, S3-API adapter (MinIO), shared contract test suite.
- **F1.4 Capture upload (presigned):** `POST /captures` (metadata: content type, size, optional GeoJSON point and capture time; `Idempotency-Key`) creates a `pending` capture and returns a short-lived presigned PUT URL. The client uploads directly to object storage, then calls `POST /captures/:id/complete`, which verifies the object and marks the capture `ready`. `GET /captures/:id` returns the capture with a presigned image URL. Image bytes never pass through the API, so the same flow works locally (MinIO) and on Lambda.
- **F1.5 Detector registry:** seeded `manual` detector with an output JSON Schema; `GET /detectors`, `GET /detectors/:id/schema`.
- **F1.6 Detections:** `POST /captures/:id/detections` with Ajv validation against the detector schema; `GET /captures/:id/detections`.
- **F1.7 Minimal UI:** a single plain page to upload an image and list its captures and detections. No generated UI yet.

**Out of scope for this change:** GraphQL, spatial/temporal query APIs, map, schema-driven UI, queues, ML, caching, auth and deployment. These come in later phases (see Milestones).

**Decided:** deployment target is AWS serverless plus a PostGIS droplet (see Milestones, Phase 2.5); this change stays host-agnostic, but uses presigned uploads because Lambda caps request bodies at about 6MB.

**Deferred decisions:** first real detector (Phase 5), TimescaleDB vs. native partitioning (revisit in Phase 6).

## Milestones

Each phase becomes its own OpenSpec change, planned in detail only when the previous phase is archived. Each phase lists its features, to be implemented one at a time.

| Phase | Name | Key features | Exit criteria |
|---|---|---|---|
| 0 | Scaffold | monorepo, Compose, `/health`, Testcontainers, CI, roadmap doc | CI green; `/health` reports DB + bucket OK |
| 1 | Captures & detections (REST) | migrations, BlobStore, upload, detector registry, validated detections, upload page | upload -> annotate via REST end to end, tests green |
| 2 | GraphQL + geo/time queries | Pothos + Yoga, bbox/radius/time queries, GeoJSON, relation batching, pagination, MapLibre page | map shows detections in viewport filtered by time |
| 2.5 | Deploy v0 | AWS serverless (Lambda, API Gateway, S3, CloudFront) + PostGIS container on a DigitalOcean droplet (PgBouncer, pgAdmin via SSH tunnel, pg_cron cleanup, hardening, backups) | public URL running Phases 0-2 |
| 3 | Schema-driven UI | introspection-driven lists, JSON Forms from detector schemas, bbox annotation, Playwright e2e | new detector appears in UI with no rebuild |
| 4 | Async processing | JobQueue port, pg-boss adapter, stub detector worker, retries/DLQ, idempotency, outbox, job status | upload -> job -> detections, failure paths tested |
| 5 | CV worker (Python) | pick detector, ONNX model, worker on same job contract, cross-language contract tests | real detections on the map |
| 6 | Caching & performance | Redis, `ST_AsMVT` vector tiles, HTTP caching, invalidation, k6 load test | documented before/after numbers |
| 7 | IaC & production deploy | CDK or Terraform for chosen host, SQS adapter (if AWS), CD pipeline, budgets | one-command deploy and destroy |
| 8 | Hardening (optional) | OpenTelemetry across services, auth, rate limiting | end-to-end traces across services |

## Capabilities

### New Capabilities
- `service-health`: reporting the service's and its dependencies' readiness.
- `capture-ingest`: uploading images with optional location and capture time, storing the blob and its metadata, retrieving captures.
- `detector-registry`: registering detectors with output JSON Schemas and exposing those schemas to clients.
- `detection-records`: creating and listing detections on a capture, validating attributes against the detector's schema.

### Modified Capabilities
<!-- None: no existing specs. -->

## Impact

- New monorepo: `apps/api`, `apps/web` (minimal page only), `packages/schemas`, `docs/ROADMAP.md`.
- Dependencies: Fastify, Drizzle ORM/drizzle-kit, Zod, Ajv, AWS S3 SDK, Vitest, Testcontainers.
- Infrastructure: Docker Compose (PostgreSQL + PostGIS, MinIO); GitHub Actions CI.
