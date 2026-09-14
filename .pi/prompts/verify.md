---
description: Verify a ticket against its acceptance criteria with real project gates and an independent review, and record the evidence on the ticket through the tracker tool
argument-hint: "<ticket> [--gates-only]"
---

# Verify: $ARGUMENTS

Resolve the repository root first: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. `docs/agents/issue-tracker.md` names the backend; if it is missing, stop and tell the user to run `/skill:setup-matt-pocock-skills`. Local backend → the `tracker` ops without prefix (`feature` + `ticket`); GitHub backend → the `gh-*` ops (`ticket` = issue number). Never hand-edit ticket files or shell out to `gh` for what the tool does.

`--gates-only` runs step 2 alone and reports; it never records, ticks, or completes.

## 1. Read the ticket

`tracker show` / `gh-show`. Collect the acceptance criteria (every unchecked box), the `Blocked by` references, and the originating spec when linked. An open blocker stops here: result `BLOCKED (blocked by …)`. A missing ticket is a stop, never a partial verify.

## 2. Gates

Gates are the commands the repo declares in `AGENTS.md`, its manifest, build configuration, and CI — run the narrowest relevant ones first, record each exact command, exit code, and meaningful output. An expected-but-absent category is `NOT DECLARED`, never `PASS`. A failing required gate stops the verification: report it.

## 3. Criteria → evidence

For each acceptance criterion cite code, artifact, or command output:

| Status | Meaning |
| --- | --- |
| ✓ Complete | Evidence found; behavior matches |
| ◐ Partial | Some evidence; an edge case or error path is missing |
| ✗ Missing | No evidence |

`tracker tick` / `gh-tick` (1-based `index`) only the criteria that are ✓ with evidence.

## 4. Independent review

`READY TO SHIP` requires a clean review that is not the author's: launch one read-only `reviewer` task with the diff scope, the spec, and the acceptance criteria. Any unresolved Blocker or Major finding keeps the result `NEEDS WORK`. `code-review`'s two-axis report (standards, spec) complements this task and never replaces it: its axes are scoped to conformance, this task owns correctness, security, and regressions. Cite an existing `code-review` report instead of re-running those axes.

## 5. Record

Post one block on the ticket with `tracker comment` / `gh-comment`:

```markdown
## Verification
- Completeness: N/M criteria evidenced
- Gates: <exact command> → <exit code> PASS/FAIL; absent categories NOT DECLARED
- Review: reviewer task — <clean | findings summary>
- Result: READY TO SHIP / NEEDS WORK / BLOCKED
- Blocking issues: <list, or "none">
```

Flip the ticket's status (`tracker status` / `gh-status`) only on `READY TO SHIP`: zero open criteria, all required gates passing, review clean. Otherwise leave status alone and report the limiting result.

## 6. Output

Result line, then the completeness table with `path:line` pointers, the gates table, review findings by severity, blocking issues, and where the record landed. Fix what verification found through `/skill:diagnosing-bugs` (hard failures) and `tdd` (the regression test); continue the work with `/skill:implement`.
