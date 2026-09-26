# Agent roster

Seven task roles for the `task` tool. Each file is the role's **prompt** — pi-task appends its body to the child's system prompt, so a body says only what the child needs (purpose, input, rules, output). Routing lives in the `description` field (the parent's catalog) and in `APPEND_SYSTEM.md`; the shared rules every child follows (scope, evidence, `blocked`, memory, final message) live in APPEND_SYSTEM's **Task child contract**, which every child loads with the rest of the project context.

## Roster and tiers

Three model tiers, so picking a model is mechanical: **read** roles map or search and never change code; **reason** roles change or design; **review** roles judge what the reason tier wrote. Change a tier's model by editing the `model:` line of the roles in that tier — pi-task has no shared default. One rule binds the choice: the review tier runs a **different model family** from the reason tier (and ideally from the model you drive the main session with), because a reviewer on the author's model shares the author's blind spots — `tests/agents.test.ts` fails when the families match.

| Role | Tier | Writes? | Serves (Matt's skills) |
| --- | --- | --- | --- |
| `explore` | read (`thinking: low`) | no | grilling's fact-finding, to-spec exploration, `/init` discovery, `improve-codebase-architecture`'s friction walk |
| `scout` | read (`thinking: high`) | one report file when the prompt names a path | `research` skill, wayfinder `research` tickets, any docs/web question |
| `general` | reason | yes | `implement` step execution; `implement-spec`'s implementer (cwd = a worktree the parent made), merger (land a branch), and notes-only exploration |
| `designer` | reason | no | `codebase-design`'s DESIGN-IT-TWICE (several in parallel, one candidate each) |
| `ultra-verifier` | reason | yes | `/skill:ultra-review-receive` — `proactive: false`, launched only by that skill |
| `reviewer` | review | no | the independent review APPEND_SYSTEM requires before merge-ready; either axis of `code-review` when it delegates |
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

pi-task parses frontmatter line by line: one-line `description`, comma-separated `tools` / `skills`. Honoured fields: `description`, `model`, `thinking`, `readonly`, `proactive`, `hidden`, `tools`, `disallowed_tools`, `skills`, `fast`. `skills:` names resolve against pi's registry and an unknown name fails the launch. `readonly: true` denies write/edit/apply_patch but not `bash`. Recursive `task` delegation is always blocked in children.

`skills:` is a **preload**, not a wish list: every listed skill rides in every run of that role. A skill a role needs in one shape only — the merge shape's `resolving-merge-conflicts` — is named in the body and loaded on demand with the skill tool instead. Every role also carries `disallowed_tools: memory_write, memory_delete`, which makes the child contract's "only the parent writes memory" rule mechanical rather than advisory.

An explicit `tools:` line is an allowlist intersected with the parent's own tool names, so naming a tool a machine lacks costs nothing (it is dropped). A role *without* one inherits the parent's whole registry — `pi.getAllTools()` is every registered tool, not the active set — which is how `general`, `scout`, `reviewer`, and `designer` get `srcwalk` without naming it; an explicit list is therefore the only place a role can lose a tool, and every list that reads code names `srcwalk`. These roles are pi-runtime only: the Claude translator rejects the pi-only names they rely on.

## Worktrees

pi-task never creates, merges, or removes worktrees. For parallel mutating work the **parent** runs `git worktree add`, passes the worktree as `cwd`, and later merges (a `general` "land a branch" task) and removes it. Task workspaces are not filesystem isolation by themselves.

**Waiting is not a job.** When a background task settles, pi-task calls `pi.sendMessage` with `triggerTurn: true` ("so an idle parent still gets a turn" — `helpers.js` `completionDeliveryOptions`), which is why this roster's rules in `APPEND_SYSTEM.md` forbid waiting on one. A poll costs a whole turn with the whole context attached, and it competes with the concurrency the skill asked for: while implementers run, the parent does other independent work or ends its reply. Only a *foreground* `task` call blocks by design.

Two or more `general` implementers on one spec, end to end:

1. `git worktree add ../<repo>-t<n> -b ticket-<n>` once per takeable ticket, then launch every `general` task in one message, each with its own `cwd` and that ticket's pointer.
2. Let every writer stop before reviewing: a `reviewer` task reads a branch only after its task settled, never a live one.
3. Land branches one at a time with a `general` "land a branch" task and rerun the declared gates after each landing, so a conflict belongs to the branch that caused it.
4. `git worktree remove ../<repo>-t<n>` once its branch has landed; the branch itself stays for the parent's normal flow.

## Prompt template (parent → `task`)

Goal, non-goals, write/read policy (and the `cwd` when it is a worktree), pointers to the ticket/spec/notes instead of pasted prose, expected output, stop condition, verification recipe. Read the child's artifacts yourself before trusting its summary.

`tests/agents.test.ts` gates the roster: tier models, review family ≠ reason family, `proactive: false` on the pipeline roles, no routing sections or result-envelope boilerplate in bodies, every tool a body names reachable through that role's allowlist, a mitigation sentence behind every coordinator skill a role loads, the mechanical memory deny, and — across the vendored trees — a host translation in the `harness-catalog` skill for every skill that tells an agent to spawn one.
