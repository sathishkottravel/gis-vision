import { createDetectionRequestSchema } from '@gis-vision/schemas';
import type { FastifyPluginCallback } from 'fastify';
import { parseInput } from '../errors.js';
import type { DetectionService } from './detection-service.js';

export interface DetectionRouteOptions {
  service: DetectionService;
}

interface CaptureParams {
  id: string;
}

export const detectionRoutes: FastifyPluginCallback<DetectionRouteOptions> = (app, opts, done) => {
  app.post<{ Params: CaptureParams }>('/captures/:id/detections', async (request, reply) => {
    const input = parseInput(createDetectionRequestSchema, request.body);
    return reply.code(201).send(await opts.service.create(request.params.id, input));
  });

  app.get<{ Params: CaptureParams }>('/captures/:id/detections', async (request) => ({
    items: await opts.service.list(request.params.id),
  }));

  done();
};
