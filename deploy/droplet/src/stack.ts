import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/** The droplet's Compose stack started from its real files, with throwaway passwords. */
export interface DropletStack {
  environment: StartedDockerComposeEnvironment;
  passwords: Record<Role, string>;
  /** Host and loopback port that `db` publishes. */
  host: string;
  port: number;
  url(role: Role, database?: string): string;
  /** A connected client; the caller ends it. */
  connect(role: Role): Promise<pg.Client>;
  /** `docker inspect` port bindings of a service's container, e.g. `{ "5432/tcp": [...] }`. */
  portBindings(service: string): Record<string, { HostIp: string; HostPort: string }[]>;
  stop(): Promise<void>;
}

const secret = () => randomBytes(24).toString('base64url');

/** `docker compose up` of `compose.yaml` + `compose.test.yaml`, waiting for `db` to be healthy. */
export async function startDropletStack(): Promise<DropletStack> {
  const passwords: Record<Role, string> = {
    postgres: secret(),
    gis_owner: secret(),
    gis_app: secret(),
    gis_readonly: secret(),
  };
  const environment = await new DockerComposeEnvironment(DROPLET_DIR, [
    'compose.yaml',
    'compose.test.yaml',
  ])
    .withEnvironment({
      POSTGRES_SUPERUSER_PASSWORD: passwords.postgres,
      GIS_OWNER_PASSWORD: passwords.gis_owner,
      GIS_APP_PASSWORD: passwords.gis_app,
      GIS_READONLY_PASSWORD: passwords.gis_readonly,
      // A random loopback port, so the suite never collides with a local Compose stack.
      DB_HOST_PORT: '0',
    })
    .withWaitStrategy('db-1', Wait.forHealthCheck())
    .up();

  const host = '127.0.0.1';
  const port = environment.getContainer('db-1').getMappedPort(5432);
  const url = (role: Role, database = 'gis_vision') =>
    `postgres://${role}:${encodeURIComponent(passwords[role])}@${host}:${String(port)}/${database}`;

  return {
    environment,
    passwords,
    host,
    port,
    url,
    async connect(role) {
      const client = new pg.Client({ connectionString: url(role) });
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
    },
  };
}

/** Runs the API's real migrations (`apps/api/src/db/migrate-cli.ts`) as `gis_owner`. */
export function migrateAsOwner(stack: DropletStack): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/db/migrate-cli.ts'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: stack.url('gis_owner') },
    stdio: 'pipe',
  });
}
