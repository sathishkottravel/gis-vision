# Roadmap

gis-vision is built in phases. Each phase is **one OpenSpec change** in `openspec/changes/`, and each change is applied **one feature at a time** (`/opsx:apply <change> only F<id>`). Every feature gets its own branch and PR, ships with its own tests and leaves CI green before the next feature starts. A phase is planned in detail (specs, design, tasks) only once the previous phase is archived; until then its change is a skeleton holding only `proposal.md`.

The source of truth for each phase is its change's `proposal.md`. This document is the durable overview; the milestones table matches the one in [`bootstrap-geo-detection-service/proposal.md`](../openspec/changes/archive/2026-10-28-bootstrap-geo-detection-service/proposal.md#milestones).

## Milestones

| Phase | Name                         | Key features                                                                                                                                                                | Exit criteria                                       |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0     | Scaffold                     | monorepo, Compose, `/health`, Testcontainers, CI, roadmap doc                                                                                                               | CI green; `/health` reports DB + bucket OK          |
| 1     | Captures & detections (REST) | migrations, BlobStore, upload, detector registry, validated detections, upload page                                                                                         | upload -> annotate via REST end to end, tests green |
| 2     | GraphQL + geo/time queries   | Pothos + Yoga, bbox/radius/time queries, GeoJSON, relation batching, pagination, MapLibre page                                                                              | map shows detections in viewport filtered by time   |
| 2.5   | Deploy v0                    | AWS serverless (Lambda, API Gateway, S3, CloudFront) + PostGIS container on a DigitalOcean droplet (PgBouncer, pgAdmin via SSH tunnel, pg_cron cleanup, hardening, backups) | public URL running Phases 0-2                       |
| 3     | Schema-driven UI             | introspection-driven lists, JSON Forms from detector schemas, bbox annotation, Playwright e2e                                                                               | new detector appears in UI with no rebuild          |
| 4     | Async processing             | JobQueue port, pg-boss adapter, stub detector worker, retries/DLQ, idempotency, outbox, job status                                                                          | upload -> job -> detections, failure paths tested   |
| 5     | CV worker (Python)           | pick detector, ONNX model, worker on same job contract, cross-language contract tests                                                                                       | real detections on the map                          |
| 6     | Caching & performance        | Redis, `ST_AsMVT` vector tiles, HTTP caching, invalidation, k6 load test                                                                                                    | documented before/after numbers                     |
| 7     | IaC & production deploy      | CDK or Terraform for chosen host, SQS adapter (if AWS), CD pipeline, budgets                                                                                                | one-command deploy and destroy                      |
| 8     | Hardening (optional)         | OpenTelemetry across services, auth, rate limiting                                                                                                                          | end-to-end traces across services                   |

## Changes

| Phase | OpenSpec change                                                                                             | State                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0+1   | [`bootstrap-geo-detection-service`](../openspec/changes/archive/2026-10-28-bootstrap-geo-detection-service) | done, archived 2026-10-28 (specs in [`openspec/specs/`](../openspec/specs)) |
| 2     | [`phase-2-graphql-geo-queries`](../openspec/changes/phase-2-graphql-geo-queries)                            | skeleton                                                                    |
| 2.5   | [`phase-2-5-deploy-v0`](../openspec/changes/phase-2-5-deploy-v0)                                            | skeleton                                                                    |
| 3     | [`phase-3-schema-driven-ui`](../openspec/changes/phase-3-schema-driven-ui)                                  | skeleton                                                                    |
| 4     | [`phase-4-async-processing`](../openspec/changes/phase-4-async-processing)                                  | skeleton                                                                    |
| 5     | [`phase-5-cv-worker`](../openspec/changes/phase-5-cv-worker)                                                | skeleton                                                                    |
| 6     | [`phase-6-caching-performance`](../openspec/changes/phase-6-caching-performance)                            | skeleton                                                                    |
| 7     | [`phase-7-iac-production-deploy`](../openspec/changes/phase-7-iac-production-deploy)                        | skeleton                                                                    |
| 8     | [`phase-8-hardening`](../openspec/changes/phase-8-hardening)                                                | skeleton                                                                    |

## Deployment decision

- **API, uploads, web:** AWS serverless. The API runs on Lambda behind an HTTP API Gateway, images go to S3, and the static web app is served from S3 + CloudFront. Files live in `deploy/aws/`.
- **Database:** a self-hosted PostGIS container on a DigitalOcean droplet with PgBouncer, pgAdmin (SSH tunnel only), `pg_cron` cleanup, hardening and backups. Files live in `deploy/droplet/`, separate from the AWS stack.
- **Consequences for the core:** uploads are presigned (Lambda caps request bodies at about 6MB), so image bytes never pass through the API. Everything else stays host-agnostic behind ports (BlobStore, JobQueue, Cache).
- **Still open (Phase 2.5 planning):** Lambda has no static outbound IP, so the droplet can't allowlist it cheaply. Default: TLS-only pooler port, strong credentials, fail2ban and connection limits; alternative: VPC + NAT (about $32/mo). Droplet size and region.

## Phase 0: Scaffold

Change: `bootstrap-geo-detection-service` (task groups 1-6).

- **F0.1 Monorepo & tooling:** pnpm workspaces (`apps/api`, `apps/web`, `packages/schemas`), strict TypeScript, ESLint/Prettier, Vitest.
- **F0.2 Local infrastructure:** Docker Compose with PostgreSQL 17 + PostGIS and RustFS (bucket created on startup).
- **F0.3 API skeleton:** Fastify `buildApp(deps)` factory, Zod-validated env config, structured logging, `GET /health` reporting DB and bucket status.
- **F0.4 Test harness:** Testcontainers setup for PostGIS and RustFS; first integration test against `/health`.
- **F0.5 CI:** GitHub Actions running lint, typecheck, unit and integration tests.
- **F0.6 Roadmap doc:** this document.

**Exit criteria:** CI green; `/health` reports DB + bucket OK.

## Phase 1: Captures & detections (REST)

Change: `bootstrap-geo-detection-service` (task groups 7-13).

- **F1.1 Database foundation:** Drizzle setup, PostGIS in an `extensions` schema, migration pipeline.
- **F1.2 Core tables:** `detector`, `capture`, and `detection` (monthly range partitions on `observed_at`, plus GiST and BRIN indexes).
- **F1.3 BlobStore port:** interface, in-memory fake, S3-API adapter (RustFS), shared contract test suite.
- **F1.4 Capture upload (presigned):** `POST /captures` returns a presigned PUT URL, the client uploads directly to object storage, then `POST /captures/:id/complete` verifies the object; `GET /captures/:id` returns a presigned image URL.
- **F1.5 Detector registry:** seeded `manual` detector with an output JSON Schema; `GET /detectors`, `GET /detectors/:id/schema`.
- **F1.6 Detections:** `POST /captures/:id/detections` with Ajv validation against the detector schema; `GET /captures/:id/detections`.
- **F1.7 Minimal UI:** a single plain page to upload an image and list its captures and detections.

**Exit criteria:** upload -> annotate via REST end to end, tests green.

## Phase 2: GraphQL + geo/time queries

Change: `phase-2-graphql-geo-queries`.

- **F2.1 GraphQL server:** GraphQL Yoga in the Fastify app, code-first schema with Pothos (`plugin-relay`, `plugin-dataloader`) over the existing Drizzle 0.45 queries. `plugin-drizzle` is not used because it needs the drizzle-orm 1.0 pre-release. Read-only, consistent errors, committed SDL.
- **F2.2 Core types:** `Capture`, `Detection`, `Detector` with relations, a `GeoJSON` scalar, batched relation loading (no N+1, proven by a test).
- **F2.3 Spatial queries:** bounding box and radius (`ST_DWithin`), falling back to the capture location.
- **F2.4 Temporal filters:** time ranges on `observed_at`, with partition pruning verified by `EXPLAIN`.
- **F2.5 Pagination:** cursor-based, with stable ordering.
- **F2.6 Map page:** MapLibre page querying the visible bounding box, plus a time-range control.

**Exit criteria:** the map shows detections in the current viewport, filtered by time; spatial and temporal edge cases are covered by integration tests.

## Phase 2.5: Deploy v0

Change: `phase-2-5-deploy-v0`.

- **F2.5.1 PostGIS container:** pinned image, persistent volume, `extensions` schema, least-privilege app role.
- **F2.5.2 Connection pooling:** PgBouncer in transaction mode, TLS end to end.
- **F2.5.3 Data dashboard:** pgAdmin 4, reachable only through an SSH tunnel.
- **F2.5.4 Scheduled cleanup:** `pg_cron` jobs for upcoming partitions, retention and stale uploads.
- **F2.5.5 Security & backups:** cloud firewall + ufw, key-only SSH, fail2ban, unattended upgrades, nightly `pg_dump` to S3, tested restore runbook.
- **F2.5.6 Minimal CDK stack:** API Lambda, HTTP API Gateway, S3 captures bucket, DB credentials in Secrets Manager / SSM.
- **F2.5.7 Web hosting:** static `apps/web` build on S3 + CloudFront.
- **F2.5.8 Runbook & guardrails:** manual deploy steps, post-deploy smoke test, $5 AWS Budgets alert.

**Exit criteria:** a public URL runs Phases 0-2 end to end; the droplet passes a security checklist and a backup restore has been rehearsed.

## Phase 3: Schema-driven UI

Change: `phase-3-schema-driven-ui`.

- **F3.1 App shell:** Vite + React with routing, a GraphQL client and a layout hosting the map page.
- **F3.2 Introspection-driven views:** generic list and detail views from the GraphQL schema.
- **F3.3 Detector forms:** JSON Forms renderer for detector output schemas (supported subset only).
- **F3.4 Image annotation:** draw a bounding box, fill the generated form, create the detection.
- **F3.5 Detector registration:** register a detector and its validated schema through the API; it appears in the UI without a rebuild.
- **F3.6 End-to-end tests:** Playwright covering upload -> annotate -> visible on the map.

**Exit criteria:** a detector registered through the API appears in the UI with working forms and annotation, with no rebuild; E2E tests green in CI.

## Phase 4: Async processing

Change: `phase-4-async-processing`.

- **F4.1 JobQueue port:** interface, in-memory fake, shared contract test suite.
- **F4.2 pg-boss adapter:** Postgres-backed queue passing the contract suite.
- **F4.3 Transactional outbox:** capture write and "detect" job recorded atomically, then relayed to the queue.
- **F4.4 Stub detector worker:** deterministic fake detections, idempotent on duplicate deliveries.
- **F4.5 Failure handling:** retries with exponential backoff, dead-letter queue, poison messages, redrive.
- **F4.6 Job status:** `detection_run` records over REST and GraphQL.
- **F4.7 SQS adapter:** passes the same contract suite (via LocalStack), plus an SQS-triggered Lambda worker entry.

**Exit criteria:** upload -> job -> detections end to end; duplicate delivery, transient failure and poison-message scenarios proven on both queue adapters.

## Phase 5: CV worker (Python)

Change: `phase-5-cv-worker`.

- **F5.0 Detector decision:** choose the first real detector and its output schema (asked at planning time).
- **F5.1 Worker project:** `workers/cv` in Python with uv, pyright strict and pytest.
- **F5.2 Shared contract:** job and result schemas generated from `packages/schemas` (JSON Schema -> Pydantic), cross-language contract tests.
- **F5.3 Inference:** ONNX Runtime CPU inference, image fetched via presigned URL.
- **F5.4 Result delivery:** idempotent result submission, validated against the detector schema.
- **F5.5 Deployment:** Lambda container image triggered by the detection queue.
- **F5.6 Evaluation:** precision and recall against the manual annotations.

**Exit criteria:** uploading an image produces real ML detections on the map, with evaluation metrics reported.

## Phase 6: Caching & performance

Change: `phase-6-caching-performance`.

- **F6.1 Baseline:** k6 scenarios (map pan, time scrub, upload burst) with baselines.
- **F6.2 Vector tiles:** `/tiles/{z}/{x}/{y}.mvt` via `ST_AsMVT`; the map switches to tiles.
- **F6.3 HTTP caching:** ETag and Cache-Control, CloudFront in front of the API.
- **F6.4 Application cache:** cache-aside for hot GraphQL queries behind a `Cache` port (Redis host decided at planning time).
- **F6.5 Invalidation:** event-driven on detection writes, versioned tile keys.
- **F6.6 Time-series rollups:** materialized views refreshed by `pg_cron`; native partitioning vs TimescaleDB revisited.
- **F6.7 Report:** before/after performance report in `docs/`.

**Exit criteria:** a documented before/after report shows measurable improvement, and every cache has a tested invalidation path.

## Phase 7: IaC & production deploy

Change: `phase-7-iac-production-deploy`.

- **F7.1 CDK structure:** stacks for storage, API, workers, web and queues, with dev and prod stages.
- **F7.2 Droplet IaC:** Terraform (DigitalOcean provider) plus cloud-init provisioning the droplet from scratch.
- **F7.3 Secrets:** centralized secrets with a DB credential rotation procedure.
- **F7.4 CD pipeline:** GitHub Actions with OIDC to AWS, gated migrations, ordered droplet and AWS deploys.
- **F7.5 One-command lifecycle:** scripted `deploy` / `destroy` per environment.
- **F7.6 Operations:** CloudWatch alarms, log retention, budgets, droplet health and disk alerts.
- **F7.7 Disaster recovery:** scheduled automated restore of the latest backup into a scratch DB.

**Exit criteria:** `deploy` from a clean machine brings up a working environment, `destroy` tears it down, and the scheduled restore check passes.

## Phase 8: Hardening (optional)

Change: `phase-8-hardening`.

- **F8.1 Distributed tracing:** OpenTelemetry in the API and workers, context propagated through queue messages.
- **F8.2 Logs & metrics:** correlated structured logs, RED metrics per endpoint and job, a dashboard.
- **F8.3 Authentication & authorization:** roles viewer, annotator and admin on REST and GraphQL.
- **F8.4 Rate limiting:** per-client limits plus GraphQL depth and complexity limits.
- **F8.5 Security review:** dependency scanning, introspection behind auth, OWASP checklist pass.

**Exit criteria:** one upload is traceable across api -> queue -> worker -> api; unauthenticated writes are rejected and limits are enforced and tested.

## Deferred decisions

- First real detector and model (Phase 5).
- Native partitioning vs TimescaleDB (revisit in Phase 6).
- Redis hosting (Phase 6) and auth provider (Phase 8).
