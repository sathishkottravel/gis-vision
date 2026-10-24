import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { DependencyName, HealthCheck } from './health.js';

const healthy = (name: DependencyName): HealthCheck => ({ name, check: () => Promise.resolve() });

const failing = (name: DependencyName, message: string): HealthCheck => ({
  name,
  check: () => Promise.reject(new Error(message)),
});

const hanging = (name: DependencyName): HealthCheck => ({
  name,
  check: () => new Promise<void>(() => undefined),
});

let app: FastifyInstance | undefined;

async function getHealth(checks: HealthCheck[], timeoutMs = 1000) {
  app = await buildApp({ healthChecks: checks, healthCheckTimeoutMs: timeoutMs, logger: false });
  return app.inject({ method: 'GET', url: '/health' });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 when all dependencies are available', async () => {
    const res = await getHealth([healthy('database'), healthy('objectStorage')]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok', objectStorage: 'ok' });
  });

  it('returns 503 when the database is unavailable', async () => {
    const res = await getHealth([failing('database', 'ECONNREFUSED'), healthy('objectStorage')]);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', database: 'error', objectStorage: 'ok' });
  });

  it('returns 503 when object storage is unavailable', async () => {
    const res = await getHealth([healthy('database'), failing('objectStorage', 'NoSuchBucket')]);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', database: 'ok', objectStorage: 'error' });
  });

  it('reports a hanging dependency as error once its timeout elapses', async () => {
    const started = Date.now();
    const res = await getHealth([hanging('database'), healthy('objectStorage')], 50);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ database: 'error', objectStorage: 'ok' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not leak error details, hostnames or credentials', async () => {
    const res = await getHealth([
      failing('database', 'connect failed: postgres://gis:s3cret@db.internal:5432'),
      healthy('objectStorage'),
    ]);

    expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
      'database',
      'objectStorage',
      'status',
    ]);
    expect(res.body).not.toMatch(/s3cret|db\.internal|postgres:|connect failed/);
  });
});

describe('request logging', () => {
  async function logLinesFor(headers: Record<string, string>) {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    };
    app = await buildApp({ healthChecks: [], healthCheckTimeoutMs: 1000, logger: { stream } });
    await app.inject({ method: 'GET', url: '/health', headers });
    return lines.filter((line) => line.msg === 'request completed');
  }

  it('logs JSON with the incoming x-request-id', async () => {
    const [completed] = await logLinesFor({ 'x-request-id': 'req-123' });

    expect(completed).toMatchObject({ reqId: 'req-123', level: 30 });
  });

  it('generates a UUID request id when none is supplied', async () => {
    const [completed] = await logLinesFor({});

    expect(completed?.reqId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
