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

Uploading from a browser on another origin additionally needs a CORS rule on the bucket.

## Detectors

A detector is whatever records detections on a capture: a human (`manual`, seeded by a migration) or, later, an ML model. Each one declares a JSON Schema for its detection `attributes`.

- `GET /detectors` lists every detector with `id`, `name`, `version` and `kind` (`manual` or `ml`), ordered by id.
- `GET /detectors/:id/schema` returns that detector's output schema (`application/schema+json`), or 404.

Output schemas must stay within a subset that form generators (JSON Forms) can render: an object whose properties are strings, numbers, integers or booleans, enums of those, or arrays of them. `$ref`, nested objects and combinators such as `oneOf` are rejected; `checkDetectorSchema` in [`@gis-vision/schemas`](../../packages/schemas/src/detectors.ts) checks a schema and lists any violations. The `manual` schema allows free-form attributes (`additionalProperties: true`).
