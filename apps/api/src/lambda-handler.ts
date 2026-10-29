import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import awsLambdaFastify from '@fastify/aws-lambda';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createAppDeps, createInfrastructure } from './infrastructure.js';

/** Settings the deployment keeps in Secrets Manager, never in the Lambda's environment. */
export const SECRET_SETTINGS = ['DATABASE_URL', 'DATABASE_SSL_CA', 'WORKER_TOKEN'] as const;

/** The one call the handler needs, so tests can pass a fake. */
export interface SecretSource {
  getSecretString(secretId: string): Promise<string>;
}

export function secretsManagerSource(client = new SecretsManagerClient({})): SecretSource {
  return {
    async getSecretString(secretId) {
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (result.SecretString === undefined) {
        throw new Error(`Secret ${secretId} has no string value`);
      }
      return result.SecretString;
    },
  };
}

/**
 * The environment with the settings from the secret named by `DATABASE_SECRET_ARN` merged in
 * (design D2). Only `SECRET_SETTINGS` are taken from the secret; error messages name the
 * secret or setting, never a value.
 */
export async function environmentWithSecrets(
  env: NodeJS.ProcessEnv,
  secrets: SecretSource,
): Promise<NodeJS.ProcessEnv> {
  const secretId = env.DATABASE_SECRET_ARN;
  if (!secretId) {
    return env;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await secrets.getSecretString(secretId));
  } catch (error) {
    throw new ConfigError([
      error instanceof SyntaxError
        ? 'DATABASE_SECRET_ARN is invalid (not JSON)'
        : 'DATABASE_SECRET_ARN could not be read',
    ]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(['DATABASE_SECRET_ARN is invalid (not a JSON object)']);
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_SETTINGS) {
    const value = (parsed as Record<string, unknown>)[name];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new ConfigError([`${name} in DATABASE_SECRET_ARN is invalid`]);
    }
    merged[name] = value;
  }
  return merged;
}

/** Builds the API the way `server.ts` does: config -> infrastructure -> `buildApp`. */
async function createDeployedApp(config: Config): Promise<FastifyInstance> {
  const infra = createInfrastructure(config);
  const app = await buildApp({
    ...createAppDeps(config, infra),
    logger: { level: config.LOG_LEVEL },
  });
  // Idle pool clients emit 'error' when a connection drops; the pool reconnects on next use.
  infra.pool.on('error', (err) => {
    app.log.warn({ err }, 'idle database connection lost');
  });
  return app;
}

export interface LambdaHandlerOptions {
  env?: NodeJS.ProcessEnv;
  secrets?: SecretSource;
  /** Replaces the deployed app, for tests. */
  createApp?: (config: Config) => Promise<FastifyInstance>;
}

/**
 * The API Gateway (HTTP API, payload v2) handler. Configuration, infrastructure and the app
 * are built once per execution environment and reused by every invocation (design D2).
 */
export async function createLambdaHandler(options: LambdaHandlerOptions = {}) {
  const env = await environmentWithSecrets(
    options.env ?? process.env,
    options.secrets ?? secretsManagerSource(),
  );
  const config = loadConfig(env);
  const app = await (options.createApp ?? createDeployedApp)(config);
  const handler = awsLambdaFastify(app);
  await app.ready();
  return handler;
}
