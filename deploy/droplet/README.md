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

Migrations run from your machine, as `gis_owner`, through an SSH tunnel to the loopback-only port. Local port 15432 avoids clashing with the local Compose database on 5432:

```sh
ssh -N -L 15432:127.0.0.1:5432 root@<droplet-ip>   # leave running in another terminal
DATABASE_URL='postgres://gis_owner:<owner-password>@127.0.0.1:15432/gis_vision' pnpm -w db:migrate
```

`DATABASE_URL` set in the shell takes precedence over the repository's `.env`. Check the result:

```sh
docker compose exec -u postgres db psql -d gis_vision -c 'SELECT extensions.postgis_full_version();'
```

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

`src/roles.int.test.ts` (part of `pnpm test:integration`) starts these files with random passwords and port, runs the real migrations as `gis_owner`, and checks the role rules above.
