import { describe, expect, it } from 'vitest';
import { poolConfig, SEARCH_PATH } from './client.js';

describe('poolConfig', () => {
  const url = 'postgres://gis:gis@localhost:5432/gis_vision';

  it('puts the extensions schema on every connection search path', () => {
    expect(SEARCH_PATH).toContain('extensions');
    expect(poolConfig(url)).toMatchObject({
      connectionString: url,
      options: '-c search_path=public,extensions',
    });
  });

  it('keeps pool overrides but never lets them replace the search path or URL', () => {
    const config = poolConfig(url, {
      max: 5,
      options: '-c search_path=public',
      connectionString: 'postgres://other/db',
    });

    expect(config).toMatchObject({
      max: 5,
      connectionString: url,
      options: '-c search_path=public,extensions',
    });
  });

  it('verifies the server certificate against DATABASE_SSL_CA when one is given', () => {
    const ca = ['-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----'].join('\n');

    expect(poolConfig(url, {}, ca).ssl).toEqual({ ca, rejectUnauthorized: true });
    expect(poolConfig(url)).not.toHaveProperty('ssl');
  });
});
