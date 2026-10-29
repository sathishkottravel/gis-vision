# Spec Delta

## ADDED Requirements

### Requirement: One public HTTPS origin
The deployment SHALL serve the web app and the API from one public HTTPS origin: the web app at `/`, and every API route under `/api` with the same behavior as locally (for example `/api/health`, `/api/captures`, `/api/graphql`). Plain HTTP requests SHALL be redirected to HTTPS.

#### Scenario: Health through the public origin
- **WHEN** a client requests `https://<origin>/api/health` while the database and object storage are reachable
- **THEN** the response is 200 with `status: "ok"`

#### Scenario: Web app and API on one origin
- **WHEN** the web app is loaded from `https://<origin>/` and calls the API
- **THEN** its requests go to `https://<origin>/api/...`, and no cross-origin request is needed except the direct image upload to object storage

#### Scenario: Plain HTTP
- **WHEN** a client requests `http://<origin>/`
- **THEN** it is redirected to the HTTPS URL

### Requirement: End-to-end flow online
The deployment SHALL support the full flow: uploading a capture through a presigned URL, receiving machine detections for it, annotating it by hand, and finding its detections with spatial and time filters on the map page.

#### Scenario: Upload, detect, annotate, query
- **WHEN** a client creates a capture with a location, uploads a street photo to the presigned URL, completes it, waits for `coco-objects` detections, posts a manual detection and then searches detections with a bounding box around the capture
- **THEN** each step succeeds, and the search returns both the machine and the manual detections

### Requirement: Production behavior of the API
The deployed API SHALL run in production mode: GraphiQL is not served, and the demo seed refuses to run in the API's runtime environment.

#### Scenario: GraphiQL disabled
- **WHEN** a browser requests `GET https://<origin>/api/graphql` with `Accept: text/html`
- **THEN** no GraphiQL page is returned

### Requirement: Firewalled database host
From the internet, the database host SHALL accept connections only on SSH, with key authentication only, and on the TLS pooler port.

#### Scenario: Port scan
- **WHEN** the host's TCP ports are probed from outside
- **THEN** only the SSH port and the pooler port accept connections

#### Scenario: Password SSH login
- **WHEN** a client tries to log in over SSH with a password
- **THEN** the login is refused

### Requirement: Cost guardrails
The AWS account SHALL have a monthly budget alert at $5 that emails the maintainer, and the API's and the worker's concurrent executions SHALL be capped.

#### Scenario: Budget exceeded
- **WHEN** actual or forecast monthly spend exceeds $5
- **THEN** the maintainer receives an email alert
