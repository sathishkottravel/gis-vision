# Proposal

## Why

Phases 0-2 work locally, and the droplet database is online (Deploy v0: PostGIS, PgBouncer with verified TLS, pgAdmin). What's missing for a working demo is a public site and something the demo can show off beyond manual annotation. This change does both in one go:
- it puts the API and web app on AWS;
- it adds real machine-learning detections, so an uploaded street photo comes back with detected objects on its capture page and on the map.

It takes the shortest path to that result. The full async pipeline (Phase 4), the full CV phase (Phase 5) and droplet hardening come later, without blocking the demo.

## What Changes

Each feature is delivered on its own branch with its own PR. Feature ids are `FD.n` (demo).

- **FD.1 AWS stack and Lambda API:**
  - Lambda entry `apps/api/src/lambda.ts`, wrapping `buildApp` with `@fastify/aws-lambda` and reading the database settings from Secrets Manager.
  - CDK app `deploy/aws` with an HTTP API, a private captures bucket with CORS for presigned uploads, and the database secret.
  - The droplet's DigitalOcean cloud firewall (SSH and the TLS pooler port only) and key-only SSH, since the pooler port is now used from the internet.
- **FD.2 Web hosting:** the static `apps/web` build on S3 + CloudFront. CloudFront also routes `/api/*` to the API, so the browser sees one origin as in local development.
- **FD.3 ML detector:**
  - A built-in detector `coco-objects` (kind `ml`). It uses a pretrained, Apache-2.0 licensed COCO object detector (YOLOX-S) in ONNX format, with an output schema naming the 80 COCO classes.
  - Detections from an `ml` detector may only be posted with the worker token.
- **FD.4 Detection trigger:** completing a capture upload (the `pending` → `ready` transition only) sends one detection job to a queue (SQS with a dead-letter queue in AWS, a no-op locally).
  - The upload response is unchanged, and a failed send is logged, not surfaced.
  - This is a thin slice of Phase 4: no outbox, pg-boss or job status yet.
- **FD.5 CV worker:** a Python worker (`workers/cv`, uv, pytest, pyright):
  1. It takes a job, fetches the image through the API's presigned URL, and runs ONNX Runtime on CPU.
  2. It posts detections above a confidence threshold through the existing REST endpoint, which validates them.
  3. It is idempotent per capture, skipping a capture that already has its detections.
- **FD.6 Worker deployment:** the worker as a Lambda container image (ECR) triggered by SQS, built and pushed by GitHub Actions, since local Docker is unreliable here.
- **FD.7 Runbook and guardrails:**
  - a manual deploy runbook (`deploy/README.md`);
  - a post-deploy smoke test, including an upload that receives ML detections;
  - a $5 AWS Budgets alert and a Lambda concurrency cap;
  - README and roadmap updates.

**Deferred** (later changes, nothing removed):
- Phase 3 (schema-driven UI).
- The full Phase 4: transactional outbox, pg-boss, retries/redrive tooling, `detection_run` status.
- Phase 5's generated cross-language contracts (F5.2) and evaluation (F5.6).
- Droplet hardening: `pg_cron` cleanup, ufw and fail2ban, backups, restore rehearsal.
- Phases 6-8.

## Capabilities

### New Capabilities
- `ml-detection`: how machine detections are produced. This covers what triggers a run, the inputs (a ready capture's image), the outputs (labels, boxes, confidence above a threshold), idempotency, failure handling (retries, then the dead-letter queue) and the guarantee that uploads never wait for or fail because of detection.

### Modified Capabilities
- `capture-ingest`: completing an upload starts machine detection once, when the capture becomes `ready`. The completion response and its idempotency are unchanged.
- `detector-registry`: a second built-in detector `coco-objects` (kind `ml`) with its output schema.
- `detection-records`: posting a detection for an `ml` detector requires the worker token. Manual detections are unchanged.
- `hosted-deployment`: the public deployment, adding:
  - one HTTPS origin for the web app and the API;
  - the end-to-end flow online (now including ML detections);
  - production behavior;
  - a firewalled database host (SSH with keys and the pooler port only);
  - cost guardrails.

## Impact

- **`apps/api`:**
  - `src/lambda.ts`.
  - A `DetectionTrigger` port with SQS and no-op adapters, wired into capture completion.
  - A worker-token check for `ml` detections.
  - A migration seeding `coco-objects`.
  - New optional settings `DATABASE_SECRET_ARN`, `DETECTION_QUEUE_URL` and `WORKER_TOKEN`.
- **New folders:**
  - `deploy/aws`: a CDK app (workspace package) with assertion tests.
  - `workers/cv`: a Python package with its own tests and Dockerfile.
- **New dependencies:**
  - `@fastify/aws-lambda`, `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-sqs` (API).
  - `aws-cdk-lib`, `constructs` and `esbuild` (deploy/aws).
  - `onnxruntime`, `numpy`, `pillow` and `httpx` (worker).
  - The YOLOX-S ONNX model file, fetched at image build time and pinned by checksum.
- **CI:** a Python job (lint, typecheck, tests), and a workflow that builds and pushes the worker image when it's run manually.
- **Runtime cost:**
  - At demo traffic, Lambda, API Gateway, S3, CloudFront, SQS and ECR stay within the free tier or cost cents.
  - Secrets Manager costs $0.40/mo per secret (two secrets).
  - The droplet costs about $6/mo.
- **Operations:** deploying needs the maintainer's AWS account. Every feature is first verified locally and in CI, then on AWS by the maintainer.
