---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

<EXTREMELY-IMPORTANT>
**No completion claim without evidence.** "Done" means the named verification command ran, exited 0, and its output was inspected. Not "should work", "looks right", or "tested locally". **Evidence before assertion, always.**
</EXTREMELY-IMPORTANT>

Apply before any "done", "fixed", "passing", "works", or "ready to merge" claim; before commit, push, or PR; after non-trivial edits. For pure prose or a directly observable artifact, cite the diff or artifact instead.

## Evidence

| Claim | Required evidence |
| --- | --- |
| Test, typecheck, lint, or build passes | Named command, exit 0, inspected output showing the intended cases ran ("0 tests", skipped tests, hidden warnings, an early stop that still exits 0, or a silent fallback to a narrower check do not pass) |
| Behavior is X | Reproduction plus observed output |
| Code matches spec | Diff or path + line range |
| Bug is fixed | Regression fails without the fix, passes with it |
| Shipped | All above plus commit or PR link |

Prose and code review are inspection, not verification. If the check fails, fix it or report the work as blocked; if no check ran, name the exact intended command and say why.

A required check that ran but whose evidence could not be collected (output lost, evaluator unavailable, deadline hit) is **unobserved**: not `blocked` (the check could not run at all) and never a pass, so the result stays `partial`. A check that both passes and fails on the same revision is flaky: name the suspected nondeterminism instead of rerunning until green; it counts as unobserved.

## Bar Check

A green check proves nothing if the diff lowered the bar to reach it. Before any completion claim, read `git diff` (staged and unstaged, against the branch point) for these six moves:

1. **A test got easier** — `.skip`/`.todo`/`xit` added, a test file deleted, assertions removed from tests that stayed.
2. **A checker got silenced** — new `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`, `# type: ignore`, `# noqa`.
3. **A threshold moved down** — coverage, budget, severity, or timeout edited; a gate removed from a script or CI step.
4. **Work is unfinished** — a stub that throws, an empty `catch`, a `TODO` standing where the implementation should be.
5. **An exception appeared** — a new allowlist entry or ignore pattern nobody asked for.
6. **A baseline got regenerated** — snapshot, golden, fixture, or screenshot files rewritten (`-u`, `--update-snapshots`) so a failing comparison now matches.

Tightening the bar is silent; loosening it is loud. Every hit is either reverted or named in the final message with its reason (for a regenerated baseline, the behavior change that motivated it). A hit the task did not call for makes the work `partial`, not done.

## Red Flags

"It should work", "I've tested it", "tests pass", "LGTM", "one-line change", "existing tests cover it", "CI will catch it", "passed on the second run", "I'm in a hurry", and "it's obvious" are not evidence. Run the check again.
