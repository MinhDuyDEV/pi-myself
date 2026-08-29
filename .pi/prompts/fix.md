---
description: Fix a bug or refactor code — drives the diagnosing-bugs discipline for the hard ones and closes with evidence
argument-hint: "<bug description or path> [--refactor] [--scope minimal|moderate|aggressive]"
---

# Fix: $ARGUMENTS

Resolve the repository root first: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. If Git cannot resolve a repo and the current directory has no project files, stop.

Two tracks for improving code without adding features:

- **Default (Bug fix):** systematically diagnose and fix a bug or failing test.
- **`--refactor`:** improve code quality without changing external behavior.

## Skills

- **Bug fix:** call the Skill tool with `diagnosing-bugs` and follow its loop; a behavior-changing fix also drives `tdd` (red → green, one slice at a time). Load `verification-before-completion` at completion as the mandatory gate.
- **Refactor:** call the Skill tool with `codebase-design` when the change touches module shape or interfaces; close with `code-review` before committing. Load `verification-before-completion` at completion.
- Skill rules never override system, user, or read-only constraints; conflict → stop and ask.

## Shared Verification Contract

Discover real project gates from the nearest `AGENTS.md`, package manifest, build configuration, and CI files. Run the behavior-specific proof plus only related declared commands. Record every exact command, exit code, and meaningful output. Mark an expected-but-absent category `NOT DECLARED`, never `PASS`. If verification fails twice on the same approach, stop and escalate with what was tried and what failed.

---

# Track 1: Bug fix (default)

`--scope minimal|moderate|aggressive` (default: minimal). For a bug that resists a first glance, an intermittent flake, or a regression between two known-good states, the `diagnosing-bugs` skill owns the loop; this section is its local harness.

### Phase 1: Reproduce

- Build the tight feedback loop from the skill: one command that already goes red on *this* bug.
- Capture the exact error output, stack trace, or symptom.
- If the failure cannot be reproduced, write down the environment assumptions and stop — do not fix what cannot be reproduced.

### Phase 2: Isolate

- Search the codebase for the error message or symptom pattern.
- Check recent changes: `git diff`, `git log --oneline -15`.
- Trace backward from symptom to root cause. Before asking "how do I guard this instance?", ask "what invariant would make this class of failure impossible?"
- Read the 2-4 most relevant files around the failure point.

### Phase 3: Fix

- Name the proof path before editing: the test that fails today and will pass when fixed.
- Prefer making the bad state structurally impossible over defensive guards; no speculative guards, tolerant readers, or defensive copies.
- No unrelated fixes. A cleanup is in scope only when it belongs to the same verified failure class and has a named proof path.
- Stop and ask about architectural changes.

### Phase 4: Verify

- Run the reproduction; it must pass. Run related declared gates for regressions.
- For a behavior-changing fix, the fix is built test-first (`tdd`): a regression test that fails without the fix and passes with it.

### Output (bug fix)

1. **Root cause** (`path:line`): what was wrong and why
2. **Fix applied** (`path:line`)
3. **Verification**: exact commands, exit codes, and the red→green evidence
4. **Rejected alternatives**: what else was considered and why not
5. **Related findings**: anything else discovered

---

# Track 2: Refactor (`--refactor`)

Improve clarity, performance, or maintainability without changing external behavior.

### Phase 1: Assess

Read the target thoroughly; name the specific issues (duplication, complexity, naming, coupling). Check blast radius with search and caller reads before changing exports or signatures. Establish a baseline with an existing behavior check or declared focused gate.

### Phase 2: Plan

Present the plan before executing: | Category | What | Why | Risk |. Wait for approval.

### Phase 3: Execute

One logical change at a time; rerun the baseline check after each step; it must pass. Scope levels: `--scope minimal` (smallest fix that works, name a lazier alternative if one exists), `--scope moderate` (default), `--scope aggressive` (cross-file restructuring, interfaces may change — only with approval).

### Phase 4: Verify

Baseline behavior unchanged for the same inputs; related declared gates pass; absent categories reported as `NOT DECLARED`. Then `code-review` the diff before committing.

### Output (refactor)

1. Scope: files and modules changed
2. Issues addressed
3. Interface changes (before/after) if any
4. Verification: exact commands, exit codes, PASS/FAIL/NOT DECLARED
5. Blast radius: dependencies affected