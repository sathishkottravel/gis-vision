# @gis-vision/api

Fastify REST API. See the [root README](../../README.md) for setup, and the OpenSpec [design](../../openspec/changes/bootstrap-geo-detection-service/design.md) for the decisions referenced below.

## Capture upload flow

Image bytes never pass through the API (design D4a). The client asks for a presigned URL, uploads straight to object storage (RustFS locally, S3 when deployed), and then asks the API to verify the upload.

```
 client                          api                               object storage
   | POST /captures {meta}         |                                      |
   |------------------------------>| insert capture (status: pending)     |
   |<------------------------------| 201 {id, uploadUrl, uploadHeaders,   |
   |                               |      expiresAt}                      |
   | PUT uploadUrl (image bytes, uploadHeaders) ------------------------->|
   |<---------------------------------------------------------------- 200 |
   | POST /captures/:id/complete   |                                      |
   |------------------------------>| HEAD object: exists, size, type ---->|
   |<------------------------------| 200 {status: ready, imageUrl}        |
   | GET imageUrl --------------------------------------------------------->|
```

- **Create** (`POST /captures`): body `contentType` (`image/jpeg`, `image/png` or `image/webp`), `byteSize` (at most `UPLOAD_MAX_BYTES`), optional `capturedAt` (ISO 8601 with offset; defaults to the creation time) and optional `location` (GeoJSON Point, `[longitude, latitude]` in WGS84). Invalid fields return 400 with `error.issues[].path`.
- **Idempotency:** send an `Idempotency-Key` header to make retries safe. The same key with the same body returns the original capture (header `idempotent-replayed: true`); the same key with a different body returns 409.
- **Upload:** `PUT` the bytes to `uploadUrl` with exactly the `uploadHeaders` returned (the content type is part of the signature) before `expiresAt` (`UPLOAD_URL_TTL_SECONDS`, default 15 minutes).
- **Complete** (`POST /captures/:id/complete`): 200 with `status: "ready"`, or 409 (`upload_missing`, `upload_size_mismatch`, `upload_type_mismatch`) with the capture left `pending`. Repeating it on a ready capture is harmless.
- **Read:** `GET /captures/:id` includes `imageUrl` (valid for `IMAGE_URL_TTL_SECONDS`) once the capture is ready. `GET /captures?limit=20` lists newest first; `limit` is 1-100.

### Detailed trace: web page to Postgres and RustFS

What one upload from the web page (`apps/web`, see [Run the web app](../../README.md#run-the-web-app)) does at each hop, including every error exit. Participants: the browser (`UploadForm` in `Home.tsx`, `ApiClient` in `apps/web/src/api.ts`), the Vite dev server (proxies `/api/*` to the API and strips `/api`), the API (`captureRoutes` -> `CaptureService` -> `S3BlobStore` and Drizzle), Postgres (table `capture`) and RustFS (bucket `captures`, key `images/<id>`).

```
 Browser (UploadForm/ApiClient)   Vite :5173        API :3000 (Fastify)                     Postgres            RustFS :9000
 ─────────────────────────────    ──────────        ──────────────────────                  ────────            ────────────
 submit → parseLocation(lat,lon)
 uploadCapture(file, location)
 ① POST /api/captures ─────────────▶ proxy ────────▶ POST /captures
    {contentType, byteSize, location}                 parseInput(createCaptureRequestSchema)  ✗ 400 invalid_request
    idempotency-key: <uuid>                           check idempotency-key header            ✗ 400
                                                      CaptureService.create
                                                        id = randomUUID, blobKey images/<id>
                                                        hash = sha256(request)
                                                        INSERT capture ───────────────────────▶ row status=pending
                                                          ON CONFLICT (idempotency_key)        geom POINT 4326
                                                          DO NOTHING RETURNING ◀──────────────  captured_at=now()
                                                        (conflict → SELECT, hash differs        meta.requestHash
                                                          → ✗ 409 idempotency_key_reused)
                                                        blobStore.presignPut(images/<id>,
                                                          content-type, 900 s)  [local signing,
                                                          no network call]
    ◀────────────────────────────── 201 {id, status:pending, uploadUrl, uploadHeaders, expiresAt}
                                                                                               DB: pending   Blob: (none)
 ② OPTIONS uploadUrl (CORS preflight, Origin :5173) ──────────────────────────────────────────────────────▶ bucket CORS rule
    ◀──────────────────────────────────────────────────────────────────────── 200 allow-origin :5173      (rustfs-init, WEB_ORIGIN)
    PUT uploadUrl  content-type: image/png  body=file bytes ─────────────────────────────────────────────▶ verify SigV4:
      (API and Vite not involved)                                                                         method, key, content-type,
                                                                                                          expiry  ✗ 403
                                                                                                          store captures/images/<id>
    ◀──────────────────────────────────────────────────────────────────────────────────────────── 200
      (non-2xx → ApiError upload_failed; step ③ is skipped)                    DB: pending   Blob: images/<id>
 ③ POST /api/captures/<id>/complete ─▶ proxy ──────▶ CaptureService.complete
                                                        findCapture ──────────────────────────▶ SELECT     ✗ 404 not_found
                                                        already ready? → return as is
                                                        blobStore.head(images/<id>) ─────────────────────────────▶ HeadObject
                                                          ◀─────────────────────────────────────────────── size, content-type
                                                        missing → ✗ 409 upload_missing
                                                        size ≠ byteSize → ✗ 409 upload_size_mismatch
                                                        type ≠ contentType → ✗ 409 upload_type_mismatch
                                                        UPDATE capture SET status='ready' ────▶ row status=ready
                                                          WHERE id AND status='pending'
                                                        presignGet(images/<id>, 300 s)
    ◀────────────────────────────── 200 {status:ready, imageUrl}
                                                                                               DB: ready     Blob: images/<id>
 ④ onUploaded → GET /api/captures?limit=50 ─▶ proxy ─▶ list: ORDER BY created_at DESC ───────▶ SELECT
                                                        fresh presignGet per ready capture
    ◀────────────────────────────── 200 {items:[…imageUrl]}
    <img src=imageUrl> ─────────────────────────────────────────────────────────────────────────────────────▶ GetObject (signed)
    ◀──────────────────────────────────────────────────────────────────────────────────────────── image bytes → thumbnail
```

- Every ✗ goes through `errorHandler` (`src/http/error-handler.ts`) as `{ error: { code, message, issues? } }`; the page turns it into an `ApiError` and shows it with `ErrorMessage.tsx`.
- **State after each step:** pending row and no object (1), pending row and object (2), ready row and object (3). An abandoned upload leaves a pending row; nothing cleans those up yet.
- **Integrity:** the content type is signed into the PUT URL, so storage rejects any other type (403). The size is not in the signature; `complete` compares the stored object with `byteSize`. Retries are safe through `Idempotency-Key` plus the stored `requestHash`.
- **CORS:** the browser's direct PUT works only because `rustfs-init` gives the bucket a CORS rule for `WEB_ORIGIN`; the `<img>` GET needs none.
- **Location:** GeoJSON `[lon, lat]` is stored as `geometry(Point, 4326)` with `x = lon`, `y = lat` (`pointGeometry` in `src/db/geometry.ts`).
- **Tests per step:** `src/captures/captures.int.test.ts` (1, 3, 4), `src/blob/s3-blob-store.int.test.ts` (presigned PUT/GET and HEAD against RustFS), `apps/web/src/api.test.ts` (order 1 -> 2 -> 3).

### Try it with curl

With Compose and `pnpm --filter @gis-vision/api dev` running, from a bash shell (Git Bash on Windows). `photo.jpg` is any JPEG; `node -p` stands in for `jq`.

```sh
SIZE=$(wc -c < photo.jpg)

# 1. Create a pending capture and get the upload URL
curl -s localhost:3000/captures \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d "{\"contentType\":\"image/jpeg\",\"byteSize\":$SIZE,\"location\":{\"type\":\"Point\",\"coordinates\":[13.4,52.5]}}" \
  > capture.json
ID=$(node -p "require('./capture.json').id")
UPLOAD_URL=$(node -p "require('./capture.json').uploadUrl")

# 2. Upload the image straight to object storage
curl -s -X PUT "$UPLOAD_URL" -H 'content-type: image/jpeg' --data-binary @photo.jpg -w '%{http_code}\n'

# 3. Verify the upload and mark the capture ready
curl -s -X POST "localhost:3000/captures/$ID/complete"

# 4. Read it back; imageUrl downloads the image
curl -s "localhost:3000/captures/$ID"
curl -s "localhost:3000/captures?limit=5"
```

Uploading from a browser on another origin additionally needs a CORS rule on the bucket. Locally, Compose's `rustfs-init` allows `WEB_ORIGIN` (the web app); see [Run the web app](../../README.md#run-the-web-app).

## Detectors

A detector is whatever records detections on a capture: a human (`manual`, seeded by a migration) or, later, an ML model. Each one declares a JSON Schema for its detection `attributes`.

- `GET /detectors` lists every detector with `id`, `name`, `version` and `kind` (`manual` or `ml`), ordered by id.
- `GET /detectors/:id/schema` returns that detector's output schema (`application/schema+json`), or 404.

Output schemas must stay within a subset that form generators (JSON Forms) can render: an object whose properties are strings, numbers, integers or booleans, enums of those, or arrays of them. `$ref`, nested objects and combinators such as `oneOf` are rejected; `checkDetectorSchema` in [`@gis-vision/schemas`](../../packages/schemas/src/detectors.ts) checks a schema and lists any violations. The `manual` schema allows free-form attributes (`additionalProperties: true`).

## Detections

A detection records what a detector found on a `ready` capture: a label, an optional confidence, a pixel bounding box, a location and time, and detector-specific `attributes`.

- `POST /captures/:id/detections` with `detectorId`, `label`, `bbox` (`{x, y, w, h}` in pixels; `x`, `y` at least 0, `w`, `h` above 0) and optional `confidence` (0-1), `location` (GeoJSON Point), `observedAt` (ISO 8601 with offset) and `attributes` (default `{}`). Responds 201 with the detection.
- `GET /captures/:id/detections` returns `{ items }` ordered by `observedAt`.
- **Defaults:** without `observedAt`, the capture's `capturedAt` is used. Without `location`, none is stored and the response's `location` is the capture's (it may be `null`).
- **Errors:** 400 for a malformed body (`error.issues[].path`, e.g. `bbox.w`), 404 for an unknown capture, 409 `capture_not_ready` while the upload is pending, and 422 for an unknown detector (`unknown_detector`, path `detectorId`) or attributes that violate the detector's output schema (`invalid_attributes`, paths like `attributes.state`). Attributes are checked with Ajv; compiled schemas are cached per detector version, so a detector's schema changes only with a new version.
- Any observation time is accepted: detections are stored in monthly partitions, and times outside the pre-created months go to a default partition.

```sh
curl -s "localhost:3000/captures/$ID/detections" -H 'content-type: application/json' \
  -d '{"detectorId":"manual","label":"stop-sign","bbox":{"x":10,"y":20,"w":40,"h":30},"attributes":{"note":"faded"}}'
curl -s "localhost:3000/captures/$ID/detections"
```
