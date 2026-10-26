import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import type {
  BlobHead,
  BlobStore,
  Clock,
  PresignedRequest,
  PresignGetOptions,
  PresignPutOptions,
} from './blob-store.js';

export type S3Config = Pick<
  Config,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

/**
 * S3 client for any S3-API store. `S3_ENDPOINT` points it at RustFS (or Spaces), and
 * RustFS needs path-style URLs. Without explicit keys the default AWS credential chain applies.
 */
export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // By default the SDK signs a CRC32 of the (empty) request body into presigned PUT URLs,
    // which AWS S3 then rejects for the real upload. Checksums only where an operation needs them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

/** `BlobStore` over the S3 API: RustFS locally, AWS S3 or DigitalOcean Spaces when deployed. */
export class S3BlobStore implements BlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly now: Clock = () => new Date(),
  ) {}

  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
    });
    // Signing `content-type` makes storage reject uploads with any other type.
    return this.presign(command, options.expiresInSeconds, { 'content-type': options.contentType });
  }

  async presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return this.presign(command, options.expiresInSeconds, {});
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { byteSize: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async checkAvailable(signal?: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
  }

  private async presign(
    command: PutObjectCommand | GetObjectCommand,
    expiresInSeconds: number,
    headers: Record<string, string>,
  ): Promise<PresignedRequest> {
    const signingDate = this.now();
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signingDate,
      signableHeaders: new Set(Object.keys(headers)),
    });
    return { url, expiresAt: new Date(signingDate.getTime() + expiresInSeconds * 1000), headers };
  }
}
