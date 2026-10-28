export type TimePreset = '24h' | '7d' | '30d' | 'all' | 'custom';

export const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' },
];

const HOUR_MS = 3_600_000;
const PRESET_MS: Partial<Record<TimePreset, number>> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

export interface TimeRange {
  preset: TimePreset;
  /** `datetime-local` values (local time, no zone), used only by `custom`. */
  from: string;
  to: string;
}

/** The `observedFrom`/`observedTo` part of a `DetectionFilter` (half-open: from inclusive, to exclusive). */
export interface ObservedRange {
  observedFrom?: string;
  observedTo?: string;
}

/**
 * Resolves a range to filter bounds at `now`, or returns an error message for a custom range
 * that the API would reject. An empty custom bound is left open.
 */
export function observedRange(range: TimeRange, now: Date): ObservedRange | { error: string } {
  const span = PRESET_MS[range.preset];
  if (span !== undefined) {
    return { observedFrom: new Date(now.getTime() - span).toISOString() };
  }
  if (range.preset === 'all') {
    return {};
  }
  const from = range.from ? new Date(range.from) : undefined;
  const to = range.to ? new Date(range.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return { error: 'Enter valid dates.' };
  }
  if (from && to && from >= to) {
    return { error: '"From" must be before "to".' };
  }
  return {
    ...(from ? { observedFrom: from.toISOString() } : {}),
    ...(to ? { observedTo: to.toISOString() } : {}),
  };
}
