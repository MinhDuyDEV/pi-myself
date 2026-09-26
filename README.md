# pi-myself

A pi coding-agent harness built around [mattpocock/skills](https://github.com/mattpocock/skills) as the process core: runtime extensions, task-agent roles, slash-command adapters, and hygiene tests — assembled from [pikit](https://github.com/heyhuynhgiabuu/pikit) and rebuilt where Matt's skills need pi-specific support.

The philosophy: **one process, one vocabulary**. Matt's 25 promoted skills plus the 9 beta skills from `skills/in-progress/` are vendored verbatim and are the only process narrative; this package contributes the runtime that makes them first-class in pi — a real `skill` tool, deterministic prompts, seven delegation roles in three model tiers, and session recall.

## Install

pi-myself is a **per-project package** — run this in each repository that should use the harness (not globally: installing it user-scope while also working inside its checkout loads two copies of the extensions and conflicts the `tracker`/`skill` tools):

```bash
pi install git:github.com/MinhDuyDEV/pi-myself -l
pi install npm:@heyhuynhgiabuu/pi-task -l      # task tool + role catalog
pi install git:github.com/sting8k/pi-workspace-memory # durable memory records (global, once per machine)
pi install npm:@heyhuynhgiabuu/pi-search              # or any web-research package you already run,
                                                      # e.g. pi-web-access — the harness is name-agnostic
```

(`-l` = project-local. `pi-task`, `pi-workspace-memory`, and the web-research package may stay global; `pi-myself` should be project-local.)

Then inside the repository, once:

```text
/setup-pi-myself                  # provisions .pi/: task roles, APPEND_SYSTEM.md workflow rules, enableSkillCommands
/skill:setup-matt-pocock-skills   # per-repo config for the process core (issue tracker, domain docs, triage labels)
```

pi loads task roles, `APPEND_SYSTEM.md`, and project settings only from a repository's own `.pi/`, never from an installed package, so `/setup-pi-myself` (a command the `provision` extension registers) copies them in. After `pi update --extensions`, run it again: **a rerun is an update, not a merge.** Every role file is rewritten from the package — roster, body, `tools`, `skills`, `disallowed_tools`, `readonly` — and the only lines carried over from the project's copy are `model` and `thinking`, because the tier models are a local cost/latency choice and nothing else in the file is. `APPEND_SYSTEM.md` is harness policy and is replaced the same way. A copy the project changed outside those two fields is refreshed too, but never silently: it is first saved beside itself as `<name>.local` (the previous backup is overwritten), and a role the project added is left alone. Settings are corrected rather than merged where the harness owns the key — `enableSkillCommands` is enforced to `true`, without which user-invoked skills have no slash command, and the previous file is kept as `settings.json.local`; every other key is left exactly as the project set it. It records what it shipped in `.pi/pi-myself-provisioned.json` — commit that file; it is what tells a project edit apart from the package's own previous version when deciding whether a backup is owed. Repo-specific rules belong in `AGENTS.md`, which pi always loads. `pi-task` provides the `task` tool; `pi-workspace-memory` (formerly `pi-memory-md`) provides the `memory_*` tools the `memory` skill uses; any web-research package supplies the tools the scout role uses. Provider auth lives in `~/.pi/agent/auth.json`; no model providers are vendored here. Tasks that declare skills resolve only in **trusted** projects — pi asks for project trust on the first interactive session in a new repo.

## What the harness contributes

| Surface | What |
| --- | --- |
| `skill` tool | Extension registering a real skill-invocation tool whose enum is exactly the model-invoked skill set — `Call the Skill tool with "grilling"` works verbatim, and user-invoked skills stay human-only by construction |
| `tracker` tool | Deterministic ops for everything `to-spec`/`to-tickets`/`triage`/`wayfinder` do to the tracker — local markdown (`.scratch/`) **and** GitHub Issues via `gh-*` ops on the `gh` CLI: spec + ticket + map creation in the skills' templates, native sub-issue and dependency edges (mirrored by `Part of` / `Blocked by` lines), frontier, claim, resolve with the gist indexed into the map, out-of-scope, triage attention queue, role-family-safe label swaps mapped through `triage-labels.md`, title/body edit and map-section notes, and filtering by state role, category role, or wayfinder type. The local backend writes under a lock and allocates ticket numbers with `wx`, so parallel wayfinder sessions cannot clobber one file |
| Skill invocation | Model-invoked skills run through the `skill` tool; user-invoked ones run through pi's native `/skill:<name>` slash commands (`enableSkillCommands`) — no generated wrapper layer |
| Task roles | Seven roles in three model tiers (**read**: `explore`, `scout`; **reason**: `general`, `designer`, `ultra-verifier`; **review**: `reviewer`, `ultra-scout`, on a different model family from the reason tier), each mapped to the Matt skill it serves — `scout` writes the `research` report, `general` is `implement-spec`'s implementer/merger in a parent-made worktree, `designer` is design-it-twice, `reviewer` is the merge gate and `code-review`'s axes; the shared child contract lives once in APPEND_SYSTEM |
| Session recall | `recall` searches persisted session JSONL (including compaction summaries) before agents guess about lost context |
| Compaction continuity | Resumes a task that a manual `/compact` interrupted (recall → memory_search → reconcile → continue); automatic compaction never triggers a resume. APPEND_SYSTEM phase-boundary rules mirror `PHASE-BOUNDARIES.md` |
| Smart-zone meter | Measures context against ~150k after every turn; the reading sits in the footer past 60% and the PHASE-BOUNDARIES.md decision order toasts once at 85%/100% (`/smartzone`) |
| Memory | The `memory` skill and `/remember` drive `pi-workspace-memory` records (`state` facts, `event` findings), kept strictly apart from `CONTEXT.md` (domain) and the tracker (work units) — see `PLAN.md` §3 and ADR 0002 |
| Project provisioning | `provision` extension: `/setup-pi-myself` copies what pi only loads from a repo's own `.pi/` (task roles, `APPEND_SYSTEM.md`, `enableSkillCommands`); a rerun is an update — every role is rewritten from the package with only `model` and `thinking` carried over, `APPEND_SYSTEM.md` is replaced, and anything the project changed outside those two fields is refreshed after a `<name>.local` backup |

## The process core

```
skill:grill-with-docs → skill:to-spec → skill:to-tickets → skill:implement  ── one main flow
      ↕ skill:prototype + skill:handoff      (skill:wayfinder for the foggy and huge;
skill:triage ← incoming issues   skill:implement drives  skill:triage for raw issues;
                                 skill:tdd               skill:diagnosing-bugs for hard bugs;
                                 and closes with         skill:improve-codebase-architecture
                                 skill:code-review       for upkeep)
```

Run them as `/skill:<name>` (or ask in conversation); `/skill:ask-matt` routes when the fit is unclear — the map above is its summary. The beta bucket (`pr`, `implement-spec`, `loop-me`, `retro`, `claude-handoff`, `setup-ts-deep-modules`, `writing-beats`/`-fragments`/`-shape`) is registered the same way — `pr` is model-invoked like the promoted set, the rest are human-only. APPEND_SYSTEM maps the host mechanisms they name (subagents, session logs, `claude --bg`) onto pi's task roles, `recall`, and background tasks.

## Upgrading the vendored core

```bash
npm run sync:skills    # fast-forward vendor/mattpocock-skills, rehash skills-lock.json
npm run sync:check     # verify lock integrity (also runs in CI)
```

Never edit files under `vendor/mattpocock-skills/`; propose changes upstream instead.

## Verification

From the repository root:

```bash
npm run check     # lint → both typechecks → tests → vendored-lock check (what CI runs)
```

Individually:

```bash
npm run lint                     # Biome: format + lint (read-only)
npm run lint:fix                 # apply safe fixes and formatting
npm test                         # extension + skill tests
npm run typecheck                # root + tests
npm run extensions:typecheck     # runtime extensions
npm run sync:check               # vendored lock integrity
```

## Customizing

- Add a skill at `.pi/skills/<name>/SKILL.md`; the hygiene tests govern it.
- Add a task role at `.pi/agents/<name>.md` (fields supported by the installed task package).
- Add a prompt at `.pi/prompts/<name>.md` (a typed slash command like `/verify`; skills need no wrapper — pi exposes them natively as `/skill:<name>`). A prompt earns its place only when it does something no skill does (recording evidence in the tracker, provisioning); one that re-narrates a skill's steps is a second process and gets dropped.
- Add a top-level extension file or one-level extension directory with `index.ts`.
- Process changes belong upstream in mattpocock/skills.

## License

MIT. The vendored `vendor/mattpocock-skills/` tree is [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see its LICENSE. Harness pieces are adapted from [pikit](https://github.com/heyhuynhgiabuu/pikit) (MIT).