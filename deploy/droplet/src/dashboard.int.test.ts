import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAsOwner, startDropletStack, type DropletStack } from './stack.js';

/** The SQLSTATE a statement fails with, or `undefined` when it succeeds. */
async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Specs hosted-deployment, "No public admin surfaces" and "Least-privilege database access"
// (dashboard role); design D5. Task 3.1.
describe('droplet data dashboard (F2.5.3)', () => {
  let stack: DropletStack;

  beforeAll(async () => {
    stack = await startDropletStack({ dashboard: true });
    migrateAsOwner(stack);
  }, 300_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('publishes pgAdmin on the loopback interface only', () => {
    const bindings = stack.portBindings('pgadmin');

    expect(Object.keys(bindings)).toEqual(['80/tcp']);
    expect(bindings['80/tcp']?.map((b) => b.HostIp)).toEqual(['127.0.0.1']);
  });

  it('serves the login page through the loopback port', async () => {
    const port = stack.environment.getContainer('pgadmin-1').getMappedPort(80);
    const res = await fetch(`http://127.0.0.1:${String(port)}/login`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pgAdmin');
  });

  it('connects to db exactly as servers.json says: verify-full with the CA, as gis_readonly', async () => {
    // pgAdmin's own Python and psycopg, inside its container, with the preloaded server entry.
    const script = [
      'import json, psycopg',
      "s = json.load(open('/pgadmin4/servers.json'))['Servers']['1']",
      "p = s['ConnectionParameters']",
      "c = psycopg.connect(host=s['Host'], port=s['Port'], dbname=s['MaintenanceDB'], user=s['Username'], password=__import__('os').environ['PW'], sslmode=p['sslmode'], sslrootcert=p['sslrootcert'])",
      "print(c.execute('SELECT current_user, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()').fetchone())",
    ].join('\n');
    const result = await stack.environment
      .getContainer('pgadmin-1')
      .exec(['/venv/bin/python3', '-c', script], { env: { PW: stack.passwords.gis_readonly } });

    expect(result.exitCode, result.output).toBe(0);
    expect(result.stdout.trim()).toBe("('gis_readonly', True)");
  });

  describe('gis_readonly', () => {
    it('reads the application tables', async () => {
      const readonly = await stack.connect('gis_readonly');
      try {
        const { rows } = await readonly.query<{ id: string }>('SELECT id FROM detector');
        expect(rows).toEqual([{ id: 'manual' }]);
        await readonly.query('SELECT count(*) FROM capture');
        await readonly.query('SELECT count(*) FROM detection');
      } finally {
        await readonly.end();
      }
    });

    it.each([
      [
        'INSERT',
        `INSERT INTO detector (id, name, kind, output_schema) VALUES ('x', 'x', 'manual', '{}')`,
      ],
      ['UPDATE', `UPDATE detector SET name = 'changed' WHERE id = 'manual'`],
      ['DELETE', `DELETE FROM detector WHERE id = 'manual'`],
      ['CREATE TABLE', 'CREATE TABLE intruder (id int)'],
    ])('cannot %s', async (_, sql) => {
      const readonly = await stack.connect('gis_readonly');
      try {
        expect(await errorCode(() => readonly.query(sql))).toBe('42501');
      } finally {
        await readonly.end();
      }
    });
  });
});
