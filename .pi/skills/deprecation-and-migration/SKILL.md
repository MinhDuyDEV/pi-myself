---
name: deprecation-and-migration
description: Use when deprecating APIs, migrating consumers or data, removing legacy behavior, upgrading dependencies, or planning breaking changes with compatibility evidence and rollback.
---

# Deprecation and Migration

<HARD-GATE>
The removal date and compatibility window come from the product's support contract, compatibility policy, security obligations, release model, and consumer adoption evidence—not a universal number of versions or months. Do not remove until affected consumers and rollback conditions are known, except for an explicitly approved emergency such as an active security risk.
</HARD-GATE>

## Establish the Contract

Before changing behavior, record:

- public/internal scope and semantic-versioning or service compatibility promise;
- consumer inventory, owners, versions, and usage telemetry where lawful;
- replacement behavior and known non-equivalences;
- notice channels, support window, removal criterion, and accountable owner;
- data migration, interoperability, rollback, and incident plan.

Unknown consumers are risk, not proof of zero use. Trace imports, API traffic, schemas, jobs, scripts, documentation, and generated clients.

## Lifecycle

1. **Baseline:** contract tests characterize old behavior and the replacement.
2. **Introduce:** ship the replacement without silently changing old consumers.
3. **Notify:** mark deprecated in types/docs and publish the migration path and target policy milestone. Add a runtime warning only when appropriate, rate-limited, actionable, non-sensitive, and observable by the actual consumer.
4. **Migrate:** update first-party consumers, then support external adoption. Measure remaining usage and failures.
5. **Default:** change defaults through a reversible stage when risk warrants it.
6. **Remove:** delete only after the policy criterion is met; publish the changelog entry and verify no compatibility path remains unintentionally.

Emergency removal must name the threat, approver, consumer impact, mitigation, and communication path.

## Migration Deliverables

A migration guide includes why, affected versions/consumers, old/new examples, behavior differences, ordered steps, validation, rollback, deadline/policy, and support contact.

Use a codemod when the transformation is mechanical and its semantics can be tested. Provide diagnostics or manual guidance for ambiguous cases. Test against representative real repositories, preserve formatting where possible, support dry-run, and make reruns idempotent.

For data migrations, define expand/migrate/contract phases, mixed-version compatibility, checkpoints, backfill rate, validation queries, and restore/replay behavior.

## Staged Rollout

A feature flag is useful only when it creates a reversible decision point. Define cohort, metrics, stop conditions, ownership, expiry, and rollback before rollout. Libraries may use opt-in APIs or dual-read/write compatibility instead; services may use canaries. Do not keep both paths forever without reclassifying them as supported features.

## Verification

Test old and new versions across the supported compatibility matrix, including downgrade/rollback where promised. Validate the guide from a clean consumer, run codemod dry-run and idempotency checks, monitor adoption/errors, and confirm changelog, API docs, generated artifacts, and release notes agree.

Report what remains on the old path, the evidence supporting removal, exceptions granted, and the exact rollback boundary.
