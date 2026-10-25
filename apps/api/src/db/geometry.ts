import { customType } from 'drizzle-orm/pg-core';

/** A WGS84 position: `x` is longitude, `y` is latitude. */
export interface Point {
  x: number;
  y: number;
}

export const WGS84 = 4326;

// Flag set in the EWKB geometry type when an SRID follows it.
const EWKB_SRID_FLAG = 0x20000000;
const WKB_POINT = 1;

/**
 * Decodes a 2D point from the hex EWKB that PostGIS returns for `geometry` values.
 * Throws for anything that isn't a 2D point.
 */
export function parseEwkbPoint(hex: string): Point {
  const bytes = Buffer.from(hex, 'hex');
  const littleEndian = bytes.readUInt8(0) === 1;
  const type = littleEndian ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
  if ((type & 0xffff) !== WKB_POINT || (type & ~EWKB_SRID_FLAG) !== WKB_POINT) {
    throw new Error(`expected a 2D point, got EWKB type 0x${type.toString(16)}`);
  }
  const offset = type & EWKB_SRID_FLAG ? 9 : 5;
  const read = (at: number) => (littleEndian ? bytes.readDoubleLE(at) : bytes.readDoubleBE(at));
  return { x: read(offset), y: read(offset + 8) };
}

/**
 * `geometry(Point, 4326)`. Drizzle's built-in `geometry()` column drops the SRID
 * (DDL `geometry(point)`, values written with SRID 0), so points use this type instead.
 */
export const pointGeometry = customType<{ data: Point; driverData: string }>({
  dataType: () => `geometry(Point, ${String(WGS84)})`,
  toDriver: ({ x, y }) => `SRID=${String(WGS84)};POINT(${String(x)} ${String(y)})`,
  fromDriver: parseEwkbPoint,
});
