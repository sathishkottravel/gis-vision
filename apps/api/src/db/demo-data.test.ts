import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildDemoData, DEMO_LABEL_PREFIX, DEMO_SEED_TAG, encodePng } from './demo-data.js';

const DAY_MS = 86_400_000;
const now = new Date('2026-10-28T12:00:00Z');

describe('demo data', () => {
  const demo = buildDemoData(now);
  const detections = demo.flatMap((item) => item.detections);

  it('has about 40 tagged captures and 200 labeled detections', () => {
    expect(demo).toHaveLength(40);
    expect(detections).toHaveLength(200);
    expect(demo.every((item) => item.meta.seed === DEMO_SEED_TAG)).toBe(true);
    expect(detections.every((d) => d.label.startsWith(DEMO_LABEL_PREFIX))).toBe(true);
    expect(new Set(demo.map((item) => item.id)).size).toBe(40);
  });

  it('mixes own points and capture fallback', () => {
    const own = detections.filter((d) => d.geom !== null).length;

    expect(own).toBe(120);
    expect(detections.length - own).toBe(80);
  });

  it('covers every time preset and the default partition', () => {
    const ages = detections.map((d) => now.getTime() - d.observedAt.getTime());

    expect(ages.filter((age) => age < DAY_MS).length).toBeGreaterThan(0);
    expect(ages.filter((age) => age >= DAY_MS && age < 7 * DAY_MS).length).toBeGreaterThan(0);
    expect(ages.filter((age) => age > 3 * 365 * DAY_MS).length).toBeGreaterThan(0);
    expect(Math.max(...ages.filter((age) => age < 365 * DAY_MS))).toBeLessThan(180 * DAY_MS);
  });

  it('keeps longitudes within [-180, 180) and crosses the antimeridian', () => {
    const xs = demo.flatMap((item) => [item.geom, ...item.detections.map((d) => d.geom)]);
    const longitudes = xs.flatMap((point) => (point ? [point.x] : []));

    expect(longitudes.every((x) => x >= -180 && x < 180)).toBe(true);
    expect(longitudes.some((x) => x > 179.9)).toBe(true);
    expect(longitudes.some((x) => x < -179.9)).toBe(true);
  });

  it('is the same layout on every run, with fresh ids', () => {
    const again = buildDemoData(now);

    expect(again.map((item) => item.geom)).toEqual(demo.map((item) => item.geom));
    expect(again[0]?.id).not.toBe(demo[0]?.id);
  });
});

describe('encodePng', () => {
  it('writes a PNG whose image data inflates to one filtered row per line', () => {
    const png = Buffer.from(encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255])));

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    const idatLength = png.readUInt32BE(33);
    const idat = png.subarray(41, 41 + idatLength);
    expect([...inflateSync(idat)]).toEqual([0, 255, 0, 0, 0, 0, 255]);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
});
