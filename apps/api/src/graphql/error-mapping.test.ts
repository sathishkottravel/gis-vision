import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { mapExecutionError } from './error-mapping.js';
import { badUserInput } from './errors.js';

/** A resolver error as graphql-js reports it: wrapped, with the thrown value as `originalError`. */
function resolverError(thrown: Error): GraphQLError {
  return new GraphQLError(thrown.message, { path: ['field'], originalError: thrown });
}

describe('mapExecutionError', () => {
  it('maps a ValidationError to BAD_USER_INPUT with its issues', () => {
    const issues = [{ path: 'filter.bbox.south', message: 'must not exceed north' }];

    const { error, unexpected } = mapExecutionError(resolverError(new ValidationError(issues)));

    expect(unexpected).toBe(false);
    expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', issues });
    expect(error.path).toEqual(['field']);
  });

  it.each([
    ['NotFoundError', new NotFoundError('Capture x does not exist'), 'not_found'],
    ['ConflictError', new ConflictError('capture_not_ready', 'pending'), 'capture_not_ready'],
  ])('keeps the code of a %s', (_, thrown, code) => {
    const { error, unexpected } = mapExecutionError(resolverError(thrown));

    expect(unexpected).toBe(false);
    expect(error.extensions.code).toBe(code);
    expect(error.message).toBe(thrown.message);
  });

  it('keeps a GraphQLError thrown on purpose', () => {
    const thrown = badUserInput('Invalid cursor', [{ path: 'after', message: 'unknown cursor' }]);

    const { error, unexpected } = mapExecutionError(resolverError(thrown));

    expect(unexpected).toBe(false);
    expect(error.extensions).toMatchObject({ code: 'BAD_USER_INPUT' });
  });

  it('keeps a GraphQL-level error without an original error', () => {
    const plain = new GraphQLError('Cannot query field "nope" on type "Query".');

    expect(mapExecutionError(plain)).toEqual({ error: plain, unexpected: false });
  });

  it('masks anything else as INTERNAL_SERVER_ERROR without its details', () => {
    const thrown = new Error('relation "detection" does not exist: SELECT * FROM detection');

    const { error, unexpected } = mapExecutionError(resolverError(thrown));

    expect(unexpected).toBe(true);
    expect(error.message).toBe('Unexpected error.');
    expect(error.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
    expect(JSON.stringify(error.toJSON())).not.toContain('SELECT');
  });
});
