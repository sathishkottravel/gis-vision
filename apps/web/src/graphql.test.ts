import { describe, expect, it } from 'vitest';
import type { Fetch } from './api.js';
import { fetchMapDetections, GraphQLRequestError, type MapDetection } from './graphql.js';

const node = (i: number): MapDetection => ({
  id: `d${String(i)}`,
  label: 'car',
  observedAt: '2026-10-01T00:00:00Z',
  location: { type: 'Point', coordinates: [13.4, 52.5] },
  locationSource: 'DETECTION',
  detector: { name: 'Manual' },
  capture: { id: 'c1' },
});

/** Answers each request with a page of `first` nodes; `total` nodes match overall. */
function pagingFetch(total: number): { fetch: Fetch; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  let served = 0;
  const fetch: Fetch = (_input, init) => {
    const { variables } = JSON.parse(init?.body as string) as {
      variables: Record<string, unknown> & { first: number };
    };
    requests.push(variables);
    const count = Math.min(variables.first, total - served);
    const edges = Array.from({ length: count }, (_, i) => ({ node: node(served + i) }));
    served += count;
    const body = {
      data: {
        detections: {
          edges,
          pageInfo: { hasNextPage: served < total, endCursor: `cursor-${String(served)}` },
        },
      },
    };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return { fetch, requests };
}

describe('fetchMapDetections', () => {
  const bbox = { west: 13, south: 52, east: 14, north: 53 };

  it('follows endCursor until the last page', async () => {
    const { fetch, requests } = pagingFetch(230);

    const result = await fetchMapDetections(
      bbox,
      { observedFrom: '2026-01-01T00:00:00Z' },
      {
        fetchFn: fetch,
      },
    );

    expect(result.detections).toHaveLength(230);
    expect(result.truncated).toBe(false);
    expect(requests.map((r) => r.after)).toEqual([null, 'cursor-100', 'cursor-200']);
    expect(requests[0]?.filter).toEqual({ bbox, observedFrom: '2026-01-01T00:00:00Z' });
  });

  it('stops at 500 points and reports that more matched', async () => {
    const { fetch, requests } = pagingFetch(800);

    const result = await fetchMapDetections(bbox, {}, { fetchFn: fetch });

    expect(result.detections).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(requests).toHaveLength(5);
  });

  it('sends no bbox for the whole world', async () => {
    const { fetch, requests } = pagingFetch(1);

    await fetchMapDetections(undefined, {}, { fetchFn: fetch });

    expect(requests[0]?.filter).toEqual({});
  });

  it('throws the first GraphQL error with its code', async () => {
    const fetch: Fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: 'Invalid filter', extensions: { code: 'BAD_USER_INPUT' } }],
          }),
        ),
      );

    await expect(fetchMapDetections(bbox, {}, { fetchFn: fetch })).rejects.toEqual(
      new GraphQLRequestError('Invalid filter', 'BAD_USER_INPUT'),
    );
  });
});
