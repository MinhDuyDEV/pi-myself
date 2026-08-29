---
description: Verify a ticket or spec against its acceptance criteria, run real project gates, and record the evidence where the tracker keeps it
argument-hint: "<ticket-id|path> [--quick] [--test] [--review] [--gate-only]"
---

# Verify: $ARGUMENTS

Resolve the repository root first: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. If Git cannot resolve a repo and the current directory has no `.scratch/` or `docs/agents/`, stop — nothing here is verifiable.

Check implementation evidence against the tracker, run the project's real gates, and record results.

## 1. Parse Arguments

| Argument | Default | Description |
| --- | --- | --- |
| `<ticket-id\|path>` | required | A ticket id/path (local tracker: `.scratch/<feature>/issues/<NN>-<slug>.md`) or a spec path |
| `--quick` | false | Gates only; result cannot be `READY TO SHIP` |
| `--test` | false | Write missing tests for the target code (drive the `tdd` skill: red → green per slice) |
| `--review` | false | Code review of the diff by severity, plus an independent reviewer task |
| `--gate-only` | false | Run gates and stop; evidence only, not completion |

## 2. Prerequisites

- `docs/agents/issue-tracker.md` must exist. If missing, stop and tell the user to run `/setup-matt-pocock-skills`; do not guess where tickets live.
- For the local tracker, read `.scratch/<feature>/issues/` and resolve the ticket file from the argument. For a real tracker, follow `docs/agents/issue-tracker.md`'s fetch workflow (e.g. `gh issue view`). A missing ticket is a stop, never a partial verify.

## 3. Read the Ticket

Collect:

- **Acceptance criteria** — every open checkbox (`- [ ]`) in the ticket. Completion requires zero open items; any remaining item keeps the result `NEEDS WORK`/`BLOCKED`.
- **Blocked by** — if any blocker ticket on the tracker is still open, stop: `BLOCKED (blocked by <tickets>)`.
- **The originating spec** (linked from the ticket when present) for the spec axis.

`--quick` and `--gate-only` never close checklist items and never complete the ticket.

## 4. Run Verification

### Completeness (default)

For each acceptance criterion, cite code, artifact, or command evidence:

| Status | Meaning |
| --- | --- |
| ✓ Complete | Code evidence found; behavior matches the criterion |
| ◐ Partial | Some evidence; missing edge case or error path |
| ✗ Missing | No evidence |

### Gates

Discover the project's real gates from the nearest `AGENTS.md`, package manifest, build configuration, and CI files. Run only commands the project actually declares, narrowest relevant gate first. For every gate record the exact command, exit code, and meaningful output. Mark an expected-but-absent category `NOT DECLARED`, never `PASS`. If a required gate fails, stop and report.

### `--review`

Review the diff by severity — Critical (bug, security, broken build), Important (missing test, missing error handling, unclear contract), Minor (style, naming, docs). Fix Critical/Important before completion; Minor can ship. Then hand a read-only review brief to the `reviewer` task role (or run the `code-review` skill for the two-axis Standards/Spec report when the change maps to a spec) — a self-review is not independent evidence. Any unresolved Major+ finding returns `NEEDS WORK` or `BLOCKED`.

### `--test`

One requirement at a time: failing test → run and confirm red → minimal implementation → green → refactor only at the end. Respect the seams already agreed in the spec's testing decisions.

## 5. Record the Evidence

Where the record goes follows the tracker:

- **Local markdown** (`.scratch/<feature>/issues/<NN>-<slug>.md`): append or update a `## Verification` section:

  ```markdown
  ## Verification
  - Completeness: N/M criteria evidenced
  - Gates: <exact command> → <exit code> PASS/FAIL; absent categories NOT DECLARED
  - Review: independent (reviewer role) — <findings or "clean">
  - Result: READY TO SHIP / NEEDS WORK / BLOCKED
  - Blocking issues: <list, or "none">
  ```

- **GitHub/GitLab**: post the same block as a comment on the ticket, then set status per the tracker doc's conventions.
- **Local spec file** (no ticket): append to the spec file under a `## Verification` heading.

Only for a full verification — complete evidence, all required gates, zero open checklist items, and a clean independent review — may `status:` fields on the ticket flip to done. With `--quick`, `--gate-only`, missing evidence, failed gates, or unresolved findings: do not touch status fields; report the limiting result instead of writing it.

## 6. Output

1. Result: **READY TO SHIP** / **NEEDS WORK** / **BLOCKED** / **PARTIAL** (`--quick` and `--gate-only` are never `READY TO SHIP`)
2. Completeness: N/M with evidence pointers (`path:line` or command output)
3. Gates table: exact commands, exit codes, PASS/FAIL/NOT DECLARED
4. Review findings (when `--review`): severity-ranked, with the independent reviewer's report
5. Blocking issues, or "none"
6. Where the evidence was recorded (path or comment)

## Related Commands

| Need | Command |
| --- | --- |
| Fix what verification found | `/fix <description>` (drives `diagnosing-bugs` when the failure resists a first glance) |
| Continue the work | `/implement <ticket>` |