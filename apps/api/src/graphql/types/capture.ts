import type { Point } from '../../db/geometry.js';
import { builder } from '../builder.js';
import { CaptureRef, DetectionRef, toDetectionNode } from './refs.js';

// Same values as REST (`pending`, `ready`).
const CaptureStatus = builder.enumType('CaptureStatus', {
  values: {
    pending: { value: 'pending', description: 'Created; the image upload is not verified yet' },
    ready: { value: 'ready', description: 'The image is uploaded and verified' },
  } as const,
});

export function toGeoJson(point: Point) {
  return { type: 'Point' as const, coordinates: [point.x, point.y] as [number, number] };
}

CaptureRef.implement({
  description: 'An uploaded image with its capture time and optional location.',
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.field({ type: CaptureStatus, resolve: (row) => row.status }),
    contentType: t.exposeString('contentType'),
    byteSize: t.exposeInt('byteSize'),
    capturedAt: t.field({ type: 'DateTime', resolve: (row) => row.capturedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (row) => row.createdAt }),
    location: t.field({
      type: 'GeoJSONPoint',
      nullable: true,
      resolve: (row) => (row.geom ? toGeoJson(row.geom) : null),
    }),
    imageUrl: t.string({
      nullable: true,
      description: 'Time-limited download URL; `null` while the capture is `pending`.',
      resolve: async (row, _, ctx) => {
        if (row.status !== 'ready') {
          return null;
        }
        const image = await ctx.blobStore.presignGet(row.blobKey, {
          expiresInSeconds: ctx.imageUrlTtlSeconds,
        });
        return image.url;
      },
    }),
    detections: t.field({
      type: [DetectionRef],
      description: 'Detections on this capture, ordered by observation time.',
      resolve: async (row, _, ctx) => {
        const detections = await ctx.loaders.detectionsByCaptureId.load(row.id);
        return detections.map((detection) => toDetectionNode(detection, row.geom));
      },
    }),
  }),
});

builder.queryFields((t) => ({
  capture: t.field({
    type: CaptureRef,
    nullable: true,
    description: 'A capture by id; `null` if it does not exist or the id is not a UUID.',
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, { id }, ctx) => ctx.loaders.captureById.load(id),
  }),
}));
