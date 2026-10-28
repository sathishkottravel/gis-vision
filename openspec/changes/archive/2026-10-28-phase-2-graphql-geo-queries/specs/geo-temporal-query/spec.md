# Spec Delta

## Purpose

Finds detections and captures by where and when they happened: within a bounding box or a radius, and within a time range. It works over the effective location of each detection and across time-partitioned storage.

## ADDED Requirements

### Requirement: Detections within a bounding box
Searching detections with a bounding box (`west`, `south`, `east`, `north` in WGS84 degrees) SHALL return the detections whose effective location lies inside or on the edge of the box.

#### Scenario: Own location inside
- **WHEN** a detection's own point is inside the box
- **THEN** it is returned

#### Scenario: Capture location inside
- **WHEN** a detection has no own point and its capture's location is inside the box
- **THEN** it is returned

#### Scenario: Own location outside, capture inside
- **WHEN** a detection's own point is outside the box but its capture's location is inside
- **THEN** it is not returned, because its own point is its effective location

#### Scenario: Point on the edge
- **WHEN** a detection's effective location lies exactly on the box's east edge
- **THEN** it is returned

### Requirement: Bounding boxes across the antimeridian
A bounding box whose `west` is greater than its `east` SHALL be treated as crossing the antimeridian and SHALL cover longitudes from `west` to 180 and from -180 to `east`.

#### Scenario: Box around the date line
- **WHEN** a client searches with west 170, east -170 and detections exist at longitudes 175 and -175 and 0
- **THEN** the detections at 175 and -175 are returned and the one at 0 is not

### Requirement: Bounding box bounds
Bounding box longitudes SHALL be within -180..180 and latitudes within -90..90, and `south` SHALL NOT exceed `north`. Other values SHALL be rejected as bad input.

#### Scenario: Inverted latitudes
- **WHEN** a client searches with south 53 and north 52
- **THEN** the request is rejected as bad input naming the bounding box

### Requirement: Detections within a radius
Searching detections with a center point and a radius in meters SHALL return the detections whose effective location lies within that geodesic distance of the center, boundary included. The radius SHALL be greater than 0 and at most 50,000 meters.

#### Scenario: Nearby and far
- **WHEN** a client searches 1,000 m around a point and detections exist 500 m and 1,500 m away
- **THEN** only the one 500 m away is returned

#### Scenario: Radius too large
- **WHEN** a client searches with a radius of 60,000 m
- **THEN** the request is rejected as bad input naming the radius

### Requirement: One spatial filter per search
A detection search SHALL accept at most one of bounding box or radius. Supplying both SHALL be rejected as bad input.

#### Scenario: Both given
- **WHEN** a client supplies a bounding box and a radius in the same search
- **THEN** the request is rejected as bad input

### Requirement: Detections without any location
Detections whose effective location is null SHALL never match a spatial filter, and SHALL still be returned by searches without a spatial filter.

#### Scenario: Time-only search
- **WHEN** a detection and its capture have no location and a client searches by time range only
- **THEN** the detection is returned if its observation time is in range

### Requirement: Detection time range
Searching detections with `observedFrom` and/or `observedTo` SHALL return detections whose observation time is at or after `observedFrom` and strictly before `observedTo`. Either bound MAY be omitted. When both are given, `observedFrom` SHALL be earlier than `observedTo`, otherwise the request is rejected as bad input.

#### Scenario: Half-open range at a month boundary
- **WHEN** detections exist at 2026-01-31T23:59:59Z and 2026-02-01T00:00:00Z and a client searches from 2026-01-01T00:00:00Z to 2026-02-01T00:00:00Z
- **THEN** only the January detection is returned

#### Scenario: Old observation
- **WHEN** a detection was observed three years ago and a client searches a range that contains it
- **THEN** it is returned like any other detection

#### Scenario: Empty range
- **WHEN** a client searches with `observedFrom` equal to `observedTo`
- **THEN** the request is rejected as bad input

### Requirement: Combined filters
Spatial, time-range and detector filters in one detection search SHALL all apply (logical AND).

#### Scenario: Space, time and detector
- **WHEN** a client searches with a bounding box, a time range and detector `manual`
- **THEN** only detections matching all three are returned

### Requirement: Time-bounded searches scan only overlapping partitions
A detection search with a time range SHALL read only the storage partitions whose time span overlaps the range.

#### Scenario: One month
- **WHEN** the query plan of a detection search limited to one calendar month is inspected
- **THEN** it reads only that month's partition

#### Scenario: Range outside the pre-created months
- **WHEN** the query plan of a search limited to a month five years ago is inspected
- **THEN** it reads only the default partition

### Requirement: Captures by area and time
Searching captures SHALL support a bounding box over the capture's location (with the same bounds and antimeridian rules) and a half-open `capturedFrom`/`capturedTo` range over its capture time. Captures without a location SHALL never match a bounding box.

#### Scenario: Captures in view
- **WHEN** a client searches captures with a box containing one capture's location and not another's
- **THEN** only the first capture is returned
