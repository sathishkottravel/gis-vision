import { afterAll } from 'vitest';
import { blobStoreContract } from '../testing/blob-store-contract.js';
import { integrationConfig } from '../testing/integration-app.js';
import { createS3Client, S3BlobStore } from './s3-blob-store.js';

const config = integrationConfig();
const client = createS3Client(config);

afterAll(() => {
  client.destroy();
});

blobStoreContract('S3 adapter against RustFS', (now) => ({
  store: new S3BlobStore(client, config.S3_BUCKET, now),
  fetch: (url, init) => fetch(url, init),
}));
