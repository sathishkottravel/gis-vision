# Proposal

> **Skeleton.** Planned in detail when Phase 6 is archived. Features are implemented one at a time, in order.

## Why

By now, Deploy v0 has grown into many manual steps. This phase makes both hosting targets fully reproducible: AWS through CDK and the DigitalOcean droplet through Terraform. Deployment becomes one command with a CD pipeline, and the system is operated like production.

## What Changes

- **F7.1 CDK structure:** the AWS app split into stacks (storage, API, workers, web, queues) with dev and prod stage config.
- **F7.2 Droplet IaC:** Terraform (DigitalOcean provider) plus cloud-init that provisions the droplet, firewall and `deploy/droplet/` stack from scratch.
- **F7.3 Secrets:** centralized secrets with a rotation procedure for DB credentials, shared safely between AWS and the droplet.
- **F7.4 CD pipeline:** GitHub Actions with OIDC to AWS (no long-lived keys), a migration step with gating, and ordered deploys of the droplet and AWS stacks.
- **F7.5 One-command lifecycle:** scripted `deploy` / `destroy` for each environment.
- **F7.6 Operations:** CloudWatch alarms, log retention, budgets, and droplet health/disk alerts.
- **F7.7 Disaster recovery:** automated restore of the latest backup into a scratch DB, verified on a schedule.

## Capabilities

### New Capabilities
<!-- Likely none: infrastructure and delivery only. If confirmed at planning time, set skip_specs: true. -->

### Modified Capabilities
<!-- None expected. -->

## Exit Criteria

Running `deploy` from a clean machine (with credentials) brings up a working environment, `destroy` tears it down, and the scheduled restore check passes.

## Impact

`deploy/aws/` (CDK), `deploy/droplet/` (Terraform, cloud-init), `.github/workflows/`. New deps: Terraform, the DigitalOcean provider.
