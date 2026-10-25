import { S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import type { Config } from './config.js';
import { createDatabase, poolConfig, type Database } from './db/client.js';
import { databaseCheck, objectStorageCheck } from './health/checks.js';
import type { HealthCheck } from './health/health.js';

/** Long-lived clients for external services, shared by the server and integration tests. */
export interface Infrastructure {
  pool: pg.Pool;
  db: Database;
  s3: S3Client;
  healthChecks: HealthCheck[];
  close(): Promise<void>;
}

export function createInfrastructure(config: Config): Infrastructure {
  const pool = new pg.Pool(
    poolConfig(config.DATABASE_URL, {
      max: 5,
      connectionTimeoutMillis: config.HEALTH_CHECK_TIMEOUT_MS,
    }),
  );

  const s3 = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  return {
    pool,
    db: createDatabase(pool),
    s3,
    healthChecks: [databaseCheck(pool), objectStorageCheck(s3, config.S3_BUCKET)],
    async close() {
      await pool.end();
      s3.destroy();
    },
  };
}
