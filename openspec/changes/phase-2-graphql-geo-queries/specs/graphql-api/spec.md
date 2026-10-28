# Spec Delta

## Purpose

Provides a typed, read-only GraphQL view of captures, detections and detectors, so clients can fetch related data in one request and explore it with geo and time filters.

## ADDED Requirements

### Requirement: GraphQL endpoint
The service SHALL accept GraphQL queries at `POST /graphql` with a JSON body (`query`, optional `variables` and `operationName`) and respond with a standard GraphQL result (`data` and, when applicable, `errors`).

#### Scenario: Simple query
- **WHEN** a client posts `{ detectors { id } }` to `/graphql`
- **THEN** the response is 200 and `data.detectors` contains an entry with id `manual`

#### Scenario: Malformed query
- **WHEN** a client posts a query with a syntax error
- **THEN** the response contains an error describing the syntax problem and no `data`

### Requirement: Read-only schema
The GraphQL schema SHALL expose query operations only. Creating captures, uploading images and creating detections SHALL remain available through REST only.

#### Scenario: Mutation attempted
- **WHEN** a client sends a `mutation` operation
- **THEN** the response contains an error stating that mutations are not supported, and nothing is written

### Requirement: Core types and relations
The schema SHALL expose `Capture`, `Detection` and `Detector` types with the same fields and values the REST API returns for them. A capture SHALL link to its detections, and a detection SHALL link to its capture and its detector.

#### Scenario: Nested read
- **WHEN** a client queries a capture by id with its detections, and each detection's detector id and kind
- **THEN** the response contains the capture, its detections ordered by observation time, and each detector

#### Scenario: Consistent with REST
- **WHEN** the same capture is read through `GET /captures/:id` and through GraphQL
- **THEN** status, content type, byte size, capture time and location are equal

### Requirement: Unknown ids resolve to null
Looking up a capture or detector by an id that does not exist, or that is not a valid id, SHALL return `null` for that field without an error.

#### Scenario: Unknown capture
- **WHEN** a client queries `capture(id: ...)` with a random UUID
- **THEN** `data.capture` is `null` and the response has no errors

### Requirement: Locations as GeoJSON Points
Locations SHALL be represented as GeoJSON Point objects (`{ "type": "Point", "coordinates": [longitude, latitude] }`, WGS84), both in results and in arguments. A point argument with out-of-range coordinates SHALL be rejected.

#### Scenario: Capture location
- **WHEN** a client reads a capture stored at longitude 13.4, latitude 52.5
- **THEN** its `location` is `{ "type": "Point", "coordinates": [13.4, 52.5] }`

#### Scenario: Invalid point argument
- **WHEN** a client passes a point with latitude 95
- **THEN** the response contains a bad-input error naming the coordinate

### Requirement: Effective detection location
Each detection SHALL expose its effective `location`: its own point when it has one, otherwise its capture's location, otherwise `null`. It SHALL also expose `locationSource` with value `DETECTION`, `CAPTURE` or `NONE`.

#### Scenario: Fallback to the capture
- **WHEN** a detection without its own point belongs to a capture located at [13.4, 52.5]
- **THEN** its `location` is that point and `locationSource` is `CAPTURE`

#### Scenario: No location anywhere
- **WHEN** neither the detection nor its capture has a location
- **THEN** `location` is `null` and `locationSource` is `NONE`

### Requirement: Image URL only for ready captures
A capture's `imageUrl` SHALL be a time-limited download URL when the capture is `ready`, and `null` while it is `pending`.

#### Scenario: Pending capture
- **WHEN** a client reads a `pending` capture's `imageUrl`
- **THEN** it is `null`

### Requirement: Relation loading is batched
Resolving the same relation for many items in one request SHALL use a number of database queries that does not grow with the number of items.

#### Scenario: Many detections with capture and detector
- **WHEN** a client lists 50 detections, each with its capture and detector
- **THEN** the request issues the same number of database queries as it does for 5 detections

### Requirement: Cursor pagination
Lists of detections and captures SHALL be returned as connections: `edges { node cursor }` and `pageInfo { hasNextPage endCursor }`. They SHALL accept `first` (1-100, default 50) and `after` (a cursor from a previous page). Cursors SHALL be opaque strings.

#### Scenario: Walking all pages
- **WHEN** a client pages through 120 matching detections with `first: 50`, following `endCursor` until `hasNextPage` is false
- **THEN** it receives every detection exactly once, in result order, over three pages

#### Scenario: Page size out of range
- **WHEN** a client requests `first: 101` or `first: 0`
- **THEN** the response contains a bad-input error naming `first`

#### Scenario: Invalid cursor
- **WHEN** a client passes an `after` value that was not issued by the service
- **THEN** the response contains a bad-input error naming `after`

### Requirement: Stable ordering
Detection results SHALL be ordered by observation time ascending, then by id. Capture results SHALL be ordered by creation time descending, then by id. Items added after a page was read SHALL NOT cause items on later pages to be repeated or skipped.

#### Scenario: Equal observation times
- **WHEN** several detections share the same observation time and a page boundary falls between them
- **THEN** each of them appears on exactly one page

#### Scenario: Insert while paging
- **WHEN** a detection earlier in the order is created after the first page was read
- **THEN** the next page continues after the first page's last item, with no repeats

### Requirement: Error reporting
Invalid arguments SHALL produce errors with `extensions.code` `BAD_USER_INPUT` and, where a field is at fault, `extensions.issues` listing each path and message. Unexpected failures SHALL produce an error with `extensions.code` `INTERNAL_SERVER_ERROR` and a generic message that does not reveal internals.

#### Scenario: Bad argument
- **WHEN** a client passes a bounding box whose south edge is north of its north edge
- **THEN** the error has code `BAD_USER_INPUT` and an issue for the bounding box

#### Scenario: Internal failure
- **WHEN** the database is unreachable while resolving a query
- **THEN** the error has code `INTERNAL_SERVER_ERROR`, and its message contains no SQL, stack trace or connection details

### Requirement: Published schema
The repository SHALL contain the service's GraphQL schema in SDL form. A check SHALL fail when the committed schema differs from the schema the service serves.

#### Scenario: Schema drift
- **WHEN** a field is added to the server schema without updating the committed SDL
- **THEN** the test suite fails, naming the schema file
