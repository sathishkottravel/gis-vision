import { captureFilterSchema, detectionFilterSchema, pageSizeSchema } from '@gis-vision/schemas';
import { searchCaptures } from '../../search/capture-search.js';
import { searchDetections } from '../../search/detection-search.js';
import { parseArg } from '../args.js';
import { builder } from '../builder.js';
import type { CaptureRow } from '../loaders.js';
import { CaptureRef, DetectionRef, type DetectionNode } from './refs.js';

const BoundingBoxInput = builder.inputType('BoundingBoxInput', {
  description:
    'WGS84 degrees, edges included. `west > east` crosses the antimeridian (west..180 and -180..east).',
  fields: (t) => ({
    west: t.float({ required: true }),
    south: t.float({ required: true }),
    east: t.float({ required: true }),
    north: t.float({ required: true }),
  }),
});

const NearInput = builder.inputType('NearInput', {
  description: 'Geodesic distance from `center` in meters, boundary included (at most 50,000).',
  fields: (t) => ({
    center: t.field({ type: 'GeoJSONPoint', required: true }),
    radiusMeters: t.float({ required: true }),
  }),
});

const DetectionFilter = builder.inputType('DetectionFilter', {
  description:
    'All given conditions apply. Spatial filters use the effective location; at most one of `bbox` and `near`.',
  fields: (t) => ({
    bbox: t.field({ type: BoundingBoxInput }),
    near: t.field({ type: NearInput }),
    detectorId: t.id(),
    observedFrom: t.field({ type: 'DateTime', description: 'Observed at or after (inclusive).' }),
    observedTo: t.field({ type: 'DateTime', description: 'Observed before (exclusive).' }),
  }),
});

const CaptureFilter = builder.inputType('CaptureFilter', {
  description:
    'Spatial filters use the capture location; captures without one never match. The time range is half-open.',
  fields: (t) => ({
    bbox: t.field({ type: BoundingBoxInput }),
    capturedFrom: t.field({ type: 'DateTime', description: 'Captured at or after (inclusive).' }),
    capturedTo: t.field({ type: 'DateTime', description: 'Captured before (exclusive).' }),
  }),
});

interface PageInfoShape {
  hasNextPage: boolean;
}

const PageInfo = builder.objectRef<PageInfoShape>('PageInfo').implement({
  description: 'Where a page ends (forward pagination only).',
  fields: (t) => ({
    hasNextPage: t.exposeBoolean('hasNextPage'),
  }),
});

// Forward-only connections: `edges { node }` and `pageInfo` (spec: Cursor pagination). The
// relay plugin's connections always add `before`/`last`, which this API does not support.
const DetectionEdge = builder.objectRef<{ node: DetectionNode }>('DetectionEdge').implement({
  fields: (t) => ({ node: t.field({ type: DetectionRef, resolve: (edge) => edge.node }) }),
});

const DetectionConnection = builder
  .objectRef<{ edges: { node: DetectionNode }[]; pageInfo: PageInfoShape }>('DetectionConnection')
  .implement({
    fields: (t) => ({
      edges: t.field({ type: [DetectionEdge], resolve: (page) => page.edges }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });

const CaptureEdge = builder.objectRef<{ node: CaptureRow }>('CaptureEdge').implement({
  fields: (t) => ({ node: t.field({ type: CaptureRef, resolve: (edge) => edge.node }) }),
});

const CaptureConnection = builder
  .objectRef<{ edges: { node: CaptureRow }[]; pageInfo: PageInfoShape }>('CaptureConnection')
  .implement({
    fields: (t) => ({
      edges: t.field({ type: [CaptureEdge], resolve: (page) => page.edges }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });

builder.queryFields((t) => ({
  detections: t.field({
    type: DetectionConnection,
    description: 'Detections matching the filter, ordered by observation time, then id.',
    args: {
      filter: t.arg({ type: DetectionFilter }),
      first: t.arg.int({ description: 'Page size, 1-100 (default 50).' }),
    },
    resolve: async (_, args, ctx) => {
      const filter = parseArg('filter', detectionFilterSchema, args.filter ?? {});
      const first = parseArg('first', pageSizeSchema, args.first);
      const page = await searchDetections(ctx.db, filter, first);
      return {
        edges: page.hits.map((hit) => ({ node: hit })),
        pageInfo: { hasNextPage: page.hasNextPage },
      };
    },
  }),
  captures: t.field({
    type: CaptureConnection,
    description: 'Captures matching the filter, newest first.',
    args: {
      filter: t.arg({ type: CaptureFilter }),
      first: t.arg.int({ description: 'Page size, 1-100 (default 50).' }),
    },
    resolve: async (_, args, ctx) => {
      const filter = parseArg('filter', captureFilterSchema, args.filter ?? {});
      const first = parseArg('first', pageSizeSchema, args.first);
      const page = await searchCaptures(ctx.db, filter, first);
      return {
        edges: page.rows.map((row) => ({ node: row })),
        pageInfo: { hasNextPage: page.hasNextPage },
      };
    },
  }),
}));
