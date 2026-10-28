import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { BoundingBox } from './detection.js';
import type { Point } from './geometry.js';

/** Marks demo captures in `meta.seed`; demo detection labels start with `DEMO_LABEL_PREFIX`. */
export const DEMO_SEED_TAG = 'demo';
export const DEMO_LABEL_PREFIX = 'demo:';

const IMAGE_WIDTH = 160;
const IMAGE_HEIGHT = 120;
const DETECTIONS_PER_CAPTURE = 5;
const DAY_MS = 86_400_000;

type Rgb = [number, number, number];

interface City {
  name: string;
  center: Point;
  captures: number;
  color: Rgb;
}

// Taveuni straddles the antimeridian, so its points exercise the wrapped bounding box.
const CITIES: City[] = [
  { name: 'Berlin', center: { x: 13.405, y: 52.52 }, captures: 14, color: [70, 110, 160] },
  { name: 'New York', center: { x: -74.006, y: 40.713 }, captures: 14, color: [160, 90, 60] },
  { name: 'Taveuni', center: { x: 179.98, y: -16.85 }, captures: 12, color: [60, 140, 90] },
];

const LABELS = ['car', 'bicycle', 'tree', 'bench', 'street lamp', 'bus stop'];

export interface DemoDetection {
  label: string;
  bboxPx: BoundingBox;
  /** Null for every second detection, so it falls back to the capture's location. */
  geom: Point | null;
  observedAt: Date;
}

export interface DemoCapture {
  id: string;
  blobKey: string;
  capturedAt: Date;
  geom: Point;
  meta: { seed: string; city: string };
  png: Uint8Array;
  detections: DemoDetection[];
}

/** Deterministic PRNG (mulberry32), so every run produces the same layout. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Longitude into [-180, 180), so jitter around Taveuni wraps past the antimeridian. */
function wrapLongitude(x: number): number {
  return ((((x + 180) % 360) + 360) % 360) - 180;
}

function jitter(point: Point, degrees: number, next: () => number): Point {
  return {
    x: wrapLongitude(point.x + (next() - 0.5) * 2 * degrees),
    y: point.y + (next() - 0.5) * 2 * degrees,
  };
}

/**
 * About 40 ready captures around three cities and five detections each (design D12).
 * Each city's first capture is from the last day and its next two from the last week, so
 * every time preset shows points; its last capture is three years back, so its detections
 * land in the default partition. The rest spread over the past six months.
 */
export function buildDemoData(now: Date): DemoCapture[] {
  const next = random(2026);
  return CITIES.flatMap((city) =>
    Array.from({ length: city.captures }, (_, index) => {
      let ageMs: number;
      if (index === 0) {
        ageMs = (1 + next() * 20) * 3_600_000;
      } else if (index <= 2) {
        ageMs = (1 + next() * 5) * DAY_MS;
      } else if (index === city.captures - 1) {
        ageMs = (3 * 365 + next() * 30) * DAY_MS;
      } else {
        ageMs = (7 + next() * 173) * DAY_MS;
      }
      const capturedAt = new Date(now.getTime() - ageMs);
      const geom = jitter(city.center, 0.05, next);
      const detections = Array.from({ length: DETECTIONS_PER_CAPTURE }, (_, d) => {
        const w = 16 + Math.floor(next() * 40);
        const h = 12 + Math.floor(next() * 30);
        return {
          label: `${DEMO_LABEL_PREFIX}${LABELS[Math.floor(next() * LABELS.length)] ?? 'object'}`,
          bboxPx: {
            x: Math.floor(next() * (IMAGE_WIDTH - w)),
            y: Math.floor(next() * (IMAGE_HEIGHT - h)),
            w,
            h,
          },
          geom: d % 2 === 0 ? jitter(geom, 0.003, next) : null,
          observedAt: new Date(capturedAt.getTime() + d * 1000),
        };
      });
      const id = randomUUID();
      return {
        id,
        blobKey: `images/${id}`,
        capturedAt,
        geom,
        meta: { seed: DEMO_SEED_TAG, city: city.name },
        png: renderPng(
          city.color,
          detections.map((item) => item.bboxPx),
        ),
        detections,
      };
    }),
  );
}

/** A flat image in the city's color with a lighter rectangle under each detection box. */
function renderPng(color: Rgb, boxes: BoundingBox[]): Uint8Array {
  const pixels = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
  const light = color.map((c) => Math.min(255, c + 80)) as Rgb;
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const inBox = boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      pixels.set(inBox ? light : color, (y * IMAGE_WIDTH + x) * 3);
    }
  }
  return encodePng(IMAGE_WIDTH, IMAGE_HEIGHT, pixels);
}

/** Minimal 8-bit RGB PNG: signature, IHDR, one IDAT (filter 0 per row) and IEND. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(typeAndData.length + 8);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}
