import type { Point } from '../../db/geometry.js';
import { builder } from '../builder.js';
import type { CaptureRow, DetectionRow, DetectorRow } from '../loaders.js';

export type LocationSource = 'DETECTION' | 'CAPTURE' | 'NONE';

/** A detection together with its effective location (design D5). */
export interface DetectionNode {
  row: DetectionRow;
  location: Point | null;
  locationSource: LocationSource;
}

/** The detection's own point, else its capture's, else none (spec: Effective detection location). */
export function toDetectionNode(row: DetectionRow, captureGeom: Point | null): DetectionNode {
  if (row.geom) {
    return { row, location: row.geom, locationSource: 'DETECTION' };
  }
  if (captureGeom) {
    return { row, location: captureGeom, locationSource: 'CAPTURE' };
  }
  return { row, location: null, locationSource: 'NONE' };
}

// Refs are declared first so the object types can reference each other.
export const CaptureRef = builder.objectRef<CaptureRow>('Capture');
export const DetectionRef = builder.objectRef<DetectionNode>('Detection');
export const DetectorRef = builder.objectRef<DetectorRow>('Detector');
