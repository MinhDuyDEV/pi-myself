# The `in-progress` (beta) skills: the pi mapping

`vendor/mattpocock-skills/skills/in-progress/` is registered with pi alongside the promoted
trees (`skills-lock.json` records it as the `beta` bucket). Its skills are **user-invoked** — the
human types pi's native `/skill:<name>` — with one exception, `pr`, which is model-invoked.

Three of them name host mechanisms that have no one-to-one equivalent on pi. This is the mapping
for those three; everything else in the bucket runs as written. `APPEND_SYSTEM.md` carries only
the pointer, because it is read in every turn and this file is only needed while working one of
them.

## `implement-spec`

| The skill says | On pi |
| --- | --- |
| implementer subagent | a `general` task per ticket, with `cwd` set to a worktree the **parent** created via `git worktree add` — pi-task never creates or removes worktrees |
| merger subagent | a `general` task in the shape the prompt names: land the branch |
| exploration subagent | a `general` task, notes-only shape |
| frontier query | `tracker` op `gh-frontier` with `parent` = the spec's issue number; `frontier` for the local `.scratch/` backend |
| worktree per implementer | the WIP cap's isolated-checkout exception, stated once in `APPEND_SYSTEM.md` under `## Task roles` |

## `retro`

"Session logs on this machine" are the `recall` tool: `scope:'project'` for this repository's
earlier sessions, then `scope:'all'` when the pattern is not local. Two rules the skill states in
its own terms:

- A pattern is recurring only across **two or more distinct sessions**. Retries, forks, and
  repeated turns inside one session count once.
- An existing skill that was actually invoked is **coverage**, not a reason to create another.

## `claude-handoff`

`claude --bg` has no pi equivalent. Run the same handoff summary as a background `general` task
instead, and tell the user its task id.
