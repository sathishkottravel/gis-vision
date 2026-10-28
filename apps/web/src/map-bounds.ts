/** The API's `BoundingBoxInput`: WGS84 degrees, `west > east` crosses the antimeridian. */
export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Longitude into [-180, 180); values already inside are returned unchanged (no float drift). */
function wrapWest(x: number): number {
  return x >= -180 && x < 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180;
}

/** Longitude into (-180, 180], so a view ending exactly on the antimeridian keeps east = 180. */
function wrapEast(x: number): number {
  const wrapped = wrapWest(x);
  return wrapped === -180 ? 180 : wrapped;
}

const clampLatitude = (y: number) => Math.min(90, Math.max(-90, y));

/**
 * Turns the map's visible bounds into a search box (design D11). MapLibre reports
 * unwrapped longitudes when the view is panned across the antimeridian or onto another
 * copy of the world, e.g. west 170 / east 190. Those are wrapped into ±180; if west then
 * exceeds east the box crosses the antimeridian, which the API accepts as is. A view at
 * least 360° wide covers every longitude, so it returns `undefined` (no spatial filter).
 */
export function normalizeBounds(bounds: BoundingBox): BoundingBox | undefined {
  if (bounds.east - bounds.west >= 360) {
    return undefined;
  }
  return {
    west: wrapWest(bounds.west),
    south: clampLatitude(bounds.south),
    east: wrapEast(bounds.east),
    north: clampLatitude(bounds.north),
  };
}
