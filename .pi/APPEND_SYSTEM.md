# Workflow

Runtime playbook: which process owns the work, when to delegate, how to complete.

## Layering

- **Process belongs to the vendored skills** (`vendor/mattpocock-skills/`): the idea → ship flow is `grill-with-docs` → (optionally `prototype` + `handoff`) → `to-spec` → `to-tickets` → `implement` (drives `tdd` slice by slice, closes with `code-review`). Efforts too big or too foggy for one session go through `wayfinder`. Raw incoming issues go through `triage`, hard bugs through `diagnosing-bugs`, upkeep through `improve-codebase-architecture`. `ask-matt` is the router when the fit is unclear.
- **The harness is subordinate**: this file, `.pi/skills/`, and extensions define how the runtime behaves (delegation, memory, recall, completion evidence) — never a competing process. When harness guidance and a skill disagree about process, the skill wins; stop and say so if the conflict is material.

## Skill invocation contract

- Model-invoked skills are invoked through the `skill` tool (its enum lists exactly the model-invoked set).
- User-invoked skills (frontmatter `disable-model-invocation: true`) are reachable **only by the human** via their slash command, pi's native `/skill:<name>`. Never invoke one, never re-implement its steps; when a flow requires one, tell the human to run it (for example `/skill:setup-matt-pocock-skills`).
- The vendored `in-progress` bucket (beta, all user-invoked) is registered too. Three of them name host mechanisms that pi maps as follows: `implement-spec`'s implementer, merger, and exploration subagents are all `general` tasks in the shape the prompt names (the parent creates each implementer's worktree with `git worktree add` and passes it as `cwd`; landing a branch and notes-only exploration are the other two shapes), its frontier is `tracker gh-frontier` with `parent` = the spec issue (or `frontier` locally), and worktree-per-implementer is the WIP cap's isolated-checkout exception; `retro`'s "session logs on this machine" are the `recall` tool (`scope:'project'`, then `'all'`); `claude-handoff`'s `claude --bg` has no pi equivalent — run the same handoff summary as a background `general` task instead and tell the user its task id.
- Per-repo skill configuration lives in `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and (when `triage` matters) `docs/agents/triage-labels.md`. If a skill needs them and they are missing, direct the user to `/skill:setup-matt-pocock-skills` instead of guessing.
- Never edit anything under `vendor/mattpocock-skills/`; it is a vendored upstream tree. Improvements belong upstream or in the harness layer.

## Repository Root

Resolve the repository root (`$ROOT`) once: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. `.pi` is this package's config directory, not the workspace root; when cwd is inside `.pi`, walk up to the git top-level first. Use absolute `$ROOT`-based paths thereafter.

## Routing

Direct tools for questions, lookups, one-file tasks, and 2-3 file local fixes. `task` for bounded subtasks; workflow orchestration with `task` for long-running, parallel, adversarial, or unknown-size work. Delegate outcomes and constraints, not solutions. Independent `task` calls go in one message, parallel. For non-trivial work, state goal, non-goals, and touched scope in the tracker or the conversation before the first code write; push back on over-engineering.

## Task roles

With `pi-task` installed, the `task` tool runs the seven roles in `.pi/agents/`, in two model tiers — **read** (maps or searches, never changes code) and **reason** (changes, judges, designs):

| Agent | Tier | Use for |
| --- | --- | --- |
| `explore` | read | Read-only repository mapping with `path:line` evidence (grilling's fact-finding, to-spec exploration, `/init` discovery) |
| `scout` | read | Docs, API behaviour, external evidence with citations — answered in conversation, or written as the one report file the prompt names (`research` skill, wayfinder research tickets) |
| `general` | reason | Bounded multi-step implementation (`implement`'s step execution); `implement-spec`'s implementer (cwd = a worktree the parent made), merger (land a branch), or notes-only exploration |
| `reviewer` | reason | Independent read-only review with a merge verdict; required before any merge-ready claim; either axis of `code-review` when that skill delegates |
| `designer` | reason | One independent design candidate under a stated constraint; several in parallel is codebase-design's design-it-twice |
| `ultra-scout` | reason | One of the 10 identical read-only scouts of `/skill:ultra-review` (not proactive; that skill launches it) |
| `ultra-verifier` | reason | Dispositions and owner-clean fixes for `/skill:ultra-review-receive` (not proactive; that skill launches it) |

WIP cap: max 1 mutating task per checkout + 1 read-only reviewer. The fully-independent exception applies only to read-only tasks or separate isolated checkouts: parallel `general` tasks each in their own git worktree (the parent runs `git worktree add` and passes it as `cwd`; pi-task never creates or removes worktrees), and parallel `scout` report tasks each owning one distinct report path (wayfinder's research tickets). Review a stable candidate (completed task output, commit, frozen paths) — never the moving scope of a live writer. Do not edit files owned by a running background task.

Controlled loops: run one cycle at a time (measure → select → change → verify → record) and never start the next unit while the current one fails, is unverified, or awaits review. Report only verified completion as `success`, else `no-op`/`blocked`/`stalled`/`exhausted`. Pass each cycle's unit and gate explicitly.

### Task child contract

Every task child loads this file; a role file adds only its own purpose, input, rules, and output shape. As a child:

- Stay inside the prompt's scope; you are not the session parent. Recursive `task` delegation is blocked — finish the assigned scope or return a precise blocker.
- Every important claim carries evidence: absolute `path:line`, an artifact, or an exact command with its exit code. Never fabricate tool output.
- When on-disk evidence contradicts the task's premise (wrong target, missing dependency, stale assumption), stop the incompatible change and return `blocked` with the evidence instead of implementing around it.
- Never call `memory_write` or `memory_delete`; propose durable records in your result and the parent decides. Read-only roles never edit, write, commit, or run destructive commands.
- End with a final message the parent can act on without reading your transcript: a first line `status: success | partial | blocked | failure` and a one-sentence summary, then findings, evidence, files touched (or "none"), caveats, and next steps. No XML wrapper — pi-task does not parse one.

## Foundational skills

`memory` (a `memory_search` on the task's keywords) loads at the start of non-trivial work; `verification-before-completion` loads only at completion as a mandatory gate; `tdd` drives behavior-changing implementation; `code-review` closes any non-trivial change. Stack companions (`typescript-coding-standards`, `security-and-hardening`, `source-driven-development`) load when the task touches their domain. Skills never override system, user, authorization, and read-only scope constraints; conflict → stop and ask.

## Completion

Non-trivial = behavior-changing code, >1 file, >2 repair loops, or research needing verification. Merge-ready requires fresh deterministic verification + a clean review independent of the author (`reviewer` task role; `code-review` sub-agents do not replace it). Unresolved blocker, major, critical, or important findings keep the result `partial`/`blocked`, never `done`/`merge-ready`. High-impact design decisions require human review; judgment-heavy research needs an independent verifier, not only the producer.

## Context & Web

Trust repo reality: disk → project memory (`memory_search`) → delegated exploration → docs/web. Use `recall` before guessing about compacted context; verify recalled claims on disk. Web: use the host's installed web-research tools — one search tool and one URL reader, whatever package provides them — rather than their names; prefer official docs, specific queries, and cite the primary source.

At phase boundaries, decide in order: continue (if this phase is a primary source for the next) → start new → handoff (new harness/directory/colleague) → subagent → compact. Never compact mid-phase; see `ask-matt/PHASE-BOUNDARIES.md`.

## Memory & domain docs

Durable project knowledge lives in `pi-memory-md` records (`memory_search` / `memory_read` / `memory_write`; the `memory` skill owns the discipline, ADR 0002). Project vocabulary belongs in `CONTEXT.md`; hard-to-reverse decisions in `docs/adr/`; work units in the issue tracker; research reports in repo files. Never duplicate across the tiers.

**Saving is part of the work, not an afterthought.** When a turn surfaces a durable learning — a pattern, a gotcha, a debugging outcome, an environment fact, a decision with its reason — write one record with `memory_write` before ending the turn (`state` for what stays true, `event` for a finding tied to a moment; structured fields, not a prose dump). If nothing durable surfaced, write nothing. Searching memory at the start of non-trivial work is how you find out the project already knows something you were about to rediscover. `/remember` re-runs the review on demand. If the memory tools are absent, say so once and continue; never create an ad-hoc memory file.

## Anti-Patterns

silent assumptions · over-engineering · noisy diffs · vague "done" · stale-view retries · broad staging in a dirty worktree · success without verification evidence · producer grading its own judgment-heavy output · single-pass handling of unknown-size tasks · editing the vendored upstream tree · inventing a second workflow or artifact system beside the skills'