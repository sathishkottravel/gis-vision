import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppDeps, createInfrastructure, type Infrastructure } from '../infrastructure.js';
import {
  buildIntegrationApp,
  integrationConfig,
  type IntegrationApp,
} from '../testing/integration-app.js';

interface GraphQLBody {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

describe('GraphQL endpoint (F2.1)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function post(query: string) {
    return ctx.app.inject({ method: 'POST', url: '/graphql', payload: { query } });
  }

  describe('serving queries (1.2)', () => {
    it('answers a query with 200 and data', async () => {
      const res = await post('{ __typename ping }');

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { __typename: 'Query', ping: 'pong' } });
    });

    it('accepts variables and an operation name', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: 'query Check { ping }', operationName: 'Check', variables: {} },
      });

      expect(res.json()).toEqual({ data: { ping: 'pong' } });
    });

    it('reports a syntax error without data', async () => {
      const body = (await post('{ ping ')).json<GraphQLBody>();

      expect(body.data).toBeUndefined();
      expect(body.errors?.[0]?.message).toMatch(/Syntax Error/);
    });

    it('rejects a mutation, because the schema is read-only', async () => {
      const body = (await post('mutation { ping }')).json<GraphQLBody>();

      // Rejected before any resolver runs: no data (`null` at execution time), one error.
      expect(body.data ?? null).toBeNull();
      expect(body.errors?.[0]?.message).toMatch(/not configured to execute mutation/);
    });

    it('rejects batched operations', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/graphql',
        payload: [{ query: '{ ping }' }, { query: '{ ping }' }],
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('serves GraphiQL to a browser outside production', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/graphql',
        headers: { accept: 'text/html' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('GraphiQL');
    });

    describe('in production', () => {
      let infra: Infrastructure;
      let app: Awaited<ReturnType<typeof buildApp>>;

      beforeAll(async () => {
        const config = { ...integrationConfig(), NODE_ENV: 'production' as const };
        infra = createInfrastructure(config);
        app = await buildApp({ ...createAppDeps(config, infra), logger: false });
      });

      afterAll(async () => {
        await app.close();
        await infra.close();
      });

      it('does not serve GraphiQL', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/graphql',
          headers: { accept: 'text/html' },
        });

        expect(res.body).not.toContain('GraphiQL');
      });

      it('still answers queries', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/graphql',
          payload: { query: '{ ping }' },
        });

        expect(res.json()).toEqual({ data: { ping: 'pong' } });
      });
    });
  });

  describe('error reporting (1.3)', () => {
    const logLines: string[] = [];
    let app: Awaited<ReturnType<typeof buildApp>>;

    // A schema whose resolver fails the way a broken database query would.
    const failingSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          boom: {
            type: GraphQLString,
            resolve: () => {
              throw new Error('connect ECONNREFUSED 10.0.0.5:5432 during SELECT * FROM capture');
            },
          },
        },
      }),
    });

    beforeAll(async () => {
      app = await buildApp({
        healthChecks: [],
        healthCheckTimeoutMs: 1000,
        graphql: { schema: failingSchema, graphiql: false },
        logger: { level: 'error', stream: { write: (line: string) => logLines.push(line) } },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('masks an unexpected failure as INTERNAL_SERVER_ERROR without internals', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ boom }' },
        headers: { 'x-request-id': 'req-boom-1' },
      });
      const body = res.json<GraphQLBody>();

      expect(body.data).toEqual({ boom: null });
      expect(body.errors).toEqual([
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 3 }],
          path: ['boom'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ]);
      expect(res.body).not.toMatch(/ECONNREFUSED|SELECT|at .*\.ts/);
    });

    it('logs the original error with the request id', () => {
      const entry = logLines
        .map(
          (line) =>
            JSON.parse(line) as { reqId?: string; msg?: string; err?: { message?: string } },
        )
        .find((log) => log.msg === 'graphql resolver failed');

      expect(entry?.reqId).toBe('req-boom-1');
      expect(entry?.err?.message).toContain('ECONNREFUSED');
    });
  });
});
