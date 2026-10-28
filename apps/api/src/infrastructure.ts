import type { S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import type { BlobStore } from './blob/blob-store.js';
import { createS3Client, S3BlobStore } from './blob/s3-blob-store.js';
import type { AppDeps } from './app.js';
import { CaptureService } from './captures/capture-service.js';
import type { Config } from './config.js';
import { createDatabase, poolConfig, type Database } from './db/client.js';
import { AttributeValidator } from './detections/attribute-validator.js';
import { DetectionService } from './detections/detection-service.js';
import { PgDetectorRegistry } from './detectors/detector-registry.js';
import { schema } from './graphql/schema.js';
import { databaseCheck, objectStorageCheck } from './health/checks.js';
import type { HealthCheck } from './health/health.js';

/** Long-lived clients for external services, shared by the server and integration tests. */
export interface Infrastructure {
  pool: pg.Pool;
  db: Database;
  s3: S3Client;
  blobStore: BlobStore;
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
  const s3 = createS3Client(config);
  const blobStore = new S3BlobStore(s3, config.S3_BUCKET);

  return {
    pool,
    db: createDatabase(pool),
    s3,
    blobStore,
    healthChecks: [databaseCheck(pool), objectStorageCheck(blobStore)],
    async close() {
      await pool.end();
      s3.destroy();
    },
  };
}

/** Wires configuration and infrastructure into `buildApp` dependencies (server and integration tests). */
export function createAppDeps(config: Config, infra: Infrastructure): AppDeps {
  const registry = new PgDetectorRegistry(infra.db);
  return {
    healthChecks: infra.healthChecks,
    healthCheckTimeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
    captures: {
      service: new CaptureService({
        db: infra.db,
        blobStore: infra.blobStore,
        uploadUrlTtlSeconds: config.UPLOAD_URL_TTL_SECONDS,
        imageUrlTtlSeconds: config.IMAGE_URL_TTL_SECONDS,
      }),
      maxUploadBytes: config.UPLOAD_MAX_BYTES,
    },
    detectors: { registry },
    detections: {
      service: new DetectionService({
        db: infra.db,
        registry,
        validator: new AttributeValidator(),
      }),
    },
    graphql: { schema, graphiql: config.NODE_ENV !== 'production' },
  };
}
