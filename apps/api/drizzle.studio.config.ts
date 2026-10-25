import { defineConfig } from 'drizzle-kit';
import base from './drizzle.config.js';

// Studio also shows `detection`, which is mapped in a file drizzle-kit must not generate DDL from.
export default defineConfig({ ...base, schema: ['./src/db/schema.ts', './src/db/detection.ts'] });
