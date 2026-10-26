/** Size and type of a stored object. */
export interface BlobHead {
  byteSize: number;
  contentType: string | undefined;
}

/** A time-limited URL the client calls directly, bypassing the API (design D4a). */
export interface PresignedRequest {
  url: string;
  expiresAt: Date;
  /** Headers the client must send unchanged, because they are part of the signature. */
  headers: Record<string, string>;
}

export interface PresignPutOptions {
  /** The only content type the upload is allowed to use. */
  contentType: string;
  expiresInSeconds: number;
}

export interface PresignGetOptions {
  expiresInSeconds: number;
}

/**
 * Object storage port (design D5). The S3-API adapter covers RustFS, AWS S3 and
 * DigitalOcean Spaces; the in-memory fake serves unit tests. Both pass the same
 * contract suite (`testing/blob-store-contract.ts`).
 */
export interface BlobStore {
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest>;
  presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest>;
  /** Returns `null` when no object exists under `key`. */
  head(key: string): Promise<BlobHead | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Rejects unless the store and its bucket are reachable; used by `/health`. */
  checkAvailable(signal?: AbortSignal): Promise<void>;
}

/** Clock used for signing, injectable so tests can mint URLs that are already expired. */
export type Clock = () => Date;
