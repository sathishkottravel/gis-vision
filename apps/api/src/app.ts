import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { captureRoutes, type CaptureRouteOptions } from './captures/routes.js';
import type { HealthCheck } from './health/health.js';
import { healthRoute } from './health/route.js';
import { errorHandler } from './http/error-handler.js';

export interface AppDeps {
  healthChecks: readonly HealthCheck[];
  healthCheckTimeoutMs: number;
  /** Capture upload routes; omitted by tests that only exercise `/health`. */
  captures?: CaptureRouteOptions;
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
  app.setErrorHandler(errorHandler);

  await app.register(healthRoute, {
    checks: deps.healthChecks,
    timeoutMs: deps.healthCheckTimeoutMs,
  });
  if (deps.captures) {
    await app.register(captureRoutes, deps.captures);
  }

  return app;
}
