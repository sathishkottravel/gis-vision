# Spec Delta

## ADDED Requirements

### Requirement: Built-in COCO object detector
The system SHALL provide a detector with id `coco-objects`, kind `ml` and version 1, available without any setup. Its output schema SHALL require `attributes.class`, one of the 80 COCO class names (for example `person`, `car`, `bicycle`, `bus`, `traffic light`), and allow no other attributes.

#### Scenario: Fresh installation
- **WHEN** the service starts against a freshly migrated database
- **THEN** `GET /detectors` lists `manual` and `coco-objects`, and `GET /detectors/coco-objects/schema` returns a schema whose `class` property is an enum of the 80 COCO class names

#### Scenario: Class outside the list
- **WHEN** a `coco-objects` detection is posted with `attributes.class` `unicorn`
- **THEN** the response is 422 with an issue on `attributes.class`
