import type { z } from 'zod';

/** A request field that failed validation, e.g. `{ path: 'location.coordinates.1', ... }`. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** Errors the HTTP layer maps to 4xx responses (see `http/error-handler.ts`). */
export abstract class RequestError extends Error {
  abstract readonly statusCode: number;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends RequestError {
  readonly statusCode = 400;

  constructor(readonly issues: FieldIssue[]) {
    super('invalid_request', `Invalid ${issues.map((issue) => issue.path || 'body').join(', ')}`);
  }
}

export class NotFoundError extends RequestError {
  readonly statusCode = 404;

  constructor(message: string) {
    super('not_found', message);
  }
}

export class ConflictError extends RequestError {
  readonly statusCode = 409;
}

/** Parses `value` with `schema`, or throws a `ValidationError` naming each failing field. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new ValidationError(
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}
