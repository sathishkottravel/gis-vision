import type { Pool } from 'pg';
import type { BlobStore } from '../blob/blob-store.js';
import type { HealthCheck } from './health.js';

export function databaseCheck(pool: Pool): HealthCheck {
  return {
    name: 'database',
    async check() {
      await pool.query('SELECT 1');
    },
  };
}

export function objectStorageCheck(blobStore: BlobStore): HealthCheck {
  return {
    name: 'objectStorage',
    check: (signal) => blobStore.checkAvailable(signal),
  };
}
