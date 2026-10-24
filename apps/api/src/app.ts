import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { HealthCheck } from './health/health.js';
import { healthRoute } from './health/route.js';

export interface AppDeps {
  healthChecks: readonly HealthCheck[];
  healthCheckTimeoutMs: number;
  /** Pino logger options; `false` disables logging (useful in tests). */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds the Fastify application from its dependencies without starting it.
 * The same factory serves the local server, tests (`app.inject`) and, later, a Lambda handler.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? { level: 'info' },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  await app.register(healthRoute, {
    checks: deps.healthChecks,
    timeoutMs: deps.healthCheckTimeoutMs,
  });

  return app;
}
