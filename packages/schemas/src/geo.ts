import { z } from 'zod';

const longitude = z.number().min(-180).max(180);
const latitude = z.number().min(-90).max(90);

/** GeoJSON Point in WGS84 (SRID 4326): `[longitude, latitude]`, as it crosses both APIs. */
export const geoJsonPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([longitude, latitude]),
});

export type GeoJsonPoint = z.infer<typeof geoJsonPointSchema>;

/**
 * Bounding box in WGS84 degrees, edges included. `west > east` means the box crosses the
 * antimeridian and covers `west..180` plus `-180..east` (spec geo-temporal-query).
 */
export const geoBoundingBoxSchema = z
  .object({ west: longitude, south: latitude, east: longitude, north: latitude })
  .refine((box) => box.south <= box.north, {
    path: ['south'],
    message: 'south must not be north of north',
  });

export type GeoBoundingBox = z.infer<typeof geoBoundingBoxSchema>;

/** True when the box wraps around the antimeridian (`west > east`). */
export function crossesAntimeridian(box: GeoBoundingBox): boolean {
  return box.west > box.east;
}

export const MAX_RADIUS_METERS = 50_000;

/** A circle on the earth's surface: geodesic distance from `center`, boundary included. */
export const nearSchema = z.object({
  center: geoJsonPointSchema,
  radiusMeters: z.number().positive().max(MAX_RADIUS_METERS),
});

export type Near = z.infer<typeof nearSchema>;

/**
 * A time bound: a `Date` (GraphQL's `DateTime` scalar parses to one) or an ISO 8601 string
 * with offset (REST and the web app). Either way it comes out as a `Date`.
 */
export const instantSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);

/**
 * Half-open time range `[from, to)`: either bound may be omitted, and when both are given
 * `from` must be earlier than `to` (spec geo-temporal-query: Detection time range).
 */
export function timeRangeSchema<From extends string, To extends string>(from: From, to: To) {
  return z
    .object({ [from]: instantSchema.optional(), [to]: instantSchema.optional() } as Record<
      From | To,
      z.ZodOptional<typeof instantSchema>
    >)
    .refine(
      (range) => {
        const start = (range as Record<string, Date | undefined>)[from];
        const end = (range as Record<string, Date | undefined>)[to];
        return start === undefined || end === undefined || start < end;
      },
      { path: [to], message: `${to} must be later than ${from}` },
    );
}

/** Detection search filter: all given conditions apply, and at most one of `bbox` or `near`. */
export const detectionFilterSchema = z
  .object({
    bbox: geoBoundingBoxSchema.optional(),
    near: nearSchema.optional(),
    detectorId: z.string().min(1).optional(),
  })
  .and(timeRangeSchema('observedFrom', 'observedTo'))
  .refine((filter) => filter.bbox === undefined || filter.near === undefined, {
    path: ['near'],
    message: 'use either bbox or near, not both',
  });

export type DetectionFilter = z.infer<typeof detectionFilterSchema>;

/** Capture search filter over the capture's own location and capture time. */
export const captureFilterSchema = z
  .object({ bbox: geoBoundingBoxSchema.optional() })
  .and(timeRangeSchema('capturedFrom', 'capturedTo'));

export type CaptureFilter = z.infer<typeof captureFilterSchema>;

export const SEARCH_PAGE_SIZE = { default: 50, max: 100 } as const;

/** `first` of a search connection: 1-100, default 50. */
export const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(SEARCH_PAGE_SIZE.max)
  .default(SEARCH_PAGE_SIZE.default);
