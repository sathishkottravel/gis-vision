import { z } from 'zod';
import { geoJsonPointSchema } from './geo.js';

/** Pixel bounding box in the capture image: top-left corner plus width and height. */
export const boundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export type BoundingBox = z.infer<typeof boundingBoxSchema>;

/** Detector-specific payload; its shape is checked against the detector's output schema. */
export const detectionAttributesSchema = z.record(z.string(), z.unknown());

/** Body of `POST /captures/:id/detections`. */
export const createDetectionRequestSchema = z.object({
  detectorId: z.string().min(1),
  label: z.string().trim().min(1).max(200),
  confidence: z.number().min(0).max(1).optional(),
  bbox: boundingBoxSchema,
  /** Defaults to the capture's location (which may be absent). */
  location: geoJsonPointSchema.optional(),
  /** ISO 8601 with offset; defaults to the capture's capture time. */
  observedAt: z.iso.datetime({ offset: true }).optional(),
  attributes: detectionAttributesSchema.default({}),
});

export type CreateDetectionRequest = z.infer<typeof createDetectionRequestSchema>;

/**
 * A detection as returned by the API. `location` is the effective location: the detection's
 * own point, or the capture's when the detection has none.
 */
export const detectionSchema = z.object({
  id: z.uuid(),
  captureId: z.uuid(),
  detectorId: z.string(),
  label: z.string(),
  confidence: z.number().nullable(),
  bbox: boundingBoxSchema,
  location: geoJsonPointSchema.nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  attributes: detectionAttributesSchema,
  createdAt: z.iso.datetime({ offset: true }),
});

export type Detection = z.infer<typeof detectionSchema>;

export const detectionListSchema = z.object({ items: z.array(detectionSchema) });
