import type { Plugin } from 'graphql-yoga';
import { GraphQLError, type ExecutionResult } from 'graphql';
import { RequestError } from '../errors.js';
import type { GraphQLContext } from './context.js';

const INTERNAL_MESSAGE = 'Unexpected error.';

/**
 * Maps one execution error to what the client sees (design D9). Bad input and domain errors
 * keep their code and issues; anything else is masked and returned to the caller for logging.
 */
export function mapExecutionError(error: GraphQLError): {
  error: GraphQLError;
  unexpected: boolean;
} {
  const original = error.originalError;
  if (original instanceof RequestError) {
    return {
      unexpected: false,
      error: new GraphQLError(original.message, {
        nodes: error.nodes,
        path: error.path,
        extensions: {
          code: original.statusCode === 400 ? 'BAD_USER_INPUT' : original.code,
          ...(original.issues ? { issues: original.issues } : {}),
        },
      }),
    };
  }
  // Thrown on purpose by resolvers or scalars (e.g. `badUserInput`), or a GraphQL-level error.
  if (original === undefined || original instanceof GraphQLError) {
    return { unexpected: false, error };
  }
  return {
    unexpected: true,
    error: new GraphQLError(INTERNAL_MESSAGE, {
      nodes: error.nodes,
      path: error.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    }),
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Applies `mapExecutionError` to every execution result and logs each masked error with the
 * request id through Fastify's logger. Replaces Yoga's built-in masking, which has no access
 * to the request context.
 */
export function useErrorMapping(): Plugin<GraphQLContext> {
  return {
    onExecute({ args }) {
      const context = args.contextValue as GraphQLContext;
      return {
        onExecuteDone({ result, setResult }) {
          if (isAsyncIterable(result)) {
            return;
          }
          // Envelop types the result loosely; graphql-js always reports GraphQLErrors here.
          const reported = (result as ExecutionResult).errors ?? [];
          if (reported.length === 0) {
            return;
          }
          const errors = reported.map((error: GraphQLError) => {
            const mapped = mapExecutionError(error);
            if (mapped.unexpected) {
              context.log.error(
                { err: error.originalError, path: error.path, reqId: context.requestId },
                'graphql resolver failed',
              );
            }
            return mapped.error;
          });
          setResult({ ...result, errors } satisfies ExecutionResult);
        },
      };
    },
  };
}
