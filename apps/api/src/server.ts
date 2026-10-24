import { S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { databaseCheck, objectStorageCheck } from './health/checks.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Settings are named, values are never printed.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: config.HEALTH_CHECK_TIMEOUT_MS,
});

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

const app = await buildApp({
  healthChecks: [databaseCheck(pool), objectStorageCheck(s3, config.S3_BUCKET)],
  healthCheckTimeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
  logger: { level: config.LOG_LEVEL },
});

// Idle pool clients emit 'error' when Postgres drops their connection (e.g. a restart).
// Without a listener Node treats it as unhandled and exits; the pool reconnects on next use.
pool.on('error', (err) => {
  app.log.warn({ err }, 'idle database connection lost');
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  s3.destroy();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
