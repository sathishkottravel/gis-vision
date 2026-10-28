import type { CreateDetectionRequest, Detection, GeoJsonPoint } from '@gis-vision/schemas';
import { asc, eq } from 'drizzle-orm';
import { findCapture } from '../captures/capture-service.js';
import type { Database } from '../db/client.js';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import type { DetectorRegistry } from '../detectors/detector-registry.js';
import { ConflictError, UnprocessableError } from '../errors.js';
import type { AttributeValidator } from './attribute-validator.js';

type DetectionRow = typeof detection.$inferSelect;

export interface DetectionServiceOptions {
  db: Database;
  registry: DetectorRegistry;
  validator: AttributeValidator;
}

/**
 * Records what a detector found on a capture. Attributes are validated against the
 * detector's output schema; time and location default from the capture (design D6).
 */
export class DetectionService {
  constructor(private readonly options: DetectionServiceOptions) {}

  async create(captureId: string, input: CreateDetectionRequest): Promise<Detection> {
    const parent = await findCapture(this.options.db, captureId);
    if (parent.status !== 'ready') {
      throw new ConflictError(
        'capture_not_ready',
        `Capture ${captureId} is ${parent.status}; complete its upload first`,
      );
    }
    const detector = await this.options.registry.find(input.detectorId);
    if (!detector) {
      throw new UnprocessableError('unknown_detector', [
        { path: 'detectorId', message: `Detector ${input.detectorId} does not exist` },
      ]);
    }
    this.options.validator.validate(detector, input.attributes);

    const [row] = await this.options.db
      .insert(detection)
      .values({
        captureId: parent.id,
        detectorId: detector.id,
        label: input.label,
        confidence: input.confidence ?? null,
        bboxPx: input.bbox,
        // Stored as null when omitted, so the capture's location stays the single source.
        geom: input.location
          ? { x: input.location.coordinates[0], y: input.location.coordinates[1] }
          : null,
        observedAt: input.observedAt === undefined ? parent.capturedAt : new Date(input.observedAt),
        attributes: input.attributes,
      })
      .returning();
    if (!row) {
      throw new Error('detection insert returned no row');
    }
    return toDetection(row, parent.geom);
  }

  /** All detections of a capture, ordered by observation time. */
  async list(captureId: string): Promise<Detection[]> {
    const parent = await findCapture(this.options.db, captureId);
    const rows = await this.options.db
      .select()
      .from(detection)
      .where(eq(detection.captureId, parent.id))
      .orderBy(asc(detection.observedAt), asc(detection.createdAt), asc(detection.id));
    return rows.map((row) => toDetection(row, parent.geom));
  }
}

function toGeoJson(point: Point): GeoJsonPoint {
  return { type: 'Point', coordinates: [point.x, point.y] };
}

/** `location` is the effective location: the detection's own point, else the capture's. */
function toDetection(row: DetectionRow, captureGeom: Point | null): Detection {
  const location = row.geom ?? captureGeom;
  return {
    id: row.id,
    captureId: row.captureId,
    detectorId: row.detectorId,
    label: row.label,
    confidence: row.confidence,
    bbox: row.bboxPx,
    location: location ? toGeoJson(location) : null,
    observedAt: row.observedAt.toISOString(),
    attributes: row.attributes,
    createdAt: row.createdAt.toISOString(),
  };
}
