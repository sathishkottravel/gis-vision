import type { DetectionFilter } from '@gis-vision/schemas';
import {
  and,
  asc,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { CURSOR_TIMESTAMP_FORMAT, type Cursor } from './cursor.js';
import { decodePoint, spatialPredicate } from './spatial.js';

export type LocationSource = 'DETECTION' | 'CAPTURE' | 'NONE';

export type DetectionRow = typeof detection.$inferSelect;

/** A matching detection with its effective location (design D5, D6). */
export interface DetectionHit {
  row: DetectionRow;
  location: Point | null;
  locationSource: LocationSource;
  /** Keyset position after this hit, for `after` (design D8). */
  cursor: Cursor;
}

export interface DetectionSearchPage {
  hits: DetectionHit[];
  hasNextPage: boolean;
}

const columns = getTableColumns(detection);

/** `observed_at` at full (microsecond) precision; a JS `Date` would round it to milliseconds. */
const cursorTimestamp =
  sql<string>`to_char(${detection.observedAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`.as(
    'cursor_ts',
  );

/**
 * Predicates every branch shares. The time bounds sit on `detection.observed_at` itself in
 * each branch, so Postgres prunes the monthly partitions per branch (design D7).
 */
function commonPredicates(filter: DetectionFilter, after?: Cursor): (SQL | undefined)[] {
  return [
    // Keyset: strictly after the cursor in (observed_at, id) order. The plain lower bound on
    // observed_at repeats it in a form the planner can also use to skip earlier partitions.
    after === undefined
      ? undefined
      : sql`(${detection.observedAt}, ${detection.id}) > (${after.timestamp}::timestamptz, ${after.id}::uuid)`,
    after === undefined
      ? undefined
      : sql`${detection.observedAt} >= ${after.timestamp}::timestamptz`,
    filter.detectorId === undefined ? undefined : eq(detection.detectorId, filter.detectorId),
    filter.observedFrom === undefined ? undefined : gte(detection.observedAt, filter.observedFrom),
    filter.observedTo === undefined ? undefined : lt(detection.observedAt, filter.observedTo),
  ];
}

const ORDER = [asc(sql`"observed_at"`), asc(sql`"id"`)];

/**
 * Detections matching the filter, ordered by observation time then id (spec: Stable ordering).
 *
 * With a spatial filter the search is a `UNION ALL` of two branches (design D6), so each can
 * use an index: detections with their own point (detection GiST), and detections without one
 * matched by their capture's point (capture GiST, then `detection_capture_id_idx`). A single
 * `COALESCE(d.geom, c.geom)` predicate spans two tables and could use neither index.
 */
export function detectionSearchQuery(
  db: Database,
  filter: DetectionFilter,
  limit: number,
  after?: Cursor,
) {
  const common = commonPredicates(filter, after);
  const ownSpatial = spatialPredicate(detection.geom, filter);
  const captureSpatial = spatialPredicate(capture.geom, filter);

  if (ownSpatial === undefined || captureSpatial === undefined) {
    // No spatial filter: one query, effective location computed in SQL.
    return db
      .select({
        ...columns,
        cursorTs: cursorTimestamp,
        effectiveGeom: sql<unknown>`COALESCE(${detection.geom}, ${capture.geom})`.as(
          'effective_geom',
        ),
        locationSource:
          sql<LocationSource>`CASE WHEN ${detection.geom} IS NOT NULL THEN 'DETECTION' WHEN ${capture.geom} IS NOT NULL THEN 'CAPTURE' ELSE 'NONE' END`.as(
            'location_source',
          ),
      })
      .from(detection)
      .leftJoin(capture, eq(capture.id, detection.captureId))
      .where(and(...common))
      .orderBy(asc(detection.observedAt), asc(detection.id))
      .limit(limit);
  }

  const own = db
    .select({
      ...columns,
      cursorTs: cursorTimestamp,
      effectiveGeom: sql<unknown>`${detection.geom}`.as('effective_geom'),
      locationSource: sql<LocationSource>`'DETECTION'`.as('location_source'),
    })
    .from(detection)
    .where(and(isNotNull(detection.geom), ownSpatial, ...common));

  const fromCapture = db
    .select({
      ...columns,
      cursorTs: cursorTimestamp,
      effectiveGeom: sql<unknown>`${capture.geom}`.as('effective_geom'),
      locationSource: sql<LocationSource>`'CAPTURE'`.as('location_source'),
    })
    .from(detection)
    .innerJoin(capture, eq(capture.id, detection.captureId))
    .where(and(isNull(detection.geom), captureSpatial, ...common));

  return unionAll(own, fromCapture)
    .orderBy(...ORDER)
    .limit(limit);
}

/** Runs the search for one page of `first` hits, starting after `after` when given. */
export async function searchDetections(
  db: Database,
  filter: DetectionFilter,
  first: number,
  after?: Cursor,
): Promise<DetectionSearchPage> {
  // One extra row tells whether another page exists.
  const rows = await detectionSearchQuery(db, filter, first + 1, after);
  const hits = rows.slice(0, first).map(({ effectiveGeom, locationSource, cursorTs, ...row }) => ({
    row,
    location: decodePoint(effectiveGeom),
    locationSource,
    cursor: { kind: 'detection' as const, timestamp: cursorTs, id: row.id },
  }));
  return { hits, hasNextPage: rows.length > first };
}
