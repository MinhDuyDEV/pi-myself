---
name: harness-catalog
description: Use when a request maps onto no flow already in context, or the user asks where to start — the situation-to-command map across the vendored process skills and the harness skills, naming which actor can start each one.
---

# Harness Catalog

The vendored skills own the process; the harness is subordinate (see `.pi/APPEND_SYSTEM.md`). What
matters here is **who can start the work**: most of the main flow is user-invoked, so the model
cannot launch it — it names the command and the human runs it. This file is the `harness-catalog`
skill; `pi-mapping.md` beside it holds the host translations for the skills that spawn agents or
name a mechanism pi lacks — read it from this skill's own directory.

## Where to start

| Situation | Actor | Command or role |
| --- | --- | --- |
| Idea or feature, still foggy | human | `/skill:grill-with-docs` |
| Effort too big for one session | human | `/skill:wayfinder` |
| Unclear which skill fits | human | `/skill:ask-matt` |
| Raw incoming issue | human | `/skill:triage` |
| Hard bug, no diagnosis yet | model | `diagnosing-bugs` |
| Architecture upkeep, friction pass | human | `/skill:improve-codebase-architecture` |
| A decision needs adversarial scrutiny | human | `/skill:grill-me` |
| The questioning discipline behind the grilling on-ramps | model | `grilling` |
| Something unexplained, explain it back | human | `/skill:wait-what` |
| Alternative interfaces for one module | model | `codebase-design`, then `designer` tasks |

## The main flow

| Step | Actor | Command or role |
| --- | --- | --- |
| Shape the idea into a spec | human | `/skill:to-spec` |
| Spec into tickets | human | `/skill:to-tickets` |
| Execute the work | human | `/skill:implement` |
| Execute tickets in parallel worktrees | human | `/skill:implement-spec` |
| Prove it done | human | `/verify` |
| Independent review before merge | model | `code-review` plus a `reviewer` task |
| Behaviour change, test first | model | `tdd` |
| Completion gate | model | `verification-before-completion` |
| Build to understand | model | `prototype` |

## Review and proof

| Situation | Actor | Command or role |
| --- | --- | --- |
| Maximum-recall static bug hunt | human | `/skill:ultra-review` |
| Verify and fix an ultra-review report | human | `/skill:ultra-review-receive` |
| Inventory proof debt | human | `/skill:test-proof-debt-audit` |
| Guidance, links, and hygiene refresh | human | `/skill:repo-refresh` |
| Security pass | model | `security-and-hardening` |
| TypeScript conventions | model | `typescript-coding-standards` |
| Claims from docs or APIs | model | `source-driven-development`, `research` |

## Continuity

| Situation | Actor | Command or role |
| --- | --- | --- |
| Hand off to a fresh session | human | `/skill:handoff` |
| Hand off to a background agent | human | `/skill:claude-handoff` |
| Recover compacted context | model | the `recall` tool |
| Keep a durable learning | model | `memory` |
| Write a PR body | model | `pr` |
| Land a merge conflict | model | `resolving-merge-conflicts` |

## Setup and provisioning

| Situation | Actor | Command or role |
| --- | --- | --- |
| Per-repo skill configuration | human | `/skill:setup-matt-pocock-skills` |
| Install harness roles and policy | human | `/setup-pi-myself` |
| Install a git guardrail | human | `/skill:commit-guardrails` |
| TypeScript deep-module boundaries | human | `/skill:setup-ts-deep-modules` |
| Steps only a human can perform | model | `wizard` |
| Design a recurring workflow loop | human | `/skill:loop-me` |
| Project vocabulary and glossary | human | `/skill:domain-modeling` |
| Retrospective over past sessions | human | `/skill:retro` |

## Writing and teaching

| Situation | Actor | Command or role |
| --- | --- | --- |
| Writing a skill or agent instructions | model | `writing-for-agents` |
| Draft prose, beats or shape | human | `/skill:writing-beats`, `/skill:writing-fragments`, `/skill:writing-shape` |
| Explain a topic properly | human | `/skill:teach` |
| Turn a topic into questions | human | `/skill:to-questionnaire` |

## Two standing rules

Name the command; never re-implement a user-invoked skill's steps. When several rows could fit, put
the choice to the user with the one you recommend first.
