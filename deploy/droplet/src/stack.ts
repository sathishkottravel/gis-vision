import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';

const DROPLET_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = fileURLToPath(new URL('../../../apps/api', import.meta.url));

export type Role = 'postgres' | 'gis_owner' | 'gis_app' | 'gis_readonly';
/** `db` is Postgres on its loopback port; `pgbouncer` is the public pooler port. */
export type Endpoint = 'db' | 'pgbouncer';

/** The droplet's Compose stack started from its real files, with throwaway passwords. */
export interface DropletStack {
  environment: StartedDockerComposeEnvironment;
  passwords: Record<Role, string>;
  host: string;
  ports: Record<Endpoint, number>;
  /** PEM of the stack's private CA (scripts/make-certs.sh). */
  ca: string;
  url(role: Role, endpoint?: Endpoint): string;
  /** Connects with verified TLS (or `tls: false` for plaintext); the caller ends the client. */
  connect(
    role: Role,
    options?: { endpoint?: Endpoint; tls?: boolean; ca?: string },
  ): Promise<pg.Client>;
  /** `docker inspect` port bindings of a service's container, e.g. `{ "5432/tcp": [...] }`. */
  portBindings(service: string): Record<string, { HostIp: string; HostPort: string }[]>;
  stop(): Promise<void>;
}

const secret = () => randomBytes(24).toString('base64url');

/** Git Bash on Windows (Node would pick WSL's bash.exe from System32), plain bash elsewhere. */
function bashPath(): string {
  if (process.platform !== 'win32') {
    return 'bash';
  }
  const gitCore = execFileSync('git', ['--exec-path']).toString().trim();
  return join(dirname(dirname(dirname(gitCore))), 'bin', 'bash.exe');
}

/** Runs one of `scripts/*.sh` from the droplet folder, as an operator would. */
export function runScript(script: string, args: string[], env: Record<string, string>): string {
  return execFileSync(bashPath(), [`scripts/${script}`, ...args], {
    cwd: DROPLET_DIR,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  }).toString();
}

/** A CA (and server certificate) from a separate `make-certs.sh` run, unrelated to any stack. */
export function makeUnrelatedCa(): string {
  const volume = `droplet-test-other-${randomBytes(4).toString('hex')}`;
  const outDir = mkdtempSync(join(tmpdir(), 'droplet-other-ca-'));
  try {
    runScript('make-certs.sh', ['127.0.0.1'], { SECRETS_VOLUME: volume, OUT_DIR: outDir });
    return readFileSync(join(outDir, 'ca.crt'), 'utf8');
  } finally {
    execFileSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'pipe' });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Follows the README's order: `make-certs.sh` into a fresh secrets volume, `up db`,
 * `make-userlist.sh`, then `up pgbouncer`. Ports are random and bound as in production.
 */
export async function startDropletStack(): Promise<DropletStack> {
  const passwords: Record<Role, string> = {
    postgres: secret(),
    gis_owner: secret(),
    gis_app: secret(),
    gis_readonly: secret(),
  };
  const run = randomBytes(4).toString('hex');
  const secretsVolume = `droplet-test-secrets-${run}`;
  const outDir = mkdtempSync(join(tmpdir(), 'droplet-certs-'));
  runScript('make-certs.sh', ['127.0.0.1'], { SECRETS_VOLUME: secretsVolume, OUT_DIR: outDir });
  const ca = readFileSync(join(outDir, 'ca.crt'), 'utf8');

  const compose = new DockerComposeEnvironment(DROPLET_DIR, ['compose.yaml', 'compose.test.yaml'])
    .withProjectName(`droplet-test-${run}`)
    .withEnvironment({
      POSTGRES_SUPERUSER_PASSWORD: passwords.postgres,
      GIS_OWNER_PASSWORD: passwords.gis_owner,
      GIS_APP_PASSWORD: passwords.gis_app,
      GIS_READONLY_PASSWORD: passwords.gis_readonly,
      SECRETS_VOLUME: secretsVolume,
      // Random host ports, so the suite never collides with a local Compose stack.
      DB_HOST_PORT: '0',
      PGBOUNCER_HOST_PORT: '0',
    })
    .withWaitStrategy('db-1', Wait.forHealthCheck())
    .withWaitStrategy('pgbouncer-1', Wait.forHealthCheck());

  const dbEnvironment = await compose.up(['db']);
  runScript('make-userlist.sh', [], {
    SECRETS_VOLUME: secretsVolume,
    DB_CONTAINER: dbEnvironment.getContainer('db-1').getId(),
    PGBOUNCER_CONTAINER: '',
  });
  const environment = await compose.up(['pgbouncer']);

  const host = '127.0.0.1';
  const ports: Record<Endpoint, number> = {
    db: dbEnvironment.getContainer('db-1').getMappedPort(5432),
    pgbouncer: environment.getContainer('pgbouncer-1').getMappedPort(6432),
  };
  const url = (role: Role, endpoint: Endpoint = 'db') =>
    `postgres://${role}:${encodeURIComponent(passwords[role])}@${host}:${String(ports[endpoint])}/gis_vision`;

  return {
    environment,
    passwords,
    host,
    ports,
    ca,
    url,
    async connect(role, options = {}) {
      const client = new pg.Client({
        connectionString: url(role, options.endpoint),
        ...(options.tls === false
          ? {}
          : { ssl: { ca: options.ca ?? ca, rejectUnauthorized: true } }),
      });
      await client.connect();
      return client;
    },
    portBindings(service) {
      const id = environment.getContainer(`${service}-1`).getId();
      const json = execFileSync('docker', [
        'inspect',
        '--format',
        '{{json .HostConfig.PortBindings}}',
        id,
      ]).toString();
      return JSON.parse(json) as Record<string, { HostIp: string; HostPort: string }[]>;
    },
    async stop() {
      await environment.down({ removeVolumes: true });
      execFileSync('docker', ['volume', 'rm', '-f', secretsVolume], { stdio: 'pipe' });
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

/** Runs the API's real migrations (`apps/api/src/db/migrate-cli.ts`) as `gis_owner`, over TLS. */
export function migrateAsOwner(stack: DropletStack): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/db/migrate-cli.ts'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: stack.url('gis_owner'), DATABASE_SSL_CA: stack.ca },
    stdio: 'pipe',
  });
}
