# The pi mapping: host mechanisms the vendored skills name

`vendor/mattpocock-skills/` is written for a generic agent host. This file maps every host
mechanism a registered skill names that pi lacks or names differently: follow a skill as written
except where a row or section here translates it. The workflow policy carries only the pointer,
because it is read in every turn and this file is needed only while working one of these skills.
`tests/agents.test.ts` fails when a vendored skill mentions a sub-agent or background agent without
a section here, or uses a pinned host token (`/clear`, `/handoff`, `CLAUDE.md`, `claude --bg`, a
script that reads stdin) without a row in the table below.

## Invocation classes decide who can start the work

The main flow (`grill-with-docs` → `to-spec` → `to-tickets` → `implement`), `wayfinder`, `triage`,
`improve-codebase-architecture`, and the router `ask-matt` are **user-invoked**. pi exposes each as
`/skill:<name>` and the model cannot call it: when a request maps onto one of them, naming the
command for the human is the handoff. The `harness-catalog` skill holds the situation-to-command
table. In the `in-progress` (beta) bucket, `pr` is the one model-invoked skill; the rest are
user-invoked.

The skills often write a command bare. A **model-invoked** skill written as a slash command
(`/tdd`, `/code-review` inside `implement`, `implement-spec`, `loop-me`) means "call the `skill`
tool with that name" — never hand it to the human. A **user-invoked** one typed bare by the human
(`/grill-with-docs`) is rewritten to `/skill:grill-with-docs` by the harness's `host-commands`
extension when no command or prompt owns the name; `/skill:<name>` always works.

## Host commands and files

| The skill names | On pi |
| --- | --- |
| `/clear` | `/new` starts a fresh session (the old one stays resumable with `/resume`); the harness also registers `/clear` as the same thing |
| `/handoff` | the `handoff` skill: `/skill:handoff` |
| `CLAUDE.md` | pi loads **one** context file per directory, the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Where `AGENTS.md` exists, a block written to `CLAUDE.md` is never read: put it in `AGENTS.md`, and mirror it into `CLAUDE.md` only if Claude Code also works the repo (`setup-matt-pocock-skills`, `setup-ts-deep-modules`) |
| the global `AGENTS.md` (`retro`) | `<agent-dir>/AGENTS.md` — `~/.pi/agent/AGENTS.md` unless `PI_CODING_AGENT_DIR` moves the agent dir |
| `claude --bg` | a new top-level pi session; see `claude-handoff` below |
| a script that reads stdin (`diagnosing-bugs`' HITL loop, `wizard`) | pi's `bash` tool runs commands with stdin closed, so the first `read` ends the script. The agent writes the script and checks it with `bash -n`; the human runs it in their own terminal or a HerdR/tmux pane and pastes the output back |
| `/compact` | pi's own `/compact`; the phase-boundary decision order is restated in the workflow policy |
| MCP servers | pi has no MCP client; only an adapter extension adds one (`retro` names MCP as a review question only) |
| a background agent | a background `task`; pi-task spawns the child as a separate pi process |
| a sub-agent / the Task tool | `task` with one of the roles in `.pi/agents/` |
| a throwaway branch | plain git; nothing to translate |
| `.claude-plugin`, `agents/openai.yaml` | upstream packaging for other hosts, not harness surface |

## `ask-matt`

The router's entries are pointers, not work, so it needs no per-skill translation beyond this file.
Two of its branches name a host mechanism: "delegate reading legwork to a background agent" for
`/research` is the `scout` role, and "send it to a subagent" at a phase boundary is a `task` with one
of the roles here. Its fresh-session branch is `/new` (after `/skill:handoff` when the next phase
needs a summary).

## `setup-matt-pocock-skills`

Its `CLAUDE.md` edit follows the table row above. The `tracker` tool covers the local and GitHub
backends only: for GitLab or any other tracker, run the CLI recipes `docs/agents/issue-tracker.md`
records directly.

## `tdd`

`tdd` confirms the seams with the user before any test. A task child cannot ask, so the parent
agrees the seams (the spec's testing decisions, or with the user) and names them in the `general`
prompt; a child given none returns `blocked` with the seams it proposes.

## `triage`

- Won't-fix is `gh-resolve` with `status:"wontfix"` (comment, close, exactly one state role). The
  tracker's `out-of-scope` / `gh-out-of-scope` op is wayfinder's rule-out and has nothing to do with
  triage's `.out-of-scope/` knowledge base, which triage writes as files.
- The tracker refuses pull requests. When `docs/agents/issue-tracker.md` enables PRs as a request
  surface, run its `gh pr` recipes directly: the one exception to "tracker work goes through the
  tool".

## `implement-spec`

| The skill says | On pi |
| --- | --- |
| implementer subagent | a `general` task per ticket, with `cwd` set to a worktree the **parent** created via `git worktree add` — pi-task never creates or removes worktrees |
| merger subagent | a `general` task in the shape the prompt names: land the branch |
| exploration subagent | a `general` task, notes-only shape |
| frontier query | `tracker` op `gh-frontier` with `parent` = the spec's issue number; `frontier` for the local `.scratch/` backend. Both hold back `needs-triage`, `needs-info`, and `ready-for-human` tickets |
| worktree per implementer | the WIP cap's isolated-checkout exception, stated once in the workflow policy under `## Task roles` |

## `wayfinder`

The skill fires a research subagent per `research` ticket that "captures its findings on a throwaway
`research/<name>` branch". On pi that child is a `scout` task: one report path, and deliberately no
branch and no commit. The **parent** creates `research/<name>`, commits the scout's report there, and
points the ticket at it. Scouts run in parallel, each owning a distinct report path.

## `code-review`

Both axes run as parallel sub-agents. On pi they are two read-only tasks on the review tier, scoped
to conformance (standards, spec) and never replacing the independent `reviewer` task the workflow
policy requires before a merge-ready claim — that task owns correctness, security, and regressions.

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
earlier sessions, then `scope:'all'` when the pattern is not local. Its "global AGENTS.md" is the
agent-dir file in the table above. Two rules the skill states in its own terms:

- A pattern is recurring only across **two or more distinct sessions**. Retries, forks, and
  repeated turns inside one session count once.
- An existing skill that was actually invoked is **coverage**, not a reason to create another.

Its guardrail finding — a repo with no pre-commit hook and no CI job running the check command — is
answered for this harness by the `commit-guardrails` skill.

## `claude-handoff`

`claude --bg` starts an independent top-level session. On pi that is a new top-level session, not a
task: write the handoff summary to a file (for example `$TMPDIR/handoff-<name>.md`) and have the
human start `pi --name "<name>" @<file>` in a new terminal or HerdR pane. A background `general`
task fits only a bounded continuation — a child cannot delegate, run `code-review` or
`implement-spec`, or write memory, and its result returns to this session.
