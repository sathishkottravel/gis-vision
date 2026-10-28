# Database host (DigitalOcean droplet)

The Deploy v0 database: PostgreSQL 17 with PostGIS 3.6 in Docker on one DigitalOcean droplet. The API on AWS Lambda reaches it through PgBouncer over TLS. Design: [`phase-2-5-deploy-v0` design.md](../../openspec/changes/phase-2-5-deploy-v0/design.md) (D1-D3).

| Service | Listens on                  | Notes                                                                    |
| ------- | --------------------------- | ------------------------------------------------------------------------ |
| `db`    | `127.0.0.1:5432` (loopback) | reached for migrations through an SSH tunnel; never open to the internet |

PgBouncer, TLS, pgAdmin, scheduled cleanup, hardening and backups follow in F2.5.2-F2.5.5.

## Roles

`postgres/initdb/10-roles.sh` runs once, when the data volume is created:

| Role           | Can                                                               | Used by                                   |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `postgres`     | everything (superuser), **only** through the container socket     | `docker compose exec -u postgres db psql` |
| `gis_owner`    | owns the `gis_vision` database and every object migrations create | `pnpm db:migrate` through the tunnel      |
| `gis_app`      | read and write rows in the application tables; no DDL             | the API                                   |
| `gis_readonly` | read rows                                                         | the data dashboard (F2.5.3)               |

No role is a superuser or can create roles or databases. Passwords are SCRAM-SHA-256 only, and `pg_hba.conf` rejects everything else, including the superuser over TCP. PostGIS is installed into the `extensions` schema by the superuser, so migration `0000` finds it present when `gis_owner` runs it.

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

4. Start the database:

   ```sh
   docker compose up -d --wait
   docker compose exec -u postgres db psql -d gis_vision -c '\du'
   ```

## Run migrations

Migrations run **on your machine**, from the repository root, as `gis_owner`, through an SSH tunnel to the loopback-only port. The droplet itself needs only Docker: don't install Node.js or pnpm there (the standalone pnpm installer also fails on the droplet image with `libatomic.so.1` missing). Local port 15432 avoids clashing with the local Compose database on 5432.

Open the tunnel and leave it running in another terminal:

```sh
ssh -N -L 15432:127.0.0.1:5432 root@<droplet-ip>
```

Then run the migrations. Bash or Git Bash:

```sh
DATABASE_URL='postgres://gis_owner:<owner-password>@127.0.0.1:15432/gis_vision' pnpm -w db:migrate
```

PowerShell (it has no `VAR=value command` form; clear the variable afterwards so later local commands don't reach the droplet):

```powershell
$env:DATABASE_URL = 'postgres://gis_owner:<owner-password>@127.0.0.1:15432/gis_vision'
pnpm -w db:migrate
Remove-Item Env:DATABASE_URL
```

Either way it prints `Migrations applied.` `DATABASE_URL` set in the shell takes precedence over the repository's `.env`; without it, the `.env` applies and the command migrates your **local** database instead.

## Check the database

On the droplet, in `deploy/droplet`. Load the passwords into the shell first:

```sh
set -a; . ./.env; set +a
```

Each role logs in over TCP with its `.env` password (expected: `ok as gis_owner`, `ok as gis_app`, `ok as gis_readonly`):

```sh
for pair in gis_owner:GIS_OWNER_PASSWORD gis_app:GIS_APP_PASSWORD gis_readonly:GIS_READONLY_PASSWORD; do
  role=${pair%%:*}; var=${pair#*:}
  docker compose exec -T -e PGPASSWORD="${!var}" db     psql -h 127.0.0.1 -U "$role" -d gis_vision -tAc "SELECT 'ok as ' || current_user"     || echo "FAILED: $role"
done
```

A `password authentication failed` means the role no longer matches `.env` (see [Change a password](#change-a-password)). The superuser must be refused over TCP (expected: `pg_hba.conf rejects connection ...`):

```sh
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" db psql -h 127.0.0.1 -U postgres -d gis_vision -c 'SELECT 1'
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

The API's role writes data but cannot change the schema. The transaction is rolled back, so nothing stays behind (expected: `INSERT 0 1`, `13.4`, then `permission denied for schema public`):

```sh
docker compose exec -T -e PGPASSWORD="$GIS_APP_PASSWORD" db psql -h 127.0.0.1 -U gis_app -d gis_vision <<'SQL'
SHOW search_path;
BEGIN;
INSERT INTO capture (status, blob_key, content_type, byte_size, captured_at, geom)
VALUES ('ready', 'images/check', 'image/png', 1, now(), ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));
SELECT ST_X(geom) FROM capture WHERE blob_key = 'images/check';
ROLLBACK;
CREATE TABLE should_fail (id int);
SQL
```

Finally, the real API against the droplet: with the tunnel open, start it on your machine as `gis_app` (images still go to the local RustFS, so keep the repository's Compose running). PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://gis_app:<app-password>@127.0.0.1:15432/gis_vision'
$env:PORT = '3002'
pnpm --filter @gis-vision/api dev
# in another terminal:
curl.exe -s localhost:3002/health
# stop the API (Ctrl+C), then:
Remove-Item Env:DATABASE_URL, Env:PORT
```

`/health` returns `{"status":"ok","database":"ok","objectStorage":"ok"}`. Don't run `db:seed-demo` against the droplet: its images would land in your local RustFS while the rows land on the droplet. The deploy runbook seeds it once the S3 bucket exists (F2.5.6).

## Change a password

The `.env` passwords are read only when the volume is first created. To rotate one later, update `.env` and the role together:

```sh
docker compose exec -u postgres db psql -d gis_vision -c "ALTER ROLE gis_app PASSWORD '<new-password>';"
```

## Try it locally

The same files run on any machine with Docker. Use another host port if the repository's own Compose database already uses 5432:

```sh
cd deploy/droplet
cp .env.example .env                      # local only: the placeholder passwords are fine
sed -i 's/^DB_HOST_PORT=.*/DB_HOST_PORT=5433/' .env
docker compose up -d --wait
DATABASE_URL='postgres://gis_owner:change-me@127.0.0.1:5433/gis_vision' pnpm -w db:migrate
docker compose down -v                    # removes the data volume
```

In PowerShell, copy the example file and set the port in `.env` by hand (or with `(Get-Content .env) -replace '^DB_HOST_PORT=.*', 'DB_HOST_PORT=5433' | Set-Content .env`), then migrate with `$env:DATABASE_URL = 'postgres://gis_owner:change-me@127.0.0.1:5433/gis_vision'; pnpm -w db:migrate; Remove-Item Env:DATABASE_URL`.

`src/roles.int.test.ts` (part of `pnpm test:integration`) starts these files with random passwords and port, runs the real migrations as `gis_owner`, and checks the role rules above.
