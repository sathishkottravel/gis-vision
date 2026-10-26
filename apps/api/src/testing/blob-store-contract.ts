import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobStore, Clock } from '../blob/blob-store.js';
import type { BlobFetch } from '../blob/memory-blob-store.js';

export interface BlobStoreSubject {
  store: BlobStore;
  /** Executes requests against the store's presigned URLs (global `fetch` for real stores). */
  fetch: BlobFetch;
}

/** Creates the store under test; `now` is the clock it signs URLs with. */
export type BlobStoreFactory = (now?: Clock) => BlobStoreSubject;

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('gis-vision')]);

/**
 * Behaviour every `BlobStore` adapter must share (design D5). Run it once per adapter:
 * against the in-memory fake in unit tests and against RustFS in integration tests.
 */
export function blobStoreContract(name: string, create: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name}`, () => {
    const { store, fetch } = create();
    const keys: string[] = [];

    function newKey(): string {
      const key = `contract/${randomUUID()}`;
      keys.push(key);
      return key;
    }

    afterEach(async () => {
      await Promise.all(keys.splice(0).map((key) => store.delete(key)));
    });

    it('puts, heads and deletes an object', async () => {
      const key = newKey();

      await store.put(key, BYTES, 'image/jpeg');
      expect(await store.head(key)).toEqual({
        byteSize: BYTES.byteLength,
        contentType: 'image/jpeg',
      });

      await store.delete(key);
      expect(await store.head(key)).toBeNull();
    });

    it('returns null from head for a missing key', async () => {
      expect(await store.head(newKey())).toBeNull();
    });

    it('treats deleting a missing key as success', async () => {
      await expect(store.delete(newKey())).resolves.toBeUndefined();
    });

    it('accepts an upload to a presigned PUT URL with the signed content type', async () => {
      const key = newKey();
      const upload = await store.presignPut(key, {
        contentType: 'image/png',
        expiresInSeconds: 60,
      });

      const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: BYTES });

      expect(res.ok).toBe(true);
      expect(upload.headers).toEqual({ 'content-type': 'image/png' });
      expect(await store.head(key)).toEqual({
        byteSize: BYTES.byteLength,
        contentType: 'image/png',
      });
    });

    it('rejects a presigned PUT with a different content type', async () => {
      const key = newKey();
      const upload = await store.presignPut(key, {
        contentType: 'image/png',
        expiresInSeconds: 60,
      });

      const res = await fetch(upload.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        body: BYTES,
      });

      expect(res.status).toBe(403);
      expect(await store.head(key)).toBeNull();
    });

    it('downloads the object bytes from a presigned GET URL', async () => {
      const key = newKey();
      await store.put(key, BYTES, 'image/jpeg');
      const download = await store.presignGet(key, { expiresInSeconds: 60 });

      const res = await fetch(download.url, { headers: download.headers });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    });

    it('rejects a presigned URL after it expires', async () => {
      const key = newKey();
      const hourAgo = new Date(Date.now() - 3_600_000);
      const expired = create(() => hourAgo);
      const upload = await expired.store.presignPut(key, {
        contentType: 'image/jpeg',
        expiresInSeconds: 60,
      });

      const res = await expired.fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: BYTES,
      });

      expect(upload.expiresAt.getTime()).toBeLessThan(Date.now());
      expect(res.status).toBe(403);
      expect(await expired.store.head(key)).toBeNull();
    });

    it('reports itself available', async () => {
      await expect(store.checkAvailable()).resolves.toBeUndefined();
    });
  });
}
