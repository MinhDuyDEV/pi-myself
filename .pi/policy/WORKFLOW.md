# Workflow

Runtime playbook: which process owns the work, when to delegate, how to complete.

## Layering

- **Process belongs to the vendored skills** (`vendor/mattpocock-skills/`): the idea → ship flow is `grill-with-docs` → (optionally `prototype` + `handoff`) → `to-spec` → `to-tickets` → `implement` per ticket, or `implement-spec` for the whole spec on one integration branch (either drives `tdd` slice by slice and closes with `code-review`) → `retro`. Efforts too big or too foggy for one session go through `wayfinder`. Raw incoming issues go through `triage`, hard bugs through `diagnosing-bugs`, upkeep through `improve-codebase-architecture`. `ask-matt` is the router when the fit is unclear.
- **The harness is subordinate**: this policy, `.pi/skills/`, and extensions define how the runtime behaves (delegation, memory, recall, completion evidence) — never a competing process. When harness guidance and a skill disagree about process, the skill wins; stop and say so if the conflict is material. One exception: a task child never spawns (see the Task child contract), so a skill's orchestration steps are the parent's to run. A skill's own concurrency demands (code-review's two parallel axes, implement-spec's concurrent implementers) set the task count they need; the harness's steady-state limits bend to them, never the reverse.

## Skill invocation contract

- Model-invoked skills are invoked through the `skill` tool (its `name` parameter lists exactly the model-invoked set), also when a skill writes one as a slash command (`/tdd`, `/code-review` inside `implement`).
- User-invoked skills (frontmatter `disable-model-invocation: true`) are reachable **only by the human** via their slash command, pi's native `/skill:<name>`. Never invoke one, never re-implement its steps; when a flow requires one, tell the human to run it (for example `/skill:setup-matt-pocock-skills`).
- When no flow you hold fits the request, or the user asks where to start, load the `harness-catalog` skill and name the command to run: the main flow is human-launched, so naming it is the whole handoff.
- The vendored `in-progress` bucket (beta) is registered too, all user-invoked. A skill naming a host mechanism pi lacks or names differently (a spawned sub-agent, a background agent, `/clear`, `CLAUDE.md`, a script that reads stdin, `tdd`'s seam agreement inside a child) is translated in the `harness-catalog` skill's `pi-mapping.md`; load that skill before working one.
- Per-repo skill configuration lives in `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and (when `triage` matters) `docs/agents/triage-labels.md`. If a skill needs them and they are missing, direct the user to `/skill:setup-matt-pocock-skills` instead of guessing.
- Never edit anything under `vendor/mattpocock-skills/`; it is a vendored upstream tree. Improvements belong upstream or in the harness layer.

## Repository Root

Resolve the repository root (`$ROOT`) once: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. `.pi` is this package's config directory, not the workspace root; when cwd is inside `.pi`, walk up to the git top-level first. Use absolute `$ROOT`-based paths thereafter.

## Routing

Direct tools for questions, lookups, one-file tasks, and 2-3 file local fixes — and on structural questions (callers, dependencies, traces) reach for the `srcwalk` tool when the host has it, before `bash` grep/find. `task` for bounded subtasks; workflow orchestration with `task` for long-running, parallel, adversarial, or unknown-size work. Delegate outcomes and constraints, not solutions. Label each constraint in the prompt by its source — `Requirement:` the user asked for it; `Decision:` a spec, ticket, or ADR settled it (name which); `Choice:` you or an earlier task picked it — and put choices in `parent_context`/`proposed_changes`, apart from the goal. An unlabelled choice hardens into a requirement for every task after it. Where a vendored skill prescribes the brief (`code-review`'s axes, `implement-spec`'s context pointers, design-it-twice's constraints), its content wins: a pointer to a spec, ticket, or ADR is one `Decision:`, and you label only what you add. Independent `task` calls go in one message, parallel. For non-trivial work, state goal, non-goals, and touched scope in the tracker or the conversation before the first code write; push back on over-engineering. Tracker work goes through the `tracker` tool — it owns the field-level ops in the backend `docs/agents/issue-tracker.md` names, not raw `gh` or hand-edited ticket files.

## Task roles

With `pi-task` installed, the `task` tool runs the seven roles in `.pi/agents/`, in three model tiers — **read** (maps or searches, never changes code), **reason** (changes, designs), and **review** (judges; the `reviewer` runs a model family no reason-tier role uses, so it does not share the author's blind spots). A tier may mix models, each picked for its role's workload (ADR 0009):

| Agent | Tier | Use for |
| --- | --- | --- |
| `explore` | read | Read-only repository mapping with `path:line` evidence (grilling's fact-finding, to-spec exploration, `/init` discovery, `improve-codebase-architecture`'s friction walk) |
| `scout` | read | Docs, API behaviour, external evidence with citations — answered in conversation, or written as the one report file the prompt names (`research` skill, wayfinder research tickets) |
| `general` | reason | Bounded multi-step implementation (`implement`'s step execution); `implement-spec`'s implementer (cwd = a worktree the parent made), merger (land a branch), or notes-only exploration |
| `designer` | reason | One independent design candidate under a stated constraint; several in parallel is codebase-design's design-it-twice |
| `ultra-verifier` | reason | Dispositions and owner-clean fixes for `/skill:ultra-review-receive` (not proactive; that skill launches it) |
| `reviewer` | review | Independent read-only review with a merge verdict; required before any merge-ready claim; either axis of `code-review` when that skill delegates |
| `ultra-scout` | review | One of the 10 identical read-only scouts of `/skill:ultra-review` (not proactive; that skill launches it) |

WIP cap: max 1 mutating task per checkout; read-only tasks carry no cap, so the reviewer that usually follows a writer is a rhythm, not a reserved slot. Parallel read-only tasks run freely: `code-review`'s two axes as two read-only tasks on the review tier, several `designer` candidates, `scout` reports each owning one distinct report path (wayfinder's research tickets). Mutating concurrency requires separate isolated checkouts: parallel `general` tasks each in their own git worktree (the parent runs `git worktree add` and passes it as `cwd`; pi-task never creates or removes worktrees). Review a stable candidate (completed task output, commit, frozen paths) — never the moving scope of a live writer. Do not edit files owned by a running background task, and never wait on one (`sleep`, `ps`/`pgrep`, re-resuming to check): a completion starts its own turn.

Brief a review-tier task with the diff scope, the spec or criteria, and the raw gate output — never your own verdict or your explanation of why the change is correct; a judge that reads the author's conclusion inherits it.

A child's **challenge** argues, with evidence, that a `Decision` or `Choice` in its brief cannot meet the goal — a writer returns it as `blocked`, a reading, reviewing, or design child as a finding; treat it as evidence about the brief. Question it before ruling: which condition fails, whether a smaller fix inside the current choice holds, what the alternative adds or removes. A ruling that changes a `Requirement` or an ADR decision, or spends cost the user has not approved, is the user's to make. Record the ruling where the plan lives (the tracker, else the conversation), then deliver it by `task_id`: to a challenger that blocked, whatever the ruling (a resume keeps its discovery), and, when the ruling changes the brief, to every running task that writes on top of the old choice (a `task_id` call steers a live run). A review whose candidate the ruling changes starts again on the new candidate. The SDK backend can neither resume nor steer: there the ruling travels in a fresh task carrying the challenger's evidence.

Controlled loops: run one cycle at a time (measure → select → change → verify → record) and never start the next unit while the current one fails, is unverified, or awaits review. Report only verified completion as `success`, else `no-op` (nothing needed changing), `blocked` (a precondition, dependency, or authority is missing), `stalled` (a round produced no new evidence or hypothesis, or the same approach failed a second time), or `exhausted` (the round bound agreed before the loop, 3 when none was set, ran out; return the round record: hypothesis, change scope, and rerun verdict per round). Before spending a round on a red check the unit did not set out to fix, attribute it: red on the base revision too is infrastructure (rerun once, then escalate; never bend the change to it), a changed fixture or upstream asset is drift (repin), and only a failure that reproduces on this diff is the change's to repair — then rerun the same check, not an easier one. Pass each cycle's unit and gate explicitly.

### Task child contract

A child never sees this policy: the `policy` extension injects it into the session parent only, and pi-task hands a child its role body. What binds every child — stay in scope, spawn nothing, never ask the user or write memory, `blocked` on contradicting evidence or with a challenge, a first line `Status: success | partial | blocked | failure` — is the generated block that ends each role in `.pi/agents/`. The prompt is the whole handoff: put every decision the child needs in it, including the seams agreed for `tdd` work.

## Foundational skills

`memory` (a `memory_search` on the task's keywords) loads at the start of non-trivial work; `verification-before-completion` loads only at completion as a mandatory gate; `tdd` drives behavior-changing implementation; `code-review` closes any non-trivial change. Stack companions (`typescript-coding-standards`, `security-and-hardening`, `source-driven-development`) load when the task touches their domain. Skills never override system, user, authorization, and read-only scope constraints; conflict → stop and ask.

## Completion

Non-trivial = behavior-changing code, >1 file, >2 repair loops, or research needing verification. Merge-ready requires fresh deterministic verification + a clean review independent of the author (`reviewer` task role; `code-review` sub-agents do not replace it). Unresolved blocker, major, critical, or important findings keep the result `partial`/`blocked`, never `done`/`merge-ready`. High-impact design decisions require human review; judgment-heavy research needs an independent verifier, not only the producer. For delegated work, the final report separates the user's requirements from the choices made along the way and names each challenge a child raised, the ruling it got, and any disagreement still open.

## Context & Web

Trust repo reality: disk → project memory (`memory_search`) → delegated exploration → docs/web. Use `recall` before guessing about compacted context; verify recalled claims on disk. Web: use the host's installed web-research tools — one search tool and one URL reader, whatever package provides them — rather than their names; prefer official docs, specific queries, and cite the primary source.

At phase boundaries, decide in order: continue (if this phase is a primary source for the next) → start new → handoff (new harness/directory/colleague) → subagent → compact. Never compact mid-phase.

## Memory & domain docs

Durable project knowledge lives in `pi-workspace-memory` records (`memory_search` / `memory_read` / `memory_write`; the `memory` skill owns the discipline, ADR 0002). Project vocabulary belongs in `GLOSSARY.md`; hard-to-reverse decisions in `docs/adr/`; work units in the issue tracker; research reports in repo files. Never duplicate across them.

**Saving is part of the work, not an afterthought.** When a turn surfaces a durable learning — a pattern, a gotcha, a debugging outcome, an environment fact, a decision with its reason — write one record with `memory_write` before ending the turn (`state` for what stays true, `event` for a finding tied to a moment; structured fields, not a prose dump). If nothing durable surfaced, write nothing. Searching memory at the start of non-trivial work is how you find out the project already knows something you were about to rediscover. If the memory tools are absent, say so once and continue; never create an ad-hoc memory file.

## Anti-Patterns

silent assumptions · over-engineering · noisy diffs · vague "done" · stale-view retries · broad staging in a dirty worktree · success without verification evidence · producer grading its own judgment-heavy output · single-pass handling of unknown-size tasks · editing the vendored upstream tree · inventing a second workflow or artifact system beside the skills'