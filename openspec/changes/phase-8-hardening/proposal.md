# Proposal

> **Skeleton (optional phase).** Planned in detail when Phase 7 is archived. Features are implemented one at a time, in order.

## Why

The system now spans an API, queues, a Python worker, AWS and a droplet. This phase makes it observable across those boundaries and safe to leave public: tracing, authentication and abuse protection.

## What Changes

- **F8.1 Distributed tracing:** OpenTelemetry in the API and both workers, with trace context propagated through queue messages.
- **F8.2 Logs & metrics:** correlated structured logs, RED metrics per endpoint and job, and a dashboard.
- **F8.3 Authentication & authorization:** user authentication with role-based access (viewer, annotator, admin) on REST and GraphQL.
- **F8.4 Rate limiting:** per-client limits on upload and query endpoints, plus GraphQL query depth and complexity limits.
- **F8.5 Security review:** dependency scanning, introspection gated behind auth, and an OWASP checklist pass.

## Capabilities

### New Capabilities
- `api-auth`: authentication and role-based authorization rules.
- `rate-limiting`: request and query-cost limits and the responses returned when they are exceeded.

### Modified Capabilities
- `graphql-api`: introspection and query limits depend on the caller's role.

## Exit Criteria

One upload is traceable end to end across api -> queue -> worker -> api. Unauthenticated writes are rejected, and limits are enforced and tested.

## Impact

All services (instrumentation), `apps/web` (login), `deploy/` (collector/exporter). New deps: OpenTelemetry SDKs, an auth provider (decided at planning time).
