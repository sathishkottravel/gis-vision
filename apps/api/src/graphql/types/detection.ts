import { builder } from '../builder.js';
import { toGeoJson } from './capture.js';
import { CaptureRef, DetectionRef, DetectorRef } from './refs.js';

const LocationSource = builder.enumType('LocationSource', {
  description: "Where a detection's effective `location` comes from.",
  values: {
    DETECTION: { description: "The detection's own point" },
    CAPTURE: { description: "Its capture's location (the detection has no own point)" },
    NONE: { description: 'Neither the detection nor its capture has a location' },
  } as const,
});

const BoundingBox = builder
  .objectRef<{ x: number; y: number; w: number; h: number }>('BoundingBox')
  .implement({
    description: 'Pixel bounding box in the capture image: top-left corner, width and height.',
    fields: (t) => ({
      x: t.exposeFloat('x'),
      y: t.exposeFloat('y'),
      w: t.exposeFloat('w'),
      h: t.exposeFloat('h'),
    }),
  });

DetectionRef.implement({
  description: 'Something a detector found in a capture, located in space and time.',
  fields: (t) => ({
    id: t.id({ resolve: (node) => node.row.id }),
    label: t.string({ resolve: (node) => node.row.label }),
    confidence: t.float({ nullable: true, resolve: (node) => node.row.confidence }),
    bbox: t.field({ type: BoundingBox, resolve: (node) => node.row.bboxPx }),
    location: t.field({
      type: 'GeoJSONPoint',
      nullable: true,
      description: "Effective location: its own point, else its capture's location.",
      resolve: (node) => (node.location ? toGeoJson(node.location) : null),
    }),
    locationSource: t.field({ type: LocationSource, resolve: (node) => node.locationSource }),
    observedAt: t.field({ type: 'DateTime', resolve: (node) => node.row.observedAt }),
    attributes: t.field({ type: 'JSON', resolve: (node) => node.row.attributes }),
    createdAt: t.field({ type: 'DateTime', resolve: (node) => node.row.createdAt }),
    capture: t.field({
      type: CaptureRef,
      resolve: async (node, _, ctx) => {
        const parent = await ctx.loaders.captureById.load(node.row.captureId);
        if (!parent) {
          throw new Error(`capture ${node.row.captureId} of detection ${node.row.id} is missing`);
        }
        return parent;
      },
    }),
    detector: t.field({
      type: DetectorRef,
      resolve: async (node, _, ctx) => {
        const found = await ctx.loaders.detectorById.load(node.row.detectorId);
        if (!found) {
          throw new Error(`detector ${node.row.detectorId} of detection ${node.row.id} is missing`);
        }
        return found;
      },
    }),
  }),
});
