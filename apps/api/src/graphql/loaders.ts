import { asc, inArray } from 'drizzle-orm';
import DataLoader from 'dataloader';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { detection } from '../db/detection.js';
import { capture, detector } from '../db/schema.js';

export type CaptureRow = typeof capture.$inferSelect;
export type DetectorRow = typeof detector.$inferSelect;
export type DetectionRow = typeof detection.$inferSelect;

export interface Loaders {
  /** `null` for unknown ids and for ids that are not UUIDs. */
  captureById: DataLoader<string, CaptureRow | null>;
  detectorById: DataLoader<string, DetectorRow | null>;
  /** Each capture's detections, ordered by observation time, then id. */
  detectionsByCaptureId: DataLoader<string, DetectionRow[]>;
}

const uuid = z.uuid();

/** Puts rows back in the order of `keys`, with `null` where no row matched. */
function byKey<T>(keys: readonly string[], rows: T[], keyOf: (row: T) => string): (T | null)[] {
  const found = new Map(rows.map((row) => [keyOf(row), row]));
  return keys.map((key) => found.get(key) ?? null);
}

/** One query per loader per request tick, however many items ask (design D5). */
export function createLoaders(db: Database): Loaders {
  return {
    captureById: new DataLoader(async (ids) => {
      const valid = ids.filter((id) => uuid.safeParse(id).success);
      const rows =
        valid.length === 0 ? [] : await db.select().from(capture).where(inArray(capture.id, valid));
      return byKey(ids, rows, (row) => row.id);
    }),

    detectorById: new DataLoader(async (ids) => {
      const rows = await db
        .select()
        .from(detector)
        .where(inArray(detector.id, [...ids]));
      return byKey(ids, rows, (row) => row.id);
    }),

    detectionsByCaptureId: new DataLoader(async (captureIds) => {
      const rows = await db
        .select()
        .from(detection)
        .where(inArray(detection.captureId, [...captureIds]))
        .orderBy(asc(detection.observedAt), asc(detection.id));
      const grouped = new Map<string, DetectionRow[]>(captureIds.map((id) => [id, []]));
      for (const row of rows) {
        grouped.get(row.captureId)?.push(row);
      }
      return captureIds.map((id) => grouped.get(id) ?? []);
    }),
  };
}
