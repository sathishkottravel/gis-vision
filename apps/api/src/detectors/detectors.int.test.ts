import { randomUUID } from 'node:crypto';
import { checkDetectorSchema, type Detector } from '@gis-vision/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detector } from '../db/schema.js';
import type { ErrorBody } from '../http/error-handler.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';
import { PgDetectorRegistry } from './detector-registry.js';

describe('detector registry', () => {
  let ctx: IntegrationApp;
  const testId = `test-${randomUUID()}`;
  const testSchema = {
    type: 'object',
    properties: { state: { type: 'string', enum: ['red', 'green'] } },
    required: ['state'],
  };

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
    await ctx.infra.db.insert(detector).values({
      id: testId,
      name: 'Test detector',
      version: 2,
      kind: 'ml',
      outputSchema: testSchema,
    });
  });

  afterAll(async () => {
    await ctx.infra.db.delete(detector).where(eq(detector.id, testId));
    await ctx.app.close();
  });

  describe('PgDetectorRegistry (F1.5 11.2)', () => {
    it('finds the seeded manual detector with a schema in the supported subset', async () => {
      const manual = await new PgDetectorRegistry(ctx.infra.db).find('manual');

      expect(manual).toMatchObject({ id: 'manual', name: 'Manual annotation', kind: 'manual' });
      expect(checkDetectorSchema(manual?.outputSchema)).toEqual([]);
    });

    it('returns undefined for an unknown detector', async () => {
      expect(await new PgDetectorRegistry(ctx.infra.db).find(`missing-${randomUUID()}`)).toBe(
        undefined,
      );
    });
  });

  describe('GET /detectors and GET /detectors/:id/schema (F1.5 11.3)', () => {
    it('lists every detector with id, name, version and kind', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/detectors' });
      const { items } = res.json<{ items: Detector[] }>();

      expect(res.statusCode).toBe(200);
      expect(items).toContainEqual({
        id: 'manual',
        name: 'Manual annotation',
        version: 1,
        kind: 'manual',
      });
      expect(items).toContainEqual({ id: testId, name: 'Test detector', version: 2, kind: 'ml' });
      expect(items.map((item) => item.id)).toEqual(items.map((item) => item.id).sort());
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(['id', 'kind', 'name', 'version']);
      }
    });

    it('returns the manual detector schema as a JSON Schema document', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/detectors/manual/schema' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/schema+json; charset=utf-8');
      expect(res.json()).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
      });
      expect(checkDetectorSchema(res.json())).toEqual([]);
    });

    it('returns exactly the stored schema of another detector', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: `/detectors/${testId}/schema` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(testSchema);
    });

    it('returns 404 for an unknown detector', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/detectors/missing-${randomUUID()}/schema`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('not_found');
    });
  });
});
