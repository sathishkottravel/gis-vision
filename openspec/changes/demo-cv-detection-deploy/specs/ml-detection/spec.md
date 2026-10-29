# Spec Delta

## Purpose

Defines how machine-learning detectors produce detections on captures: what starts a run, what a run reads and writes, how confidence and repeats are handled, and how failures stay away from uploads.

## ADDED Requirements

### Requirement: Detection runs on new captures
When a capture becomes `ready`, the system SHALL run every built-in `ml` detector on it once, without the client asking. A capture that was already `ready` SHALL NOT start another run when it is completed again.

#### Scenario: New upload
- **WHEN** a client completes the upload of a street photo containing a car
- **THEN** within 60 seconds the capture lists a detection from `coco-objects` labelled `car`

#### Scenario: Repeated completion
- **WHEN** a client completes an already `ready` capture again
- **THEN** no second run starts, and the capture's `coco-objects` detections are not duplicated

### Requirement: Machine detection output
A run SHALL create one detection per object found with a confidence of at least 0.5. Each detection SHALL carry the detector id `coco-objects`, the object's class name as its label, its confidence between 0 and 1, and a pixel bounding box inside the image. Its location and observation time SHALL default from the capture, as for any detection.

#### Scenario: Objects above the threshold
- **WHEN** the detector finds a person with confidence 0.91 and a bicycle with confidence 0.32
- **THEN** only the person is stored, as label `person` with confidence 0.91 and `attributes.class` `person`

#### Scenario: Nothing found
- **WHEN** the image contains no object above the threshold
- **THEN** the run succeeds and creates no detection

#### Scenario: Shown like any detection
- **WHEN** a capture has `coco-objects` detections
- **THEN** they are returned by `GET /captures/:id/detections`, by GraphQL and by spatial and time searches, exactly like manual ones

### Requirement: One set of detections per capture and detector
Running a detector again on a capture that already has detections from it SHALL NOT add more, so repeated or duplicated jobs leave exactly one set.

#### Scenario: Duplicate job
- **WHEN** the same detection job is delivered twice
- **THEN** the capture has one set of `coco-objects` detections

### Requirement: Uploads never depend on detection
Completing an upload SHALL respond as before whether or not detection can be started, and detection failures SHALL NOT change a capture or its existing detections. A run that keeps failing SHALL be retried a bounded number of times and then set aside for inspection.

#### Scenario: Detection unavailable
- **WHEN** the detection queue cannot be reached while a client completes an upload
- **THEN** the response is still 200 with `status: "ready"`, and the failure is logged

#### Scenario: Run keeps failing
- **WHEN** a run fails on every attempt, for example because the image cannot be decoded
- **THEN** after three attempts the job is moved to a dead-letter queue, and the capture stays `ready` without `coco-objects` detections
