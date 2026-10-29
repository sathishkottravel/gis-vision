import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { ConfigError, type Config } from './config.js';
import {
  createLambdaHandler,
  environmentWithSecrets,
  type SecretSource,
} from './lambda-handler.js';

const baseEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://placeholder@localhost:5432/gis_vision',
  S3_BUCKET: 'captures',
  S3_REGION: 'eu-central-1',
};

const pem = ['-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----'].join('\n');

/** A secret source returning `value` and recording which secret was read. */
function fakeSecrets(value: string): SecretSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getSecretString(secretId) {
      reads.push(secretId);
      return Promise.resolve(value);
    },
  };
}

/** A minimal API Gateway HTTP API (payload v2) event. */
function httpApiEvent(method: string, path: string) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'api.example.test', accept: 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'api.example.test',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '29/Oct/2026:10:00:00 +0000',
      timeEpoch: 1_793_268_000_000,
    },
    isBase64Encoded: false,
  };
}

describe('environmentWithSecrets', () => {
  const secretArn = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:gis-vision-db';

  it('returns the environment unchanged without DATABASE_SECRET_ARN', async () => {
    const secrets = fakeSecrets('{}');

    expect(await environmentWithSecrets(baseEnv, secrets)).toBe(baseEnv);
    expect(secrets.reads).toEqual([]);
  });

  it('lets the secret override the environment, for its own settings only', async () => {
    const secrets = fakeSecrets(
      JSON.stringify({
        DATABASE_URL: 'postgres://gis_app:from-secret@db.example.test:6432/gis_vision',
        DATABASE_SSL_CA: pem,
        WORKER_TOKEN: 'token-from-secret',
        NODE_ENV: 'development',
      }),
    );

    const env = await environmentWithSecrets(
      { ...baseEnv, DATABASE_SECRET_ARN: secretArn },
      secrets,
    );

    expect(secrets.reads).toEqual([secretArn]);
    expect(env).toMatchObject({
      DATABASE_URL: 'postgres://gis_app:from-secret@db.example.test:6432/gis_vision',
      DATABASE_SSL_CA: pem,
      WORKER_TOKEN: 'token-from-secret',
      // Not a secret setting: the environment wins.
      NODE_ENV: 'production',
    });
  });

  it.each([
    ['not JSON', 'p@ssw0rd-not-json', 'DATABASE_SECRET_ARN is invalid (not JSON)'],
    ['a JSON array', '["p@ssw0rd"]', 'DATABASE_SECRET_ARN is invalid (not a JSON object)'],
    [
      'a non-string setting',
      '{"DATABASE_URL": {"password": "p@ssw0rd"}}',
      'DATABASE_URL in DATABASE_SECRET_ARN is invalid',
    ],
  ])('rejects a secret that is %s without printing its value', async (_, value, message) => {
    const error = await environmentWithSecrets(
      { ...baseEnv, DATABASE_SECRET_ARN: secretArn },
      fakeSecrets(value),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).invalidSettings).toEqual([message]);
    expect((error as Error).message).not.toContain('p@ssw0rd');
  });

  it('reports an unreadable secret by name only', async () => {
    const secrets: SecretSource = {
      getSecretString: () => Promise.reject(new Error('AccessDenied for p@ssw0rd')),
    };

    const error = await environmentWithSecrets(
      { ...baseEnv, DATABASE_SECRET_ARN: secretArn },
      secrets,
    ).catch((e: unknown) => e);

    expect((error as ConfigError).invalidSettings).toEqual([
      'DATABASE_SECRET_ARN could not be read',
    ]);
  });
});

describe('createLambdaHandler', () => {
  it('answers an API Gateway v2 GET /health through the app built from the secret', async () => {
    const configs: Config[] = [];
    const handler = await createLambdaHandler({
      env: { ...baseEnv, DATABASE_SECRET_ARN: 'secret' },
      secrets: fakeSecrets(
        JSON.stringify({ DATABASE_URL: 'postgres://gis_app:x@db.example.test:6432/gis_vision' }),
      ),
      createApp: (config) => {
        configs.push(config);
        return buildApp({
          healthChecks: [{ name: 'database', check: () => Promise.resolve() }],
          healthCheckTimeoutMs: 100,
          logger: false,
        });
      },
    });

    const response = await handler(httpApiEvent('GET', '/health'), {});

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok', database: 'ok' });
    expect(configs).toHaveLength(1);
    expect(configs[0]?.DATABASE_URL).toBe('postgres://gis_app:x@db.example.test:6432/gis_vision');
    expect(configs[0]?.NODE_ENV).toBe('production');
  });

  it('builds the app once and reuses it across invocations', async () => {
    let builds = 0;
    const handler = await createLambdaHandler({
      env: baseEnv,
      secrets: fakeSecrets('{}'),
      createApp: () => {
        builds += 1;
        return buildApp({ healthChecks: [], healthCheckTimeoutMs: 100, logger: false });
      },
    });

    await handler(httpApiEvent('GET', '/health'), {});
    await handler(httpApiEvent('GET', '/health'), {});

    expect(builds).toBe(1);
  });
});
