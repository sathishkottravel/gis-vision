import { readFile } from 'node:fs/promises';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Environment variables (same names as `.env`) pointing at the test containers. */
    integrationEnv: Record<string, string>;
  }
}

// Same images and PostGIS init as docker-compose.yml.
const POSTGIS_IMAGE = 'postgis/postgis:17-3.6';
const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.3';
const INIT_SQL = new URL('../../../../docker/db/initdb/10_postgis.sql', import.meta.url);

const S3_ACCESS_KEY = 'test-access-key';
const S3_SECRET_KEY = 'test-secret-key';
const S3_BUCKET = 'captures';
const S3_REGION = 'us-east-1';

/**
 * Starts PostGIS and RustFS once per integration run and exposes their connection
 * settings via `inject('integrationEnv')`. Returns the teardown that stops both.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const initSql = await readFile(INIT_SQL, 'utf8');

  const [db, rustfs] = await Promise.all([
    new PostgreSqlContainer(POSTGIS_IMAGE)
      .withDatabase('gis_vision')
      .withUsername('gis')
      .withPassword('gis')
      .withCopyContentToContainer([
        // Neutralise the image's own init script, which installs PostGIS into `public`.
        {
          content: '#!/bin/sh\n# Replaced by 10_postgis.sql\n',
          target: '/docker-entrypoint-initdb.d/10_postgis.sh',
        },
        { content: initSql, target: '/docker-entrypoint-initdb.d/10_postgis.sql' },
      ])
      .start(),
    new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({ RUSTFS_ACCESS_KEY: S3_ACCESS_KEY, RUSTFS_SECRET_KEY: S3_SECRET_KEY })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
      .start(),
  ]);

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
