# Spec Delta

## Purpose

Keeps stored data bounded and the time-partitioned detection storage ready for new data: it prepares upcoming partitions, removes detection data past its retention period and deletes abandoned uploads, while never touching data that is still in use.

## ADDED Requirements

### Requirement: Upcoming detection partitions
Running partition maintenance SHALL ensure that a monthly detection partition exists for the current UTC month and each of the next three months. Running it again SHALL change nothing.

#### Scenario: Missing upcoming month
- **WHEN** no partition exists yet for the month two months from now and maintenance runs
- **THEN** that month's partition exists afterwards, and detections observed in that month are stored in it

#### Scenario: Repeated run
- **WHEN** maintenance runs twice in a row
- **THEN** the second run creates, moves and removes nothing

#### Scenario: Detections already stored for a new month
- **WHEN** detections observed in a month without its own partition were stored before that partition is created, and maintenance creates it
- **THEN** those detections are kept and still returned by searches, with the same ids and values, and they now belong to the new month's partition

### Requirement: Detection retention period
Running retention maintenance SHALL remove detections observed before the start of the UTC month 60 months before the current month (the retention cutoff). Detections observed on or after the cutoff SHALL be kept, whichever partition holds them.

#### Scenario: Detection past retention
- **WHEN** a detection was observed 61 months ago and retention maintenance runs
- **THEN** it is no longer returned by any read or search

#### Scenario: Detection inside retention
- **WHEN** a detection was observed 59 months ago, or three years ago in the default partition, and retention maintenance runs
- **THEN** it is still returned

#### Scenario: Whole month past retention
- **WHEN** an entire monthly partition lies before the cutoff
- **THEN** the partition itself is removed, not only its rows

### Requirement: Abandoned uploads
Running upload maintenance SHALL delete captures that are still `pending` more than 24 hours after they were created. Since their upload URL expires long before that, they can never be completed. Captures in `ready` status SHALL never be deleted by maintenance.

#### Scenario: Old pending capture
- **WHEN** a capture was created 25 hours ago and is still `pending`
- **THEN** upload maintenance deletes it, and `GET /captures/:id` returns 404

#### Scenario: Recent pending capture
- **WHEN** a capture was created one hour ago and is still `pending`
- **THEN** it is kept, and it can still be completed while its upload URL is valid

#### Scenario: Ready capture
- **WHEN** a `ready` capture was created years ago
- **THEN** maintenance never deletes it or its detections, except for detections past the retention period
