import type { FastifyPluginCallback } from 'fastify';
import { runHealthChecks, type HealthCheck } from './health.js';

export interface HealthRouteOptions {
  checks: readonly HealthCheck[];
  timeoutMs: number;
}

const statusField = { type: 'string', enum: ['ok', 'error'] } as const;

// `additionalProperties: false` makes the serializer drop anything beyond the status
// fields, so error details can never reach the response body.
const healthResponse = {
  type: 'object',
  required: ['status', 'database', 'objectStorage'],
  additionalProperties: false,
  properties: { status: statusField, database: statusField, objectStorage: statusField },
} as const;

export const healthRoute: FastifyPluginCallback<HealthRouteOptions> = (app, opts, done) => {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponse, 503: healthResponse } } },
    async (request, reply) => {
      const { report, failures } = await runHealthChecks(opts.checks, opts.timeoutMs);
      for (const failure of failures) {
        request.log.warn({ dependency: failure.name, err: failure.error }, 'health check failed');
      }
      return reply.code(report.status === 'ok' ? 200 : 503).send(report);
    },
  );
  done();
};
