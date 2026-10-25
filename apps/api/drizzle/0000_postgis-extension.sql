-- Design D8: PostGIS lives in its own `extensions` schema, which keeps
-- spatial_ref_sys out of `public` (no ORM drift) and matches managed layouts.
CREATE SCHEMA IF NOT EXISTS extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;
--> statement-breakpoint
-- Default for sessions that don't set their own search path (psql, pgAdmin).
-- The app sets it per connection anyway (src/db/client.ts).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, extensions', current_database());
END
$$;
