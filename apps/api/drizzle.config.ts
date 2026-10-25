import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Only `public` holds app tables; PostGIS objects (in `extensions`) are not ours to diff (design D8).
  schemaFilter: ['public'],
  extensionsFilters: ['postgis'],
});
