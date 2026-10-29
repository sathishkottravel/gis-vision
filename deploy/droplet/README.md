# Database host (DigitalOcean droplet)

The Deploy v0 database: PostgreSQL 17 with PostGIS 3.6 in Docker on one DigitalOcean droplet, behind PgBouncer. The API on AWS Lambda reaches it through PgBouncer over TLS. Design: [`phase-2-5-deploy-v0` design.md](../../openspec/changes/archive/2026-10-29-phase-2-5-deploy-v0/design.md) (D1-D5).

| Service     | Listens on                  | Notes                                                                                   |
| ----------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `pgbouncer` | `6432` (all interfaces)     | the only port for clients from the internet; TLS required, SCRAM, transaction pooling   |
| `db`        | `127.0.0.1:5432` (loopback) | TLS required; reached for migrations through an SSH tunnel, never open to the internet  |
| `pgadmin`   | `127.0.0.1:5050` (loopback) | data dashboard, started on demand (profile `tools`); reached only through an SSH tunnel |

Scheduled cleanup, hardening and backups follow in F2.5.4-F2.5.5.

## Roles

`postgres/initdb/10-roles.sh` runs once, when the data volume is created:

| Role           | Can                                                               | Used by                                   |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `postgres`     | everything (superuser), **only** through the container socket     | `docker compose exec -u postgres db psql` |
| `gis_owner`    | owns the `gis_vision` database and every object migrations create | `pnpm db:migrate` through the tunnel      |
| `gis_app`      | read and write rows in the application tables; no DDL             | the API, through PgBouncer                |
| `gis_readonly` | read rows                                                         | the data dashboard (pgAdmin)              |

No role is a superuser or can create roles or databases. Passwords are SCRAM-SHA-256 only, and `pg_hba.conf` rejects everything else, including the superuser over TCP. PostGIS is installed into the `extensions` schema by the superuser, so migration `0000` finds it present when `gis_owner` runs it.

## TLS and pooling

- **Certificates** (design D4): `scripts/make-certs.sh` creates a private CA and a server certificate (2 years) whose names cover the droplet's public IP, any DNS names you pass, `db`, `pgbouncer`, `localhost` and `127.0.0.1`. Clients verify the server against `certs/ca.crt`, so a stolen connection string is useless against an impostor and nothing travels in plaintext.
- **Where keys live:** the server key and certificate go into the Docker volume `gis-vision-droplet-secrets` (`SECRETS_VOLUME`), owned by each container's user; `certs/` on the host gets `ca.crt` (give it to clients) and `ca.key` (move it off the droplet).
- **Postgres** accepts network logins only over TLS (`hostssl`). **PgBouncer** requires TLS from clients and verifies Postgres's certificate (`server_tls_sslmode = verify-full`).
- **Pooling** (design D5): transaction mode, at most 10 server connections for the API's role (`default_pool_size`), up to 200 clients. Lambda instances each hold one connection to PgBouncer.
- **Authentication:** `scripts/make-userlist.sh` copies `gis_app`'s SCRAM verifier from Postgres into PgBouncer's auth file in the volume, so no plaintext password is stored.
- **Search path:** PgBouncer ignores the `options` startup parameter the API sends; the database-level `search_path` set by migration `0000` applies instead.

## Provision the droplet

Size and region follow design D1: Basic `s-1vcpu-1gb` ($6/mo) in `fra1`, next to the AWS region `eu-central-1`.

1. Create it with your SSH key (fingerprint from `doctl compute ssh-key list`):

   ```sh
   doctl compute droplet create gis-vision-db \
     --region fra1 --size s-1vcpu-1gb --image ubuntu-24-04-x64 \
     --ssh-keys <key-fingerprint> --enable-monitoring --wait
   doctl compute droplet list --format Name,PublicIPv4
   ```

   Until hardening (F2.5.5) creates the `deploy` user, log in as `root`.

2. Install Docker Engine and the Compose plugin from Docker's apt repository:

   ```sh
   ssh root@<droplet-ip>
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
   apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
   ```

3. Get these files and create `.env` with long random passwords:

   ```sh
   git clone --depth 1 https://github.com/sathishkottravel/gis-vision.git
   cd gis-vision/deploy/droplet
   cp .env.example .env && chmod 600 .env
   for name in POSTGRES_SUPERUSER_PASSWORD GIS_OWNER_PASSWORD GIS_APP_PASSWORD GIS_READONLY_PASSWORD; do
     sed -i "s|^$name=.*|$name=$(openssl rand -hex 32)|" .env
   done
   ```

   Keep a copy of the `gis_owner` and `gis_app` passwords in your password manager: the first runs migrations, the second goes into the API's secret (F2.5.6).

4. Create the certificates with the droplet's public IP (and a DNS name, if you have one), then start Postgres, write PgBouncer's auth file, and start everything:

   ```sh
   scripts/make-certs.sh <droplet-ip>
   docker compose up -d --wait db
   scripts/make-userlist.sh
   docker compose up -d --wait
   docker compose exec -u postgres db psql -d gis_vision -c '\du'
   ```

5. On your machine, fetch the CA certificate (clients need it) and the CA key (it must not stay on the droplet), then delete the key there:

   ```sh
   scp root@<droplet-ip>:gis-vision/deploy/droplet/certs/ca.crt ./droplet-ca.crt
   scp root@<droplet-ip>:gis-vision/deploy/droplet/certs/ca.key ./droplet-ca.key   # keep it in your password manager
   ssh root@<droplet-ip> rm gis-vision/deploy/droplet/certs/ca.key
   ```

### Upgrading a droplet set up before TLS (F2.5.1)

The data volume stays; only configuration and the new service change:

```sh
cd ~/gis-vision && git pull && cd deploy/droplet
scripts/make-certs.sh <droplet-ip>
docker compose up -d --wait db            # restarts Postgres with TLS and hostssl
scripts/make-userlist.sh
docker compose up -d --wait               # starts PgBouncer
```

Then do step 5 above. From now on, every network client needs the CA certificate (below).

## Run migrations

Migrations run **on your machine**, from the repository root, as `gis_owner`, through an SSH tunnel to the loopback-only port. The droplet itself needs only Docker: don't install Node.js or pnpm there (the standalone pnpm installer also fails on the droplet image with `libatomic.so.1` missing). Local port 15432 avoids clashing with the local Compose database on 5432.

Open the tunnel and leave it running in another terminal:

```sh
ssh -N -L 15432:127.0.0.1:5432 root@<droplet-ip>
```

Then run the migrations with the CA certificate from step 5 (`DATABASE_SSL_CA`, design D4; the URL must not carry `sslmode`). Bash or Git Bash:

```sh
DATABASE_SSL_CA="$(cat droplet-ca.crt)" \
DATABASE_URL='postgres://gis_owner:<owner-password>@127.0.0.1:15432/gis_vision' pnpm -w db:migrate
```

PowerShell (it has no `VAR=value command` form; clear the variables afterwards so later local commands don't reach the droplet):

```powershell
$env:DATABASE_SSL_CA = Get-Content -Raw droplet-ca.crt
$env:DATABASE_URL = 'postgres://gis_owner:<owner-password>@127.0.0.1:15432/gis_vision'
pnpm -w db:migrate
Remove-Item Env:DATABASE_URL, Env:DATABASE_SSL_CA
```

Either way it prints `Migrations applied.` Settings in the shell take precedence over the repository's `.env`; without `DATABASE_URL`, the `.env` applies and the command migrates your **local** database instead. Without `DATABASE_SSL_CA`, Postgres refuses the connection (`pg_hba.conf rejects connection ... no encryption`).

## Connect through PgBouncer

This is how the API connects: to the public pooler port, verifying the certificate. With `psql` installed:

```sh
psql "host=<droplet-ip> port=6432 dbname=gis_vision user=gis_app sslmode=verify-full sslrootcert=droplet-ca.crt" -c "SELECT current_user, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
```

Without a local `psql`, through Docker (PowerShell or bash, from the folder holding `droplet-ca.crt`):

```sh
docker run --rm -it -v "${PWD}:/certs:ro" postgres:17 psql "host=<droplet-ip> port=6432 dbname=gis_vision user=gis_app sslmode=verify-full sslrootcert=/certs/droplet-ca.crt" -c "SELECT current_user"
```

Expected: `gis_app` (and `t` for `ssl`). With `sslmode=disable` the same command fails with `SSL required`, and with another CA file it fails certificate verification.

## Check the database

On the droplet, in `deploy/droplet`. Load the passwords into the shell first:

```sh
set -a; . ./.env; set +a
```

Each role logs in over TCP with verified TLS and its `.env` password (expected: `ok as gis_owner`, `ok as gis_app`, `ok as gis_readonly`):

```sh
for pair in gis_owner:GIS_OWNER_PASSWORD gis_app:GIS_APP_PASSWORD gis_readonly:GIS_READONLY_PASSWORD; do
  role=${pair%%:*}; var=${pair#*:}
  docker compose exec -T -e PGPASSWORD="${!var}" -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/secrets/postgres/ca.crt db \
    psql -h 127.0.0.1 -U "$role" -d gis_vision -tAc "SELECT 'ok as ' || current_user" \
    || echo "FAILED: $role"
done
```

A `password authentication failed` means the role no longer matches `.env` (see [Change a password](#change-a-password)). The superuser must be refused over TCP, and plaintext too (expected: `pg_hba.conf rejects connection ...` twice):

```sh
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" -e PGSSLMODE=require db psql -h 127.0.0.1 -U postgres -d gis_vision -c 'SELECT 1'
docker compose exec -T -e PGPASSWORD="$GIS_OWNER_PASSWORD" -e PGSSLMODE=disable db psql -h 127.0.0.1 -U gis_owner -d gis_vision -c 'SELECT 1'
```

What the migrations created:

| Check                | Command (`docker compose exec -u postgres db psql -d gis_vision -tAc "..."`)                                        | Expected                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Migrations recorded  | `SELECT count(*) FROM drizzle.__drizzle_migrations`                                                                 | `5`                                                                                    |
| Detection partitions | `SELECT count(*) FROM pg_inherits WHERE inhparent = 'detection'::regclass`                                          | `26` (25 monthly plus `detection_default`)                                             |
| Seeded detector      | `SELECT id, kind, version FROM detector`                                                                            | `manual\|manual\|1`                                                                    |
| PostGIS schema       | `SELECT extnamespace::regnamespace FROM pg_extension WHERE extname = 'postgis'`                                     | `extensions`                                                                           |
| Spatial indexes      | `SELECT indexname FROM pg_indexes WHERE tablename IN ('capture','detection') AND indexdef LIKE '%gist%' ORDER BY 1` | `capture_geog_gist`, `capture_geom_gist`, `detection_geog_gist`, `detection_geom_gist` |
| Table owner          | `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`                                             | `gis_owner`                                                                            |

The API's role writes data but cannot change the schema. The transaction is rolled back, so nothing stays behind (expected: `public, extensions`, `INSERT 0 1`, `13.4`, then `permission denied for schema public`):

```sh
docker compose exec -T -e PGPASSWORD="$GIS_APP_PASSWORD" -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/secrets/postgres/ca.crt db \
  psql -h 127.0.0.1 -U gis_app -d gis_vision <<'SQL'
SHOW search_path;
BEGIN;
INSERT INTO capture (status, blob_key, content_type, byte_size, captured_at, geom)
VALUES ('ready', 'images/check', 'image/png', 1, now(), ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));
SELECT ST_X(geom) FROM capture WHERE blob_key = 'images/check';
ROLLBACK;
CREATE TABLE should_fail (id int);
SQL
```

Finally, the real API against the droplet, the way Lambda will connect: through PgBouncer as `gis_app`, with the CA and one pooled connection. Start it on your machine (images still go to the local RustFS, so keep the repository's Compose running). PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://gis_app:<app-password>@<droplet-ip>:6432/gis_vision'
$env:DATABASE_SSL_CA = Get-Content -Raw droplet-ca.crt
$env:DATABASE_POOL_MAX = '1'
$env:PORT = '3002'
pnpm --filter @gis-vision/api dev
# in another terminal:
curl.exe -s localhost:3002/health
# stop the API (Ctrl+C), then:
Remove-Item Env:DATABASE_URL, Env:DATABASE_SSL_CA, Env:DATABASE_POOL_MAX, Env:PORT
```

`/health` returns `{"status":"ok","database":"ok","objectStorage":"ok"}`. Don't run `db:seed-demo` against the droplet: its images would land in your local RustFS while the rows land on the droplet. The deploy runbook seeds it once the S3 bucket exists (F2.5.6).

## Data dashboard (pgAdmin)

pgAdmin 4 explores the data, and its geometry viewer draws PostGIS results on a map. It never listens on a public interface: Compose binds it to the droplet's loopback address, so it is reachable only through an SSH tunnel, and it still asks for its own login. It connects to `db` over verified TLS as the read-only `gis_readonly` role (`pgadmin/servers.json`), so nothing done in the dashboard can change data. It needs about 200 MB, so start it only while you use it.

1. On the droplet, set the dashboard login in `.env` once. A droplet set up before F2.5.3 needs the lines added first; `PGADMIN_EMAIL` must look like an email address:

   ```sh
   grep -q '^PGADMIN_EMAIL=' .env || printf 'PGADMIN_EMAIL=admin@example.com\nPGADMIN_PASSWORD=change-me\n' >> .env
   sed -i "s|^PGADMIN_PASSWORD=.*|PGADMIN_PASSWORD=$(openssl rand -hex 16)|" .env
   grep '^PGADMIN_' .env        # note the email and password
   ```

2. Start it. The server entry needs `certs/ca.crt`, which `make-certs.sh` created:

   ```sh
   docker compose --profile tools up -d --wait pgadmin
   ```

3. On your machine, open a tunnel to its loopback port and leave it running. Local port 15050 avoids the repository's own Compose pgAdmin on 5050:

   ```sh
   ssh -N -L 15050:127.0.0.1:5050 root@<droplet-ip>
   ```

4. Browse to `http://localhost:15050`, log in with `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`, expand _gis-vision (droplet, read-only)_ and enter the `gis_readonly` password (`GIS_READONLY_PASSWORD` in `.env`).

5. Open the Query Tool (_Tools > Query Tool_), run a query that returns a geometry column, then click the map icon in the `geom` column header to open the geometry viewer. Before any data is loaded, this draws three points on an OpenStreetMap basemap:

   ```sql
   SELECT name, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
     FROM (VALUES ('Berlin', 13.405, 52.52), ('New York', -74.006, 40.713), ('Taveuni', 179.98, -16.85))
          AS t(name, lon, lat);
   ```

   With data, the same works on the tables, for example each detection's effective location:

   ```sql
   SELECT d.label, d.observed_at, COALESCE(d.geom, c.geom) AS geom
     FROM detection d JOIN capture c ON c.id = d.capture_id
    ORDER BY d.observed_at DESC LIMIT 500;
   ```

6. When done, stop it and close the tunnel. Its saved settings stay in the `pgadmin-data` volume:

   ```sh
   docker compose --profile tools stop pgadmin
   ```

From outside, port 5050 must not answer (expected: a connection error or timeout, never a page):

```sh
curl -m 5 http://<droplet-ip>:5050/login
```

## API settings

| Setting             | Default | Meaning                                                                                                        |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_SSL_CA`   | unset   | PEM CA certificate. When set, connections use TLS and verify the server; one-line values may use escaped `\n`. |
| `DATABASE_POOL_MAX` | `5`     | Pooled connections per process (1-100); `1` on Lambda, where one instance serves one request at a time.        |

Both are optional, so local development is unchanged. `DATABASE_SSL_CA` is also read by `db:migrate`. A `DATABASE_URL` carrying `sslmode` or `sslrootcert` is rejected together with `DATABASE_SSL_CA`, because node-pg would let those override the certificate check.

## Change a password

The `.env` passwords are read only when the volume is first created. To rotate one later, update `.env` and the role together, then refresh PgBouncer's copy of the verifier (it reloads automatically):

```sh
docker compose exec -u postgres db psql -d gis_vision -c "ALTER ROLE gis_app PASSWORD '<new-password>';"
scripts/make-userlist.sh
```

## Renew the server certificate

The server certificate lasts 2 years (`openssl x509 -in certs/server.crt -noout -enddate`). Renew it with the same CA, so clients keep working, and restart both services:

```sh
scp ./droplet-ca.key root@<droplet-ip>:gis-vision/deploy/droplet/certs/ca.key   # from your machine
scripts/make-certs.sh <droplet-ip>                                               # on the droplet
docker compose restart db pgbouncer
rm certs/ca.key
```

## Try it locally

The same files run on any machine with Docker. Use other host ports if the repository's own Compose database already uses 5432 (Bash or Git Bash):

```sh
cd deploy/droplet
cp .env.example .env                      # local only: the placeholder passwords are fine
sed -i 's/^DB_HOST_PORT=.*/DB_HOST_PORT=5433/; s/^PGBOUNCER_HOST_PORT=.*/PGBOUNCER_HOST_PORT=6433/' .env
scripts/make-certs.sh 127.0.0.1
docker compose up -d --wait db
scripts/make-userlist.sh
docker compose up -d --wait
DATABASE_SSL_CA="$(cat certs/ca.crt)" \
DATABASE_URL='postgres://gis_owner:change-me@127.0.0.1:5433/gis_vision' pnpm -w db:migrate
docker compose down -v                    # removes the data volume
docker volume rm gis-vision-droplet-secrets && rm -r certs
```

`src/*.int.test.ts` (part of `pnpm test:integration`) run these files the same way, with random passwords and ports:

- `roles.int.test.ts`: the role rules above, over TLS, and plaintext refused.
- `pooling.int.test.ts`: TLS through PgBouncer and on to Postgres, plaintext and an unrelated CA refused, a wrong password rejected, 50 concurrent clients on at most 10 server connections, and the port bindings.
- `api-through-pooler.int.test.ts`: the API's own infrastructure through PgBouncer with the CA and one pooled connection, serving `/health` and a two-page GraphQL search.
- `dashboard.int.test.ts`: pgAdmin bound to loopback only and serving its login page, `servers.json`'s connection (verify-full, `gis_readonly`) working from inside pgAdmin, and `gis_readonly` reading but not writing.
