# Design

## Context

Greenfield repository. See proposal.md - Why. Two constraints shape everything below:

- **Hosting is undecided** (AWS Lambda + Neon/Supabase, or a DigitalOcean droplet). Nothing in the core may depend on a specific cloud.
- **The detector is undecided** (traffic signal, pedestrian crossing, price tag, ...). Nothing in the core may depend on a specific detection type.

## Scope of This Design

This change implements **Phase 0 and Phase 1** (see proposal.md - What Changes and Milestones). The design also records the target architecture, so that early choices don't block later phases. Each decision is tagged:

- **[This change]**: implemented now.
- **[Partial]**: the foundation lands now, the rest in the named phase.
- **[Preview: Phase N]**: direction only, nothing built in this change. That phase's own change will confirm or revise it.

## Goals / Non-Goals

**Goals:**
- A pure-TS core behind ports, so infrastructure adapters can be swapped without touching domain code.
- One schema chain from database to UI, with no hand-maintained duplicate type definitions.
- Real PostGIS SQL for spatial and temporal queries, kept type-safe.
- Every adapter verified by a shared contract test suite.
- Each feature (F0.x, F1.x) is independently implementable, testable and committable, in order.

**Non-Goals:**
- Runtime adapters other than local ones (Fastify server, MinIO). The Lambda wrapper, SQS and pg-boss come in later phases.
- Multi-tenant or auth concerns.
- Any UI beyond a single plain upload/list page (F1.7).

## Target Architecture (all phases)

```
 +------------------------------------------------------------------------------+
 |  apps/web: React + JSON Forms + MapLibre (runtime-generated UI)              |
 |   reads: GraphQL introspection (entities) + detector JSON Schemas            |
 +---------------------------+--------------------------------------------------+
                             | GraphQL (reads/explore)   REST (upload, ingest, health)
 +---------------------------v--------------------------------------------------+
 |  apps/api: Fastify + GraphQL Yoga + Pothos (plugin-drizzle)                  |
 |   core (pure TS)  --ports-->  BlobStore | DetectorRegistry | (JobQueue later)|
 |   Drizzle ORM  -->  drizzle-zod  -->  Zod  -->  JSON Schema                  |
 +-------+-----------------------------+----------------------------------------+
         v                             v
  PostgreSQL + PostGIS          S3-compatible store (MinIO locally)
```

Monorepo layout: `apps/api`, `apps/web`, `packages/schemas` (shared Zod schemas and generated JSON Schema), with `workers/cv` reserved.

In this change, only these pieces exist: Fastify REST routes, Drizzle, the BlobStore port with its S3 adapter, the detector registry, and a plain HTML/React page in `apps/web`. GraphQL, the generated UI and the map come in Phases 2-3.

## Decisions

### D1. Node/TS API, with Python only in a future CV worker [This change]
The target role asks for Node/TS. The later Python worker sits at a real service boundary, which is where service-to-service communication gets demonstrated.
*Alternative:* FastAPI + SQLAlchemy/GeoAlchemy2 has the most mature PostGIS ORM support, but it moves the core off the target stack.

### D2. Drizzle ORM over Prisma [This change]
Drizzle has a native PostGIS `geometry` column (point), GiST indexes declared in the schema, and typed `sql<T>` fragments for `ST_*` functions. Polygons and lines get a small `customType`.
*Alternative:* Prisma needs `Unsupported("geometry")` columns that the client cannot read or write, raw SQL for every geo operation, hand-edited migrations for indexes, and a workaround for PostGIS-table migration drift. *Also considered:* Kysely and PgTyped, which are good but provide no schema-to-Zod chain.

### D3. Code-first GraphQL with Pothos + GraphQL Yoga [Preview: Phase 2]
Pothos derives GraphQL types from Drizzle tables and batches relation loads, avoiding N+1. Yoga runs on Node servers and on Lambda, so it keeps hosting open.
*Alternatives:* SDL-first via `makeExecutableSchema` (types drift from the DB), Apollo Server (heavier), and `express-graphql` (deprecated).

### D4. API style split [Partial: REST now, GraphQL in Phase 2]
In this change, the REST endpoints also provide the simple reads (`GET /captures/:id`, `GET /captures/:id/detections`, `GET /detectors`). Rich querying moves to GraphQL in Phase 2.
- **GraphQL** for reads and exploration: nested capture -> detections -> detector, spatial and time filters.
- **REST** for `POST /captures` + `POST /captures/:id/complete` (presigned upload flow, `Idempotency-Key` header), `POST /captures/:id/detections`, and `GET /health`. Upload orchestration, idempotency and future worker callbacks fit REST better.

### D4a. Presigned two-step upload [This change]
```
 client                     api                          object storage (MinIO / S3)
   | POST /captures {meta}   |                                  |
   |------------------------>| insert capture(status=pending)  |
   |<------------------------| {id, uploadUrl, expiresAt}       |
   | PUT uploadUrl (bytes) ---------------------------------------->|
   | POST /captures/:id/complete                                |
   |------------------------>| HEAD object: exists, size, type |
   |                         |--------------------------------->|
   |<------------------------| capture(status=ready)            |
```
- The presigned PUT is bound to the object key, content type and declared size, and expires in about 15 minutes.
- `complete` is idempotent. It fails with a clear error if the object is missing or doesn't match the declared size/type.
- Detections can only be created on `ready` captures.
- Stale `pending` captures are left for the Phase 2.5 `pg_cron` cleanup.
*Alternative:* multipart through the API is simpler, but breaks on Lambda/API Gateway (about 6MB body cap) and puts image bytes through the API.
Geometry crosses both APIs as GeoJSON (`ST_AsGeoJSON`, `ST_GeomFromGeoJSON`), in SRID 4326.

### D5. Ports and adapters [Partial: BlobStore + DetectorRegistry now, JobQueue in Phase 4]
- `BlobStore`: `presignPut`, `presignGet`, `head`, `put`, `delete`. One S3-API adapter covers MinIO, AWS S3 and DigitalOcean Spaces; an in-memory fake is used in unit tests.
- `DetectorRegistry`: lists detectors and resolves schemas, backed by the `detector` table.
- `JobQueue`: not defined in this change. It arrives in Phase 4 with pg-boss, and later an SQS adapter if AWS is chosen.
The Fastify app is built by a factory (`buildApp(deps)`), so a Lambda entry can wrap it later without code changes.

### D6. Detector-agnostic data model [This change]
```
 detector(id slug PK, name, version, kind manual|ml, output_schema jsonb)
 capture(id uuid PK, status pending|ready, blob_key, content_type, byte_size, idempotency_key UNIQUE NULL,
         captured_at, geom geometry(Point,4326) NULL, meta jsonb, created_at)
 detection(id uuid, capture_id FK, detector_id FK, label, confidence real,
           bbox_px jsonb {x,y,w,h}, geom geometry(Point,4326) NULL,
           observed_at timestamptz, attributes jsonb, created_at)
           PARTITION BY RANGE (observed_at), PK (id, observed_at)
 indexes: GiST(capture.geom), GiST(detection.geom), BRIN(detection.observed_at),
          BTREE(detection.capture_id), BTREE(detection.detector_id, observed_at)
```
- `attributes` holds the detector-specific payload and is validated with Ajv against `detector.output_schema` on write.
- `detection.geom` is nullable. When it is absent, queries fall back to the capture's location; this covers indoor cases like price tags.
- `observed_at` defaults to `capture.captured_at`.
- The seeded `manual` detector ships with a generic schema (`label` plus free attributes). Example detector schemas live in `packages/schemas` as Zod.

### D7. Time series via native partitioning, not TimescaleDB [This change; revisit in Phase 6]
Monthly range partitions on `detection.observed_at`, plus BRIN, work on Neon, Supabase (which dropped Timescale on PG17), RDS and a droplet. A migration creates partitions ahead, plus a DEFAULT partition as a safety net. Timescale can be added later as an optional extension.
*Alternative:* TimescaleDB hypertables give better ergonomics but are not portable across the candidate hosts.

### D8. PostGIS in a dedicated schema [This change]
`CREATE EXTENSION postgis SCHEMA extensions` keeps `spatial_ref_sys` out of `public`, which avoids ORM migration drift and matches Supabase's layout. `search_path` includes `extensions`. Partitioning, extension setup and GiST/BRIN indexes not expressible in Drizzle go into custom drizzle-kit SQL migrations.

### D9. Runtime-generated UI [Preview: Phases 2-3]
This change ships only the plain upload/list page (F1.7). The rest of this decision describes the target.
The web app introspects GraphQL to discover entities and fields, and fetches detector JSON Schemas to render attribute forms with JSON Forms. The UI is built at runtime, not by codegen, because detector schemas are data: a newly registered detector must appear without a rebuild. Views: capture list/upload, image annotation (draw a bbox, then fill the generated form), MapLibre map of detections in the viewport (bbox query on map move), and a time-range filter.

### D10. Test strategy [Partial: unit, contract, integration now; E2E in Phase 3]
- **Unit (Vitest):** schema validation, detector registry, domain services with in-memory fakes.
- **Contract suites:** one shared suite per port, run against the fake and the real adapter (MinIO via Testcontainers).
- **Integration:** Testcontainers PostGIS. In this change it covers migrations (extension schema, partitions, indexes), partition routing at month boundaries, and REST through `buildApp` with `inject`. Spatial/temporal query cases (bbox, radius edges) come in Phase 2.
- **E2E (Playwright, few):** upload -> annotate -> detection visible on the map.
- **Per-feature rule:** every feature F0.x / F1.x ships with its own tests and leaves CI green before the next feature starts.

### D12. Feature-by-feature delivery [This change and all phases]
Each phase is a separate OpenSpec change. `tasks.md` groups tasks under one heading per feature (`## F1.4 Capture upload`, ...). Features are implemented in order, one per apply session, and each is verified (tests green, manual check) and committed before the next one starts. A feature must never depend on a later feature in the same phase.
*Alternative:* applying a whole phase in one pass is faster, but harder to review, learn from and demo incrementally.

### D11. Local environment [This change]
Docker Compose runs `postgis/postgis` (PG17) and MinIO, with a bucket created on startup. The API and web run on the host in dev. Configuration comes from env vars validated by Zod at startup.

## Risks / Trade-offs

- [Drizzle geometry support covers points natively only] -> polygons/lines use a small tested `customType`; slice 1 only needs points.
- [Partitioned tables need composite PKs and can't be referenced by FKs] -> nothing references `detection` yet; future references carry `(id, observed_at)`.
- [Missing future partitions cause inserts to land in DEFAULT] -> create partitions ahead in migrations; a later change adds scheduled partition maintenance.
- [GraphQL introspection as the UI source exposes the schema publicly] -> acceptable for a demo; disable or gate it when auth lands.
- [Unvalidated large uploads] -> enforce a max size and image content types at the REST boundary.
- [JSON Schema features unsupported by JSON Forms] -> restrict detector schemas to a documented subset (objects, primitives, enums, arrays of primitives).

## Migration Plan

Greenfield, so there's nothing to migrate. Rollback means dropping the database and bucket created by Compose.

## Open Questions

- (Resolved) Hosting for Deploy v0 is AWS serverless plus a PostGIS droplet. This change's only consequence is the presigned upload flow (D4a); everything else stays host-agnostic.
- First real ML detector and model (deferred to the CV worker change).
