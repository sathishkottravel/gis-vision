#!/usr/bin/env bash
# Runs once, as the bootstrap superuser, when the data volume is first created (design D3).
# Creates the three login roles and the database, installs PostGIS into `extensions`, and sets
# default privileges so tables created later by gis_owner's migrations are usable by the others.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v owner_password="$GIS_OWNER_PASSWORD" \
  -v app_password="$GIS_APP_PASSWORD" \
  -v readonly_password="$GIS_READONLY_PASSWORD" <<'SQL'
-- Owner: runs migrations and owns every object they create. Not a superuser.
CREATE ROLE gis_owner LOGIN PASSWORD :'owner_password';
-- API: reads and writes data, never DDL.
CREATE ROLE gis_app LOGIN PASSWORD :'app_password';
-- Data dashboard (pgAdmin): reads only.
CREATE ROLE gis_readonly LOGIN PASSWORD :'readonly_password';

CREATE DATABASE gis_vision OWNER gis_owner;
REVOKE ALL ON DATABASE gis_vision FROM PUBLIC;
GRANT CONNECT ON DATABASE gis_vision TO gis_app, gis_readonly;
SQL

psql -v ON_ERROR_STOP=1 --username postgres --dbname gis_vision <<'SQL'
-- PostGIS is not a trusted extension, so the superuser installs it once. Migration 0000 then
-- finds the schema and the extension present (IF NOT EXISTS) when gis_owner runs it.
CREATE SCHEMA extensions AUTHORIZATION gis_owner;
CREATE EXTENSION postgis SCHEMA extensions;

-- `public` is owned by the database owner (pg_database_owner); nobody else may create in it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, extensions TO gis_app, gis_readonly;
GRANT SELECT ON extensions.spatial_ref_sys TO gis_app, gis_readonly;

-- Tables and sequences gis_owner creates later (migrations, new partitions).
ALTER DEFAULT PRIVILEGES FOR ROLE gis_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gis_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gis_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO gis_readonly;
SQL
