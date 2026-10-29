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

- [x] 3.1 Add the `pgadmin` service (`dpage/pgadmin4` pinned by digest, profile `tools`, `127.0.0.1:5050`, login from `.env`) with a preloaded `servers.json` connecting to `db` over TLS as `gis_readonly` (design D5); verify a `deploy/droplet` integration test that pgAdmin binds only `127.0.0.1` and that `gis_readonly` can select but not insert, update or delete

## Deferred / moved

The scope changed on 2026-10-29 to reach a working public demo sooner (see proposal.md, "Scope change"). These items are not tracked here any more:

- **F2.5.3 checks, deferred:** the README steps and `.env` entries are written and the integration test passed in CI, but these two manual checks are still open:
  - 3.2: Document starting pgAdmin on demand and the SSH tunnel (`ssh -L 5050:127.0.0.1:5050`) in `deploy/droplet/README.md`, with a geometry-viewer example query; verify the local steps run as written
  - 3.3: On the droplet (maintainer): start pgAdmin, open it through the tunnel, log in, run the example query, and open the geometry viewer; verify the points render on the map and that port 5050 is not reachable from outside
- **Moved to `demo-cv-detection-deploy`:** F2.5.6 (minimal CDK stack and Lambda API), F2.5.7 (web hosting), F2.5.8 (runbook, smoke test, budget), the minimum of F2.5.5 needed for a public pooler port (DigitalOcean cloud firewall and key-only SSH), and the exit check 9.1.
- **Deferred to a later hardening change:** F2.5.4 (scheduled cleanup with `pg_cron`, the `data-retention` capability) and the rest of F2.5.5 (`harden.sh` with ufw, fail2ban and unattended upgrades; nightly backups to S3 with an upload-only key; the restore runbook and rehearsal; `SECURITY.md`). Their planned tasks are in this change's git history (`main` commit `731cf5d`, PR #28: `tasks.md` groups 4-5) and design D9-D11.

## Workflow follow-up

- Archive with `/opsx:archive phase-2-5-deploy-v0`, which adds `hosted-deployment` (database hosting requirements only) to `openspec/specs/`.
- Then plan the demo: `/opsx:propose demo-cv-detection-deploy`.
