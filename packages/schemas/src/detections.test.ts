import { describe, expect, it } from 'vitest';
import { createDetectionRequestSchema } from './detections.js';

const valid = {
  detectorId: 'manual',
  label: 'stop-sign',
  bbox: { x: 0, y: 0, w: 40, h: 30 },
};

/** Paths of the fields that failed validation, e.g. `bbox.w`. */
function failedPaths(input: unknown): string[] {
  const result = createDetectionRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('detection request schema', () => {
  it('accepts the minimal manual annotation and defaults attributes to {}', () => {
    expect(createDetectionRequestSchema.parse(valid)).toEqual({ ...valid, attributes: {} });
  });

  it('accepts every optional field', () => {
    const input = {
      ...valid,
      confidence: 0.87,
      location: { type: 'Point', coordinates: [13.4, 52.5] },
      observedAt: '2026-03-01T10:00:00Z',
      attributes: { state: 'red', heads: 3 },
    };

    expect(createDetectionRequestSchema.parse(input)).toEqual(input);
  });

  it.each([0, 1])('accepts confidence %d at the edge of the range', (confidence) => {
    expect(failedPaths({ ...valid, confidence })).toEqual([]);
  });

  it.each([
    ['a negative width', { ...valid, bbox: { x: 0, y: 0, w: -5, h: 30 } }, 'bbox.w'],
    ['a zero height', { ...valid, bbox: { x: 0, y: 0, w: 40, h: 0 } }, 'bbox.h'],
    ['a negative x', { ...valid, bbox: { x: -1, y: 0, w: 40, h: 30 } }, 'bbox.x'],
    ['a negative y', { ...valid, bbox: { x: 0, y: -1, w: 40, h: 30 } }, 'bbox.y'],
    ['a missing bounding box', { detectorId: 'manual', label: 'stop-sign' }, 'bbox'],
    ['confidence above 1', { ...valid, confidence: 1.5 }, 'confidence'],
    ['confidence below 0', { ...valid, confidence: -0.1 }, 'confidence'],
    ['an empty label', { ...valid, label: '  ' }, 'label'],
    ['a missing detector', { label: 'x', bbox: valid.bbox }, 'detectorId'],
    [
      'a latitude out of range',
      { ...valid, location: { type: 'Point', coordinates: [13.4, 95] } },
      'location.coordinates.1',
    ],
    [
      'an observation time without offset',
      { ...valid, observedAt: '2026-03-01T10:00:00' },
      'observedAt',
    ],
    ['attributes that are not an object', { ...valid, attributes: ['red'] }, 'attributes'],
  ])('rejects %s', (_, input, path) => {
    expect(failedPaths(input)).toEqual([path]);
  });
});
