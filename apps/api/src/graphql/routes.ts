import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import type { GraphQLContext } from './context.js';
import { useErrorMapping } from './error-mapping.js';

export interface GraphQLRouteOptions {
  schema: GraphQLSchema;
  /** Serve GraphiQL on `GET /graphql`; off in production (design D2). */
  graphiql: boolean;
}

interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

/** GraphQL Yoga mounted as a Fastify route, so Fastify keeps logging, request ids and hooks. */
export const graphqlRoutes: FastifyPluginCallback<GraphQLRouteOptions> = (app, opts, done) => {
  const yoga = createYoga<ServerContext, GraphQLContext>({
    schema: opts.schema,
    graphqlEndpoint: '/graphql',
    graphiql: opts.graphiql,
    landingPage: false,
    batching: false,
    // Masking and logging happen in `useErrorMapping`, which can see the request.
    maskedErrors: false,
    logging: app.log,
    context: ({ req }): GraphQLContext => ({ log: req.log, requestId: req.id }),
    plugins: [useErrorMapping()],
  });

  app.route({
    url: '/graphql',
    method: ['GET', 'POST', 'OPTIONS'],
    handler: async (req, reply) => {
      const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply });
      for (const [name, value] of response.headers) {
        void reply.header(name, value);
      }
      return reply.status(response.status).send(response.body);
    },
  });

  done();
};
