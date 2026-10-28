import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDatabaseConfig } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgres://gis:gis@localhost:5432/gis_vision',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'captures',
  S3_ACCESS_KEY_ID: 'rustfsadmin',
  S3_SECRET_ACCESS_KEY: 'rustfsadmin-secret',
  S3_FORCE_PATH_STYLE: 'true',
};

function loadError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      HEALTH_CHECK_TIMEOUT_MS: 2000,
      UPLOAD_MAX_BYTES: 10_485_760,
      UPLOAD_URL_TTL_SECONDS: 900,
      IMAGE_URL_TTL_SECONDS: 300,
      DATABASE_POOL_MAX: 5,
    });
    expect(config.DATABASE_SSL_CA).toBeUndefined();
  });

  it('coerces numeric settings', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('names missing required settings', () => {
    const error = loadError({ S3_BUCKET: 'captures' });

    expect(error.invalidSettings).toEqual(['DATABASE_URL is required']);
  });

  it('names malformed settings', () => {
    const error = loadError({
      ...validEnv,
      DATABASE_URL: 'mysql://localhost/db',
      PORT: 'not-a-port',
      S3_FORCE_PATH_STYLE: 'maybe',
    });

    expect(error.invalidSettings).toEqual([
      'PORT is invalid',
      'DATABASE_URL is invalid',
      'S3_FORCE_PATH_STYLE is invalid',
    ]);
  });

  it('never includes setting values in the error message', () => {
    const secretUrl = 'not a url with p@ssw0rd-secret';
    const error = loadError({ ...validEnv, DATABASE_URL: secretUrl, S3_ENDPOINT: 'p@ssw0rd' });

    expect(error.message).not.toContain('p@ssw0rd');
    expect(error.message).toContain('DATABASE_URL');
  });
});

describe('loadDatabaseConfig', () => {
  it('needs only DATABASE_URL, so migrations run without S3 settings', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: validEnv.DATABASE_URL })).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
    });
  });

  it('rejects a missing DATABASE_URL by name', () => {
    expect(() => loadDatabaseConfig({})).toThrow('DATABASE_URL is required');
  });
});

describe('database TLS and pool settings', () => {
  const pem = ['-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----'].join('\n');

  it('accepts a PEM CA, also with escaped newlines on one line', () => {
    expect(loadConfig({ ...validEnv, DATABASE_SSL_CA: `${pem}\n` }).DATABASE_SSL_CA).toBe(pem);
    const oneLine = pem.replaceAll('\n', String.raw`\n`);
    expect(oneLine).not.toContain('\n');
    expect(loadConfig({ ...validEnv, DATABASE_SSL_CA: oneLine }).DATABASE_SSL_CA).toBe(pem);
    expect(
      loadDatabaseConfig({ DATABASE_URL: validEnv.DATABASE_URL, DATABASE_SSL_CA: pem }),
    ).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      DATABASE_SSL_CA: pem,
    });
  });

  it('rejects a CA that is not a PEM certificate, without printing it', () => {
    const error = loadError({ ...validEnv, DATABASE_SSL_CA: 'not-a-cert-secret' });

    expect(error.invalidSettings).toEqual(['DATABASE_SSL_CA is invalid']);
    expect(error.message).not.toContain('not-a-cert-secret');
  });

  it('rejects sslmode in the URL together with a CA, since it would override the check', () => {
    const env = {
      ...validEnv,
      DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=require`,
      DATABASE_SSL_CA: pem,
    };

    expect(loadError(env).invalidSettings).toEqual(['DATABASE_URL is invalid']);
    expect(() => loadDatabaseConfig(env)).toThrow('DATABASE_URL is invalid');
  });

  it('bounds DATABASE_POOL_MAX to 1-100', () => {
    expect(loadConfig({ ...validEnv, DATABASE_POOL_MAX: '1' }).DATABASE_POOL_MAX).toBe(1);
    expect(loadError({ ...validEnv, DATABASE_POOL_MAX: '0' }).invalidSettings).toEqual([
      'DATABASE_POOL_MAX is invalid',
    ]);
  });
});
