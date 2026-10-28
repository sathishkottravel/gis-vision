import type { FastifyBaseLogger } from 'fastify';

/** Per-request GraphQL context (design D2); F2.2 adds the database and loaders. */
export interface GraphQLContext {
  log: FastifyBaseLogger;
  requestId: string;
}
