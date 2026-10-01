# Agent roster

Seven task roles for the `task` tool. Each file is the role's **prompt** — pi-task passes its body as the child's `--append-system-prompt`, so a body says only what the child needs (purpose, input, rules, output). Routing lives in the `description` field (the parent's catalog) and in the workflow policy the `policy` extension injects into the session parent, which the child never sees: the extension skips task children, and the flag also suppresses any discovered `APPEND_SYSTEM.md`, so a child gets pi's base prompt, `AGENTS.md`, the skills list, and its role body. The shared rules every child follows (scope, no spawning, no questions to the user, evidence, `blocked`, memory, the `Status:` line) therefore ride in each body: `.pi/policy/CHILD-CONTRACT.md` is the one source, and `npm run agents:sync` splices it between the `child-contract` markers at the end of every role (`npm run agents:check` fails on drift). Edit the source, never a block.

## Roster and tiers

Three model tiers fix what a role may do: **read** roles map or search and never change code; **reason** roles change or design; **review** roles judge what the reason tier wrote and never write. The model is picked per role, for its workload (ADR 0009): a tier may mix a cheap workhorse with a stronger model for its judgement roles, set on each role's `model:` and `thinking:` lines — pi-task has no shared default. One rule binds the choice: the `reviewer` runs a **model family no reason-tier role uses** (and ideally not the one you drive the main session with), because any reason role may have authored what it judges, and a reviewer on the author's family shares the author's blind spots — `tests/agents.test.ts` and `/setup-pi-myself --check` both fail on a shared family. `ultra-scout` is not bound: `/skill:ultra-review` is an opt-in sweep, not the merge gate.

| Role | Tier | Writes? | Serves (Matt's skills) |
| --- | --- | --- | --- |
| `explore` | read (`thinking: low`) | no | grilling's fact-finding, to-spec exploration, `/init` discovery, `improve-codebase-architecture`'s friction walk |
| `scout` | read (`thinking: high`) | one report file when the prompt names a path | `research` skill, wayfinder `research` tickets, any docs/web question |
| `general` | reason | yes | `implement` step execution; `implement-spec`'s implementer (cwd = a worktree the parent made), merger (land a branch), and notes-only exploration |
| `designer` | reason | no | `codebase-design`'s DESIGN-IT-TWICE (several in parallel, one candidate each) |
| `ultra-verifier` | reason | yes | `/skill:ultra-review-receive` — `proactive: false`, launched only by that skill |
| `reviewer` | review | no | the independent review the workflow policy requires before merge-ready; either axis of `code-review` when it delegates |
| `ultra-scout` | review | no | `/skill:ultra-review` (10 identical scouts) — `proactive: false`, launched only by that skill |

Read-tier roles are `readonly: true` except `scout`, whose only write is the one report path a prompt authorises. Review-tier roles are always `readonly: true`. A scout's single-file bound is prose, not machinery: pi-task cannot scope a write to a path, and `readonly: true` would break the report shape, so the bound is stated in the body and pinned by a test.

## Pick by task

| Task shape | Role |
| --- | --- |
| How does X work in this repo? | `explore` |
| Docs, API behaviour, external facts; a research ticket that must land as a file | `scout` |
| Implement, fix, or research that needs edits; one spec ticket in a worktree; land a branch | `general` |
| Review a diff or check it against a spec | `reviewer` |
| One interface/architecture candidate (run several) | `designer` |

## Frontmatter

pi-task parses frontmatter line by line: one-line `description`, comma-separated `tools` / `skills`. Honoured fields: `description`, `model`, `thinking`, `readonly`, `proactive`, `hidden`, `tools`, `disallowed_tools`, `skills`, `fast`, `max_turns`. `skills:` names resolve against pi's registry and an unknown name fails the launch. `readonly: true` denies write/edit/apply_patch but not `bash` or `tracker`. Recursive `task` delegation is always blocked in children.

`skills:` is **not a preload**. pi-task validates each name and passes its path with `--skill`, but loading stays progressive (pi-task README): the child sees the skill in its list and reads the body only when told to. So every declared skill is named on the body's `Load first:` line, which the child contract tells the child to act on before starting; a skill a role needs in one shape only (`scout`'s `research`, in the report shape) is named there with that condition. Memory reads need no skill: the contract carries them.

Mechanical denies back the contract's prose: every role carries `disallowed_tools: memory_write, memory_delete, ask_user` (only the parent writes memory; a child's question would wait in a pane nobody answers until the hard timeout), and the roles that must not change state also deny `tracker` or leave it off their allowlist. `max_turns` is the soft limit pi-task enforces on terminal backends — HerdR, this harness's primary backend, or tmux: at the limit it steers a wrap-up and allows ten grace turns, well before the 30-minute `PI_TASK_HARD_TIMEOUT_MINUTES` ceiling that stops a child without a result. SDK and foreground runs have no turn limit.

An explicit `tools:` line is an allowlist intersected with the parent's own tool names, so naming a tool a machine lacks costs nothing (it is dropped). A role *without* one inherits the parent's whole registry — `pi.getAllTools()` is every registered tool, not the active set — which is how `general`, `scout`, `reviewer`, and `designer` get `srcwalk` without naming it; an explicit list is therefore the only place a role can lose a tool, and every list that reads code names `srcwalk`. These roles are pi-runtime only: the Claude translator rejects the pi-only names they rely on.

## Worktrees

pi-task never creates, merges, or removes worktrees. For parallel mutating work the **parent** runs `git worktree add`, passes the worktree as `cwd`, and later merges (a `general` "land a branch" task) and removes it. Task workspaces are not filesystem isolation by themselves.

**Waiting is not a job.** When a background task settles, pi-task calls `pi.sendMessage` with `triggerTurn: true` ("so an idle parent still gets a turn" — `helpers.js` `completionDeliveryOptions`), which is why the workflow policy forbids waiting on one. A poll costs a whole turn with the whole context attached, and it competes with the concurrency the skill asked for: while implementers run, the parent does other independent work or ends its reply. Only a *foreground* `task` call blocks by design.

**Steering is a job.** A `task` call carrying a running task's `task_id` delivers its prompt into the live run on HerdR or tmux (pi-task answers "delivered the follow-up prompt"; `lifecycle/task-resume.js`), and one carrying a settled task's `task_id` reopens that saved session, context included. The SDK fallback supports neither (nor `cancel`): a ruling there reaches the challenger as a fresh task whose prompt carries its evidence, and a running SDK writer it touches finishes first and is then briefed again. This is how the parent sends a changed decision to the tasks it touches — a new instruction, never a status check.

Two or more `general` implementers on one spec (`implement-spec`), end to end:

1. Create the integration branch, then `git worktree add ../<repo>-t<n> -b ticket-<n> <integration-branch>` once per takeable ticket, and launch every `general` task in one message, each with its own `cwd`, that ticket's pointer, and the integration branch's name. Each implementer merges that branch's tip into its own before reporting done.
2. Let every writer stop before reviewing: a `reviewer` task reads a branch only after its task settled, never a live one.
3. Land branches one at a time with a `general` "land a branch" task and rerun the declared gates after each landing, so a conflict belongs to the branch that caused it.
4. `git worktree remove ../<repo>-t<n>` once its branch has landed; the branch itself stays for the parent's normal flow.

## Prompt template (parent → `task`)

Goal, non-goals, each constraint the prompt adds labelled `Requirement:`, `Decision:`, or `Choice:` (the workflow policy's routing rule; choices in `parent_context` / `proposed_changes`, and a pointer to a spec, ticket, or ADR counts as one `Decision:`), write/read policy (and the `cwd` when it is a worktree), pointers to the ticket/spec/notes instead of pasted prose, **agreed seams** for any behaviour change (`tdd` confirms seams with the user before a test, which a child cannot do, so `general` returns `blocked` with proposed seams when none are named), expected output, stop condition, verification recipe. Read the child's artifacts yourself before trusting its summary.

`tests/agents.test.ts` gates the roster: a model on every role, read from the role files, the `reviewer`'s family ≠ every reason-tier role's, `proactive: false` on the pipeline roles, no routing sections or result-envelope boilerplate in bodies, the child-contract block identical to its source at the end of every role, every declared skill on the `Load first:` line, the `ask_user` and `tracker` denies, `max_turns`, every tool a body names reachable through that role's allowlist, a mitigation sentence behind every coordinator skill a role loads, the mechanical memory deny, and — across the vendored trees — a host translation in the `harness-catalog` skill for every skill that mentions a sub-agent or background agent (a mention-only skill is exempted by name, with the reason).
