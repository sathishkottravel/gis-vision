import { randomUUID } from 'node:crypto';
import type {
  BlobHead,
  BlobStore,
  Clock,
  PresignedRequest,
  PresignGetOptions,
  PresignPutOptions,
} from './blob-store.js';

interface StoredBlob {
  body: Uint8Array;
  contentType: string;
}

interface Grant {
  method: 'GET' | 'PUT';
  key: string;
  contentType?: string;
  expiresAt: Date;
}

/** Fetch-compatible function that understands the fake's presigned URLs. */
export type BlobFetch = (url: string, init?: RequestInit) => Promise<Response>;

const URL_PREFIX = 'http://memory-blob-store.invalid/';

/**
 * In-memory `BlobStore` for unit tests. Its presigned URLs are not reachable over the
 * network; `fetch` serves them in-process with the same rules as S3: they expire, are
 * limited to one method and key, and uploads must use the signed content type.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly now: Clock = () => new Date()) {}

  presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest> {
    return Promise.resolve(
      this.grant(
        { method: 'PUT', key, contentType: options.contentType },
        options.expiresInSeconds,
      ),
    );
  }

  presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest> {
    return Promise.resolve(this.grant({ method: 'GET', key }, options.expiresInSeconds));
  }

  head(key: string): Promise<BlobHead | null> {
    const blob = this.blobs.get(key);
    return Promise.resolve(
      blob ? { byteSize: blob.body.byteLength, contentType: blob.contentType } : null,
    );
  }

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { body: Uint8Array.from(body), contentType });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }

  checkAvailable(): Promise<void> {
    return Promise.resolve();
  }

  /** Executes a request against a presigned URL, as object storage would. */
  readonly fetch: BlobFetch = async (url, init) => {
    const grant = url.startsWith(URL_PREFIX)
      ? this.grants.get(url.slice(URL_PREFIX.length))
      : undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (grant?.method !== method || Date.now() > grant.expiresAt.getTime()) {
      return new Response(null, { status: 403 });
    }
    if (grant.method === 'GET') {
      const blob = this.blobs.get(grant.key);
      return blob
        ? new Response(Uint8Array.from(blob.body), {
            headers: { 'content-type': blob.contentType },
          })
        : new Response(null, { status: 404 });
    }
    const contentType = new Headers(init?.headers).get('content-type');
    if (contentType !== grant.contentType) {
      return new Response(null, { status: 403 });
    }
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    await this.put(grant.key, body, contentType);
    return new Response(null, { status: 200 });
  };

  private grant(grant: Omit<Grant, 'expiresAt'>, expiresInSeconds: number): PresignedRequest {
    const expiresAt = new Date(this.now().getTime() + expiresInSeconds * 1000);
    const token = randomUUID();
    this.grants.set(token, { ...grant, expiresAt });
    return {
      url: URL_PREFIX + token,
      expiresAt,
      headers: grant.contentType ? { 'content-type': grant.contentType } : {},
    };
  }
}
