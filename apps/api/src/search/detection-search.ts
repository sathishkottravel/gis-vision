import type { DetectionFilter } from '@gis-vision/schemas';
import { and, asc, eq, getTableColumns, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { decodePoint, spatialPredicate } from './spatial.js';

export type LocationSource = 'DETECTION' | 'CAPTURE' | 'NONE';

export type DetectionRow = typeof detection.$inferSelect;

/** A matching detection with its effective location (design D5, D6). */
export interface DetectionHit {
  row: DetectionRow;
  location: Point | null;
  locationSource: LocationSource;
}

export interface DetectionSearchPage {
  hits: DetectionHit[];
  hasNextPage: boolean;
}

const columns = getTableColumns(detection);

/** Predicates every branch shares (detector now; time and keyset come in F2.4/F2.5). */
function commonPredicates(filter: DetectionFilter): (SQL | undefined)[] {
  return [
    filter.detectorId === undefined ? undefined : eq(detection.detectorId, filter.detectorId),
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
export function detectionSearchQuery(db: Database, filter: DetectionFilter, limit: number) {
  const common = commonPredicates(filter);
  const ownSpatial = spatialPredicate(detection.geom, filter);
  const captureSpatial = spatialPredicate(capture.geom, filter);

  if (ownSpatial === undefined || captureSpatial === undefined) {
    // No spatial filter: one query, effective location computed in SQL.
    return db
      .select({
        ...columns,
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
      effectiveGeom: sql<unknown>`${detection.geom}`.as('effective_geom'),
      locationSource: sql<LocationSource>`'DETECTION'`.as('location_source'),
    })
    .from(detection)
    .where(and(isNotNull(detection.geom), ownSpatial, ...common));

  const fromCapture = db
    .select({
      ...columns,
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

/** Runs the search for one page of `first` hits. */
export async function searchDetections(
  db: Database,
  filter: DetectionFilter,
  first: number,
): Promise<DetectionSearchPage> {
  const rows = await detectionSearchQuery(db, filter, first + 1);
  const hits = rows.slice(0, first).map(({ effectiveGeom, locationSource, ...row }) => ({
    row,
    location: decodePoint(effectiveGeom),
    locationSource,
  }));
  return { hits, hasNextPage: rows.length > first };
}
