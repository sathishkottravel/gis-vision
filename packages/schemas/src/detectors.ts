import { z } from 'zod';

export const detectorKindSchema = z.enum(['manual', 'ml']);

/** A detector as listed by `GET /detectors`. */
export const detectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  kind: detectorKindSchema,
});

export type Detector = z.infer<typeof detectorSchema>;

export const detectorListSchema = z.object({ items: z.array(detectorSchema) });

/**
 * The JSON Schema subset detector output schemas may use (design: JSON Forms must render
 * every detector form). An object schema whose properties are primitives, enums of
 * primitives, or arrays of primitives. Anything else (`$ref`, nested objects, `oneOf`, ...)
 * is rejected, because every schema is a strict object that allows only the keywords below.
 */
const annotations = {
  title: z.string().optional(),
  description: z.string().optional(),
};

const primitiveValue = z.union([z.string(), z.number(), z.boolean()]);

const stringProperty = z.strictObject({
  ...annotations,
  type: z.literal('string'),
  enum: z.array(z.string()).min(1).optional(),
  default: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.string().optional(),
});

const numericProperty = z.strictObject({
  ...annotations,
  type: z.enum(['number', 'integer']),
  enum: z.array(z.number()).min(1).optional(),
  default: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const booleanProperty = z.strictObject({
  ...annotations,
  type: z.literal('boolean'),
  default: z.boolean().optional(),
});

const primitiveProperty = z.discriminatedUnion('type', [
  stringProperty,
  numericProperty,
  booleanProperty,
]);

const arrayProperty = z.strictObject({
  ...annotations,
  type: z.literal('array'),
  items: primitiveProperty,
  default: z.array(primitiveValue).optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
});

export const detectorOutputSchemaSchema = z
  .strictObject({
    $schema: z.literal('https://json-schema.org/draft/2020-12/schema').optional(),
    ...annotations,
    type: z.literal('object'),
    properties: z.record(z.string().min(1), z.union([primitiveProperty, arrayProperty])).optional(),
    required: z.array(z.string()).optional(),
    /** `true` allows free-form attributes (the `manual` detector); a schema is not supported. */
    additionalProperties: z.boolean().optional(),
  })
  .superRefine((schema, ctx) => {
    for (const [index, name] of (schema.required ?? []).entries()) {
      if (!Object.hasOwn(schema.properties ?? {}, name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['required', index],
          message: `required property "${name}" is not declared in properties`,
        });
      }
    }
  });

/** A detector output schema that conforms to the supported subset. */
export type DetectorOutputSchema = z.infer<typeof detectorOutputSchemaSchema>;

/** Why a schema falls outside the supported subset, e.g. `properties.size: ...`. */
export interface SchemaSubsetIssue {
  path: string;
  message: string;
}

/** Checks a detector output schema against the supported subset; an empty list means it conforms. */
export function checkDetectorSchema(schema: unknown): SchemaSubsetIssue[] {
  const result = detectorOutputSchemaSchema.safeParse(schema);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
