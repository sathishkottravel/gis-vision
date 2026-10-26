import type { FastifyPluginCallback } from 'fastify';
import { NotFoundError } from '../errors.js';
import type { DetectorRegistry } from './detector-registry.js';

export interface DetectorRouteOptions {
  registry: DetectorRegistry;
}

interface DetectorParams {
  id: string;
}

export const detectorRoutes: FastifyPluginCallback<DetectorRouteOptions> = (app, opts, done) => {
  app.get('/detectors', async () => ({ items: await opts.registry.list() }));

  app.get<{ Params: DetectorParams }>('/detectors/:id/schema', async (request, reply) => {
    const detector = await opts.registry.find(request.params.id);
    if (!detector) {
      throw new NotFoundError(`Detector ${request.params.id} does not exist`);
    }
    return reply.type('application/schema+json; charset=utf-8').send(detector.outputSchema);
  });

  done();
};
