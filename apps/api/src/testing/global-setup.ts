import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { poolConfig } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Environment variables (same names as `.env`) pointing at the test containers. */
    integrationEnv: Record<string, string>;
  }
}

// Same images as docker-compose.yml.
const POSTGIS_IMAGE = 'postgis/postgis:17-3.6';
const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.3';

const S3_ACCESS_KEY = 'test-access-key';
const S3_SECRET_KEY = 'test-secret-key';
const S3_BUCKET = 'captures';
const S3_REGION = 'us-east-1';

/**
 * Starts PostGIS and RustFS once per integration run, applies the database migrations,
 * creates the bucket and exposes connection settings via `inject('integrationEnv')`. Returns the teardown that stops both.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [db, rustfs] = await Promise.all([
    new PostgreSqlContainer(POSTGIS_IMAGE)
      .withDatabase('gis_vision')
      .withUsername('gis')
      .withPassword('gis')
      .withCopyContentToContainer([
        // Neutralise the image's own init script, which installs PostGIS into `public`.
        // The migrations install it into `extensions` instead (design D8).
        {
          content: '#!/bin/sh\n# PostGIS is installed by the database migrations.\n',
          target: '/docker-entrypoint-initdb.d/10_postgis.sh',
        },
      ])
      .start(),
    new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({ RUSTFS_ACCESS_KEY: S3_ACCESS_KEY, RUSTFS_SECRET_KEY: S3_SECRET_KEY })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
      .start(),
  ]);

  const pool = new pg.Pool(poolConfig(db.getConnectionUri(), { max: 1 }));
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  const s3Endpoint = `http://${rustfs.getHost()}:${String(rustfs.getMappedPort(9000))}`;
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });
  await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  s3.destroy();

  project.provide('integrationEnv', {
    NODE_ENV: 'test',
    DATABASE_URL: db.getConnectionUri(),
    S3_ENDPOINT: s3Endpoint,
    S3_REGION,
    S3_BUCKET,
    S3_ACCESS_KEY_ID: S3_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: S3_SECRET_KEY,
    S3_FORCE_PATH_STYLE: 'true',
  });

  return async () => {
    await Promise.all([db.stop(), rustfs.stop()]);
  };
}
