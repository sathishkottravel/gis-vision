import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationApp } from './integration-app.js';

describe('integration harness', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('migrates the shared database: PostGIS is in the extensions schema', async () => {
    const { rows } = await ctx.infra.pool.query<{ schema: string }>(
      `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'postgis'`,
    );

    expect(rows).toEqual([{ schema: 'extensions' }]);
  });

  it('resolves PostGIS functions without schema qualification', async () => {
    const { rows } = await ctx.infra.pool.query<{ wkt: string }>(
      'SELECT ST_AsText(ST_MakePoint(13.4, 52.5)) AS wkt',
    );

    expect(rows[0]?.wkt).toBe('POINT(13.4 52.5)');
  });

  it('creates the captures bucket', async () => {
    await expect(
      ctx.infra.s3.send(new HeadBucketCommand({ Bucket: ctx.config.S3_BUCKET })),
    ).resolves.toBeDefined();
  });
});
