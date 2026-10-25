# gis-vision

[![CI](https://github.com/sathishkottravel/gis-vision/actions/workflows/ci.yml/badge.svg)](https://github.com/sathishkottravel/gis-vision/actions/workflows/ci.yml)

A geospatial detection service. Images (captures) are uploaded, then detectors (a human first, ML later) record what they found, located in **space and time**, in PostGIS. The project is a portfolio piece showing Node.js/TypeScript, REST + GraphQL, PostGIS and time-series data, serverless/IaC, distributed systems and testing.

![Architecture](docs/architecture.svg)

## Stack

Node/TS (Fastify, GraphQL Yoga + Pothos, Drizzle, Zod) | PostgreSQL 17 + PostGIS | React + JSON Forms + MapLibre | Python ONNX worker (later) | AWS Lambda/S3/SQS (CDK) + a DigitalOcean droplet for the database | Vitest + Testcontainers.

## Status & roadmap

Planned with [OpenSpec](https://github.com/Fission-AI/OpenSpec). Each phase is one change in `openspec/changes/` and is implemented **one feature at a time**.

| Phase | Change                            | Focus                                                             |
| ----- | --------------------------------- | ----------------------------------------------------------------- |
| 0+1   | `bootstrap-geo-detection-service` | scaffold, REST captures (presigned upload), detectors, detections |
| 2     | `phase-2-graphql-geo-queries`     | GraphQL, bbox/radius/time queries, map                            |
| 2.5   | `phase-2-5-deploy-v0`             | AWS serverless + PostGIS droplet                                  |
| 3     | `phase-3-schema-driven-ui`        | UI generated from schemas                                         |
| 4     | `phase-4-async-processing`        | queue, outbox, retries, DLQ                                       |
| 5     | `phase-5-cv-worker`               | Python CV detector                                                |
| 6     | `phase-6-caching-performance`     | vector tiles, caching, load tests                                 |
| 7     | `phase-7-iac-production-deploy`   | CDK + Terraform, CD                                               |
| 8     | `phase-8-hardening`               | tracing, auth, rate limits                                        |

Only Phase 0+1 is fully planned. The others are skeletons (proposal only), planned when the previous phase is archived. See [docs/ROADMAP.md](docs/ROADMAP.md) for every phase's features, exit criteria and the deployment decision.

## Getting started

Prerequisites: Node 22.22+ (required by Testcontainers), pnpm 11, Docker Desktop (needed by Compose and Testcontainers), and the [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec) with Claude Code.

### Local setup

```sh
pnpm install
cp .env.example .env        # defaults match docker-compose.yml
docker compose up -d        # PostGIS + RustFS, then creates the `captures` bucket
docker compose ps -a        # db and rustfs (healthy); rustfs-init Exited (0)
pnpm db:migrate             # installs PostGIS into `extensions`, then applies table migrations
```

| Service                     | Address                                 | Notes                                                       |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| PostgreSQL 17 + PostGIS 3.6 | `localhost:5432`                        | user/password/db from `.env` (`gis` / `gis` / `gis_vision`) |
| RustFS S3 API               | `http://localhost:9000`                 | path-style; keys from `.env`                                |
| RustFS console              | `http://localhost:9001/rustfs/console/` | log in with the S3 keys from `.env`                         |
| pgAdmin (optional)          | `http://localhost:5050`                 | `docker compose --profile tools up -d`; no login            |

Check PostGIS: `docker compose exec db psql -U gis -d gis_vision -c "SELECT postgis_full_version();"`

Reset all local data: `docker compose down -v`.

### Database migrations

Migrations live in `apps/api/drizzle/` and are applied by Drizzle's migrator, which records them in `drizzle.__drizzle_migrations`, so `pnpm db:migrate` is safe to rerun. Integration tests apply them automatically.

```sh
pnpm --filter @gis-vision/api db:generate                      # SQL from schema changes in src/db/schema.ts
pnpm --filter @gis-vision/api db:generate --custom --name=<n>  # empty SQL file for DDL Drizzle can't express
pnpm --filter @gis-vision/api db:check                         # migration files are consistent (also run in CI)
```

### Run the API

```sh
pnpm --filter @gis-vision/api dev   # watches src/, reads ../../.env, logs JSON
curl localhost:3000/health          # 200 {"status":"ok","database":"ok","objectStorage":"ok"}
```

`/health` returns 503 with the failing dependency set to `"error"` when Postgres or object storage is down or slower than `HEALTH_CHECK_TIMEOUT_MS` (default 2000).

### Running tests

```sh
pnpm lint              # ESLint (type-aware) + Prettier check; `pnpm format` fixes formatting
pnpm typecheck         # tsc in every package
pnpm test              # unit tests (*.test.ts), no Docker needed
pnpm test:integration  # *.int.test.ts against PostGIS + RustFS started by Testcontainers
```

Integration tests need Docker running but not Compose: Testcontainers starts its own throwaway containers once per run and removes them afterwards. The first run pulls the images, so it is slower.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same four commands, plus `db:check`, on Node 24 (current LTS) for every pull request and every push to `main`.

### Explore the database

- **pgAdmin:** `docker compose --profile tools up -d`, open `http://localhost:5050`, expand _gis-vision (local)_ and enter the DB password (`gis`). In the Query Tool, the map icon on a geometry column opens the geometry viewer, e.g. for `SELECT ST_MakePoint(13.4, 52.5) AS geom;`.
- **Drizzle Studio:** `pnpm db:studio`, then open `https://local.drizzle.studio`. Shows the tables defined in `apps/api/src/db/schema.ts`.
- **psql:** `docker compose exec db psql -U gis -d gis_vision` (`\dn` schemas, `\dx` extensions, `\dt public.*` tables).
- **Desktop clients** (DBeaver has a map view for geometry): `localhost:5432`, `gis` / `gis`, database `gis_vision`.

## OpenSpec workflow

```
/opsx:explore                                         # think, no code
/opsx:propose <change>                                # write specs + design + tasks.md
/opsx:apply <change> only F0.1                        # build ONE feature, then review + commit
/opsx:apply <change> only F0.2                        # ...next feature
/opsx:archive <change>                                # specs move into openspec/specs/
/opsx:propose phase-2-graphql-geo-queries             # plan the next phase
```

Useful CLI commands: `openspec list` (changes), `openspec list --specs` (archived capabilities), `openspec status --change <name>`, `openspec validate <name> --strict`.

### Configuration tips

- `openspec/config.yaml` sets `schema: spec-driven` (proposal -> specs + design -> tasks). Optional keys:
  - `context`: project constraints applied to every artifact.
  - `rules.<artifact>`: per-artifact rules.
  - `operations.apply.guidance`: e.g. "implement only the requested feature group, then stop".
- Keep `config.yaml` to constraints an agent can't infer from the code; don't paste docs into it.
- `/opsx:*` commands and skills live in `.claude/`. Commit them so the workflow travels with the repo.

### OpenSpec gotchas

- Create changes with `openspec new change <name>`, never by hand; the CLI writes the `.openspec.yaml` metadata.
- Spec scenarios need **exactly** `#### Scenario:` (4 hashes) or they're silently ignored. Every requirement needs at least one scenario.
- Only `- [x]` counts as a done task. `- [~]` and `- []` read as unfinished.
- Skeleton changes fail `openspec validate` ("no deltas") until their specs exist. That's expected.
- `openspec list --specs` stays empty until the first change is archived.
- Explore mode only writes planning artifacts. Code changes happen through `/opsx:apply`.

## Project gotchas

- **Uploads are presigned:** Lambda/API Gateway cap request bodies at about 6MB, so image bytes go straight to S3/RustFS, never through the API.
- **PostGIS lives in the `extensions` schema:** this keeps `spatial_ref_sys` out of `public` and avoids ORM migration drift. The first migration installs it there; Compose and Testcontainers hide the `postgis/postgis` image's own init script, which would put it in `public`. Every app connection sets `search_path=public,extensions`.
- **`detection` is partitioned by month:** its primary key is `(id, observed_at)` and it can't be the target of foreign keys. Partitions are created ahead of time, with a DEFAULT partition as a safety net.
- **No TimescaleDB:** it isn't portable (Supabase dropped it on PG17), so the project uses native partitioning + BRIN.
- **Lambda has no static outbound IP:** the droplet database is protected by TLS, PgBouncer, strong credentials and fail2ban, not an IP allowlist (a NAT gateway would cost about $32/mo).
- **RustFS instead of MinIO:** MinIO no longer publishes community Docker images, so local S3 is RustFS. The app only speaks the S3 API, so swapping stores is a config change.
- **Windows:** integration tests (Testcontainers) need Docker Desktop running. If they hang at "Starting container" (containers stuck in `Created`), Docker Desktop's API pipe is wedged: restart Docker Desktop (a reboot fixed it here), then kill leftover `vitest` processes and delete the folder `%LOCALAPPDATA%\Temp\testcontainers-node--1.lock.lock`.
