import { GraphQLError } from 'graphql';
import type { FieldIssue } from '../errors.js';

/** `BAD_USER_INPUT` with the failing fields, mirroring REST's `error.issues` (design D9). */
export function badUserInput(message: string, issues: FieldIssue[] = []): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', issues } });
}
