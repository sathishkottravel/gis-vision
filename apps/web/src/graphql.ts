import type { Fetch } from './api.js';
import type { BoundingBox } from './map-bounds.js';
import type { ObservedRange } from './time-range.js';

/** A GraphQL error response: `errors[0]` with its `extensions.code` (design D9). */
export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * POSTs a query to `/api/graphql` (proxied to the API like REST). A plain `fetch` with the
 * query text; a client library comes with Phase 3 (design D11).
 */
export async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { fetchFn?: Fetch; signal?: AbortSignal } = {},
): Promise<T> {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const res = await fetchFn('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: options.signal,
  });
  const body = (await res.json()) as GraphQLResponse<T>;
  const error = body.errors?.[0];
  if (error) {
    throw new GraphQLRequestError(error.message, error.extensions?.code ?? 'GRAPHQL_ERROR');
  }
  if (!body.data) {
    throw new GraphQLRequestError(`Request failed (${String(res.status)})`, 'HTTP_ERROR');
  }
  return body.data;
}

export type LocationSource = 'DETECTION' | 'CAPTURE' | 'NONE';

export interface MapDetection {
  id: string;
  label: string;
  observedAt: string;
  location: { type: 'Point'; coordinates: [number, number] } | null;
  locationSource: LocationSource;
  detector: { name: string };
  capture: { id: string };
}

const MAP_DETECTIONS = /* GraphQL */ `
  query MapDetections($filter: DetectionFilter, $first: Int, $after: String) {
    detections(filter: $filter, first: $first, after: $after) {
      edges {
        node {
          id
          label
          observedAt
          location
          locationSource
          detector {
            name
          }
          capture {
            id
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface MapDetectionsData {
  detections: {
    edges: { node: MapDetection }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export const MAP_POINT_LIMIT = 500;
const PAGE_SIZE = 100;

/**
 * Detections in `bbox` (all of them without one) and the time range, following `endCursor`
 * until `MAP_POINT_LIMIT` points. `truncated` is true when more matched.
 */
export async function fetchMapDetections(
  bbox: BoundingBox | undefined,
  range: ObservedRange,
  options: { fetchFn?: Fetch; signal?: AbortSignal } = {},
): Promise<{ detections: MapDetection[]; truncated: boolean }> {
  const filter = { ...(bbox ? { bbox } : {}), ...range };
  const detections: MapDetection[] = [];
  let after: string | null = null;
  for (;;) {
    const first = Math.min(PAGE_SIZE, MAP_POINT_LIMIT - detections.length);
    const data: MapDetectionsData = await graphqlRequest<MapDetectionsData>(
      MAP_DETECTIONS,
      { filter, first, after },
      options,
    );
    const { edges, pageInfo } = data.detections;
    detections.push(...edges.map((edge) => edge.node));
    if (!pageInfo.hasNextPage) {
      return { detections, truncated: false };
    }
    if (detections.length >= MAP_POINT_LIMIT) {
      return { detections, truncated: true };
    }
    after = pageInfo.endCursor;
  }
}
