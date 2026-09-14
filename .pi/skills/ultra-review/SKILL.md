---
name: ultra-review
description: Use when a branch, diff, or named scope needs a maximum-recall static bug hunt — 10 independent read-only scouts receive one identical standard prompt and every candidate is preserved in a durable report under docs/ultrareview/; not for single-claim proof audits, reviewing a small local fix, or repeating a finished round.
disable-model-invocation: true
---

# Ultra Review

Coordinator instructions. The scout's own rules (search lenses, reporting contract, read-only restrictions) live in `.pi/agents/ultra-scout.md` and reach every scout through `agent_type: ultra-scout`; do not restate them in the prompt.

## Goal

Maximize bugs discovered. False positives and noise are acceptable. Never filter a candidate out of the artifact because it is speculative, unique, low-confidence, weakly evidenced, duplicated, or hard to classify. Verification and rejection belong to `/skill:ultra-review-receive`.

## Launch

The review brief provides scope, change intent, an identity digest, repository contracts, and prior-round warnings. Build one standard prompt from it containing:

- exact review scope and change intent;
- relevant repository contracts and prior-round warnings;
- every caller directive, unchanged and mandatory for every scout.

Then launch exactly 10 scouts, `scout-01` through `scout-10`, all `agent_type: ultra-scout`, all with the identical prompt. Do not assign specialised angles (logic, performance, security, lifecycle) to individual scouts; each scout chooses its own path. Do not share candidates between scouts before consolidation. The coordinator creates exactly one report under `docs/ultrareview/` and no other workspace artifact.

## Restart Recovery

A system notice that subagents or background tasks stopped is a recovery trigger, not permission to restart from scratch.

1. Freeze the existing logical roster, report path, and review-brief digest.
2. Inventory persisted scout reports by logical scout ID; preserve every completed one exactly once.
3. Revive or restart only the missing logical scouts with their original assignment; a replacement continues the same scout ID. Never create an eleventh scout or duplicate completed work.
4. After all ten complete, consolidate once into the existing report.

When resumed with a recovery prompt, inspect persisted state before any launch action.

## Prior Round Guard

Before round 2 or later, read every earlier report with the same review name. Pass concise warnings about confirmed fixes, rejected false positives, unresolved routes, and regression risks into the standard prompt — as context, not as a filter: a scout may revive a rejected candidate with or without new evidence, and the artifact must retain it.

## Artifact

Resolve `$ROOT` once per APPEND_SYSTEM (repository root), then let the script own the path, round number, and skeleton:

```bash
python "$ROOT/.pi/skills/ultra-review/scripts/create_ultra_review_report.py" --workspace "$ROOT" --review-name <review-name> --scope "<scope>" --review-brief-sha256 <sha256> --scout-count 10 --directive-count <count>
```

Use the script's `report_path`; never improvise or overwrite it. Replace every `TODO`. If scouts submitted no candidates, state `No candidates reported.` After writing, print the report path and full content.

### Consolidation

1. Group every scout candidate into Findings (`F001`, `F002`, ...) by root cause. No Raw Candidate Ledger, Execution Receipt, preservation counters, or Merge Notes.
2. Preserve all unique or speculative candidates.
3. Each finding carries only what a verifier needs: severity (`P0`–`P3`), confidence (`high`/`medium`/`low`), exact `file:line`, evidence observed, contract violated, plausible failure mode, durable solution hypothesis, disconfirming check.
4. Build a Verification Queue with every finding and its read-only disconfirming check.

### Report shape

Keep the script's headings: metadata header (Date, Review name, Round, Scope, Report path), Prior Round Guard, Findings, Verification Queue, Strongest Reason Not To Merge Yet, Next Receive Prompt. End with:

```text
Run /skill:ultra-review-receive to verify <report path> and implement confirmed owner-clean fixes.
```
