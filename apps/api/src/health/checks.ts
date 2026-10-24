import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import type { HealthCheck } from './health.js';

export function databaseCheck(pool: Pool): HealthCheck {
  return {
    name: 'database',
    async check() {
      await pool.query('SELECT 1');
    },
  };
}

// Replaced by a BlobStore-based check in F1.3 (task 9.4).
export function objectStorageCheck(s3: S3Client, bucket: string): HealthCheck {
  return {
    name: 'objectStorage',
    async check(signal) {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
    },
  };
}
