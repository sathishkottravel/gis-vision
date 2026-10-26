import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createAppDeps, createInfrastructure } from './infrastructure.js';

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
const infra = createInfrastructure(config);

const app = await buildApp({
  ...createAppDeps(config, infra),
  logger: { level: config.LOG_LEVEL },
});

// Idle pool clients emit 'error' when Postgres drops their connection (e.g. a restart).
// Without a listener Node treats it as unhandled and exits; the pool reconnects on next use.
infra.pool.on('error', (err) => {
  app.log.warn({ err }, 'idle database connection lost');
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await infra.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
