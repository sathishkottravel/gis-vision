import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';

describe('GET /health against real PostGIS and RustFS', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('returns 200 with all dependencies ok', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok', objectStorage: 'ok' });
  });
});
