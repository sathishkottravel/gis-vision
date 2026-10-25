# Postgres init scripts

Mounted over `/docker-entrypoint-initdb.d`, which hides the `postgis/postgis` image's own init script. That script installs PostGIS into `public`; this project keeps it in the `extensions` schema instead (design D8).

PostGIS itself is installed by the database migrations (`apps/api/drizzle/0000_postgis-extension.sql`), so run `pnpm db:migrate` after `docker compose up -d`. Init scripts run only when the data volume is first created.
