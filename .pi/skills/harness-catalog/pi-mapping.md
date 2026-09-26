# The pi mapping: host mechanisms the vendored skills name

`vendor/mattpocock-skills/` is written for a generic agent host. A few registered skills name a
host mechanism pi does not have one-to-one; this file is the mapping for every one of them, and
everything else in the registered trees runs as written. `APPEND_SYSTEM.md` carries only the
pointer, because it is read in every turn and this file is needed only while working one of these
skills. `tests/agents.test.ts` scans the vendored trees for the spawn phrasing below and fails when
a skill that uses it has no mapping here.

## Invocation classes decide who can start the work

The main flow (`grill-with-docs` → `to-spec` → `to-tickets` → `implement`), `wayfinder`, `triage`,
`improve-codebase-architecture`, and the router `ask-matt` are **user-invoked**. pi exposes each as
`/skill:<name>` and the model cannot call it: when a request maps onto one of them, naming the
command for the human is the handoff. The `harness-catalog` skill holds the situation-to-command
table. In the `in-progress` (beta) bucket, `pr` is the one model-invoked skill; the rest are
user-invoked.

## Not gaps

Checked against pi's own loader and CLI, so nobody "fixes" these twice:

| The skill names | On pi |
| --- | --- |
| `CLAUDE.md` | pi discovers `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` — the file it names is read either way |
| `/compact` | pi's own `/compact`; the phase-boundary decision order is restated in `APPEND_SYSTEM.md` |
| MCP servers | pi loads MCP from its own configuration |
| A background agent | a background `task`; pi-task spawns the child as a separate pi process |
| A sub-agent / the Task tool | `task` with one of the roles in `.pi/agents/` |
| `.claude-plugin`, `agents/openai.yaml` | upstream packaging for other hosts, not harness surface |

## `ask-matt`

The router's entries are pointers, not work, so it needs no per-skill translation beyond this file.
Two of its branches name a host mechanism: "delegate reading legwork to a background agent" for
`/research` is the `scout` role, and "send it to a subagent" at a phase boundary is a `task` with one
of the roles here. Its handoff branch (a fresh host session) is a new session, or `claude-handoff`'s
background `general` task.

## `implement-spec`

| The skill says | On pi |
| --- | --- |
| implementer subagent | a `general` task per ticket, with `cwd` set to a worktree the **parent** created via `git worktree add` — pi-task never creates or removes worktrees |
| merger subagent | a `general` task in the shape the prompt names: land the branch |
| exploration subagent | a `general` task, notes-only shape |
| frontier query | `tracker` op `gh-frontier` with `parent` = the spec's issue number; `frontier` for the local `.scratch/` backend |
| worktree per implementer | the WIP cap's isolated-checkout exception, stated once in `APPEND_SYSTEM.md` under `## Task roles` |

## `wayfinder`

The skill fires a research subagent per `research` ticket that "captures its findings on a throwaway
`research/<name>` branch". On pi that child is a `scout` task: one report path, and deliberately no
branch and no commit. The **parent** creates `research/<name>`, commits the scout's report there, and
points the ticket at it. Scouts run in parallel, each owning a distinct report path.

## `code-review`

Both axes run as parallel sub-agents. On pi they are two read-only tasks on the review tier, scoped
to conformance (standards, spec) and never replacing the independent `reviewer` task APPEND_SYSTEM
requires before a merge-ready claim — that task owns correctness, security, and regressions.

## `codebase-design`

DESIGN-IT-TWICE spawns 3+ parallel sub-agents, one radically different interface each. On pi that is
N parallel `designer` tasks with one candidate apiece; the parent frames the problem space, gives
each its own constraint, and compares afterwards. A `designer` child is one branch of that pattern
and never spawns.

## `improve-codebase-architecture`

Its first pass spawns a sub-agent to walk the codebase and note friction: that is one `explore` task.
Its second delegation ("call the Skill tool with codebase-design") is the `designer` pattern above.

## `research`

The skill opens with "Spin up a background agent to do the research". The `scout` role **is** that
agent: it loads `research`, writes exactly the one report path the prompt names, and returns the
findings. It does not spawn, and it does not commit — the parent commits.

## `grilling`

Environment facts are found by dispatching a sub-agent, never by asking the user: that is one
`explore` task, and the rest of the frontier proceeds without waiting on it.

## `retro`

"Session logs on this machine" are the `recall` tool: `scope:'project'` for this repository's
earlier sessions, then `scope:'all'` when the pattern is not local. Two rules the skill states in
its own terms:

- A pattern is recurring only across **two or more distinct sessions**. Retries, forks, and
  repeated turns inside one session count once.
- An existing skill that was actually invoked is **coverage**, not a reason to create another.

Its guardrail finding — a repo with no pre-commit hook and no CI job running the check command — is
answered for this harness by the `commit-guardrails` skill.

## `claude-handoff`

`claude --bg` has no pi equivalent. Run the same handoff summary as a background `general` task
instead, and tell the user its task id.
