import type { FastifyBaseLogger } from 'fastify';
import type { BlobStore } from '../blob/blob-store.js';
import type { Database } from '../db/client.js';
import { createLoaders, type Loaders } from './loaders.js';

/** What resolvers read data through; built once per request (design D2, D5). */
export interface DataContext {
  db: Database;
  blobStore: BlobStore;
  /** Lifetime of `Capture.imageUrl` (`IMAGE_URL_TTL_SECONDS`). */
  imageUrlTtlSeconds: number;
  /** Per-request batching loaders; nothing is cached across requests. */
  loaders: Loaders;
}

/** Per-request GraphQL context. */
export interface GraphQLContext extends DataContext {
  log: FastifyBaseLogger;
  requestId: string;
}

export interface DataContextDeps {
  db: Database;
  blobStore: BlobStore;
  imageUrlTtlSeconds: number;
}

/** Returns a factory that gives every request fresh loaders over the shared dependencies. */
export function dataContextFactory(deps: DataContextDeps): () => DataContext {
  return () => ({ ...deps, loaders: createLoaders(deps.db) });
}
