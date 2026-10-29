# Spec Delta

## Purpose

Defines how the hosted database behind the public deployment is protected and shared: connections only over verified TLS, least-privilege roles, no database or dashboard port open to the internet, and pooled server connections.

## ADDED Requirements

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

### Requirement: No public database or dashboard ports
Postgres itself and the data dashboard SHALL NOT listen on any public interface of the database host. They SHALL be reachable only from the host, for example through an SSH tunnel. Only the TLS pooler port SHALL be published for database clients.

#### Scenario: Postgres from outside
- **WHEN** a client outside the host connects to the Postgres port
- **THEN** no connection is accepted, because Postgres is bound to the loopback interface only

#### Scenario: Dashboard through a tunnel
- **WHEN** an operator forwards the dashboard's loopback port over SSH and browses to it
- **THEN** the dashboard's login page loads, while the same port is not reachable from outside the host

### Requirement: Pooled database connections
Concurrent API requests SHALL share a bounded number of database server connections, so bursts of concurrent invocations do not exhaust Postgres connections.

#### Scenario: Burst of concurrent requests
- **WHEN** more concurrent database clients connect than the configured server pool size
- **THEN** their queries succeed, waiting for a pooled connection if needed, and Postgres never holds more connections from the pooler than the pool size
