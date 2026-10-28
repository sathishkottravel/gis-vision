import type { CaptureFilter } from '@gis-vision/schemas';
import { and, desc, getTableColumns, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { capture } from '../db/schema.js';
import { CURSOR_TIMESTAMP_FORMAT, type Cursor } from './cursor.js';
import { inBoundingBox } from './spatial.js';

export type CaptureRow = typeof capture.$inferSelect;

export interface CaptureHit {
  row: CaptureRow;
  /** Keyset position after this capture, for `after` (design D8). */
  cursor: Cursor;
}

export interface CaptureSearchPage {
  hits: CaptureHit[];
  hasNextPage: boolean;
}

/**
 * Captures matching the filter, newest first (spec: Stable ordering). A bounding box applies
 * to the capture's own location, so captures without one never match it; the time range is
 * half-open over the capture time.
 */
export function captureSearchQuery(
  db: Database,
  filter: CaptureFilter,
  limit: number,
  after?: Cursor,
) {
  return db
    .select({
      ...getTableColumns(capture),
      // `created_at` defaults to now(), which has microseconds; keep them for the cursor.
      cursorTs: sql<string>`to_char(${capture.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`,
    })
    .from(capture)
    .where(
      and(
        // Keyset: strictly after the cursor in (created_at DESC, id DESC) order.
        after === undefined
          ? undefined
          : sql`(${capture.createdAt}, ${capture.id}) < (${after.timestamp}::timestamptz, ${after.id}::uuid)`,
        filter.bbox ? isNotNull(capture.geom) : undefined,
        filter.bbox ? inBoundingBox(capture.geom, filter.bbox) : undefined,
        filter.capturedFrom ? gte(capture.capturedAt, filter.capturedFrom) : undefined,
        filter.capturedTo ? lt(capture.capturedAt, filter.capturedTo) : undefined,
      ),
    )
    .orderBy(desc(capture.createdAt), desc(capture.id))
    .limit(limit);
}

/** Runs the search for one page of `first` captures, starting after `after` when given. */
export async function searchCaptures(
  db: Database,
  filter: CaptureFilter,
  first: number,
  after?: Cursor,
): Promise<CaptureSearchPage> {
  const rows = await captureSearchQuery(db, filter, first + 1, after);
  const hits = rows.slice(0, first).map(({ cursorTs, ...row }) => ({
    row,
    cursor: { kind: 'capture' as const, timestamp: cursorTs, id: row.id },
  }));
  return { hits, hasNextPage: rows.length > first };
}
