# Design

## Context

See `proposal.md` (Why) and the specs (`hosted-deployment`, `data-retention`) for the required behavior. This document covers how to deploy what Phases 0-2 left in place:

- **API:**
  - `buildApp(deps)` (`apps/api/src/app.ts`) is host-agnostic. `server.ts` wires it with `createInfrastructure`/`createAppDeps` and calls `listen`.
  - Config comes from environment variables, validated by Zod (`config.ts`). `NODE_ENV=production` already turns GraphiQL off and makes `db:seed-demo` refuse to run.
  - `poolConfig` (`db/client.ts`) sets `search_path` per connection through the libpq `options` startup parameter. The pool size is hard-coded to 5 in `infrastructure.ts`.
- **Database bootstrap:**
  - Migration `0000` runs `CREATE SCHEMA IF NOT EXISTS extensions`, then `CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions`, then `ALTER DATABASE ... SET search_path = public, extensions`.
  - Locally the Compose user is a superuser, so this works unchanged. Locally `docker/db/initdb/` is mounted only to hide the image's own init script.
- **Detections partitions:** `detection` is range-partitioned by month. Migration `0002` created 25 partitions around its run date plus `detection_default`. Nothing creates later partitions yet, so after about a year new rows would pile up in the default partition.
- **Object storage:**
  - `createS3Client` uses the SDK's default credential chain when no keys are configured, which is how a Lambda role works.
  - Uploads are presigned, so image bytes never pass through the API.
  - `objectStorageCheck` (`/health`) issues a HeadBucket.
- **Web:** `apps/web` calls `/api/...` on its own origin: the Vite proxy locally, CloudFront when deployed.
- **Tests:**
  - Vitest projects pick up `{apps,packages}/*/src/**/*.test.ts` (unit) and `*.int.test.ts` (integration, Testcontainers).
  - CI runs both on every PR. Docker is available in the integration job.
- **Accounts:** the AWS and DigitalOcean accounts are the maintainer's. Cloud commands are run by the maintainer from the runbook. Everything is first verified locally.

## Goals / Non-Goals

**Goals:**
- Every droplet behavior the spec promises is tested locally against the same Compose files that run on the droplet, in an integration suite: roles, TLS refusal and verification, pooling, cron jobs, loopback-only ports.
- The AWS stacks are tested offline with CDK assertion tests, so `cdk synth` passes in CI without credentials.
- Application code needs no hosting-specific branches beyond a Lambda entry point and two optional settings.

**Non-Goals:**
- **Phase 7:** infrastructure-as-code for the droplet (Terraform/doctl automation), CD pipelines, one-command deploy and destroy. Phase 2.5 is a manual runbook.
- **Phase 8:** high availability, replicas, point-in-time recovery (WAL archiving), auth and rate limiting.
- **Later:** a custom domain and TLS certificates for it (the CloudFront default domain is used); deleting S3 objects of abandoned uploads (Phase 4, with the outbox).

## Decisions

### D1. Regions, sizing and the network path from Lambda to the droplet
- **Regions:** AWS `eu-central-1` (Frankfurt) and DigitalOcean `fra1`, so Lambda-to-database round trips stay within one metro area (about 1-3 ms).
- **Droplet:** Basic `s-1vcpu-1gb` ($6/mo, 25 GB disk) on Ubuntu 24.04 LTS, with a 2 GB swap file.
  - Postgres is tuned for 1 GB: `shared_buffers=128MB`, `max_connections=40`.
  - pgAdmin runs only on demand (D5), because it alone needs about 200 MB.
- **Network path:** Lambda reaches the droplet over the public internet, not from a VPC. Lambda has no static egress IP, so the firewall cannot allowlist it. Instead:
  - the pooler port is TLS-only with SCRAM authentication and long random passwords;
  - fail2ban watches PgBouncer's authentication failures;
  - connection limits are set in PgBouncer.
  - *Alternative:* a VPC with a NAT gateway and an Elastic IP to allowlist, about $32/mo. Rejected for a demo; it can be revisited in Phase 7.

### D2. Droplet layout (`deploy/droplet/`)
- **`compose.yaml`:**
  - Services: `db` (Postgres + PostGIS), `pgbouncer` (F2.5.2) and `pgadmin` (profile `tools`, F2.5.3).
  - One named volume for the data directory. Images are pinned by tag **and** digest.
  - Ports: only PgBouncer publishes on all interfaces (`6432`). `db` publishes `127.0.0.1:5432` (for migrations through an SSH tunnel), and `pgadmin` publishes `127.0.0.1:5050`.
- **Folders:**
  - `postgres/`: `postgresql.conf`, `pg_hba.conf`, `initdb/` SQL (run once by the entrypoint), and from F2.5.4 a `Dockerfile` that adds `pg_cron`.
  - `pgbouncer/`, `pgadmin/`: configuration for each service.
  - `scripts/`: `make-certs.sh`, `harden.sh`, `backup.sh`, `restore.sh`, `make-userlist.sh`.
  - `systemd/`: the backup service and timer.
- **Secrets:**
  - `.env.example` lists the passwords: superuser, owner, app, read-only, and pgAdmin login.
  - The real `.env` and the `certs/` folder stay on the droplet, are git-ignored, and have mode 600.
- **Docs:** `README.md` (provisioning), `SECURITY.md` (checklist), `RESTORE.md` (runbook and rehearsal log).
- **Package:** `deploy/droplet` is a workspace package (`@gis-vision/deploy-droplet`). It holds only its integration tests under `src/` and their dev dependencies (`testcontainers`, `pg`).

### D3. Roles and bootstrap
The `initdb` SQL runs once, as the bootstrap superuser `postgres`, when the volume is created:
- **`gis_owner`** (LOGIN): owns the `gis_vision` database, the `extensions` schema, and every object the migrations create. It runs `pnpm db:migrate` and owns the maintenance jobs. It is not a superuser and has no CREATEDB/CREATEROLE.
- **`gis_app`** (LOGIN), the API's role:
  - `CONNECT` on the database and `USAGE` on `public` and `extensions`.
  - Default privileges from `gis_owner`: `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT` on sequences.
  - No `CREATE` anywhere, so DDL fails (spec: Least-privilege database access).
- **`gis_readonly`** (LOGIN): the dashboard's role. `CONNECT`, `USAGE`, and default `SELECT` only.
- **Superuser setup:** it creates the database and the `extensions` schema, then `CREATE EXTENSION postgis SCHEMA extensions`. PostGIS is not a trusted extension, so the owner could not install it. Migration `0000` then finds the schema and extension already present (`IF NOT EXISTS`). Its `ALTER DATABASE ... SET search_path` runs as the database owner. **No existing migration changes.**
- **`pg_hba.conf`:**
  - `local all postgres peer`: the superuser logs in only through the container's socket, for `docker compose exec`.
  - `hostssl gis_vision gis_owner,gis_app,gis_readonly all scram-sha-256`.
  - `host all all all reject`.
  - `password_encryption = scram-sha-256`.
- *Alternative:* one app role that also runs migrations. Rejected: a compromised Lambda could then drop tables.

### D4. TLS with a private CA
- **Certificates:** `scripts/make-certs.sh` creates them with openssl, run in a pinned `alpine/openssl` container so it works on any OS with Docker:
  - an EC P-256 CA, valid 10 years;
  - a server certificate, valid 2 years, whose SANs are the droplet's public IP, an optional DNS name, and the Compose service names `db` and `pgbouncer`.
- **Postgres:** `ssl = on`, so pgAdmin and tunneled connections also arrive over TLS.
- **PgBouncer:**
  - `client_tls_sslmode = require` with the server certificate.
  - `server_tls_sslmode = verify-full` towards `db`, with the CA.
- **API clients:**
  - A new optional setting `DATABASE_SSL_CA` (PEM text). When it is set, the pool gets `ssl: { ca, rejectUnauthorized: true }`; Node verifies IP SANs.
  - The URL then carries no `sslmode`. `loadDatabaseConfig` accepts it too, so `db:migrate` through the tunnel verifies the same CA.
- *Alternative:* Let's Encrypt. Rejected: it needs a domain, renewal automation, and an HTTP challenge on a host that should expose only 22 and 6432.

### D5. PgBouncer and pgAdmin
- **PgBouncer image:** `edoburu/pgbouncer`, pinned by version and digest.
  - *Alternative:* Bitnami's image. Rejected: Bitnami moved its catalog behind a subscription in 2025.
- **Pooling:**
  - `pool_mode = transaction`, `default_pool_size = 10`, `max_client_conn = 200`, `max_db_connections = 20` (below Postgres's 40, leaving room for the owner, cron and pgAdmin).
  - Authentication: `auth_type = scram-sha-256` with a `userlist.txt` of SCRAM verifiers. `make-userlist.sh` generates it from the passwords in `.env`, so no plaintext is stored.
- **Startup parameters:** `ignore_startup_parameters = extra_float_digits, options`, because PgBouncer would otherwise reject the `options` parameter that `poolConfig` sends. The search path still applies: the database-level default from migration `0000` covers every server connection.
- **Transaction-mode caveats:** the app keeps no session state:
  - no `LISTEN` and no session `SET`;
  - node-pg sends unnamed prepared statements, which Drizzle does not name.

  Migrations bypass PgBouncer and run directly against Postgres through the SSH tunnel as `gis_owner`.
- **pgAdmin:**
  - `dpage/pgadmin4`, pinned, under Compose profile `tools`. Start it with `docker compose --profile tools up -d pgadmin`, and stop it after use.
  - It requires a login (`PGADMIN_DEFAULT_EMAIL`/`PASSWORD` from `.env`).
  - A preloaded `servers.json` connects to `db` over TLS as `gis_readonly`.

### D6. Lambda entry point (`apps/api/src/lambda.ts`)
- **Handler:** `@fastify/aws-lambda` wraps the same `buildApp`. The app and its infrastructure are built once per execution environment, at module load with top-level await, and reused across invocations.
- **Secrets:**
  - `DATABASE_SECRET_ARN` names a Secrets Manager secret holding JSON `{ "DATABASE_URL", "DATABASE_SSL_CA" }`.
  - The entry fetches it with `@aws-sdk/client-secrets-manager` and merges it into the environment before `loadConfig`. Values never appear in CloudFormation or Lambda environment variables.
- **Pool:** a new optional setting `DATABASE_POOL_MAX` (default 5) is set to `1` on Lambda, because one instance serves one request at a time. PgBouncer multiplexes the instances.
- **Unchanged:** `server.ts` keeps working locally exactly as before.
- *Alternative:* the Parameters and Secrets Lambda Extension. Rejected: an extra layer for one read per cold start.

### D7. AWS stacks (`deploy/aws/`, CDK v2 in TypeScript)
- **Package:** `@gis-vision/deploy-aws` (workspace), with `bin/app.ts`, `src/*-stack.ts`, tests in `src/*.test.ts`, and `cdk.json` running `tsx bin/app.ts`.
- **Stacks:**
  - **`GisVisionBackups`** (F2.5.5): the backups bucket and the droplet's upload-only IAM user (D11).
  - **`GisVisionApp`** (F2.5.6-8): the API, the captures bucket, the web hosting, the secret and the budget.
- **API:**
  - `NodejsFunction` bundles `apps/api/src/lambda.ts` with esbuild as ESM.
  - Runtime: Node.js 22.x on arm64, 512 MB, 10 s timeout, reserved concurrency 10.
  - Environment: `NODE_ENV=production`, `S3_BUCKET`, `S3_REGION`, `DATABASE_POOL_MAX=1`, `DATABASE_SECRET_ARN`.
  - Log retention: 14 days.
  - It sits behind an HTTP API (payload v2) with a single `$default` route.
- **Captures bucket:**
  - Block Public Access, `enforceSSL`, S3-managed encryption, retained on stack deletion.
  - CORS allows `PUT`/`GET` from the CloudFront origin.
  - The Lambda role gets `s3:GetObject`/`PutObject` on its objects and `s3:ListBucket` (HeadBucket for `/health`).
- **Secret:** created by the stack with a placeholder value. The runbook sets the real value with `aws secretsmanager put-secret-value` from a file. The Lambda role may only `GetSecretValue` on it.
- **Tests:** `aws-cdk-lib/assertions` templates. Bundling is skipped in tests through the `aws:cdk:bundling-stacks` context, so they run fast and offline.

### D8. Web hosting and routing
- **Origins:**
  - A private S3 bucket behind CloudFront with Origin Access Control. `apps/web/dist` is uploaded by `BucketDeployment`, with an invalidation.
  - Price class 100, redirect HTTP to HTTPS, default root `index.html`.
- **API routing:** a `/api/*` behavior points at the HTTP API origin:
  - all methods, `CachingDisabled`, `AllViewerExceptHostHeader`;
  - a CloudFront Function strips the `/api` prefix, so the API's routes are unchanged.
- **Cross-origin uploads:** the only cross-origin request is the browser's presigned PUT/GET to the captures bucket, covered by its CORS rule.
- **No dependency cycle:** the bucket CORS needs the distribution domain, and the distribution needs only the API, so there is no cycle.
- *Alternative:* a separate API domain with CORS. Rejected: it would differ from local development and need CORS on the API.

### D9. Maintenance functions and scheduling
- **Migration `0005_maintenance.sql`** (custom, owned by `gis_owner`) adds schema `maintenance` with three plpgsql functions:
  - **`ensure_detection_partitions(months_ahead int default 3)`:** for each month from now to `months_ahead`, if there is no partition, create `detection_yYYYYmMM`. To do so it creates a standalone table `(LIKE detection INCLUDING ALL)`, moves that month's rows out of `detection_default` (INSERT, then DELETE), and runs `ATTACH PARTITION`. Everything happens in one transaction, so detections are never lost or duplicated.
  - **`expire_detections(retention interval default '60 months')`:**
    - The cutoff is `date_trunc('month', now() at time zone 'UTC') - retention`.
    - Partitions whose upper bound is at or before the cutoff are detached and dropped.
    - Default-partition rows older than the cutoff are deleted.
  - **`delete_abandoned_uploads(max_age interval default '24 hours')`:** deletes captures where `status = 'pending'` and `created_at < now() - max_age`. Pending captures cannot have detections (spec `detection-records`).
  - Each function returns a summary row (created / moved / dropped / deleted counts) for the job history. `gis_app` gets no `EXECUTE`.
  - Locally and in CI the functions exist and are called directly by integration tests. Nothing schedules them there.
- **Scheduling (F2.5.4):**
  - A `Dockerfile` `FROM` the pinned PostGIS image adds `postgresql-17-cron` from the PGDG apt repository the image already uses, with its version pinned.
  - `postgresql.conf` settings: `shared_preload_libraries = 'pg_cron'`, `cron.database_name = 'gis_vision'`, `cron.use_background_workers = on` (no extra libpq connections or `pg_hba` entries).
  - An `initdb` script creates the extension and schedules four jobs with `cron.schedule_in_database(..., username => 'gis_owner')`, daily at 03:00-03:15 UTC: the three functions, plus a purge of `cron.job_run_details` older than 14 days.
- **Retention period:** 60 months, so the demo seed's three-year-old detections stay (Phase 2 D12).
- *Alternative:* `pg_partman`. Rejected: a larger extension for three small functions, and it would hide the move-out-of-default logic that the spec requires.

### D10. Host hardening (`scripts/harden.sh`, idempotent)
- **Users and SSH:** a `deploy` sudo user with the maintainer's key. `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`.
- **Services:** unattended-upgrades for security updates, Docker Engine from Docker's apt repository, and the swap file.
- **Firewall:** `ufw` denies incoming by default and allows `22/tcp` and `6432/tcp`. Docker-published ports bypass ufw, so everything except PgBouncer is published on `127.0.0.1` only (D2), and the integration test asserts the bindings.
- **fail2ban:** the `sshd` jail, plus a `pgbouncer` jail with a filter on PgBouncer's "password authentication failed" log lines, read from its Docker log.
- **DigitalOcean cloud firewall:** the same two inbound rules, created with `doctl` from the README, as a second layer outside the host.

### D11. Backups and restore
- **Backups stack (`GisVisionBackups`):**
  - Bucket: private, `enforceSSL`, S3-managed encryption, lifecycle expiry after 30 days, retained on stack deletion.
  - An IAM user `gis-vision-droplet-backup` with only `s3:PutObject` on `pg_dump/*`, so it cannot read, list or delete, and a stolen key cannot destroy history. Its access key is created by the runbook (`aws iam create-access-key`) and never appears in a stack output.
- **`scripts/backup.sh`:**
  - It streams `docker compose exec -T db pg_dump -U gis_owner -Fc gis_vision` into a pinned `amazon/aws-cli` container: `aws s3 cp - s3://<bucket>/pg_dump/<UTC date>.dump`.
  - It runs nightly at 02:30 UTC from a systemd timer (`Persistent=true`). Failures land in the journal.
  - It accepts an `S3_ENDPOINT` override, so it is tested locally against RustFS.
- **`scripts/restore.sh`:**
  - Runs with the maintainer's own AWS credentials. It downloads a dump and creates a scratch database `gis_vision_restore` owned by `gis_owner`, with `extensions` and PostGIS created as superuser.
  - It runs `pg_restore --no-owner --role=gis_owner`, then a verification query comparing table and partition row counts and `postgis_version()` with the source.
  - `RESTORE.md` records each rehearsal (date, dump name, result).
- **Recovery point:** 24 hours.

### D12. Tests and CI
- **`deploy/droplet/src/*.int.test.ts`:**
  - They use Testcontainers' `DockerComposeEnvironment` on `compose.yaml` plus a `compose.test.yaml` override: random host ports, test passwords, and certificates generated by `make-certs.sh` in global setup.
  - They assert the spec scenarios:
    - DDL denied for `gis_app`, DML allowed (after running the real migrations as `gis_owner`);
    - the superuser refused over TCP;
    - plaintext refused, and the wrong CA refused;
    - a burst of 50 clients with `pg_stat_activity` ≤ the pool size;
    - the API's own `createInfrastructure` through PgBouncer: `/health` ok, a GraphQL search, a paged search;
    - loopback-only port bindings, read from `docker inspect`;
    - from F2.5.4, the cron jobs registered and the read-only role unable to write.
- **Maintenance functions:** tested in `apps/api` integration tests against the existing Testcontainers PostGIS, with no `pg_cron` needed.
- **CDK tests:** run in the unit project.
- **Vitest config:** both project globs widen from `{apps,packages}/*/src/**` to `{apps,packages,deploy}/*/src/**`, and `pnpm-workspace.yaml` adds `deploy/*`. CI needs no new job.

### D13. Runbook and smoke test (`deploy/README.md`)
- **Order:**
  1. Create the droplet and cloud firewall (`doctl`), then run `harden.sh`.
  2. `make-certs.sh` and `make-userlist.sh`, then `docker compose up -d`.
  3. Deploy `GisVisionBackups`, create the access key, and install it with the backup timer.
  4. `pnpm --filter @gis-vision/web build`, then deploy `GisVisionApp` (with the `budgetEmail` context).
  5. Put the secret value.
  6. Open an SSH tunnel and run `pnpm db:migrate` as `gis_owner` with the CA.
  7. Seed the demo data through the tunnel. This runs from the maintainer's machine with `NODE_ENV=development`, the deploy bucket and the maintainer's AWS profile. The Lambda's production guard is unaffected.
  8. Run the smoke test.
- **Smoke test** (`pnpm --filter @gis-vision/deploy-aws smoke https://<origin>`):
  - `/api/health` ok;
  - the http→https redirect;
  - GraphiQL not served;
  - a GraphQL `detectors` query;
  - the full presigned upload of a tiny PNG, a detection, and a bbox search that finds it.
  - Each run leaves one capture with the label prefix `smoke:` at a remote location, at 0° longitude in the Southern Ocean. This is documented and harmless.

### D14. Cost guardrails
- **Budget:** `GisVisionApp` includes an AWS Budgets `CfnBudget`: monthly cost of $5, with email notifications on actual > 100% and forecast > 100% to the required `budgetEmail` context value.
- **Concurrency:** reserved concurrency 10 caps the API's Lambda spend and its PgBouncer clients.
- **Retention:** CloudWatch log retention of 14 days keeps the log storage cost near zero.

## Risks / Trade-offs

- **[The pooler port is open to the internet]** → TLS-only with SCRAM and 32-byte random passwords, a fail2ban jail on PgBouncer authentication failures, `max_client_conn` limits, and the cloud firewall. A VPC + NAT allowlist is the documented upgrade path (D1).
- **[Docker-published ports bypass ufw]** → Only PgBouncer is published on all interfaces. The integration test fails if `db` or `pgadmin` bind anything other than `127.0.0.1`, and `SECURITY.md` includes an external port scan.
- **[A single droplet is a single point of failure; backups have a 24 h RPO]** → This is acceptable for a demo and stated in the README. Phase 8 can add WAL archiving or a managed database.
- **[Server certificate expiry (2 years) breaks every connection at once]** → The runbook has a renewal section, and `SECURITY.md` includes `openssl x509 -enddate`. The smoke test fails loudly on TLS errors.
- **[Creating a partition takes a lock on `detection_default` while moving rows]** → It runs once a month at 03:00 UTC, and normally finds nothing to move, because upcoming months are created three months early.
- **[Objects of abandoned uploads stay in S3]** → They are at most 10 MB each, cost cents, and are listed for Phase 4 (outbox-driven blob deletion). Only the database rows are cleaned now (spec wording: records).
- **[Cold starts add latency (about 1 s for Fastify, Pothos and the AWS SDK)]** → This is acceptable for a demo. Provisioned concurrency would cost money and is not used.
- **[Running cloud steps needs the maintainer's accounts]** → Tasks verify locally first. Each feature's on-infrastructure check is a separate task the maintainer confirms, like the browser checks in Phase 2.
- **[Free-tier assumptions change]** → The $5 budget alert catches surprises. Secrets Manager costs $0.40/mo.

## Migration Plan

- **Additive:**
  - Migration `0005` adds the `maintenance` schema; local and CI databases get it through `pnpm db:migrate`, as before.
  - The new settings are optional, so local `.env` files need no change.
- **First deployment:** follow D13 in order. The hosted database starts empty plus migrations and demo seed; there is no data to migrate.
- **Rollback:**
  - `cdk destroy GisVisionApp` removes the API, web hosting and budget, but keeps the captures bucket.
  - The droplet can be destroyed after a final `backup.sh`. The backups bucket is retained, and its contents still expire after 30 days.
