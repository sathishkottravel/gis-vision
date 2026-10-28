import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { RequestError } from '../errors.js';

/** Body of every error response. `issues` lists the failing fields of a 400 or 422. */
export interface ErrorBody {
  error: { code: string; message: string; issues?: { path: string; message: string }[] };
}

/**
 * Maps errors to one response shape. Domain `RequestError`s keep their status and code,
 * Fastify's own 4xx errors (malformed JSON, unsupported media type) keep their status,
 * and anything else becomes a 500 whose details are only logged, never returned.
 */
export function errorHandler(
  error: FastifyError | RequestError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof RequestError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    if (error.issues) {
      body.error.issues = error.issues;
    }
    return reply.code(error.statusCode).send(body);
  }
  const status = error.statusCode ?? 500;
  if (status < 500) {
    return reply.code(status).send({ error: { code: 'invalid_request', message: error.message } });
  }
  request.log.error({ err: error }, 'request failed');
  return reply
    .code(500)
    .send({ error: { code: 'internal_error', message: 'Internal server error' } });
}
