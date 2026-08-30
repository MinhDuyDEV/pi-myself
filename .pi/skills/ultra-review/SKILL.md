---
name: ultra-review
description: Use when a branch, diff, or named scope needs a maximum-recall static bug hunt — 10 independent read-only scouts receive one identical standard prompt and every candidate is preserved in a durable report under docs/ultrareview/; not for single-claim proof audits, reviewing a small local fix, or repeating a finished round.
disable-model-invocation: true
---

# Ultra Review

## Goal

Maximize bugs discovered. False positives and noise are acceptable. Never filter a candidate out of the artifact because it is speculative, unique, low-confidence, weakly evidenced, duplicated, or hard to classify.

The coordinator clusters all scout submissions directly into clean, actionable Findings (`F001`, `F002`, ...). Do not include Raw Candidate Ledgers, Execution Receipts, or metadata clutter that an agent does not need to read to verify and fix bugs. Verification and rejection belong to the later receive workflow.

## Inputs And Standard Prompt

The review brief provides scope, change intent, an identity digest, repository contracts, and prior-round warnings. Ultra review always uses 10 scouts.

- Build one complete standard prompt from the review brief.
- Launch exactly 10 scouts, named consecutively `scout-01` through `scout-10`.
- Launch every scout as `agent_type: ultra-scout` (defined in `.pi/agents/ultra-scout.md`: read-only, thinking max) and use the same agent for every scout and sub-agent.
- Send the exact same standard prompt to all 10 scouts. Do not assign specialized logic, performance, security, lifecycle, or other angles to individual scouts.
- Let each scout independently choose its own search path from the full search surface.
- Preserve scout independence and do not share candidate findings before consolidation.

## Scout Packet

Each scout prompt must contain:

- exact review scope and change intent
- relevant repository contracts and prior-round warnings
- every caller directive, unchanged and mandatory for every scout
- permission to report every in-scope concern
- instruction to inspect the full relevant production surface, not only the visible diff
- request for file/line evidence, failure mode, confidence, durable solution, and a disconfirming check when available
- explicit permission to return incomplete or speculative candidates rather than suppressing them
- read-only restrictions

Scouts must not edit, stage, format, generate, or mutate source files. Use static read-only inspection only; do not run tests, builds, package managers, proof commands, or xtask. The coordinator may create exactly one report under `docs/ultrareview/` and no other workspace artifact.

## Restart Recovery

A system notice that subagents or background tasks stopped due to a server restart is a recovery trigger, not permission to restart the review from scratch.

1. Freeze the existing logical roster, concern allocation, report path, and review-brief digest.
2. Inventory persisted mailbox reports by logical scout ID.
3. Preserve every completed scout report exactly once.
4. Do not relaunch the full scout batch. Revive or restart only missing logical scouts with their original assignments as `agent_type: ultra-scout` (defined in `.pi/agents/ultra-scout.md`).
5. A replacement attempt continues the same logical scout ID; never create an eleventh logical scout or duplicate completed work.
6. After all ten logical scouts complete, consolidate once into the existing report.

When resumed with a recovery prompt, inspect persisted state before taking any launch action. A bare continuation must never create another full batch.

## Search Surface

Choose and combine lenses appropriate to the scope, including but not limited to:

- semantic and state-machine correctness
- ownership × lifecycle/event × expected-outcome gaps
- caller/API/schema/protocol/data-format contracts
- concurrency, ordering, cancellation, cleanup, and resource lifetime
- error masking, fallback, retry, partial failure, and invariant handling
- authorization, trust boundaries, adversarial input, and abuse cases
- hot-path allocation, copies, rescans, N+1 work, blocking, and contention
- generated artifacts, fixtures, validators, snapshots, docs, and examples
- test/proof gaps, fake-pass evidence, and mocked production claims
- compatibility paths, duplicate state, wrappers, caches, and compensation for a broken foundation
- owner/module boundaries, file responsibility, and missing essential mechanisms
- alternate end-to-end call traces and hostile edge cases

This list is raw material available identically to every scout, not a coordinator-assigned topology.

## Prior Round Guard

Before round 2 or later, read every earlier report with the same review name. Give relevant scouts concise warnings about confirmed fixes, rejected false positives, unresolved routes, and regression risks, but do not use prior rejection as a filter: a scout may revive it with or without new evidence, and the artifact must retain that candidate.

## Artifact Contract

Create exactly one report with:

Resolve `$ROOT` once per APPEND_SYSTEM (repository root), then:

```bash
python "$ROOT/.pi/skills/ultra-review/scripts/create_ultra_review_report.py" --workspace "$ROOT" --review-name <review-name> --scope "<scope>" --review-brief-sha256 <sha256> --scout-count 10 --directive-count <count>
```

Use the script's `report_path`; never improvise or overwrite it. Replace every `TODO`. If scouts submitted no candidates, state `No candidates reported.` After writing, print the report path and full content.

## Finding Consolidation

1. Group every bug candidate reported by scouts into consolidated Findings (`F001`, `F002`, ...) by root cause. Do NOT add a `Raw Candidate Ledger`, `Execution Receipt`, `Scout preservation counters`, or `Merge Notes` checklist.
2. Preserve all unique or speculative bug candidates in `Findings`. Do not filter out candidates during review.
3. Keep finding descriptions concise and focused purely on actionable information needed by an agent to verify and fix the bug:
   - Severity (`P0`, `P1`, `P2`, `P3`) & Confidence (`high`, `medium`, `low`)
   - Source pointer (exact `file:line`)
   - Evidence observed
   - Contract violated / expected law
   - Plausible failure mode
   - Durable solution hypothesis
   - Disconfirming check
4. Build a Verification Queue containing every finding and its read-only disconfirming check.

## Report Shape

Preserve these headings:

- Metadata header (Date, Review name, Round, Scope, Report path)
- Prior Round Guard
- Findings
- Verification Queue
- Strongest Reason Not To Merge Yet
- Next Receive Prompt

End with:

```text
Run /skill:ultra-review-receive to verify <report path> and implement confirmed owner-clean fixes.
```
