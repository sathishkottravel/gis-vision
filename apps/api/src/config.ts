import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * PEM CA certificate for database TLS (Deploy v0, design D4). When set, connections use TLS
   * and verify the server certificate against it. Escaped `\n` are accepted for one-line values.
   */
  DATABASE_SSL_CA: z
    .string()
    .transform((pem) => pem.replaceAll(String.raw`\n`, '\n').trim())
    .refine((pem) => pem.startsWith('-----BEGIN CERTIFICATE-----'))
    .optional(),
  /** Connections per process: 1 on Lambda, where one instance serves one request at a time. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  /** Largest image accepted by `POST /captures` (default 10 MiB). */
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Lifetime of the presigned upload URL (design D4a: about 15 minutes). */
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Lifetime of the presigned `imageUrl` on ready captures. */
  IMAGE_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Config = z.infer<typeof configSchema>;

/** The subset needed by tooling that only talks to the database, such as `db:migrate`. */
const databaseConfigSchema = configSchema.pick({ DATABASE_URL: true, DATABASE_SSL_CA: true });

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly invalidSettings: string[]) {
    super(`Invalid configuration: ${invalidSettings.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates configuration from environment variables.
 * Error messages name the offending settings but never include their values,
 * so secrets cannot leak into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseEnv(withTlsCheck(configSchema), env);
}

/** Like `loadConfig`, but validates only the database settings. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return parseEnv(withTlsCheck(databaseConfigSchema), env);
}

/**
 * node-pg applies `sslmode`/`sslrootcert` from the URL over the `ssl` option, which would
 * silently drop the CA check, so a URL carrying them is invalid together with DATABASE_SSL_CA.
 */
function withTlsCheck<T extends z.ZodType<{ DATABASE_URL: string; DATABASE_SSL_CA?: string }>>(
  schema: T,
) {
  return schema.superRefine((config, ctx) => {
    // Runs even when DATABASE_URL itself failed validation; that issue is reported already.
    if (!config.DATABASE_SSL_CA || !URL.canParse(config.DATABASE_URL)) {
      return;
    }
    const params = new URL(config.DATABASE_URL).searchParams;
    if (params.has('sslmode') || params.has('sslrootcert')) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'conflicts with DATABASE_SSL_CA',
      });
    }
  });
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const settings = result.error.issues.map((issue) => {
    const name = issue.path.join('.');
    // Check the environment directly: Zod omits `issue.input` unless `reportInput` is set.
    return env[name] === undefined ? `${name} is required` : `${name} is invalid`;
  });
  throw new ConfigError([...new Set(settings)]);
}
