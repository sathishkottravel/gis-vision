import { z } from 'zod';

/** GeoJSON Point in WGS84 (SRID 4326): `[longitude, latitude]`, as it crosses both APIs. */
export const geoJsonPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});

export type GeoJsonPoint = z.infer<typeof geoJsonPointSchema>;
