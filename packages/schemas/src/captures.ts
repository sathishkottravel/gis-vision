import { z } from 'zod';
import { geoJsonPointSchema } from './geo.js';

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const captureStatusSchema = z.enum(['pending', 'ready']);

export interface CaptureLimits {
  /** Largest accepted upload, from the API's `UPLOAD_MAX_BYTES` setting. */
  maxBytes: number;
}

/** Body of `POST /captures`. The size limit is configuration, so the schema is built from it. */
export function createCaptureRequestSchema(limits: CaptureLimits) {
  return z.object({
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    byteSize: z.number().int().positive().max(limits.maxBytes),
    /** ISO 8601 with offset; defaults to the creation time. */
    capturedAt: z.iso.datetime({ offset: true }).optional(),
    location: geoJsonPointSchema.optional(),
  });
}

export type CreateCaptureRequest = z.infer<ReturnType<typeof createCaptureRequestSchema>>;

/** A capture as returned by the API. `imageUrl` is present only once the capture is `ready`. */
export const captureSchema = z.object({
  id: z.uuid(),
  status: captureStatusSchema,
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  byteSize: z.number().int().positive(),
  capturedAt: z.iso.datetime({ offset: true }),
  location: geoJsonPointSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  imageUrl: z.url().optional(),
});

export type Capture = z.infer<typeof captureSchema>;

/** Response of `POST /captures`: the pending capture plus where and how to upload the image. */
export const createCaptureResponseSchema = captureSchema.extend({
  uploadUrl: z.url(),
  /** Headers the upload must send unchanged (they are part of the URL's signature). */
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});

export type CreateCaptureResponse = z.infer<typeof createCaptureResponseSchema>;

export const CAPTURE_PAGE_SIZE = { default: 20, max: 100 } as const;

/** Query of `GET /captures`. */
export const listCapturesQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CAPTURE_PAGE_SIZE.max)
    .default(CAPTURE_PAGE_SIZE.default),
});

export const captureListSchema = z.object({ items: z.array(captureSchema) });

export type CaptureList = z.infer<typeof captureListSchema>;
