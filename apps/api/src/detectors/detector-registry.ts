import type { Detector } from '@gis-vision/schemas';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { detector } from '../db/schema.js';

/** A detector together with the JSON Schema its detection attributes must satisfy. */
export interface RegisteredDetector extends Detector {
  outputSchema: Record<string, unknown>;
}

/**
 * Port (design D5): the catalog of detectors and their output schemas. Detections are
 * validated against `outputSchema`, and clients build attribute forms from it.
 */
export interface DetectorRegistry {
  /** Every registered detector, ordered by id. */
  list(): Promise<Detector[]>;
  /** The detector with this id, or `undefined` if none is registered. */
  find(id: string): Promise<RegisteredDetector | undefined>;
}

/** `DetectorRegistry` backed by the `detector` table; `manual` is seeded by a migration. */
export class PgDetectorRegistry implements DetectorRegistry {
  constructor(private readonly db: Database) {}

  async list(): Promise<Detector[]> {
    return this.db
      .select({
        id: detector.id,
        name: detector.name,
        version: detector.version,
        kind: detector.kind,
      })
      .from(detector)
      .orderBy(asc(detector.id));
  }

  async find(id: string): Promise<RegisteredDetector | undefined> {
    const [row] = await this.db.select().from(detector).where(eq(detector.id, id));
    return row;
  }
}
