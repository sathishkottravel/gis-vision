import { describe, expect, it } from 'vitest';
import { observedRange } from './time-range.js';

const now = new Date('2026-10-28T12:00:00Z');

describe('observedRange', () => {
  it.each([
    ['24h', '2026-10-27T12:00:00.000Z'],
    ['7d', '2026-10-21T12:00:00.000Z'],
    ['30d', '2026-09-28T12:00:00.000Z'],
  ] as const)('starts %s before now, open-ended', (preset, from) => {
    expect(observedRange({ preset, from: '', to: '' }, now)).toEqual({ observedFrom: from });
  });

  it('has no bounds for all', () => {
    expect(observedRange({ preset: 'all', from: '2026-01-01T00:00', to: '' }, now)).toEqual({});
  });

  it('converts custom local times to UTC instants, either bound optional', () => {
    const from = '2026-03-01T00:00';
    const to = '2026-04-01T00:00';

    expect(observedRange({ preset: 'custom', from, to }, now)).toEqual({
      observedFrom: new Date(from).toISOString(),
      observedTo: new Date(to).toISOString(),
    });
    expect(observedRange({ preset: 'custom', from: '', to }, now)).toEqual({
      observedTo: new Date(to).toISOString(),
    });
  });

  it('rejects an empty or inverted custom range', () => {
    expect(
      observedRange({ preset: 'custom', from: '2026-03-01T00:00', to: '2026-03-01T00:00' }, now),
    ).toEqual({ error: '"From" must be before "to".' });
  });
});
