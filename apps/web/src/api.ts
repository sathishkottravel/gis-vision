import type {
  Capture,
  CreateCaptureRequest,
  CreateCaptureResponse,
  CreateDetectionRequest,
  Detection,
  GeoJsonPoint,
} from '@gis-vision/schemas';

/** The API's error body: `{ error: { code, message, issues? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; issues?: { path: string; message: string }[] };
}

export type Fetch = typeof fetch;

/** Thin client for the REST API, which the Vite dev server proxies under `/api`. */
export class ApiClient {
  constructor(
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
    private readonly base = '/api',
  ) {}

  async health(): Promise<{ status: string } & Record<string, string>> {
    // 503 still carries the report, so read the body whatever the status.
    const res = await this.fetchFn(`${this.base}/health`);
    return (await res.json()) as { status: string } & Record<string, string>;
  }

  async listCaptures(limit = 50): Promise<Capture[]> {
    return (await this.request<{ items: Capture[] }>(`/captures?limit=${String(limit)}`)).items;
  }

  async getCapture(id: string): Promise<Capture> {
    return this.request<Capture>(`/captures/${encodeURIComponent(id)}`);
  }

  async listDetections(captureId: string): Promise<Detection[]> {
    const path = `/captures/${encodeURIComponent(captureId)}/detections`;
    return (await this.request<{ items: Detection[] }>(path)).items;
  }

  async createDetection(
    captureId: string,
    body: Omit<CreateDetectionRequest, 'attributes'> & { attributes?: unknown },
  ): Promise<Detection> {
    return this.request<Detection>(`/captures/${encodeURIComponent(captureId)}/detections`, {
      method: 'POST',
      body,
    });
  }

  /**
   * The presigned two-step upload (design D4a): create a pending capture, PUT the bytes
   * straight to object storage, then ask the API to verify them and mark the capture ready.
   */
  async uploadCapture(file: File, location?: GeoJsonPoint): Promise<Capture> {
    const request: CreateCaptureRequest = {
      contentType: file.type as CreateCaptureRequest['contentType'],
      byteSize: file.size,
      ...(location ? { location } : {}),
    };
    const pending = await this.request<CreateCaptureResponse>('/captures', {
      method: 'POST',
      body: request,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });

    const put = await this.fetchFn(pending.uploadUrl, {
      method: 'PUT',
      headers: pending.uploadHeaders,
      body: file,
    });
    if (!put.ok) {
      throw new ApiError(
        put.status,
        'upload_failed',
        `Upload to storage failed (${String(put.status)})`,
      );
    }

    return this.request<Capture>(`/captures/${pending.id}/complete`, { method: 'POST' });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    const json: unknown = text === '' ? undefined : JSON.parse(text);
    if (!res.ok) {
      const error = (json as ErrorBody | undefined)?.error;
      throw new ApiError(
        res.status,
        error?.code ?? 'http_error',
        error?.message ?? `Request failed (${String(res.status)})`,
        error?.issues,
      );
    }
    return json as T;
  }
}
