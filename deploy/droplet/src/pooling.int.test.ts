import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUnrelatedCa, migrateAsOwner, startDropletStack, type DropletStack } from './stack.js';

/** `default_pool_size` in pgbouncer/pgbouncer.ini. */
const POOL_SIZE = 10;

// Specs hosted-deployment, "Verified TLS for database connections" and "Pooled database
// connections"; design D4, D5.
describe('droplet connection pooling and TLS (F2.5.2)', () => {
  let stack: DropletStack;
  let unrelatedCa: string;

  beforeAll(async () => {
    stack = await startDropletStack();
    migrateAsOwner(stack);
    unrelatedCa = makeUnrelatedCa();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('serves gis_app over verified TLS with the database-default search path', async () => {
    const app = await stack.connect('gis_app', { endpoint: 'pgbouncer' });
    try {
      const { rows } = await app.query<{ user: string; search_path: string }>(
        `SELECT current_user AS user, current_setting('search_path') AS search_path`,
      );
      expect(rows).toEqual([{ user: 'gis_app', search_path: 'public, extensions' }]);
    } finally {
      await app.end();
    }
  });

  it('encrypts the PgBouncer-to-Postgres connections too', async () => {
    const app = await stack.connect('gis_app', { endpoint: 'pgbouncer' });
    try {
      const { rows } = await app.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      expect(rows).toEqual([{ ssl: true }]);
    } finally {
      await app.end();
    }
  });

  it('refuses a plaintext connection before authentication', async () => {
    await expect(
      stack.connect('gis_app', { endpoint: 'pgbouncer', tls: false }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/SSL required/) as string });
  });

  it('fails the TLS handshake for a client trusting a different CA', async () => {
    await expect(
      stack.connect('gis_app', { endpoint: 'pgbouncer', ca: unrelatedCa }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CERT|SIGNATURE/) as string });
  });

  it('rejects a wrong password', async () => {
    const wrong = stack
      .url('gis_app', 'pgbouncer')
      .replace(encodeURIComponent(stack.passwords.gis_app), 'wrong-password');
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: wrong,
      ssl: { ca: stack.ca, rejectUnauthorized: true },
    });

    await expect(client.connect()).rejects.toMatchObject({ code: '28P01' });
  });

  it('runs 50 concurrent clients on at most the pool size of server connections', async () => {
    const owner = await stack.connect('gis_owner');
    let peak = 0;
    const sampler = { running: true };
    const sampling = (async () => {
      while (sampler.running) {
        const { rows } = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'gis_app'`,
        );
        peak = Math.max(peak, rows[0]?.n ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          const client = await stack.connect('gis_app', { endpoint: 'pgbouncer' });
          try {
            const { rows } = await client.query<{ i: number }>(
              'SELECT $1::int AS i FROM pg_sleep(0.3)',
              [i],
            );
            return rows[0]?.i;
          } finally {
            await client.end();
          }
        }),
      );

      expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(POOL_SIZE);
    } finally {
      sampler.running = false;
      await sampling;
      await owner.end();
    }
  });

  it('publishes PgBouncer on all interfaces and Postgres on loopback only', () => {
    expect(stack.portBindings('pgbouncer')['6432/tcp']?.map((b) => b.HostIp)).toEqual(['']);
    expect(stack.portBindings('db')['5432/tcp']?.map((b) => b.HostIp)).toEqual(['127.0.0.1']);
  });
});
