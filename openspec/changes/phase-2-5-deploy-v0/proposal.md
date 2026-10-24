# Proposal

> **Skeleton.** Planned in detail when Phase 2 is archived. Features are implemented one at a time, in order.

## Why

Phases 0-2 run only locally. Deploy v0 puts them online at minimal cost, so there's a public demo early. It also tests the hosting-agnostic design against real infrastructure before async processing and ML add more moving parts.

## Decisions Already Made

- **API, uploads, web:** AWS serverless. The API runs on Lambda behind an HTTP API Gateway, images go to S3, the static web app is on S3 + CloudFront.
- **Database:** a self-hosted PostGIS container on a DigitalOcean droplet, with a data-exploration dashboard, scheduled cleanup and hardened security. All droplet deployment files live in their own folder, `deploy/droplet/`, separate from the AWS stack (`deploy/aws/`).

## What Changes

**Droplet (database host), in `deploy/droplet/`**
- **F2.5.1 PostGIS container:** Docker Compose with a pinned `postgis/postgis` image, a persistent volume, an `extensions` schema, and a least-privilege app role (no superuser, `scram-sha-256` auth).
- **F2.5.2 Connection pooling:** PgBouncer in transaction mode in front of Postgres, so concurrent Lambda invocations don't exhaust connections. TLS enforced end to end.
- **F2.5.3 Data dashboard:** pgAdmin 4 (its geometry viewer renders PostGIS results on a map), never exposed publicly and reachable only through an SSH tunnel.
- **F2.5.4 Scheduled cleanup:** `pg_cron` jobs that create upcoming monthly partitions, drop partitions past retention, and remove orphaned or stale records (e.g. abandoned uploads).
- **F2.5.5 Security & backups:** DigitalOcean cloud firewall plus ufw (only SSH and the TLS pooler port open), key-only SSH, fail2ban, unattended upgrades, nightly `pg_dump` to S3 with a retention policy, and a tested restore runbook.

**AWS, in `deploy/aws/`**
- **F2.5.6 Minimal CDK stack:** API Lambda (wrapping `buildApp`), HTTP API Gateway, S3 captures bucket (private, CORS for presigned uploads), DB credentials in Secrets Manager / SSM.
- **F2.5.7 Web hosting:** static `apps/web` build on S3 + CloudFront.
- **F2.5.8 Runbook & guardrails:** manual deploy steps, a post-deploy smoke test, and an AWS Budgets alert at $5.

## Capabilities

### New Capabilities
- `data-retention`: what gets cleaned up, when, and the retention guarantees.

### Modified Capabilities
<!-- None expected: presigned uploads are already part of Phase 1 (capture-ingest). -->

Stale `pending` captures (uploads never completed) are cleaned up by `pg_cron` under `data-retention`.

## Open Decisions (resolve when planning this phase)

- **Lambda -> droplet over the public internet.** Lambda has no static outbound IP unless it runs in a VPC with a NAT gateway (about $32/mo), so the firewall can't allowlist it cheaply. Default: TLS-only pooler port, strong credentials, fail2ban, and connection limits. Alternative: a VPC + NAT for IP allowlisting, at extra cost.
- Droplet size and region (co-locate with the AWS region to keep latency low).

## Exit Criteria

A public URL runs Phases 0-2 end to end: upload, annotate, map query. The droplet passes a security checklist, and a backup restore has been rehearsed.

## Impact

New `deploy/droplet/` and `deploy/aws/` folders, a Lambda entry point in `apps/api`. New deps: aws-cdk-lib, @fastify/aws-lambda. Runtime cost: about $6/mo for the droplet, about $0 for AWS at demo traffic.
