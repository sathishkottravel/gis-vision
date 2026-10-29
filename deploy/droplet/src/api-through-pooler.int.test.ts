import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../../apps/api/src/app.js';
import { loadConfig } from '../../../apps/api/src/config.js';
import { createAppDeps, createInfrastructure } from '../../../apps/api/src/infrastructure.js';
import { migrateAsOwner, startDropletStack, type DropletStack } from './stack.js';

type App = Awaited<ReturnType<typeof buildApp>>;

interface DetectionsPage {
  edges: { node: { label: string } }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

// The API exactly as deployed talks to the droplet: gis_app through PgBouncer, verified TLS,
// one pooled connection (as on Lambda), `options` ignored by PgBouncer. Object storage is the
// integration run's RustFS. Design D4-D6; task 2.3.
describe('the API through PgBouncer (F2.5.2)', () => {
  let stack: DropletStack;
  let app: App;

  beforeAll(async () => {
    stack = await startDropletStack();
    migrateAsOwner(stack);
    const config = loadConfig({
      ...inject('integrationEnv'),
      DATABASE_URL: stack.url('gis_app', 'pgbouncer'),
      DATABASE_SSL_CA: stack.ca,
      DATABASE_POOL_MAX: '1',
    });
    const infra = createInfrastructure(config);
    app = await buildApp({ ...createAppDeps(config, infra), logger: false });
    app.addHook('onClose', () => infra.close());

    // Three detections in a remote box, via the API's role.
    const writer = await stack.connect('gis_app', { endpoint: 'pgbouncer' });
    try {
      await writer.query(
        `WITH c AS (
           INSERT INTO capture (status, blob_key, content_type, byte_size, captured_at, geom)
           VALUES ('ready', 'images/pooler-test', 'image/png', 1, now(),
                   ST_SetSRID(ST_MakePoint(-150.5, -60.5), 4326))
           RETURNING id)
         INSERT INTO detection (capture_id, detector_id, label, bbox_px, observed_at)
         SELECT c.id, 'manual', 'pooled-' || n, '{"x":0,"y":0,"w":1,"h":1}',
                timestamptz '2026-03-01T00:00:00Z' + n * interval '1 minute'
           FROM c, generate_series(1, 3) AS n`,
      );
    } finally {
      await writer.end();
    }
  }, 240_000);

  afterAll(async () => {
    await app.close();
    await stack.stop();
  });

  it('reports healthy dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok', objectStorage: 'ok' });
  });

  it('walks a GraphQL bbox search over two pages', async () => {
    const page = async (after: string | null): Promise<DetectionsPage> => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `query ($after: String) {
            detections(filter: { bbox: { west: -151, south: -61, east: -150, north: -60 } }, first: 2, after: $after) {
              edges { node { label } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          variables: { after },
        },
      });
      const body = res.json<{ data?: { detections: DetectionsPage }; errors?: unknown[] }>();
      expect(body.errors).toBeUndefined();
      if (!body.data) {
        throw new Error('no data');
      }
      return body.data.detections;
    };

    const first = await page(null);
    const second = await page(first.pageInfo.endCursor);

    expect(first.edges.map((e) => e.node.label)).toEqual(['pooled-1', 'pooled-2']);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(second.edges.map((e) => e.node.label)).toEqual(['pooled-3']);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });
});
