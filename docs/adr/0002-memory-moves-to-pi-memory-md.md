# ADR 0002: Durable memory moves from `.pi/MEMORY.md` to the `pi-memory-md` extension

Supersedes ADR 0001 (session-end memory nudge).

**Note (2026-09-15):** the extension was renamed upstream to `pi-workspace-memory` (`git:github.com/sting8k/pi-workspace-memory`). Storage, tools, and this decision are unchanged; the text below keeps the name it was decided under.

## Context

ADR 0001 built the memory layer on a single hand-edited file, `.pi/MEMORY.md`, with three cooperating mechanisms: an in-turn saving rule in APPEND_SYSTEM, a `memory-nudge` extension that reminded at quit when the file had not changed, and a `/remember` prompt. Two weeks of use produced five bullets, all written on one day; the quit-time nudge was swallowed by the TUI's last frame (recorded in ADR 0001 itself), so the only mechanism that actually fired was the agent's own discipline.

The harness audit of 2026-09-14 asked whether a purpose-built extension does the job better. `pi-memory-md` (sting8k fork of VandeeFeng/pi-memory-md, dependencies already on the `@earendil-works` scope pi 0.85 uses) provides identity-addressed Markdown records with `state`/`event` kinds, structured fields (`summary`, `claims`, `facts`, `concepts`, `relations`), regex + multi-term search, automatic injection of the newest records' metadata on the first turn, and explicit `supersedes`-based compaction. It keeps the property ADR 0001 cared about most: writes are manual, so "is this durable?" stays the agent's judgment call.

## Decision

1. **`pi-memory-md` is the memory tier.** The harness's `memory` skill teaches its workflow (search → read `knowledge` view → structured write); `/remember` walks it on demand. Records live under `~/.pi/memory-md/projects/<slug>/`, outside git.
2. **The session parent alone writes.** Task children return proposed records; the rule that previously said "the parent alone writes MEMORY.md" now names `memory_write`.
3. **`memory-nudge` is removed** and `.pi/MEMORY.md` retired. The five existing bullets were migrated as `state.*` records (all still true).
4. **Post-compaction recovery consults memory.** The continuation prompt gains a `memory_search` step after `recall`.
5. **Install is global, declared as a companion package** in the README beside `pi-task`, because pi packages cannot depend on other pi packages.

## Consequences

- Memory is per machine and per project-slug (the git root's folder name). Two repos with the same folder name share memory; worktrees of one repo share it by design. Anything a collaborator must know goes into a tracked file, not memory.
- There is no cross-project tier; `state.preferences` (created by the extension) is the per-project home for personal preferences.
- The three-tier boundary in PLAN.md §3 is unchanged in shape: domain docs (Matt's conventions), work tracking (Matt's tracker), harness (memory records + `recall`). `event` records must not duplicate research reports or tracker issues; they may point at them.
- If the host lacks the extension, the skill says so once and the session runs without memory; no fallback file is created.
