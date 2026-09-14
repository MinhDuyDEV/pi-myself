# pi-myself

A pi coding-agent harness built around [mattpocock/skills](https://github.com/mattpocock/skills) as the process core: runtime extensions, task-agent roles, slash-command adapters, and hygiene tests — assembled from [pikit](https://github.com/heyhuynhgiabuu/pikit) and rebuilt where Matt's skills need pi-specific support.

The philosophy: **one process, one vocabulary**. Matt's 25 promoted skills plus the 8 beta skills from `skills/in-progress/` are vendored verbatim and are the only process narrative; this package contributes the runtime that makes them first-class in pi — a real `skill` tool, deterministic prompts, seven delegation roles in two model tiers, and session recall.

## Install

pi-myself is a **per-project package** — run this in each repository that should use the harness (not globally: installing it user-scope while also working inside its checkout loads two copies of the extensions and conflicts the `tracker`/`skill` tools):

```bash
pi install git:github.com/MinhDuyDEV/pi-myself -l
pi install npm:@heyhuynhgiabuu/pi-task -l      # task tool + role catalog
pi install git:github.com/sting8k/pi-memory-md # durable memory records (global, once per machine)
pi install npm:@heyhuynhgiabuu/pi-search       # or any web-research package you already run,
                                               # e.g. pi-web-access — the harness is name-agnostic
```

(`-l` = project-local. `pi-task`, `pi-memory-md`, and the web-research package may stay global; `pi-myself` should be project-local.)

Then inside the repository, once:

```text
/setup-pi-myself                  # provisions .pi/: task roles, APPEND_SYSTEM.md workflow rules, enableSkillCommands
/skill:setup-matt-pocock-skills   # per-repo config for the process core (issue tracker, domain docs, triage labels)
```

pi loads task roles, `APPEND_SYSTEM.md`, and project settings only from a repository's own `.pi/`, never from an installed package, so `/setup-pi-myself` copies them in (idempotent — re-run after upgrades to refresh; a settings key the project already sets is never overwritten). `pi-task` provides the `task` tool; `pi-memory-md` provides the `memory_*` tools the `memory` skill uses; any web-research package supplies the tools the scout role uses. Provider auth lives in `~/.pi/agent/auth.json`; no model providers are vendored here. Tasks that declare skills resolve only in **trusted** projects — pi asks for project trust on the first interactive session in a new repo.

## What the harness contributes

| Surface | What |
| --- | --- |
| `skill` tool | Extension registering a real skill-invocation tool whose enum is exactly the model-invoked skill set — `Call the Skill tool with "grilling"` works verbatim, and user-invoked skills stay human-only by construction |
| `tracker` tool | Deterministic ops for everything `to-spec`/`to-tickets`/`triage`/`wayfinder` do to the tracker — local markdown (`.scratch/`) **and** GitHub Issues via `gh-*` ops on the `gh` CLI: spec + ticket + map creation in the skills' templates, native sub-issue and dependency edges (mirrored by `Part of` / `Blocked by` lines), frontier, claim, resolve with the gist indexed into the map, out-of-scope, triage attention queue, role-family-safe label swaps mapped through `triage-labels.md` |
| Skill invocation | Model-invoked skills run through the `skill` tool; user-invoked ones run through pi's native `/skill:<name>` slash commands (`enableSkillCommands`) — no generated wrapper layer |
| Task roles | Seven roles in two model tiers (**read**: `explore`, `scout`; **reason**: `general`, `reviewer`, `designer`, `ultra-scout`, `ultra-verifier`), each mapped to the Matt skill it serves — `scout` writes the `research` report, `general` is `implement-spec`'s implementer/merger in a parent-made worktree, `designer` is design-it-twice, `reviewer` is the merge gate and `code-review`'s axes; the shared child contract lives once in APPEND_SYSTEM |
| Session recall | `recall` searches persisted session JSONL (including compaction summaries) before agents guess about lost context |
| Compaction continuity | Auto-resume after compaction (recall → memory_search → reconcile → continue); APPEND_SYSTEM phase-boundary rules mirror `PHASE-BOUNDARIES.md` |
| Smart-zone meter | Measures context against ~150k after every turn; the reading sits in the footer past 60% and the PHASE-BOUNDARIES.md decision order toasts once at 85%/100% (`/smartzone`) |
| Memory | The `memory` skill and `/remember` drive `pi-memory-md` records (`state` facts, `event` findings), kept strictly apart from `CONTEXT.md` (domain) and the tracker (work units) — see `PLAN.md` §3 and ADR 0002 |
| Project provisioning | `/setup-pi-myself` copies what pi only loads from a repo's own `.pi/`: task roles, `APPEND_SYSTEM.md`, `enableSkillCommands` |

## The process core

```
skill:grill-with-docs → skill:to-spec → skill:to-tickets → skill:implement  ── one main flow
      ↕ skill:prototype + skill:handoff      (skill:wayfinder for the foggy and huge;
skill:triage ← incoming issues   skill:implement drives  skill:triage for raw issues;
                                 skill:tdd               skill:diagnosing-bugs for hard bugs;
                                 and closes with         skill:improve-codebase-architecture
                                 skill:code-review       for upkeep)
```

Run them as `/skill:<name>` (or ask in conversation); `/skill:ask-matt` routes when the fit is unclear — the map above is its summary. The beta bucket (`implement-spec`, `loop-me`, `retro`, `claude-handoff`, `setup-ts-deep-modules`, `writing-beats`/`-fragments`/`-shape`) is registered the same way; APPEND_SYSTEM maps the host mechanisms they name (subagents, session logs, `claude --bg`) onto pi's task roles, `recall`, and background tasks.

## Upgrading the vendored core

```bash
npm run sync:skills    # fast-forward vendor/mattpocock-skills, rehash skills-lock.json
npm run sync:check     # verify lock integrity (also runs in CI)
```

Never edit files under `vendor/mattpocock-skills/`; propose changes upstream instead.

## Verification

From the repository root:

```bash
npm test
npx tsc -p .pi/extensions/tsconfig.json --noEmit
npm run typecheck
npm run sync:check
```

This repository declares no root `lint` script. Do not report lint as passing unless a declared linter command was actually run.

## Customizing

- Add a skill at `.pi/skills/<name>/SKILL.md`; the hygiene tests govern it.
- Add a task role at `.pi/agents/<name>.md` (fields supported by the installed task package).
- Add a prompt at `.pi/prompts/<name>.md` (a typed slash command like `/verify`; skills need no wrapper — pi exposes them natively as `/skill:<name>`). A prompt earns its place only when it does something no skill does (recording evidence in the tracker, provisioning); one that re-narrates a skill's steps is a second process and gets dropped.
- Add a top-level extension file or one-level extension directory with `index.ts`.
- Process changes belong upstream in mattpocock/skills.

## License

MIT. The vendored `vendor/mattpocock-skills/` tree is [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see its LICENSE. Harness pieces are adapted from [pikit](https://github.com/heyhuynhgiabuu/pikit) (MIT).