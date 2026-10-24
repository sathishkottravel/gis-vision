# Proposal

> **Skeleton.** Planned in detail when Phase 4 is archived. Features are implemented one at a time, in order.

## Why

The async pipeline works with a stub. This phase replaces it with a real computer-vision detector in Python, communicating with the Node/TS API only through the job contract. That makes it a genuine polyglot service boundary.

## What Changes

- **F5.0 Detector decision:** choose the first real detector (traffic signal state, pedestrian crossing, price tag, ...) and its output schema. This will be asked at planning time.
- **F5.1 Worker project:** `workers/cv` in Python, managed with uv, with pyright strict and pytest.
- **F5.2 Shared contract:** job and result schemas generated from `packages/schemas` (JSON Schema -> Pydantic), with cross-language contract tests.
- **F5.3 Inference:** ONNX Runtime CPU inference with a pretrained or fine-tuned model, plus image fetching via presigned URL.
- **F5.4 Result delivery:** idempotent result submission to the API, which validates against the detector schema.
- **F5.5 Deployment:** a Lambda container image (up to 10GB) triggered by the detection queue.
- **F5.6 Evaluation:** precision and recall measured against the manual annotations collected in earlier phases.

## Capabilities

### New Capabilities
- `ml-detection`: behaviour of ML detectors: inputs, outputs, confidence semantics and failure reporting.

### Modified Capabilities
- `detection-jobs`: the result submission contract for out-of-process workers.

## Exit Criteria

Uploading an image produces real ML detections on the map, and evaluation metrics are reported against the manual annotations.

## Impact

New `workers/cv` (Python), `packages/schemas` (contract export), `deploy/aws` (container Lambda). The model's size affects the Lambda's memory and cold start.
