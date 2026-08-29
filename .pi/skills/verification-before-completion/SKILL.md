---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
version: 1.0.0
tags: [workflow, code-quality]
dependencies: []
agent_types: [planner, worker, reviewer]
tools: []
---

# Verification Before Completion

## The Iron Law

<EXTREMELY-IMPORTANT>
**No completion claim without evidence.** "Done" means the named verification command ran, exited 0, and its output was inspected. Not "should work", "looks right", or "tested locally". **Evidence before assertion, always.**
</EXTREMELY-IMPORTANT>

## Use

Apply before any "done", "fixed", "passing", "works", or "ready to merge" claim; commit, push, PR, or after non-trivial edits. For pure prose or a directly observable artifact, cite the diff or artifact instead.

## Evidence

| Claim | Required evidence |
| --- | --- |
| Test, typecheck, lint, or build passes | Named command, exit 0, inspected output |
| Behavior is X | Reproduction plus observed output |
| Code matches spec | Diff or path + line range |
| Bug is fixed | Regression fails without, passes with |
| Shipped | All above plus commit or PR link |

Prose and code review are inspection, not verification.

## Workflow

1. Name the check before editing.
2. Run it and show the relevant output; do not paraphrase.
3. Inspect the exit code: non-zero makes the claim false. "0 tests", skipped tests, or hidden warnings do not pass.
4. Cite the command, output, path, line range, SHA, or test artifact.
5. If it fails, fix it or report the work as blocked; do not claim completion.

## Red Flags and Rationalizations

"It should work", "I've tested it", "tests pass", "LGTM", "one-line change", "existing tests cover it", "CI will catch it", "I'm in a hurry", and "it's obvious" are not evidence. Run the check again.

## Report

Report verification in normal, concise prose; do not emit a mandatory XML/JSON wrapper. Match detail to the claim:

- **Result:** say whether the requested result is verified, partial, blocked, or unverified.
- **Evidence:** name the exact command or probe, exit status, relevant output, and path/SHA when applicable.
- **Limits:** state skipped checks, remaining risks, or unavailable review; do not imply stronger proof than the evidence supports.

A one-line change may need only a diff review and focused command. A code change needs the relevant test/typecheck output. Research needs cited sources and a clear separation of fact, inference, and uncertainty. If no check ran, name the exact intended command and say why; urgency or small scope does not waive verification. Do not claim completion from inspection alone.
