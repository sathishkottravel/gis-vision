import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';

const cursor: Cursor = {
  kind: 'detection',
  timestamp: '2026-03-01T10:00:00.123456Z',
  id: '0b5c2f9e-1d2a-4c3b-9a8e-7f6d5c4b3a21',
};

/** base64url of an arbitrary JSON value, to forge cursors. */
function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('search cursors', () => {
  it('round-trips and is opaque (URL-safe, no readable fields)', () => {
    const encoded = encodeCursor(cursor);

    expect(decodeCursor(encoded, 'detection')).toEqual(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain(cursor.id);
  });

  it('keeps microsecond precision', () => {
    const decoded = decodeCursor(encodeCursor(cursor), 'detection');

    expect(decoded?.timestamp).toBe('2026-03-01T10:00:00.123456Z');
  });

  it('rejects a cursor issued for the other search', () => {
    expect(decodeCursor(encodeCursor(cursor), 'capture')).toBeUndefined();
  });

  it('rejects a tampered cursor', () => {
    const encoded = encodeCursor(cursor);
    const tampered = `${encoded.slice(0, 10)}${encoded[10] === 'A' ? 'B' : 'A'}${encoded.slice(11)}`;

    expect(decodeCursor(tampered, 'detection')).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['arbitrary text', 'hello world'],
    ['base64 of non-JSON', Buffer.from('not json').toString('base64url')],
    ['an unknown version', forge({ v: 2, k: 'detection', t: cursor.timestamp, id: cursor.id })],
    [
      'millisecond precision',
      forge({ v: 1, k: 'detection', t: '2026-03-01T10:00:00.123Z', id: cursor.id }),
    ],
    ['an id that is not a UUID', forge({ v: 1, k: 'detection', t: cursor.timestamp, id: '42' })],
    [
      'extra fields',
      forge({ v: 1, k: 'detection', t: cursor.timestamp, id: cursor.id, admin: true }),
    ],
    ['a JSON array', forge([1, 'detection'])],
  ])('rejects %s', (_, value) => {
    expect(decodeCursor(value, 'detection')).toBeUndefined();
  });
});
