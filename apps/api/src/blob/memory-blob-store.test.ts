import { blobStoreContract } from '../testing/blob-store-contract.js';
import { MemoryBlobStore } from './memory-blob-store.js';

blobStoreContract('in-memory fake', (now) => {
  const store = new MemoryBlobStore(now);
  return { store, fetch: store.fetch };
});
