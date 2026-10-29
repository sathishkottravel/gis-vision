# Design

## Context

See `proposal.md` (Why) and the specs (`ml-detection`, `hosted-deployment`, and the `capture-ingest`, `detector-registry` and `detection-records` deltas) for the required behavior. What exists:

- **API:**
  - `buildApp(deps)` is host-agnostic.
  - `CaptureService.complete` (`apps/api/src/captures/capture-service.ts`) verifies the object, then flips `pending` → `ready` with a conditional `UPDATE ... WHERE status = 'pending' RETURNING`. Only the caller that wins that update gets a row back, and repeated completes return early.
  - `DetectionService.create` validates attributes against the detector's output schema (Ajv). The detector registry is a table seeded by migration (`0003_seed-manual-detector.sql`), and `detector_kind` already includes `ml`.
- **API settings:**
  - `DATABASE_SSL_CA` and `DATABASE_POOL_MAX` exist (Deploy v0, F2.5.2).
  - `NODE_ENV=production` disables GraphiQL and the demo seed.
  - There is no authentication: every route is public.
- **Database:**
  - It lives on the droplet, behind PgBouncer on `6432` with verified TLS (main spec `hosted-deployment`).
  - Migrations run as `gis_owner` through an SSH tunnel; the API connects as `gis_app`.
  - The cloud firewall and SSH hardening aren't done yet.
- **Earlier AWS design:** the archived Deploy v0 design (`openspec/changes/archive/2026-10-29-phase-2-5-deploy-v0/design.md`) already decided the Lambda entry (D6), the CDK layout (D7), web hosting with `/api` routing (D8), the runbook and smoke test (D13) and cost guardrails (D14). They are carried over here as D2-D4 and D11, adjusted where noted.
- **Tooling:**
  - CI runs lint, typecheck, unit tests and Testcontainers integration tests on Linux.
  - Local Docker Desktop on the maintainer's Windows machine is unreliable, so anything needing a Docker build runs in GitHub Actions.

## Goals / Non-Goals

**Goals:**
- A public demo in seven small PRs: upload a street photo and see labelled boxes from a real model on the capture page and on the map.
- Keep Phase 0-2 behavior unchanged. An upload never waits for or fails because of ML.
- Everything testable without AWS:
  - API changes via unit and integration tests;
  - the worker via pytest, with the real model on a fixture image;
  - the stacks via CDK assertion tests.

**Non-Goals:**
- **Full Phase 4:** a transactional outbox, pg-boss, a JobQueue contract suite, `detection_run` status, redrive tooling.
- **Full Phase 5:** generated cross-language contracts, model evaluation, fine-tuning, GPU.
- **Hardening:** authentication for users, rate limiting, droplet hardening beyond the firewall, backups.
- **Other phases:** a custom domain, CD pipelines, one-command deploy.

## Decisions

### D1. Order of features
- **FD.1 and FD.2 first:** the API and the web app go public before any ML work, so the deployment path is proven with Phase 0-2 features.
- **FD.3-FD.5 are cloud-free:** they're built and tested entirely locally and in CI.
- **FD.6 then FD.7:** FD.6 wires the worker to AWS; FD.7 adds the runbook, smoke test and budget.
- **On-AWS checks:** each feature that touches AWS ends with a check the maintainer runs with their account.

### D2. Lambda entry (carried over from Deploy v0 D6)
- **Handler:** `apps/api/src/lambda.ts` uses `@fastify/aws-lambda` over `buildApp`. The app and its infrastructure are built once per execution environment, with top-level await.
- **Secret:** `DATABASE_SECRET_ARN` names a Secrets Manager secret holding JSON `{ DATABASE_URL, DATABASE_SSL_CA, WORKER_TOKEN }`. It's merged into the environment before `loadConfig`, so its values never appear in CloudFormation or Lambda environment variables.
- **Runtime:** `DATABASE_POOL_MAX=1`, Node.js 22.x on arm64, 512 MB, 10 s timeout, reserved concurrency 10.
- *Alternative:* the Parameters and Secrets Lambda Extension. Rejected: an extra layer for one read per cold start.

### D3. AWS stacks (carried over from D7, simplified)
- **One CDK v2 app** in `deploy/aws` (`@gis-vision/deploy-aws`, workspace package), region `eu-central-1`, which is next to the droplet in `fra1`.
- **Two stacks:**
  - **`GisVisionWorkerRepo`:** the ECR repository, with a lifecycle rule keeping 5 images, and the GitHub OIDC deploy role (D9). It's deployed first, because the worker function needs an image to exist.
  - **`GisVisionApp`:**
    - the API function and HTTP API (`$default` route);
    - the private captures bucket (Block Public Access, `enforceSSL`, SSE-S3, retained on stack deletion, CORS `PUT`/`GET` from the CloudFront origin);
    - the secret, with a placeholder value that the runbook sets from a file;
    - the detection queue and DLQ (D6), the worker function (D9), the web hosting (D4) and the budget (D11).
- **Not built:** the Deploy v0 backups stack is deferred with backups.
- **Permissions:** grants are least-privilege. The API may get and put captures, list the bucket (HeadBucket for `/health`), read its secret and send to the queue. The worker may consume the queue and read its secret.
- **Tests:** CDK assertion tests run in the unit project. Bundling is skipped through the `aws:cdk:bundling-stacks` context, and the worker image is referenced by a fixed tag in tests.

### D4. Web hosting and `/api` routing (carried over from D8)
- **Static origin:** a private S3 bucket with Origin Access Control. `BucketDeployment` uploads `apps/web/dist` and invalidates the cache. HTTPS redirect, `index.html` root, price class 100.
- **API behavior:** `/api/*` points at the HTTP API origin, with all methods, `CachingDisabled` and `AllViewerExceptHostHeader`. A CloudFront Function strips `/api`.
- **No cycle:** the captures bucket's CORS origin is the distribution domain. The distribution depends only on the API and the web bucket.

### D5. Detector: YOLOX-S in ONNX
- **Model:** YOLOX-S (Megvii, Apache-2.0), using the official ONNX export from the YOLOX GitHub release (`yolox_s.onnx`, 640×640 input, 80 COCO classes, about 36 MB).
  - *Alternative:* YOLOv8 and YOLO11. Rejected: Ultralytics models are AGPL-3.0.
  - *Alternative:* RT-DETR. Rejected: larger and slower on CPU.
  - *Alternative:* SSD-MobileNet. Rejected: noticeably weaker on small street objects.
- **Not committed to git:** it's downloaded by `workers/cv/scripts/fetch-model.sh` from the pinned release URL and checked against a pinned SHA-256. That happens in the Docker build and in CI, with a cache.
- **Pre-processing:** letterbox resize to 640×640, padding 114. YOLOX's legacy export expects BGR float pixels 0-255 without normalization; the fixture test (D12) locks this in.
- **Post-processing:**
  1. Decode the 8400 grid predictions (strides 8/16/32), with score = objectness × class probability.
  2. Keep scores ≥ 0.5 (spec `ml-detection`), then run class-wise NMS at IoU 0.45.
  3. Map the boxes back to original pixels, clip them to the image, and round to integers with `w`, `h` ≥ 1.
- **Detector row:** migration `0005_seed-coco-detector.sql` inserts `coco-objects` (kind `ml`, version 1). Its output schema is a strict object requiring `class`, a string enum of the 80 COCO names in the model's class order, with no other properties. This fits the supported subset (`packages/schemas/src/detectors.ts`).
- **Detection fields:** `label` = class name; `confidence` = score rounded to 3 decimals; `attributes` = `{ class }`; no own location, so it falls back to the capture's (spec `detection-records`).

### D6. Detection trigger: the thin Phase 4 slice
- **Port:** `DetectionTrigger` with `requestDetection(captureId)` in `apps/api/src/detections/detection-trigger.ts`. It has two adapters:
  - **`SqsDetectionTrigger`:** `SendMessage` of `{"v":1,"captureId":"…","detectorId":"coco-objects"}` to `DETECTION_QUEUE_URL`. It's a standard queue (no FIFO needed, because the worker is idempotent).
  - **`NoopDetectionTrigger`:** used when `DETECTION_QUEUE_URL` is unset. It logs at debug level; locally the worker can be run by hand (D8).
- **When it's called:** `CaptureService.complete` calls it only when its conditional update returned the row, meaning this call made the capture `ready`. That satisfies "detection requested once" even for concurrent completes.
- **Awaited, not fire-and-forget:** Lambda freezes the environment after the response, so an unawaited send may never run. The send is awaited with a 2 s timeout, and errors are caught and logged with the request id, so the response is unchanged (spec `capture-ingest`).
- **Queue settings:** visibility timeout 360 s (6 × the worker's 60 s timeout), retention 4 days. The DLQ keeps messages 14 days, with `maxReceiveCount` 3 (spec `ml-detection`: three attempts).
- *Alternative:* an S3 `ObjectCreated` event. Rejected: it fires before `complete` validates the upload, and it fires for uploads that never complete.
- *Alternative:* the API invoking the worker Lambda asynchronously. Rejected: no DLQ semantics per message, and it couples the API to the worker's function name.
- **Known gap, accepted:** with no outbox, a failed send after the status update loses that capture's run. The failure is logged, and Phase 4 adds the outbox.

### D7. Worker token for `ml` detections
- **Why:** the API has no authentication, and anyone could post fake model output. `ml` detections therefore require `x-worker-token` (spec `detection-records`).
- **The check:** a new optional setting `WORKER_TOKEN`. `DetectionService.create` looks the detector up first. For kind `ml`, it compares the header with `crypto.timingSafeEqual` (after a length check) and throws a new `ForbiddenError` (403, code `forbidden`) on mismatch, or when `WORKER_TOKEN` is unset. The route passes the header through.
- **Storage:** the token is 32 random bytes in hex. The API reads it from its secret (D2); the worker reads the same secret's `WORKER_TOKEN` (D9).
- **Rotation:** update the secret; new execution environments pick it up.
- *Alternative:* the worker writes to the database directly. Rejected: it would bypass the API's validation and need database credentials in the worker.

### D8. CV worker (`workers/cv`)
- **Project:** Python 3.12, managed with uv (`pyproject.toml`, `uv.lock`). Dependencies: `onnxruntime`, `numpy`, `pillow`, `httpx`. Dev: `pytest`, `pyright` (strict), `ruff`.
- **Modules:**
  - **`detector.py`:** `YoloxDetector(model_path).detect(image) -> list[Found]` (pure, D5).
  - **`api.py`:** an `ApiClient` with three calls. `get_capture(id)` returns status and `imageUrl`. `has_detections(id, detector_id)` uses `GET /captures/:id/detections`. `post_detection(...)` sends the `x-worker-token`.
  - **`pipeline.py`:** `process(capture_id)` does:
    1. skip unless the capture is `ready`;
    2. skip if it already has `coco-objects` detections;
    3. download `imageUrl`, which is presigned and valid 300 s (enough for one attempt);
    4. detect, then post each detection.
  - **`handler.py`:** the Lambda SQS handler, with batch size 1 and partial batch responses. An exception fails the message so SQS retries it.
  - **`__main__.py`:** `uv run python -m cv <capture-id>` for local runs against `API_BASE_URL`.
- **Idempotency:** the "already has detections" check makes duplicate deliveries harmless (spec `ml-detection`). Two concurrent deliveries could still race. That's accepted for the demo, since reserved concurrency 2 and standard-queue semantics make it rare; Phase 4 adds run records.
- **Configuration (environment):** `API_BASE_URL` (the API's HTTP API URL, not CloudFront, to skip the extra hop), `WORKER_SECRET_ARN` or `WORKER_TOKEN` (local), `MODEL_PATH`, `SCORE_THRESHOLD` (default 0.5).

### D9. Worker deployment
- **Image:**
  - `workers/cv/Dockerfile` is based on the AWS Lambda Python 3.12 base image for arm64, pinned by digest.
  - The build installs the locked dependencies, fetches and verifies the model, and sets the handler to `cv.handler.handle`.
  - The workflow `.github/workflows/worker-image.yml` (`workflow_dispatch`, plus pushes to `main` touching `workers/cv/**`) runs on `ubuntu-24.04-arm`. It builds and pushes the image to ECR, tagged with the git SHA and `latest`, through the OIDC role from `GisVisionWorkerRepo`. If `GisVisionApp` exists, it then calls `aws lambda update-function-code`.
- **Function:** a `DockerImageFunction` using the ECR tag `latest`, 2048 MB, 60 s timeout, reserved concurrency 2, and an SQS event source with batch size 1 and `reportBatchItemFailures`. Logs are kept 14 days.
- **Order:** the first deploy pushes the image before `GisVisionApp` is created (runbook order).
- *Alternative:* building the image with CDK `DockerImageAsset` locally. Rejected: it needs a working local Docker and cross-arch builds.

### D10. Droplet firewall and SSH (minimum of Deploy v0 D10)
- **Cloud firewall:** `gis-vision-db`, created with `doctl compute firewall create`. Inbound is TCP 22 and 6432 from anywhere; outbound is all; it's attached to the droplet.
- **SSH:** a check that `sshd -T` reports `passwordauthentication no` and `permitrootlogin prohibit-password` (DigitalOcean's key-based default). If not, the droplet README gives the two `sshd_config.d` lines to set them.
- **Where it's documented:** both live in `deploy/droplet/README.md` as commands. The verification is an external port probe (`nc -zv` on 22, 5432, 5050, 6432) and a refused password login (`ssh -o PubkeyAuthentication=no`).
- **Deferred:** ufw, fail2ban and unattended upgrades go to the hardening change.

### D11. Runbook, smoke test, budget (carried over from D13 and D14)
- **`deploy/README.md`, in order:**
  1. Droplet status (from `deploy/droplet/README.md`) and the firewall.
  2. `cdk bootstrap`, then deploy `GisVisionWorkerRepo`.
  3. Run the worker-image workflow.
  4. `pnpm --filter @gis-vision/web build`, then deploy `GisVisionApp` (`-c budgetEmail=...`).
  5. Put the secret from a file.
  6. Migrations through the tunnel.
  7. Demo seed through the tunnel, from the maintainer's machine with the deploy bucket and the maintainer's AWS profile.
  8. Smoke test.
  9. Teardown and rollback.
- **Smoke test** (`pnpm --filter @gis-vision/deploy-aws smoke https://<origin>`):
  - `/api/health` ok, the HTTPS redirect, and no GraphiQL;
  - upload the fixture street photo, then wait up to 60 s for `coco-objects` detections;
  - post a manual detection, and check that a bbox search finds both.

  Each run leaves one `smoke:`-labelled capture in the Southern Ocean (0° E, 60° S), which is documented.
- **Budget:** a `CfnBudget` with a $5 monthly cost limit, notifying on actual and forecast > 100% to the required `budgetEmail` context. The API's and worker's reserved concurrency (10 and 2) cap spend.

### D12. Tests and CI
- **API:**
  - Unit tests: the trigger adapters (a fake SQS client, timeout and error swallowing); the worker-token check (constant-time path, missing or wrong token, no `WORKER_TOKEN`); the Lambda handler with an API Gateway v2 event.
  - Integration tests: complete → trigger called once; two concurrent completes → once; a throwing trigger → 200; the `coco-objects` row and schema; `ml` detections 403 without the token and 201 with it.
- **Worker (pytest):**
  - post-processing on synthetic tensors (decode, threshold, NMS, clipping);
  - the pipeline against a fake `ApiClient` (skip rules, idempotency, failure propagation);
  - one test running the real model on the fixture street photo, asserting at least one `car` or `person` ≥ 0.5. It's skipped only when the model file is absent; CI fetches it, so it runs in CI.
- **CI:** a new `worker` job in `ci.yml` runs `uv sync --locked`, `ruff check`, `pyright`, `fetch-model.sh` (cached by checksum) and `pytest`.
- **Fixture:** a CC0 street photo from Wikimedia Commons, at most 300 KB, in `workers/cv/tests/fixtures/` with a `SOURCE.md` naming its URL and licence. The smoke test reuses it.

## Risks / Trade-offs

- **[No outbox: a send failure after `complete` loses that run]** → It's logged with the capture id, and Phase 4 adds the outbox. Re-running is manual for now (`python -m cv <id>`).
- **[Concurrent duplicate deliveries could post two sets]** → Reserved concurrency 2, batch size 1 and the "already has detections" check make it rare, and Phase 4 adds run records.
- **[Worker cold start (about 3-6 s) plus inference (about 0.5-1.5 s on 2 GB arm64)]** → It fits the 60 s detection expectation, and the upload response doesn't wait (D6).
- **[Shared worker token]** → It's 32 random bytes kept only in Secrets Manager, compared in constant time, and rotated by updating the secret. User auth (Phase 8) replaces it for clients.
- **[Model licence and provenance]** → YOLOX is Apache-2.0. The model is pinned by checksum, and its licence and source are recorded in `workers/cv/README.md`.
- **[The droplet is only firewalled, with no fail2ban or backups]** → It holds demo data only. The hardening change follows, and the README states this.
- **[Fixture licence]** → Only CC0/public-domain images are used, and the source is recorded.
- **[Costs]** → The $5 budget and concurrency caps, ECR lifecycle (5 images), and 14-day log retention.

## Migration Plan

- **Database:** migration `0005_seed-coco-detector.sql` is additive, inserting one row. It runs through the tunnel as `gis_owner`. Rollback: `DELETE FROM detector WHERE id = 'coco-objects'`, once no `coco-objects` detections remain.
- **Settings:** the new API settings (`DATABASE_SECRET_ARN`, `DETECTION_QUEUE_URL`, `WORKER_TOKEN`) are optional. Without them, local behavior is unchanged: there is no trigger, and `ml` posts are refused.
- **Deployment order:** see D11.
- **Rollback:**
  - `cdk destroy GisVisionApp` removes the API, worker, queue, web and budget, but keeps the captures bucket.
  - `GisVisionWorkerRepo` is destroyed last, after deleting its images.
  - The droplet is unaffected.
