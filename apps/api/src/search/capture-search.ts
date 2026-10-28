import type { CaptureFilter } from '@gis-vision/schemas';
import { and, desc, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { capture } from '../db/schema.js';
import { inBoundingBox } from './spatial.js';

export type CaptureRow = typeof capture.$inferSelect;

export interface CaptureSearchPage {
  rows: CaptureRow[];
  hasNextPage: boolean;
}

/**
 * Captures matching the filter, newest first (spec: Stable ordering). A bounding box applies
 * to the capture's own location, so captures without one never match it.
 */
export function captureSearchQuery(db: Database, filter: CaptureFilter, limit: number) {
  return db
    .select()
    .from(capture)
    .where(
      and(
        filter.bbox ? isNotNull(capture.geom) : undefined,
        filter.bbox ? inBoundingBox(capture.geom, filter.bbox) : undefined,
      ),
    )
    .orderBy(desc(capture.createdAt), desc(capture.id))
    .limit(limit);
}

/** Runs the search for one page of `first` captures. */
export async function searchCaptures(
  db: Database,
  filter: CaptureFilter,
  first: number,
): Promise<CaptureSearchPage> {
  const rows = await captureSearchQuery(db, filter, first + 1);
  return { rows: rows.slice(0, first), hasNextPage: rows.length > first };
}
