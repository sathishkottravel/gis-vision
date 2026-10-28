import { z } from 'zod';

/**
 * Keyset position in a search: the sort timestamp at microsecond precision plus the row id
 * (design D8). `kind` stops a detections cursor from being replayed against captures.
 */
export interface Cursor {
  kind: 'detection' | 'capture';
  /** UTC timestamp as Postgres prints it with `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. */
  timestamp: string;
  id: string;
}

const MICROSECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const payloadSchema = z.strictObject({
  v: z.literal(1),
  k: z.enum(['detection', 'capture']),
  t: z.string().regex(MICROSECOND_TIMESTAMP),
  id: z.uuid(),
});

/** SQL that renders a timestamp column the way cursors store it (microseconds, UTC). */
export const CURSOR_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** An opaque string for clients: base64url of a small versioned JSON payload. */
export function encodeCursor(cursor: Cursor): string {
  const payload = { v: 1, k: cursor.kind, t: cursor.timestamp, id: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The cursor in `value` if this service issued it for `kind`, otherwise `undefined`. */
export function decodeCursor(value: string, kind: Cursor['kind']): Cursor | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const result = payloadSchema.safeParse(json);
  if (!result.success || result.data.k !== kind) {
    return undefined;
  }
  return { kind, timestamp: result.data.t, id: result.data.id };
}
