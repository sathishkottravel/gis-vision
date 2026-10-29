# Proposal

> **Scope change (2026-10-29).** To reach a working public demo sooner, this change closes after the droplet database work it delivered: **F2.5.1** (PostGIS container and roles), **F2.5.2** (PgBouncer with end-to-end TLS) and **F2.5.3** (pgAdmin through an SSH tunnel; its two manual checks are deferred).
> - **Moved to `demo-cv-detection-deploy`**, which also adds ML detections: F2.5.6-F2.5.8 (AWS stack, web hosting, runbook and guardrails) and the minimum of F2.5.5 needed for a public pooler port (cloud firewall, key-only SSH).
> - **Deferred to a later hardening change:** F2.5.4 (scheduled cleanup) and the rest of F2.5.5 (host hardening, backups, restore rehearsal).
>
> The plan below is kept as written, for reference; `tasks.md` tracks only what was delivered.

## Why

Phases 0-2 run only locally. Deploy v0 puts them online at minimal cost, so there is a public demo early. It also tests the hosting-agnostic design (`buildApp`, the BlobStore port, presigned uploads) against real infrastructure before async processing and ML add more moving parts.

## What Changes

Each feature is delivered on its own branch with its own PR (see `docs/ROADMAP.md`). Droplet files live in `deploy/droplet/`; the AWS stack lives in `deploy/aws/`.

**Droplet (database host), in `deploy/droplet/`**
- **F2.5.1 PostGIS container:**
  - Docker Compose with a pinned `postgis/postgis` image and a persistent volume.
  - PostGIS in the `extensions` schema, installed once by the superuser.
  - Two login roles: an owner role that runs migrations, and a least-privilege app role for the API (data access only, no DDL, no superuser).
  - `scram-sha-256` authentication only. Postgres listens on the droplet's loopback interface only.
- **F2.5.2 Connection pooling:**
  - PgBouncer in transaction mode in front of Postgres, so concurrent Lambda invocations don't exhaust connections.
  - TLS is enforced end to end (client → PgBouncer → Postgres) with certificates from a private CA. Clients verify the server certificate.
  - The API gains settings for the CA certificate and its pool size.
- **F2.5.3 Data dashboard:**
  - pgAdmin 4 (its geometry viewer renders PostGIS results on a map), started on demand.
  - It is bound to the droplet's loopback interface, so it is reachable only through an SSH tunnel, and it logs in with a read-only role.
- **F2.5.4 Scheduled cleanup:**
  - Maintenance functions, added by a migration so they can be tested locally: create upcoming monthly partitions, remove detection data past retention, and delete abandoned uploads.
  - On the droplet, `pg_cron` runs them daily.
- **F2.5.5 Security & backups:**
  - DigitalOcean cloud firewall plus ufw: only SSH and the TLS pooler port are open.
  - Host hardening: key-only SSH, fail2ban, unattended upgrades.
  - A nightly `pg_dump` to a private S3 bucket that keeps 30 days of backups, using credentials that can only upload.
  - A restore runbook, rehearsed and recorded.

**AWS, in `deploy/aws/`**
- **F2.5.6 Minimal CDK stack:**
  - The API on Lambda: a new entry point wrapping `buildApp` via `@fastify/aws-lambda`, behind an HTTP API Gateway.
  - A private S3 captures bucket with CORS for presigned uploads.
  - Database credentials and the CA certificate in Secrets Manager.
- **F2.5.7 Web hosting:** the static `apps/web` build on S3 + CloudFront. CloudFront also routes `/api/*` to the API, so the browser sees one origin as in local development.
- **F2.5.8 Runbook & guardrails:**
  - A manual deploy runbook (droplet, certificates, stacks, secret, migrations, demo seed, web).
  - A post-deploy smoke test.
  - An AWS Budgets alert at $5 and a Lambda concurrency cap.

## Capabilities

### New Capabilities
- `hosted-deployment`: how the hosted database is protected and shared: TLS-only verified connections, least-privilege roles, no public Postgres or dashboard port, and connection pooling. After the scope change below, the public origin, cost guardrails, scheduled maintenance and backups are left to later changes; `data-retention` is deferred with F2.5.4.

### Modified Capabilities
None. The REST and GraphQL behavior (`capture-ingest`, `detection-records`, `detector-registry`, `service-health`, `graphql-api`, `geo-temporal-query`) is unchanged. Presigned uploads already keep image bytes out of the API (Lambda caps request bodies at about 6 MB).

## Impact

- **`apps/api`:**
  - A Lambda entry point (`src/lambda.ts`).
  - New optional settings `DATABASE_SSL_CA` and `DATABASE_POOL_MAX`.
  - A migration adding a `maintenance` schema with cleanup functions.
- **New folders:**
  - `deploy/droplet/`: Compose, configuration, scripts, an integration test package, and docs.
  - `deploy/aws/`: a CDK app with tests.
  - Both become pnpm workspace packages, and their tests join the unit and integration runs.
- **New dependencies:**
  - `@fastify/aws-lambda` and `@aws-sdk/client-secrets-manager` (API).
  - `aws-cdk-lib`, `constructs` and `esbuild` (deploy/aws).
- **Container images:**
  - Pinned `postgis/postgis` (extended with `pg_cron` in F2.5.4), PgBouncer, pgAdmin 4 and the AWS CLI.
- **Docs:**
  - A deployment runbook, a security checklist and a restore runbook.
  - Root README and `docs/ROADMAP.md` updates.
- **Runtime cost:**
  - About $6/mo for the droplet.
  - About $0 for AWS at demo traffic, within the free tier: Lambda, API Gateway, S3, CloudFront. Secrets Manager adds $0.40/mo per secret.
- **Operations:** running the stacks needs the maintainer's AWS and DigitalOcean accounts. Every feature is first verified locally (Compose and CDK synth/assertion tests), then on the real infrastructure.
