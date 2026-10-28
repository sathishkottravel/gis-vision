import { captureFilterSchema, detectionFilterSchema, pageSizeSchema } from '@gis-vision/schemas';
import { searchCaptures } from '../../search/capture-search.js';
import { decodeCursor, encodeCursor, type Cursor } from '../../search/cursor.js';
import { searchDetections } from '../../search/detection-search.js';
import { parseArg } from '../args.js';
import { builder } from '../builder.js';
import { badUserInput } from '../errors.js';
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
  endCursor: string | null;
}

interface Edge<T> {
  node: T;
  cursor: string;
}

interface ConnectionShape<T> {
  edges: Edge<T>[];
  pageInfo: PageInfoShape;
}

const PageInfo = builder.objectRef<PageInfoShape>('PageInfo').implement({
  description: 'Where a page ends (forward pagination only).',
  fields: (t) => ({
    hasNextPage: t.exposeBoolean('hasNextPage'),
    endCursor: t.string({
      nullable: true,
      description:
        'Cursor of the last edge; pass it as `after` for the next page. `null` on an empty page.',
      resolve: (info) => info.endCursor,
    }),
  }),
});

// Forward-only connections: `edges { node cursor }` and `pageInfo` (spec: Cursor pagination).
// The relay plugin's connections always add `before`/`last`, which this API does not support.
const DetectionEdge = builder.objectRef<Edge<DetectionNode>>('DetectionEdge').implement({
  fields: (t) => ({
    node: t.field({ type: DetectionRef, resolve: (edge) => edge.node }),
    cursor: t.exposeString('cursor'),
  }),
});

const DetectionConnection = builder
  .objectRef<ConnectionShape<DetectionNode>>('DetectionConnection')
  .implement({
    fields: (t) => ({
      edges: t.field({ type: [DetectionEdge], resolve: (page) => page.edges }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });

const CaptureEdge = builder.objectRef<Edge<CaptureRow>>('CaptureEdge').implement({
  fields: (t) => ({
    node: t.field({ type: CaptureRef, resolve: (edge) => edge.node }),
    cursor: t.exposeString('cursor'),
  }),
});

const CaptureConnection = builder
  .objectRef<ConnectionShape<CaptureRow>>('CaptureConnection')
  .implement({
    fields: (t) => ({
      edges: t.field({ type: [CaptureEdge], resolve: (page) => page.edges }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });

/** Builds a connection from hits that each carry their keyset cursor. */
function toConnection<T>(
  items: { node: T; cursor: Cursor }[],
  hasNextPage: boolean,
): ConnectionShape<T> {
  const edges = items.map((item) => ({ node: item.node, cursor: encodeCursor(item.cursor) }));
  return { edges, pageInfo: { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null } };
}

/** Decodes `after`, or throws `BAD_USER_INPUT` on `after` for a cursor this search did not issue. */
function parseAfter(after: string | null | undefined, kind: Cursor['kind']): Cursor | undefined {
  if (after === null || after === undefined) {
    return undefined;
  }
  const cursor = decodeCursor(after, kind);
  if (!cursor) {
    throw badUserInput('Invalid after', [
      { path: 'after', message: 'is not a cursor returned by this field' },
    ]);
  }
  return cursor;
}

const AFTER_DESCRIPTION =
  'Continue after this cursor (an `endCursor` or edge `cursor` from this field).';

builder.queryFields((t) => ({
  detections: t.field({
    type: DetectionConnection,
    description: 'Detections matching the filter, ordered by observation time, then id.',
    args: {
      filter: t.arg({ type: DetectionFilter }),
      first: t.arg.int({ description: 'Page size, 1-100 (default 50).' }),
      after: t.arg.string({ description: AFTER_DESCRIPTION }),
    },
    resolve: async (_, args, ctx) => {
      const filter = parseArg('filter', detectionFilterSchema, args.filter ?? {});
      const first = parseArg('first', pageSizeSchema, args.first);
      const after = parseAfter(args.after, 'detection');
      const page = await searchDetections(ctx.db, filter, first, after);
      return toConnection(
        page.hits.map((hit) => ({ node: hit, cursor: hit.cursor })),
        page.hasNextPage,
      );
    },
  }),
  captures: t.field({
    type: CaptureConnection,
    description: 'Captures matching the filter, newest first.',
    args: {
      filter: t.arg({ type: CaptureFilter }),
      first: t.arg.int({ description: 'Page size, 1-100 (default 50).' }),
      after: t.arg.string({ description: AFTER_DESCRIPTION }),
    },
    resolve: async (_, args, ctx) => {
      const filter = parseArg('filter', captureFilterSchema, args.filter ?? {});
      const first = parseArg('first', pageSizeSchema, args.first);
      const after = parseAfter(args.after, 'capture');
      const page = await searchCaptures(ctx.db, filter, first, after);
      return toConnection(
        page.hits.map((hit) => ({ node: hit.row, cursor: hit.cursor })),
        page.hasNextPage,
      );
    },
  }),
}));
