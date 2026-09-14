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
| Test, typecheck, lint, or build passes | Named command, exit 0, inspected output ("0 tests", skipped tests, hidden warnings do not pass) |
| Behavior is X | Reproduction plus observed output |
| Code matches spec | Diff or path + line range |
| Bug is fixed | Regression fails without the fix, passes with it |
| Shipped | All above plus commit or PR link |

Prose and code review are inspection, not verification. If the check fails, fix it or report the work as blocked; if no check ran, name the exact intended command and say why.

## Red Flags

"It should work", "I've tested it", "tests pass", "LGTM", "one-line change", "existing tests cover it", "CI will catch it", "I'm in a hurry", and "it's obvious" are not evidence. Run the check again.
