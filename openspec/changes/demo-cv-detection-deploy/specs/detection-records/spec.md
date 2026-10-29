# Spec Delta

## ADDED Requirements

### Requirement: Machine detections require the worker token
`POST /captures/:id/detections` for a detector of kind `ml` SHALL require the deployment's worker token in the `x-worker-token` header, and SHALL respond 403 without storing anything when it is missing or wrong. Detections for `manual` detectors SHALL NOT need a token. When the deployment has no worker token configured, `ml` detections SHALL be refused.

#### Scenario: Worker posts with the token
- **WHEN** the worker posts a `coco-objects` detection with the correct `x-worker-token`
- **THEN** the response is 201 with the detection

#### Scenario: Client posts an ML detection
- **WHEN** a client posts a `coco-objects` detection without `x-worker-token`, or with a wrong one
- **THEN** the response is 403 with error code `forbidden`, and no detection is stored

#### Scenario: Manual annotation unchanged
- **WHEN** a client posts a `manual` detection without a token
- **THEN** the response is 201 as before
