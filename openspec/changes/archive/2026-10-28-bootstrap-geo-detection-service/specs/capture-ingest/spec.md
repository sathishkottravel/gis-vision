# Spec Delta

## Purpose

Lets clients register images (captures) with optional location and capture time, upload the image bytes directly to object storage, and retrieve captures. Captures are the source records that detections refer to.

## ADDED Requirements

### Requirement: Initiate a capture upload
`POST /captures` SHALL accept capture metadata (content type, byte size, optional capture time, optional GeoJSON Point location) and create a capture in `pending` status. It SHALL respond 201 with the capture id, a presigned upload URL and the URL's expiry time.

#### Scenario: Valid metadata with location
- **WHEN** a client posts content type `image/jpeg`, a byte size within limits, a capture time and a GeoJSON Point
- **THEN** the response is 201 with `id`, `status: "pending"`, `uploadUrl` and `expiresAt`

#### Scenario: Valid metadata without location or time
- **WHEN** a client posts only content type and byte size
- **THEN** the response is 201, and the capture has no location and a capture time equal to the creation time

### Requirement: Reject invalid upload metadata
The system SHALL reject a capture request with 400 and a field-level error when the content type is not an allowed image type (`image/jpeg`, `image/png`, `image/webp`), the byte size is not positive or exceeds the configured maximum, or the location is not a valid GeoJSON Point in WGS84 range.

#### Scenario: Unsupported content type
- **WHEN** a client posts content type `application/pdf`
- **THEN** the response is 400 and identifies the content type field

#### Scenario: File too large
- **WHEN** a client posts a byte size above the configured maximum
- **THEN** the response is 400 and identifies the size field

#### Scenario: Coordinates out of range
- **WHEN** a client posts a Point with latitude 95
- **THEN** the response is 400 and identifies the location field

### Requirement: Idempotent capture creation
When a request carries an `Idempotency-Key` header, repeating the same request with the same key SHALL return the original capture instead of creating a new one. Reusing a key with different metadata SHALL be rejected with 409.

#### Scenario: Retried request
- **WHEN** a client sends the same `POST /captures` twice with the same `Idempotency-Key`
- **THEN** both responses refer to the same capture id, and only one capture exists

#### Scenario: Key reused with different payload
- **WHEN** a client reuses an `Idempotency-Key` with a different byte size
- **THEN** the response is 409

### Requirement: Direct upload to object storage
The presigned upload URL SHALL allow a single object upload for that capture only, restricted to the declared content type, and SHALL expire after a short configured period. Image bytes SHALL NOT pass through the API.

#### Scenario: Upload with matching content type
- **WHEN** the client PUTs the image to `uploadUrl` with the declared content type before expiry
- **THEN** object storage accepts the upload

#### Scenario: Expired URL
- **WHEN** the client PUTs to `uploadUrl` after `expiresAt`
- **THEN** object storage rejects the upload

### Requirement: Complete a capture upload
`POST /captures/:id/complete` SHALL verify that the uploaded object exists and matches the declared content type and byte size, then set the capture's status to `ready`. The operation SHALL be idempotent.

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

### Requirement: Retrieve a capture
`GET /captures/:id` SHALL return the capture's id, status, content type, byte size, capture time, location as GeoJSON (or null) and creation time. For `ready` captures, it SHALL include a short-lived presigned image URL.

#### Scenario: Ready capture
- **WHEN** a client fetches a `ready` capture
- **THEN** the response is 200 and includes an `imageUrl` that downloads the uploaded image

#### Scenario: Pending capture
- **WHEN** a client fetches a `pending` capture
- **THEN** the response is 200 with `status: "pending"` and no `imageUrl`

#### Scenario: Unknown capture
- **WHEN** a client fetches an id that does not exist
- **THEN** the response is 404

### Requirement: List captures
`GET /captures` SHALL return captures ordered by creation time, newest first, with a bounded page size.

#### Scenario: Listing after uploads
- **WHEN** a client lists captures after creating three
- **THEN** all three are returned, newest first
