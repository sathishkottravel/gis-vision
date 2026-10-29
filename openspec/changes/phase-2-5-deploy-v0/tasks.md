# Tasks

## 1. F2.5.1 PostGIS container

- [x] 1.1 Create `deploy/droplet/` with `compose.yaml` (`db` from `postgis/postgis:17-3.6` pinned by digest, named data volume, `127.0.0.1:5432` only), `postgres/postgresql.conf` (1 GB tuning, `password_encryption = scram-sha-256`), `postgres/pg_hba.conf` (superuser `local` peer only, owner/app/read-only roles by `scram-sha-256`, everything else rejected; `hostssl` comes in 2.1), `postgres/initdb/` SQL creating `gis_owner`, `gis_app` and `gis_readonly`, the database owned by `gis_owner`, the `extensions` schema with PostGIS, and default privileges (design D2, D3), plus `.env.example` and a `.gitignore` for `.env` and `certs/`; verify `docker compose -f deploy/droplet/compose.yaml up -d` starts healthy locally, and `pnpm db:migrate` as `gis_owner` applies every existing migration unchanged
- [x] 1.2 Add the workspace package `deploy/droplet` (`@gis-vision/deploy-droplet`), add `deploy/*` to `pnpm-workspace.yaml`, widen both Vitest project globs to `{apps,packages,deploy}/*/src/**` (design D12), and add `src/roles.int.test.ts` using `DockerComposeEnvironment` with a `compose.test.yaml` override; verify integration tests that after migrations `gis_app` can insert, read, update and delete captures and detections but `CREATE TABLE`, `DROP TABLE capture` and `ALTER TABLE capture` fail, that `gis_app` is not a superuser, that the superuser is rejected over TCP, and that `db` binds only `127.0.0.1`
- [x] 1.3 Write `deploy/droplet/README.md` (provisioning the `s-1vcpu-1gb` droplet in `fra1` with Ubuntu 24.04, installing Docker, copying the folder, generating passwords into `.env`, `docker compose up -d`, and running migrations through `ssh -L 5432:127.0.0.1:5432`) and update `docs/ROADMAP.md` (Phase 2 archived, Deploy v0 planned, decisions from design D1); verify the local steps run as written
- [x] 1.4 On the droplet (maintainer): follow the README to provision it and start the database, then run migrations through the tunnel as `gis_owner`; verify `\du` shows the three roles without superuser and `postgis_full_version()` answers in the `extensions` schema

## 2. F2.5.2 Connection pooling and TLS

- [x] 2.1 Add `scripts/make-certs.sh` (private CA plus server certificate with the droplet IP, optional DNS name and `db`/`pgbouncer` as SANs, run in a pinned `alpine/openssl` container), enable `ssl = on` in Postgres and switch `pg_hba.conf` to `hostssl` for the three roles with `host all all all reject` (design D4); verify the roles test still passes over TLS and a plaintext connection to Postgres is refused
- [x] 2.2 Add the `pgbouncer` service (`edoburu/pgbouncer` pinned by digest, published on `6432`) with `pool_mode = transaction`, the pool limits, `client_tls_sslmode = require`, `server_tls_sslmode = verify-full`, `ignore_startup_parameters = extra_float_digits, options`, and `scripts/make-userlist.sh` writing SCRAM verifiers (design D5); verify `src/pooling.int.test.ts`: plaintext to PgBouncer refused, a client trusting a different CA refused, and 50 concurrent clients all succeed while `pg_stat_activity` shows at most the pool size of PgBouncer connections
- [x] 2.3 Add the optional API settings `DATABASE_SSL_CA` (pool `ssl: { ca, rejectUnauthorized: true }`, also accepted by `loadDatabaseConfig`) and `DATABASE_POOL_MAX` (default 5) in `config.ts`, `db/client.ts` and `infrastructure.ts`; verify unit tests for both settings and an integration test in `deploy/droplet` that the API's `createInfrastructure` through PgBouncer serves `/health` as ok, a GraphQL bbox search, and a two-page cursor walk with the database-default search path
- [x] 2.4 Document certificates, PgBouncer and the API settings in `deploy/droplet/README.md` and `.env.example`, including certificate renewal; verify the local steps run as written
- [x] 2.5 On the droplet (maintainer): generate the certificates with the droplet IP, start PgBouncer, and connect from a laptop with `psql "sslmode=verify-full sslrootcert=ca.crt ..."` as `gis_app`; verify the connection succeeds, and that `sslmode=disable` is refused

## 3. F2.5.3 Data dashboard

- [ ] 3.1 Add the `pgadmin` service (`dpage/pgadmin4` pinned by digest, profile `tools`, `127.0.0.1:5050`, login from `.env`) with a preloaded `servers.json` connecting to `db` over TLS as `gis_readonly` (design D5); verify a `deploy/droplet` integration test that pgAdmin binds only `127.0.0.1` and that `gis_readonly` can select but not insert, update or delete
- [ ] 3.2 Document starting pgAdmin on demand and the SSH tunnel (`ssh -L 5050:127.0.0.1:5050`) in `deploy/droplet/README.md`, with a geometry-viewer example query; verify the local steps run as written
- [ ] 3.3 On the droplet (maintainer): start pgAdmin, open it through the tunnel, log in, run the example query, and open the geometry viewer; verify the points render on the map and that port 5050 is not reachable from outside

## 4. F2.5.4 Scheduled cleanup

- [ ] 4.1 Add custom migration `0005_maintenance.sql` with schema `maintenance` and `ensure_detection_partitions`, `expire_detections` and `delete_abandoned_uploads` (design D9); verify `db:check` passes and `apps/api` integration tests for every `data-retention` scenario: missing upcoming month created, repeated run changes nothing, rows already in `detection_default` moved into the new partition with ids and values intact and still found by search, 61 months removed and 59 months and default-partition three-years kept, a whole expired partition dropped, a pending capture 25 hours old deleted (then 404) and one hour old kept, and ready captures never deleted
- [ ] 4.2 Add `postgres/Dockerfile` (`FROM` the pinned PostGIS image plus a pinned `postgresql-17-cron`), the `pg_cron` settings, and an `initdb` script scheduling the four daily jobs as `gis_owner` (design D9), and build `db` from it; verify a `deploy/droplet` integration test that the four jobs are registered with their schedules and commands, and that running each job's command succeeds as `gis_owner`
- [ ] 4.3 Document the retention policy, the job schedule and how to read `cron.job_run_details` in `deploy/droplet/README.md`; verify the documented queries run against the local stack
- [ ] 4.4 On the droplet (maintainer): rebuild and restart `db` with `pg_cron`; verify the next day that `cron.job_run_details` shows a successful run of each job

## 5. F2.5.5 Security & backups

- [ ] 5.1 Add `scripts/harden.sh` (deploy user, key-only SSH without root login, ufw allowing only 22 and 6432, fail2ban with `sshd` and a `pgbouncer` jail, unattended upgrades, swap; idempotent) and the `doctl` cloud firewall commands (design D10); verify `shellcheck` passes on all scripts and the pgbouncer fail2ban filter matches PgBouncer's failed-login log line in a unit test fixture
- [ ] 5.2 Create the CDK app `deploy/aws` (`@gis-vision/deploy-aws`, `aws-cdk-lib` and `constructs` versions at least two weeks old, `cdk.json`, `bin/app.ts`) with the `GisVisionBackups` stack: private encrypted bucket with 30-day expiry and an IAM user allowed only `s3:PutObject` on `pg_dump/*` (design D7, D11); verify CDK assertion tests for the bucket settings and that the user's policy has no read, list or delete action, and that `cdk synth` succeeds offline
- [ ] 5.3 Add `scripts/backup.sh` (`pg_dump -Fc` streamed to a pinned `amazon/aws-cli` container, optional `S3_ENDPOINT`), the systemd service and timer (02:30 UTC, `Persistent=true`), and `scripts/restore.sh` with its verification query (design D11); verify locally that a backup to RustFS restores into `gis_vision_restore` with matching table and partition row counts and PostGIS version
- [ ] 5.4 Write `deploy/droplet/SECURITY.md` (checklist with the command for each item: open ports from outside, SSH password login refused, root login refused, fail2ban jails active, unattended upgrades enabled, Postgres and pgAdmin loopback-only, TLS required, roles without superuser, certificate end date, backup credentials denied list/get/delete) and `deploy/droplet/RESTORE.md` (runbook and rehearsal log); verify every command runs against the local stack where applicable
- [ ] 5.5 On the droplet and AWS (maintainer): run `harden.sh`, create the cloud firewall, deploy `GisVisionBackups`, install the access key and timer, and rehearse a restore; verify every `SECURITY.md` item passes (including an external port scan showing only 22 and 6432), a backup object appears after the first night, and the rehearsal is recorded in `RESTORE.md`

## 6. F2.5.6 Minimal CDK stack

- [ ] 6.1 Add `@fastify/aws-lambda` and `@aws-sdk/client-secrets-manager` (versions at least two weeks old) and `apps/api/src/lambda.ts`: build the app once per environment, load `DATABASE_URL` and `DATABASE_SSL_CA` from the secret named by `DATABASE_SECRET_ARN` before `loadConfig` (design D6); verify unit tests that an API Gateway v2 event for `GET /health` is answered through the handler with injected dependencies, and that secret values override the environment and are never logged
- [ ] 6.2 Add the `GisVisionApp` stack's API part: `NodejsFunction` for `lambda.ts` (Node.js 22.x, arm64, 512 MB, 10 s, reserved concurrency 10, production environment, 14-day logs), HTTP API with `$default` route, the private captures bucket with `enforceSSL`, and the database secret with a placeholder, with least-privilege grants (design D7); verify CDK assertion tests for each of these properties and grants, and `cdk synth` with bundling
- [ ] 6.3 On AWS (maintainer): deploy `GisVisionApp`, put the secret value from a file, run migrations through the tunnel, and call the HTTP API URL; verify `GET <api-url>/health` returns 200 with `status: "ok"`

## 7. F2.5.7 Web hosting

- [ ] 7.1 Add the web hosting to `GisVisionApp`: private web bucket with Origin Access Control, CloudFront distribution (HTTPS redirect, `index.html` root, price class 100), the `/api/*` behavior to the HTTP API with caching disabled and a CloudFront Function stripping `/api`, `BucketDeployment` of `apps/web/dist`, and the captures bucket CORS for the distribution origin (design D8); verify CDK assertion tests for the behaviors, the function's code (unit test of the prefix stripping) and the CORS origin
- [ ] 7.2 On AWS (maintainer): build the web app, deploy, and open the CloudFront URL; verify the header shows `API: ok`, an image uploads with a thumbnail, a detection can be added, the map shows detections, and `http://` redirects to `https://`

## 8. F2.5.8 Runbook & guardrails

- [ ] 8.1 Add the AWS Budgets alert to `GisVisionApp` ($5 monthly cost, actual and forecast notifications to the required `budgetEmail` context; design D14); verify CDK assertion tests and that synth fails with a clear message without `budgetEmail`
- [ ] 8.2 Add the smoke test `deploy/aws/src/smoke.ts` and its `smoke` script (health, HTTPS redirect, no GraphiQL, GraphQL detectors, presigned upload of a tiny PNG, a detection, bbox search finding it; label prefix `smoke:`; design D13); verify it passes against the local stack (Compose, API and Vite) via a base-URL argument
- [ ] 8.3 Write `deploy/README.md`: the full runbook in order (design D13), including the demo seed through the tunnel, certificate renewal, rollback and teardown; add a "Deploy" section to the root README and update `docs/ROADMAP.md`; verify every command is copied from the scripts and stacks as they are
- [ ] 8.4 On AWS (maintainer): run the smoke test against the CloudFront URL and confirm the budget exists; verify the smoke test passes and the budget shows in the Billing console with the email subscriber

## 9. Deploy v0 exit check

- [ ] 9.1 Against the public URL: upload, annotate and query on the map end to end, run the README's GraphQL examples under `/api/graphql`, and confirm `SECURITY.md` passes and a restore rehearsal is recorded; verify `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` are green and CI passes

## Workflow follow-up

- Review the feature PRs, then archive with `/opsx:archive phase-2-5-deploy-v0`, which adds `hosted-deployment` and `data-retention` to `openspec/specs/`.
- Then plan Phase 3 in detail: `/opsx:propose phase-3-schema-driven-ui`.
