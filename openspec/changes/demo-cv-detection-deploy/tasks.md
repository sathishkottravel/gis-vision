# Tasks

## 1. FD.1 AWS stack and Lambda API

- [ ] 1.1 Add `@fastify/aws-lambda` and `@aws-sdk/client-secrets-manager` (versions at least two weeks old) and `apps/api/src/lambda.ts`: build the app once per execution environment and merge `DATABASE_URL`, `DATABASE_SSL_CA` and `WORKER_TOKEN` from the secret named by `DATABASE_SECRET_ARN` before `loadConfig` (design D2); verify unit tests that an API Gateway v2 `GET /health` event is answered through the handler with injected dependencies, and that secret values override the environment and never appear in logs
- [ ] 1.2 Create the CDK app `deploy/aws` (`@gis-vision/deploy-aws`, `aws-cdk-lib` and `constructs` at least two weeks old, `cdk.json`, `bin/app.ts`), add its tests to the unit project, and add the `GisVisionApp` stack's API part: `NodejsFunction` (Node.js 22.x, arm64, 512 MB, 10 s, reserved concurrency 10, `NODE_ENV=production`, `DATABASE_POOL_MAX=1`, 14-day logs), HTTP API with a `$default` route, the private captures bucket and the database secret with least-privilege grants (design D3); verify CDK assertion tests for each property and grant, and `cdk synth` offline
- [ ] 1.3 Document the droplet cloud firewall (`doctl compute firewall create` for TCP 22 and 6432) and the SSH check (`sshd -T`: password authentication off, root by key only) in `deploy/droplet/README.md`, with the outside checks (`nc -zv` on 22, 5432, 5050, 6432; a password-only `ssh` refused) (design D10); verify the commands against the documentation of `doctl` and OpenSSH, and that the README renders the steps in order
- [ ] 1.4 On AWS and the droplet (maintainer): create the firewall and check SSH, `cdk bootstrap` and deploy `GisVisionApp` (API part), put the secret value from a file, and call the HTTP API URL; verify `GET <api-url>/health` returns 200 with `status: "ok"`, and that from outside only 22 and 6432 answer

## 2. FD.2 Web hosting

- [ ] 2.1 Add the web hosting to `GisVisionApp`: private web bucket with Origin Access Control, CloudFront (HTTPS redirect, `index.html` root, price class 100), the `/api/*` behavior to the HTTP API with caching disabled and a CloudFront Function stripping `/api`, `BucketDeployment` of `apps/web/dist`, and the captures bucket's CORS for the distribution origin (design D4); verify CDK assertion tests for the behaviors and CORS, and a unit test of the CloudFront Function's prefix stripping
- [ ] 2.2 On AWS (maintainer): build the web app, deploy, and open the CloudFront URL; verify the header shows `API: ok`, an image uploads with a thumbnail, a manual detection can be added, the map shows detections, and `http://` redirects to `https://`

## 3. FD.3 ML detector registration

- [ ] 3.1 Add migration `0005_seed-coco-detector.sql` inserting `coco-objects` (kind `ml`, version 1) with a strict output schema requiring `class` from the 80 COCO names in model order (design D5); verify `db:check`, a unit test that the schema passes `checkDetectorSchema`, and integration tests that `GET /detectors` lists `manual` and `coco-objects`, `GET /detectors/coco-objects/schema` returns the enum, and `attributes.class: "unicorn"` is rejected with 422 on `attributes.class`
- [ ] 3.2 Add the optional setting `WORKER_TOKEN` and a `ForbiddenError` (403, `forbidden`), and require `x-worker-token` for detections of `ml` detectors with a constant-time comparison, refusing them when no token is configured (design D7); verify unit tests for the comparison and integration tests that a `coco-objects` detection is 403 without or with a wrong token and stores nothing, 201 with the right token, and that `manual` detections still need no token

## 4. FD.4 Detection trigger

- [ ] 4.1 Add the `DetectionTrigger` port with `SqsDetectionTrigger` (`@aws-sdk/client-sqs` at least two weeks old; `SendMessage` of `{v: 1, captureId, detectorId: "coco-objects"}`, 2 s timeout) and `NoopDetectionTrigger`, selected by the optional `DETECTION_QUEUE_URL` in `createAppDeps` (design D6); verify unit tests of the message body, the timeout and that errors are swallowed and logged
- [ ] 4.2 Call the trigger from `CaptureService.complete` only when its conditional update made the capture `ready`, awaited and with errors caught and logged with the request id; verify integration tests with a recording trigger: one call per new capture, none for a repeated complete, exactly one for two concurrent completes of the same capture, and a throwing trigger still returns 200 with `status: "ready"`
- [ ] 4.3 Add the detection queue (visibility 360 s, retention 4 days) and its DLQ (14 days, `maxReceiveCount` 3) to `GisVisionApp`, with `DETECTION_QUEUE_URL` and a send-only grant for the API (design D6); verify CDK assertion tests for the queues, redrive policy, environment variable and grant

## 5. FD.5 CV worker

- [ ] 5.1 Create `workers/cv` (Python 3.12, uv with `uv.lock`, `ruff`, strict `pyright`, `pytest`), `scripts/fetch-model.sh` (pinned YOLOX-S release URL and SHA-256), a CC0 street-photo fixture with `SOURCE.md`, and a `README.md` recording the model's and fixture's licences (design D5, D8, D12); verify `uv sync --locked`, `ruff check`, `pyright` and `pytest` pass locally and the fetched model matches its checksum
- [ ] 5.2 Implement `detector.py` (letterbox pre-processing, grid decode, score threshold 0.5, class-wise NMS at IoU 0.45, boxes mapped back, clipped and rounded) (design D5); verify unit tests on synthetic outputs for decode, threshold, NMS, clipping and minimum box size, and the real-model test that the fixture yields at least one `car` or `person` with confidence ≥ 0.5
- [ ] 5.3 Implement `api.py`, `pipeline.py`, `handler.py` (SQS, batch size 1, partial batch failures) and `__main__.py` (design D8); verify unit tests with a fake API client: a non-ready capture is skipped, a capture that already has `coco-objects` detections is skipped, found objects are posted with label, confidence, bbox, `attributes.class` and the worker token, and API or image errors fail the message
- [ ] 5.4 Add the `worker` job to `.github/workflows/ci.yml` (`uv sync --locked`, `ruff`, `pyright`, cached `fetch-model.sh`, `pytest`) and run the worker locally against the local API (`uv run python -m cv <capture-id>` with `WORKER_TOKEN` set on both); verify CI is green and the locally uploaded fixture capture shows `coco-objects` detections in the web app

## 6. FD.6 Worker deployment

- [ ] 6.1 Add `workers/cv/Dockerfile` (AWS Lambda Python 3.12 arm64 base pinned by digest, locked dependencies, verified model, handler `cv.handler.handle`) and the `GisVisionWorkerRepo` stack (ECR with a 5-image lifecycle, GitHub OIDC provider and a role limited to pushing to it and updating the worker function) (design D9); verify CDK assertion tests for the repository, lifecycle and trust policy (this repository, `main` only)
- [ ] 6.2 Add `.github/workflows/worker-image.yml` (`ubuntu-24.04-arm`, OIDC, build, push with SHA and `latest` tags, `update-function-code` when the function exists) and the worker `DockerImageFunction` in `GisVisionApp` (2048 MB, 60 s, reserved concurrency 2, SQS source with batch size 1 and batch item failures, secret read grant, `API_BASE_URL`, 14-day logs) (design D9); verify CDK assertion tests for the function, event source and grants, and that the workflow file passes `actionlint`
- [ ] 6.3 On AWS (maintainer): deploy `GisVisionWorkerRepo`, run the image workflow, redeploy `GisVisionApp`, and upload a street photo through the CloudFront site; verify `coco-objects` detections appear on the capture page and the map within 60 s, and that a message for a missing capture ends in the DLQ after three attempts

## 7. FD.7 Runbook and guardrails

- [ ] 7.1 Add the AWS Budgets alert to `GisVisionApp` ($5 monthly cost, actual and forecast notifications to the required `budgetEmail` context) (design D11); verify CDK assertion tests and that synth fails with a clear message without `budgetEmail`
- [ ] 7.2 Add the smoke test `deploy/aws/src/smoke.ts` and its `smoke` script (health, HTTPS redirect, no GraphiQL, fixture upload, `coco-objects` detections within 60 s, a manual detection, a bbox search finding both; label prefix `smoke:`) (design D11); verify it passes against the local stack with the worker run by hand, given a base URL
- [ ] 7.3 Write `deploy/README.md` (the full runbook in order, demo seed through the tunnel, rollback and teardown), add a "Deploy" section to the root README, and update `docs/ROADMAP.md` (this change, the reordering and what is deferred); verify every command is copied from the stacks, scripts and workflows as they are
- [ ] 7.4 On AWS (maintainer): run the smoke test against the CloudFront URL and confirm the budget; verify the smoke test passes and the budget shows with the email subscriber

## 8. Demo exit check

- [ ] 8.1 On the public URL: upload a street photo, see labelled `coco-objects` boxes on its capture page and on the map, add a manual detection, run the README's GraphQL examples under `/api/graphql`, and confirm only 22 and 6432 answer on the droplet; verify `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` and the worker job are green in CI

## Workflow follow-up

- Review the feature PRs, then archive with `/opsx:archive demo-cv-detection-deploy`. This adds `ml-detection` and updates `hosted-deployment`, `capture-ingest`, `detector-registry` and `detection-records` in `openspec/specs/`.
- Later changes then fill in what was deferred: droplet hardening (cleanup, ufw and fail2ban, backups), the full Phase 4 (outbox, queue contracts, run status), Phase 5's contracts and evaluation, then Phases 3 and 6-8.
