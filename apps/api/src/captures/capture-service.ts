import { createHash, randomUUID } from 'node:crypto';
import type { Capture, CreateCaptureRequest, CreateCaptureResponse } from '@gis-vision/schemas';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BlobStore } from '../blob/blob-store.js';
import type { Database } from '../db/client.js';
import { capture } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';

type CaptureRow = typeof capture.$inferSelect;

export interface CaptureServiceOptions {
  db: Database;
  blobStore: BlobStore;
  uploadUrlTtlSeconds: number;
  imageUrlTtlSeconds: number;
}

export interface CreateCaptureResult {
  capture: CreateCaptureResponse;
  /** True when an `Idempotency-Key` matched an earlier request and no capture was created. */
  replayed: boolean;
}

const uuidSchema = z.uuid();

/** Fingerprint of a create request, stored with its idempotency key to detect reuse. */
function requestHash(input: CreateCaptureRequest): string {
  const canonical = JSON.stringify([
    input.contentType,
    input.byteSize,
    input.capturedAt === undefined ? null : new Date(input.capturedAt).toISOString(),
    input.location?.coordinates ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Presigned two-step upload (design D4a): `create` stores a pending capture and returns an
 * upload URL, the client PUTs the image straight to object storage, and `complete` checks
 * the object before marking the capture ready. Image bytes never pass through the API.
 */
export class CaptureService {
  constructor(private readonly options: CaptureServiceOptions) {}

  async create(input: CreateCaptureRequest, idempotencyKey?: string): Promise<CreateCaptureResult> {
    const { db } = this.options;
    const hash = idempotencyKey === undefined ? undefined : requestHash(input);
    const id = randomUUID();
    const [inserted] = await db
      .insert(capture)
      .values({
        id,
        blobKey: `images/${id}`,
        contentType: input.contentType,
        byteSize: input.byteSize,
        idempotencyKey,
        // Same transaction timestamp as `created_at`, so an omitted capture time equals it.
        capturedAt: input.capturedAt === undefined ? sql`now()` : new Date(input.capturedAt),
        geom: input.location
          ? { x: input.location.coordinates[0], y: input.location.coordinates[1] }
          : null,
        meta: hash === undefined ? {} : { requestHash: hash },
      })
      .onConflictDoNothing({ target: capture.idempotencyKey })
      .returning();

    let row = inserted;
    if (!row) {
      // Only an existing idempotency key makes the insert a no-op.
      const [existing] = await db
        .select()
        .from(capture)
        .where(eq(capture.idempotencyKey, idempotencyKey ?? ''));
      if (!existing) {
        throw new Error('capture insert skipped without an idempotency conflict');
      }
      if (existing.meta.requestHash !== hash) {
        throw new ConflictError(
          'idempotency_key_reused',
          'Idempotency-Key was already used with a different request',
        );
      }
      row = existing;
    }

    const upload = await this.options.blobStore.presignPut(row.blobKey, {
      contentType: row.contentType,
      expiresInSeconds: this.options.uploadUrlTtlSeconds,
    });
    return {
      capture: {
        ...toCapture(row),
        uploadUrl: upload.url,
        uploadHeaders: upload.headers,
        expiresAt: upload.expiresAt.toISOString(),
      },
      replayed: row !== inserted,
    };
  }

  /** Verifies the uploaded object and marks the capture ready. Repeating it is harmless. */
  async complete(id: string): Promise<Capture> {
    const row = await this.find(id);
    if (row.status === 'ready') {
      return this.withImageUrl(row);
    }

    const head = await this.options.blobStore.head(row.blobKey);
    if (!head) {
      throw new ConflictError('upload_missing', 'No image has been uploaded for this capture');
    }
    if (head.byteSize !== row.byteSize) {
      throw new ConflictError(
        'upload_size_mismatch',
        `Uploaded image has ${String(head.byteSize)} bytes, but ${String(row.byteSize)} were declared`,
      );
    }
    if (head.contentType !== row.contentType) {
      throw new ConflictError(
        'upload_type_mismatch',
        `Uploaded image has content type ${String(head.contentType)}, but ${row.contentType} was declared`,
      );
    }

    const [updated] = await this.options.db
      .update(capture)
      .set({ status: 'ready' })
      .where(and(eq(capture.id, row.id), eq(capture.status, 'pending')))
      .returning();
    // A concurrent `complete` may have won the update; the capture is ready either way.
    return this.withImageUrl(updated ?? (await this.find(id)));
  }

  async get(id: string): Promise<Capture> {
    return this.withImageUrl(await this.find(id));
  }

  /** Newest first. */
  async list(limit: number): Promise<Capture[]> {
    const rows = await this.options.db
      .select()
      .from(capture)
      .orderBy(desc(capture.createdAt), desc(capture.id))
      .limit(limit);
    return Promise.all(rows.map((row) => this.withImageUrl(row)));
  }

  private async find(id: string): Promise<CaptureRow> {
    const [row] = uuidSchema.safeParse(id).success
      ? await this.options.db.select().from(capture).where(eq(capture.id, id))
      : [];
    if (!row) {
      throw new NotFoundError(`Capture ${id} does not exist`);
    }
    return row;
  }

  private async withImageUrl(row: CaptureRow): Promise<Capture> {
    if (row.status !== 'ready') {
      return toCapture(row);
    }
    const image = await this.options.blobStore.presignGet(row.blobKey, {
      expiresInSeconds: this.options.imageUrlTtlSeconds,
    });
    return { ...toCapture(row), imageUrl: image.url };
  }
}

function toCapture(row: CaptureRow): Capture {
  return {
    id: row.id,
    status: row.status,
    // Only allowed types are ever inserted (validated by `createCaptureRequestSchema`).
    contentType: row.contentType as Capture['contentType'],
    byteSize: row.byteSize,
    capturedAt: row.capturedAt.toISOString(),
    location: row.geom ? { type: 'Point', coordinates: [row.geom.x, row.geom.y] } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
