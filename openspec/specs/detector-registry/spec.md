# detector-registry Specification

## Purpose

Keeps the catalog of detectors (manual or automated) and the JSON Schema each one declares for its detection attributes, so clients can discover detectors and build forms or validation from their schemas.

## Requirements

### Requirement: Built-in manual detector
The system SHALL provide a detector with id `manual` and kind `manual`, available without any setup, whose output schema accepts a free-form attributes object.

#### Scenario: Fresh installation
- **WHEN** the service starts against a freshly migrated database
- **THEN** the detector `manual` is listed and has an output schema

### Requirement: List detectors
`GET /detectors` SHALL return every registered detector with its id, name, version and kind.

#### Scenario: Listing detectors
- **WHEN** a client calls `GET /detectors`
- **THEN** the response is 200 and includes the `manual` detector

### Requirement: Expose a detector's output schema
`GET /detectors/:id/schema` SHALL return the detector's output schema as a JSON Schema document.

#### Scenario: Known detector
- **WHEN** a client requests the schema of `manual`
- **THEN** the response is 200 with a valid JSON Schema document

#### Scenario: Unknown detector
- **WHEN** a client requests the schema of a detector id that does not exist
- **THEN** the response is 404

### Requirement: Detector schemas use the supported subset
Every detector output schema SHALL be a JSON Schema object schema limited to the supported subset: object properties, string/number/integer/boolean types, enums, and arrays of those primitive types.

#### Scenario: Seeded schemas conform
- **WHEN** the seeded detector schemas are checked against the supported subset
- **THEN** all of them conform
