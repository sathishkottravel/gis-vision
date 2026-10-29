import pg from 'pg';
import { ConfigError, loadDatabaseConfig } from '../config.js';
import { poolConfig } from './client.js';
import { runMigrations } from './migrate.js';

try {
  const { DATABASE_URL, DATABASE_SSL_CA } = loadDatabaseConfig();
  const pool = new pg.Pool(poolConfig(DATABASE_URL, { max: 1 }, DATABASE_SSL_CA));
  try {
    await runMigrations(pool);
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
} catch (error) {
  // Settings are named, values are never printed.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
}
