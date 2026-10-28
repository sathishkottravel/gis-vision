# Spec Delta

## Purpose

Defines how the public deployment of the service behaves and is protected: one HTTPS origin for the web app and the API, a database reachable only over verified TLS with least-privilege access, no public admin surfaces, scheduled maintenance, restorable backups and cost guardrails.

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
The deployment SHALL support the full Phase 0-2 flow: uploading a capture through a presigned URL, annotating it with detections, and finding those detections with spatial and time filters on the map page.

#### Scenario: Upload, annotate, query
- **WHEN** a client creates a capture with a location, uploads the image to the presigned URL, completes it, posts a detection and then searches detections with a bounding box around the capture
- **THEN** each step succeeds, and the search returns the new detection

### Requirement: Production behavior of the API
The deployed API SHALL run in production mode: GraphiQL is not served, and the demo seed refuses to run in the API's runtime environment.

#### Scenario: GraphiQL disabled
- **WHEN** a browser requests `GET https://<origin>/api/graphql` with `Accept: text/html`
- **THEN** no GraphiQL page is returned

### Requirement: Verified TLS for database connections
Every network connection to the database SHALL use TLS, and every client SHALL verify the server certificate against the deployment's CA. Unencrypted connections SHALL be refused.

#### Scenario: Plaintext connection
- **WHEN** a client connects to the pooler or to Postgres without TLS
- **THEN** the connection is refused before authentication

#### Scenario: Unknown certificate
- **WHEN** the API connects to a server whose certificate is not signed by the deployment's CA
- **THEN** the connection fails, and the API does not send credentials

### Requirement: Least-privilege database access
The API SHALL connect with a role that can read and write application data but cannot create, alter or drop database objects and is not a superuser. Migrations SHALL run with a separate owner role. The superuser SHALL NOT be able to log in over the network. The data dashboard SHALL use a read-only role.

#### Scenario: App role attempts DDL
- **WHEN** the API's role runs `CREATE TABLE`, `DROP TABLE capture` or `ALTER TABLE capture ...`
- **THEN** the statement fails with a permission error

#### Scenario: App role uses the data
- **WHEN** the API's role inserts, reads, updates and deletes rows in the application tables, including partitioned detections
- **THEN** each statement succeeds

#### Scenario: Superuser over the network
- **WHEN** a client tries to log in as the superuser over TCP
- **THEN** authentication is rejected

#### Scenario: Dashboard role writes
- **WHEN** the read-only role tries to insert, update or delete a row
- **THEN** the statement fails with a permission error

### Requirement: No public admin surfaces
From the internet, the database host SHALL accept connections only on SSH (key authentication only) and the TLS pooler port. Postgres itself and the data dashboard SHALL be reachable only from the host, for example through an SSH tunnel.

#### Scenario: Port scan
- **WHEN** the host's TCP ports are probed from outside
- **THEN** only the SSH port and the pooler port accept connections

#### Scenario: Password SSH login
- **WHEN** a client tries to log in over SSH with a password
- **THEN** the login is refused

#### Scenario: Dashboard through a tunnel
- **WHEN** an operator opens an SSH tunnel to the host and browses to the dashboard's forwarded port
- **THEN** the dashboard login page loads, and it can show PostGIS query results on a map

### Requirement: Pooled database connections
Concurrent API requests SHALL share a bounded number of database server connections, so bursts of concurrent invocations do not exhaust Postgres connections.

#### Scenario: Burst of concurrent requests
- **WHEN** more concurrent database clients connect than the configured server pool size
- **THEN** their queries succeed, waiting for a pooled connection if needed, and Postgres never holds more connections from the pooler than the pool size

### Requirement: Scheduled maintenance
The hosted database SHALL run partition, retention and upload maintenance (capability `data-retention`) automatically once a day. It SHALL keep a record of each run's outcome for at least 7 days.

#### Scenario: Daily run recorded
- **WHEN** a day has passed since deployment
- **THEN** the job history shows one run of each maintenance job, with its status

### Requirement: Backups and restore
The hosted database SHALL be backed up nightly to private object storage, and each backup SHALL be kept for 30 days. The host's backup credentials SHALL be able to upload backups but not read or delete them. A restore from the latest backup SHALL be rehearsed and recorded before the deployment counts as done.

#### Scenario: Nightly backup
- **WHEN** a night has passed
- **THEN** a new backup object for that date exists in the backup bucket

#### Scenario: Restore rehearsal
- **WHEN** the latest backup is restored into an empty scratch database
- **THEN** the application tables, detection partitions, PostGIS and the row counts match the source at backup time

#### Scenario: Backup credentials misused
- **WHEN** the host's backup credentials try to list, download or delete existing backups
- **THEN** the request is denied

### Requirement: Cost guardrails
The AWS account SHALL have a monthly budget alert at $5 that emails the maintainer. The API's concurrent executions SHALL be capped.

#### Scenario: Budget exceeded
- **WHEN** actual or forecast monthly spend exceeds $5
- **THEN** the maintainer receives an email alert
