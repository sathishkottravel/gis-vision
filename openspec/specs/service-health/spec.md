# service-health Specification

## Purpose

Reports whether the service and the dependencies it needs (database and object storage) are available, so operators, load balancers and deploy smoke tests can tell if it is able to serve requests.

## Requirements

### Requirement: Health endpoint reports dependency status
The service SHALL expose `GET /health` returning a JSON body with an overall `status` and a per-dependency status for `database` and `objectStorage`, each `ok` or `error`.

#### Scenario: All dependencies available
- **WHEN** a client calls `GET /health` while the database and object storage are reachable
- **THEN** the response status is 200
- **AND** the body reports `status: "ok"`, `database: "ok"` and `objectStorage: "ok"`

#### Scenario: Database unavailable
- **WHEN** a client calls `GET /health` while the database is unreachable
- **THEN** the response status is 503
- **AND** the body reports `status: "error"` and `database: "error"`

#### Scenario: Object storage unavailable
- **WHEN** a client calls `GET /health` while object storage is unreachable
- **THEN** the response status is 503
- **AND** the body reports `status: "error"` and `objectStorage: "error"`

### Requirement: Health checks are bounded in time
Each dependency check SHALL time out, so a hung dependency cannot make the health endpoint hang.

#### Scenario: Dependency hangs
- **WHEN** a dependency check does not respond within its timeout
- **THEN** that dependency is reported as `error` and the endpoint still responds within a few seconds

### Requirement: Health responses do not leak internals
The health response SHALL NOT include connection strings, credentials, hostnames or stack traces.

#### Scenario: Failure response content
- **WHEN** a dependency check fails
- **THEN** the response contains only the status fields, without error messages that reveal configuration

### Requirement: Service refuses to start with invalid configuration
The service SHALL validate its required configuration at startup and exit with a descriptive error that names the invalid settings, without printing secret values.

#### Scenario: Missing database URL
- **WHEN** the service starts without a database connection setting
- **THEN** it exits with a non-zero code and an error naming the missing setting
