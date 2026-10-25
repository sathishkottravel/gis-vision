import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs from apps/api; load the repo-root .env for local commands (studio, pull).
const ROOT_ENV = '../../.env';
if (process.env.DATABASE_URL === undefined && existsSync(ROOT_ENV)) {
  process.loadEnvFile(ROOT_ENV);
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Only `public` holds app tables; PostGIS objects (in `extensions`) are not ours to diff (design D8).
  schemaFilter: ['public'],
  extensionsFilters: ['postgis'],
});
