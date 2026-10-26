import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createAppDeps, createInfrastructure, type Infrastructure } from '../infrastructure.js';

/** Config pointing at the containers started by the integration global setup. */
export function integrationConfig(): Config {
  return loadConfig(inject('integrationEnv'));
}

export interface IntegrationApp {
  app: FastifyInstance;
  infra: Infrastructure;
  config: Config;
}

/**
 * Builds the app exactly as `server.ts` does (config -> infrastructure -> buildApp),
 * but against the test containers and without starting a listener. Use `app.inject`
 * for requests; `app.close()` also closes the database pool and S3 client.
 */
export async function buildIntegrationApp(): Promise<IntegrationApp> {
  const config = integrationConfig();
  const infra = createInfrastructure(config);
  const app = await buildApp({ ...createAppDeps(config, infra), logger: false });
  app.addHook('onClose', () => infra.close());
  return { app, infra, config };
}
