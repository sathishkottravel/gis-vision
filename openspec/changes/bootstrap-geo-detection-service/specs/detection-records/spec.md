# Spec Delta

## Purpose

Records what a detector found in a capture (label, confidence, bounding box, location, time and detector-specific attributes), with the attributes validated against the detector's schema. Detections are the core space-and-time data of the system.

## ADDED Requirements

### Requirement: Create a detection on a capture
`POST /captures/:id/detections` SHALL accept a detector id, label, optional confidence, a pixel bounding box, an optional GeoJSON Point location, an optional observation time and an attributes object. It SHALL store the detection and respond 201 with it.

#### Scenario: Valid manual annotation
- **WHEN** a client posts detector `manual`, label `stop-sign`, a bounding box inside the image and attributes `{}` on a `ready` capture
- **THEN** the response is 201 with the detection, including its id

### Requirement: Attributes are validated against the detector schema
The system SHALL validate the attributes against the detector's output schema and reject invalid attributes with 422, listing each violation with its path.

#### Scenario: Attributes violate schema
- **WHEN** a detector's schema requires `state` to be one of `red|amber|green` and a client posts `state: "blue"`
- **THEN** the response is 422 and the errors identify `state`

#### Scenario: Unknown detector
- **WHEN** a client posts a detection with a detector id that does not exist
- **THEN** the response is 422 and identifies the detector field

### Requirement: Detections only on ready captures
The system SHALL reject a detection on a capture that does not exist (404) or is still `pending` (409).

#### Scenario: Pending capture
- **WHEN** a client posts a detection on a `pending` capture
- **THEN** the response is 409

#### Scenario: Missing capture
- **WHEN** a client posts a detection on an id that does not exist
- **THEN** the response is 404

### Requirement: Bounding box and confidence are well formed
The bounding box SHALL have non-negative x and y and positive width and height. Confidence, when given, SHALL be between 0 and 1 inclusive. Invalid values SHALL be rejected with 400.

#### Scenario: Negative width
- **WHEN** a client posts a bounding box with width -5
- **THEN** the response is 400 and identifies the bounding box field

#### Scenario: Confidence out of range
- **WHEN** a client posts confidence 1.5
- **THEN** the response is 400 and identifies the confidence field

### Requirement: Location and time default from the capture
When a detection omits its observation time, the system SHALL use the capture's capture time. When it omits a location, its effective location SHALL be the capture's location (which may be null).

#### Scenario: Omitted time
- **WHEN** a detection is created without an observation time on a capture taken at 2026-03-01T10:00:00Z
- **THEN** the stored detection's observation time is 2026-03-01T10:00:00Z

#### Scenario: Omitted location
- **WHEN** a detection is created without a location on a capture that has a location
- **THEN** the returned detection's effective location equals the capture's location

### Requirement: Detections stored for any observation time
The system SHALL accept and store detections for any observation time, including times far in the past or future, without the client knowing how storage is organized.

#### Scenario: Observation in an old month
- **WHEN** a detection is created with an observation time three years ago
- **THEN** it is stored and returned like any other detection

#### Scenario: Month boundary
- **WHEN** detections are created at 2026-01-31T23:59:59Z and 2026-02-01T00:00:00Z
- **THEN** both are stored and both appear in the capture's detection list

### Requirement: List detections of a capture
`GET /captures/:id/detections` SHALL return all detections of the capture, ordered by observation time, each with its detector id, label, confidence, bounding box, effective location as GeoJSON, observation time and attributes.

#### Scenario: Capture with detections
- **WHEN** a client lists detections on a capture that has two
- **THEN** the response is 200 with both detections, ordered by observation time

#### Scenario: Unknown capture
- **WHEN** a client lists detections on an id that does not exist
- **THEN** the response is 404
