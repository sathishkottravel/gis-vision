import { crossesAntimeridian, type GeoBoundingBox, type Near } from '@gis-vision/schemas';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { parseEwkbPoint, WGS84, type Point } from '../db/geometry.js';

function envelope(west: number, south: number, east: number, north: number): SQL {
  return sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, ${WGS84})`;
}

/**
 * `geom` lies in the box, edges included. For points `&&` (bounding-box overlap) is exact and
 * uses the geometry GiST index. A box across the antimeridian becomes two envelopes.
 */
export function inBoundingBox(geom: SQLWrapper, box: GeoBoundingBox): SQL {
  if (crossesAntimeridian(box)) {
    return sql`(${geom} && ${envelope(box.west, box.south, 180, box.north)} OR ${geom} && ${envelope(-180, box.south, box.east, box.north)})`;
  }
  return sql`${geom} && ${envelope(box.west, box.south, box.east, box.north)}`;
}

/**
 * Geodesic distance from the center at most `radiusMeters`, boundary included. The
 * `geom::geography` expression matches the `*_geog_gist` indexes of migration
 * 0004_geography-indexes, so keep the two in step.
 */
export function withinRadius(geom: SQLWrapper, near: Near): SQL {
  const [lon, lat] = near.center.coordinates;
  const center = sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), ${WGS84})::geography`;
  return sql`ST_DWithin((${geom})::geography, ${center}, ${near.radiusMeters})`;
}

/** The spatial predicate for whichever filter is set, or `undefined` for none. */
export function spatialPredicate(
  geom: SQLWrapper,
  filter: { bbox?: GeoBoundingBox | undefined; near?: Near | undefined },
): SQL | undefined {
  if (filter.bbox) {
    return inBoundingBox(geom, filter.bbox);
  }
  if (filter.near) {
    return withinRadius(geom, filter.near);
  }
  return undefined;
}

/** Decodes a point selected through raw SQL (EWKB hex, as the `pointGeometry` column does). */
export function decodePoint(value: unknown): Point | null {
  return typeof value === 'string' ? parseEwkbPoint(value) : null;
}
