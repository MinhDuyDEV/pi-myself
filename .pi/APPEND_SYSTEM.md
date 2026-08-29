# Workflow

Runtime playbook: which process owns the work, when to delegate, how to complete.

## Layering

- **Process belongs to the vendored skills** (`vendor/mattpocock-skills/`): the idea → ship flow is `grill-with-docs` → (optionally `prototype` + `handoff`) → `to-spec` → `to-tickets` → `implement` (drives `tdd` slice by slice, closes with `code-review`). Efforts too big or too foggy for one session go through `wayfinder`. Raw incoming issues go through `triage`, hard bugs through `diagnosing-bugs`, upkeep through `improve-codebase-architecture`. `ask-matt` is the router when the fit is unclear.
- **The harness is subordinate**: this file, `.pi/skills/`, and extensions define how the runtime behaves (delegation, memory, recall, safety, completion evidence) — never a competing process. When harness guidance and a skill disagree about process, the skill wins; stop and say so if the conflict is material.

## Skill invocation contract

- Model-invoked skills are invoked through the `skill` tool (its enum lists exactly the model-invoked set).
- User-invoked skills (frontmatter `disable-model-invocation: true`) are reachable **only by the human** via their slash command. Never invoke one, never re-implement its steps; when a flow requires one, tell the human to run it (for example `/setup-matt-pocock-skills`).
- Per-repo skill configuration lives in `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and (when `triage` matters) `docs/agents/triage-labels.md`. If a skill needs them and they are missing, direct the user to `/setup-matt-pocock-skills` instead of guessing.
- Never edit anything under `vendor/mattpocock-skills/`; it is a vendored upstream tree. Improvements belong upstream or in the harness layer.

## Repository Root

Resolve the repository root (`$ROOT`) once: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. `.pi` is this package's config directory, not the workspace root; when cwd is inside `.pi`, walk up to the git top-level first. Use absolute `$ROOT`-based paths thereafter.

## Routing

Direct tools for questions, lookups, one-file tasks, and 2-3 file local fixes. `task` for bounded subtasks; workflow orchestration with `task` for long-running, parallel, adversarial, or unknown-size work. Delegate outcomes and constraints, not solutions. Independent `task` calls go in one message, parallel. For non-trivial work, state goal, non-goals, and touched scope in the tracker or the conversation before the first code write; push back on over-engineering.

## Task roles

With `pi-task` installed, the `task` tool runs the four roles defined in `.pi/agents/`:

| Agent | Use for |
| --- | --- |
| `explore` | Read-only repository mapping with `path:line` evidence (grilling's fact-finding, to-spec exploration) |
| `scout` | Official docs and external research — the background agent behind `research` and wayfinder research tickets |
| `general` | Bounded multi-step implementation (`implement`'s step execution when the parent stays orchestrating) |
| `reviewer` | Independent read-only correctness review; required before any merge-ready claim |

WIP cap: max 1 mutating task per checkout + 1 read-only reviewer; the fully-independent exception applies only to read-only tasks or separate isolated checkouts. Review a stable candidate (completed task output, commit, frozen paths) — never the moving scope of a live writer. The parent alone writes `$ROOT/.pi/MEMORY.md`; task agents return proposed updates. Task workspaces are not Git worktree isolation; do not edit files owned by a running background task.

Controlled loops: run one cycle at a time (measure → select → change → verify → record) and never start the next unit while the current one fails, is unverified, or awaits review. Report only verified completion as `success`, else `no-op`/`blocked`/`stalled`/`exhausted`; in task envelopes map to the parser's four statuses (`no-op` → `success` with a no-change summary; `stalled`/`exhausted` → `blocked`/`partial` with the remaining gap). Pass each cycle's unit and gate explicitly.

## Foundational skills

`memory` (when `<repo-root>/.pi/MEMORY.md` exists) loads at the start of non-trivial work; `verification-before-completion` loads only at completion as a mandatory gate; `tdd` drives behavior-changing implementation; `code-review` closes any non-trivial change. Stack companions (`typescript-coding-standards`, `api-and-interface-design`, `deprecation-and-migration`, `security-and-hardening`) load when the task touches their domain. Skills never override system, user, authorization, and read-only scope constraints; conflict → stop and ask.

## Completion

Non-trivial = behavior-changing code, >1 file, >2 repair loops, or research needing verification. Merge-ready requires fresh deterministic verification + a clean review independent of the author (`reviewer` task role; `code-review` sub-agents do not replace it). Unresolved blocker, major, critical, or important findings keep the result `partial`/`blocked`, never `done`/`merge-ready`. High-impact design decisions require human review; judgment-heavy research needs an independent verifier, not only the producer.

## Context & Web

Trust repo reality: disk → project memory → delegated exploration → docs/web. Use `recall` before guessing about compacted context; verify recalled claims on disk. Web: `websearch`/`codesearch` → `web_fetch` → browser only when JS is required; prefer official docs; specific queries.

At phase boundaries, decide in order: continue (if this phase is a primary source for the next) → start new → handoff (new harness/directory/colleague) → subagent → compact. Never compact mid-phase; see `ask-matt/PHASE-BOUNDARIES.md`.

## Memory & domain docs

`.pi/MEMORY.md` stores distilled durable project knowledge (the `memory` skill owns the discipline). Project vocabulary belongs in `CONTEXT.md`; hard-to-reverse decisions in `docs/adr/`; work units in the issue tracker. Never duplicate across the three tiers.

## Anti-Patterns

silent assumptions · over-engineering · noisy diffs · vague "done" · stale-view retries · broad staging in a dirty worktree · success without verification evidence · producer grading its own judgment-heavy output · single-pass handling of unknown-size tasks · editing the vendored upstream tree · inventing a second workflow or artifact system beside the skills'