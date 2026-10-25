// Typed mapping of the partitioned `detection` table for queries only. Its DDL (partitions,
// BRIN, composite PK) is the custom migration `drizzle/0002_detection-partitions.sql`, so this
// file is deliberately outside drizzle-kit's `schema` path and never generates migrations.
import { jsonb, pgTable, primaryKey, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pointGeometry } from './geometry.js';
import { capture, detector } from './schema.js';

/** Pixel bounding box in the capture image. */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const detection = pgTable(
  'detection',
  {
    id: uuid('id').notNull().defaultRandom(),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => capture.id),
    detectorId: text('detector_id')
      .notNull()
      .references(() => detector.id),
    label: text('label').notNull(),
    confidence: real('confidence'),
    bboxPx: jsonb('bbox_px').$type<BoundingBox>().notNull(),
    /** Null means "use the capture's location" (design D6). */
    geom: pointGeometry('geom'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.observedAt] })],
);
