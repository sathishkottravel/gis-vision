import type { z } from 'zod';
import { badUserInput } from './errors.js';

/** GraphQL passes explicit `null` for omitted-by-intent fields; Zod's `.optional()` wants `undefined`. */
export function withoutNulls(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(withoutNulls);
  }
  // Only plain objects (input objects); Dates from the DateTime scalar pass through as they are.
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  }
  return value;
}

/**
 * Parses one argument with a shared Zod schema, or throws `BAD_USER_INPUT` whose issue paths
 * start with the argument name, e.g. `filter.bbox.south` or `first` (design D9).
 */
export function parseArg<T extends z.ZodType>(name: string, schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(withoutNulls(value));
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({
    path: [name, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
  throw badUserInput(`Invalid ${issues.map((issue) => issue.path).join(', ')}`, issues);
}
