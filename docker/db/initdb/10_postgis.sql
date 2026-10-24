-- Replaces the postgis/postgis image's default init script, which installs
-- PostGIS into `public`. Design D8: PostGIS lives in its own `extensions` schema
-- (keeps spatial_ref_sys out of `public`, matches Supabase/managed layouts).
-- Runs only when the data volume is first initialized.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- Resolve ST_* functions and geometry types without schema qualification.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, extensions', current_database());
END
$$;
