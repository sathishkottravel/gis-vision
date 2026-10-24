# Proposal

> **Skeleton.** Planned in detail when Phase 3 is archived. Features are implemented one at a time, in order.

## Why

Detection is still synchronous and manual. Real detectors are slow and can fail, so they must run asynchronously. This phase builds and proves the async plumbing (queue, outbox, idempotency, retries, dead-lettering) with a stub detector, before ML adds its own complexity.

## What Changes

- **F4.1 JobQueue port:** interface plus an in-memory fake and a shared contract test suite.
- **F4.2 pg-boss adapter:** a Postgres-backed queue for local and droplet use, passing the contract suite.
- **F4.3 Transactional outbox:** a capture write and its "detect" job are recorded atomically, then a relay publishes them to the queue.
- **F4.4 Stub detector worker:** a TS worker that consumes jobs and writes deterministic fake detections through the same validation path, with idempotent handling of duplicate deliveries.
- **F4.5 Failure handling:** retries with exponential backoff, a dead-letter queue, poison-message handling and redrive.
- **F4.6 Job status:** `detection_run` records exposed over REST and GraphQL (queued/running/succeeded/failed).
- **F4.7 SQS adapter:** an SQS adapter passing the same contract suite (via LocalStack), plus a Lambda SQS-triggered worker entry for the AWS deployment.

## Capabilities

### New Capabilities
- `detection-jobs`: enqueueing, executing, retrying and reporting the status of detection runs.

### Modified Capabilities
- `capture-ingest`: a new capture can trigger detection runs for the enabled detectors.

## Exit Criteria

upload -> job -> detections works end to end. Duplicate delivery, transient failure and poison-message scenarios are proven by tests on both queue adapters.

## Impact

`apps/api` (outbox, status API), new `apps/worker-stub`, `deploy/aws` (SQS, DLQ, worker Lambda). New deps: pg-boss, @aws-sdk/client-sqs, LocalStack in Compose.
