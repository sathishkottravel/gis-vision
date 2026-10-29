# Spec Delta

## MODIFIED Requirements

### Requirement: Complete a capture upload
`POST /captures/:id/complete` SHALL verify that the uploaded object exists and matches the declared content type and byte size, then set the capture's status to `ready`. The operation SHALL be idempotent. The completion that changes the capture from `pending` to `ready` SHALL also request machine detection for it (capability `ml-detection`); the response SHALL NOT wait for or depend on that request.

#### Scenario: Object uploaded correctly
- **WHEN** the client calls complete after a successful upload
- **THEN** the response is 200 with `status: "ready"`

#### Scenario: Object missing
- **WHEN** the client calls complete before uploading anything
- **THEN** the response is 409, and the capture stays `pending`

#### Scenario: Size mismatch
- **WHEN** the uploaded object's size differs from the declared byte size
- **THEN** the response is 409, and the capture stays `pending`

#### Scenario: Repeated completion
- **WHEN** the client calls complete on a capture that is already `ready`
- **THEN** the response is 200 with `status: "ready"`, and nothing changes

#### Scenario: Unknown capture
- **WHEN** the client calls complete with an id that does not exist
- **THEN** the response is 404

#### Scenario: Detection requested once
- **WHEN** two clients complete the same `pending` capture at the same time
- **THEN** both responses are 200 with `status: "ready"`, and detection is requested exactly once

#### Scenario: Detection request fails
- **WHEN** requesting detection fails during a successful completion
- **THEN** the response is still 200 with `status: "ready"`
