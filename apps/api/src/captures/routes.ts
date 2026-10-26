import { createCaptureRequestSchema, listCapturesQuerySchema } from '@gis-vision/schemas';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../errors.js';
import type { CaptureService } from './capture-service.js';

export interface CaptureRouteOptions {
  service: CaptureService;
  /** Largest accepted upload (`UPLOAD_MAX_BYTES`). */
  maxUploadBytes: number;
}

/** Printable ASCII, as recommended for the `Idempotency-Key` header. */
const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1-255 printable ASCII characters')
  .optional();

interface CaptureParams {
  id: string;
}

export const captureRoutes: FastifyPluginCallback<CaptureRouteOptions> = (app, opts, done) => {
  const createRequestSchema = createCaptureRequestSchema({ maxBytes: opts.maxUploadBytes });

  app.post('/captures', async (request, reply) => {
    const input = parseInput(createRequestSchema, request.body);
    const idempotencyKey = parseInput(
      z.object({ 'idempotency-key': idempotencyKeySchema }),
      request.headers,
    )['idempotency-key'];

    const { capture, replayed } = await opts.service.create(input, idempotencyKey);
    if (replayed) {
      void reply.header('idempotent-replayed', 'true');
    }
    return reply.code(201).send(capture);
  });

  app.post<{ Params: CaptureParams }>('/captures/:id/complete', async (request) =>
    opts.service.complete(request.params.id),
  );

  app.get<{ Params: CaptureParams }>('/captures/:id', async (request) =>
    opts.service.get(request.params.id),
  );

  app.get('/captures', async (request) => {
    const { limit } = parseInput(listCapturesQuerySchema, request.query);
    return { items: await opts.service.list(limit) };
  });

  done();
};
