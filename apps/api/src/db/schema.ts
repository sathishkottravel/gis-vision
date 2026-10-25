// Tables managed by drizzle-kit (`pnpm db:generate`). The partitioned `detection` table
// lives in `detection.ts`: its DDL is a custom SQL migration that Drizzle can't express (design D7).
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { pointGeometry } from './geometry.js';

export const detectorKind = pgEnum('detector_kind', ['manual', 'ml']);

export const detector = pgTable('detector', {
  /** Slug, e.g. `manual`. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  kind: detectorKind('kind').notNull(),
  /** JSON Schema for `detection.attributes`, limited to the supported subset. */
  outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().notNull(),
});

export const captureStatus = pgEnum('capture_status', ['pending', 'ready']);

export const capture = pgTable(
  'capture',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: captureStatus('status').notNull().default('pending'),
    blobKey: text('blob_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    idempotencyKey: text('idempotency_key').unique(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    /** WGS84 longitude/latitude; null when the image has no location. */
    geom: pointGeometry('geom'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('capture_geom_gist').using('gist', t.geom),
    check('capture_byte_size_positive', sql`${t.byteSize} > 0`),
  ],
);
