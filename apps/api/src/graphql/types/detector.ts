import { asc } from 'drizzle-orm';
import { detector } from '../../db/schema.js';
import { builder } from '../builder.js';
import { DetectorRef } from './refs.js';

// Same values as REST (`manual`, `ml`), so clients can use either API interchangeably.
const DetectorKind = builder.enumType('DetectorKind', {
  values: {
    manual: { value: 'manual', description: 'A human annotating captures' },
    ml: { value: 'ml', description: 'An automated model' },
  } as const,
});

DetectorRef.implement({
  description: 'Records detections on captures and declares the JSON Schema of their attributes.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Slug, e.g. `manual`' }),
    name: t.exposeString('name'),
    version: t.exposeInt('version'),
    kind: t.field({ type: DetectorKind, resolve: (row) => row.kind }),
    outputSchema: t.field({
      type: 'JSON',
      description: 'JSON Schema (supported subset) for the `attributes` of its detections',
      resolve: (row) => row.outputSchema,
    }),
  }),
});

builder.queryFields((t) => ({
  detectors: t.field({
    type: [DetectorRef],
    description: 'Every registered detector, ordered by id.',
    resolve: (_, __, ctx) => ctx.db.select().from(detector).orderBy(asc(detector.id)),
  }),
  detector: t.field({
    type: DetectorRef,
    nullable: true,
    description: 'A detector by id; `null` if it does not exist.',
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, { id }, ctx) => ctx.loaders.detectorById.load(id),
  }),
}));
