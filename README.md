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
/setup-pi-myself                  # provisions .pi/agents/: the task roles
/skill:setup-matt-pocock-skills   # per-repo config for the process core (issue tracker, domain docs, triage labels)
```

pi-task loads task roles only from a repository's own `.pi/agents/`, never from an installed package, so `/setup-pi-myself` (a command the `provision` extension registers) copies them in. Nothing else is copied: skills, prompts, and extensions arrive with the package, and the workflow policy is injected by the `policy` extension from the installed package's `.pi/policy/WORKFLOW.md` into every parent turn (ADR 0003). After `pi update --extensions`, run it again: **a rerun is an update, not a merge.** Every role file is rewritten from the package — roster, body, `tools`, `skills`, `disallowed_tools`, `readonly` — and only `model`, `thinking`, and `max_turns` can survive from the project's copy, and only when the project chose them: a value that still equals what the package shipped last time follows the package, so a tier-model change reaches every repo. A copy the project changed in any other line is refreshed too, but never silently: it is first saved beside itself as `<name>.local` (the previous backup is overwritten), and a symlinked role is replaced by a file with the link kept as `<name>.local`, never written through. A role the package stops shipping is removed when untouched and kept, reported, when the project edited it; a role the project added is left alone. An `APPEND_SYSTEM.md` an older version copied in is removed, because it would stand in for the injected policy (an edited one is kept as `APPEND_SYSTEM.md.local`); a repository's own `APPEND_SYSTEM.md` is left alone, and so is `settings.json` (pi defaults `enableSkillCommands` to true, and it only drives autocomplete). `/setup-pi-myself --check` diagnoses without writing anything. It records what it shipped in `.pi/pi-myself-provisioned.json` — commit that file; it is what tells a project edit apart from the package's own previous version, and a project's own model apart from the package default. Repo-specific rules belong in `AGENTS.md`, which pi always loads. `pi-task` provides the `task` tool; `pi-workspace-memory` (formerly `pi-memory-md`) provides the `memory_*` tools the `memory` skill uses; any web-research package supplies the tools the scout role uses. Provider auth lives in `~/.pi/agent/auth.json`; no model providers are vendored here. Tasks that declare skills resolve only in **trusted** projects — pi asks for project trust on the first interactive session in a new repo.

## What the harness contributes

| Surface | What |
| --- | --- |
| `skill` tool | Extension registering a real skill-invocation tool that loads exactly the model-invoked skill set, read with pi's own frontmatter parser — `Call the Skill tool with "grilling"` works verbatim, and asking for a user-invoked skill returns the slash command to hand the human, so those stay human-only |
| `tracker` tool | Deterministic ops for everything `to-spec`/`to-tickets`/`triage`/`wayfinder` do to the tracker — local markdown (`.scratch/`) **and** GitHub Issues via `gh-*` ops on the `gh` CLI: spec + ticket + map creation in the skills' templates, native sub-issue and dependency edges (mirrored by `Part of` / `Blocked by` lines), frontier, claim, resolve with the gist indexed into the map, out-of-scope, triage attention queue, role-family-safe label swaps mapped through `triage-labels.md`, title/body edit and map-section notes, and filtering by state role, category role, or wayfinder type. The local backend writes under a lock, allocates ticket numbers under a per-directory lock, and refuses a second claim, so parallel wayfinder sessions can neither clobber one file, share a number, nor both take a ticket; `tick` addresses a fixed box position in `## Acceptance criteria`, and the GitHub ops comment before they close and add a gist only to an open `wayfinder:map`; ops of the family `docs/agents/issue-tracker.md` does not configure are refused with the op to use instead, and a local blocker naming no ticket is rejected when written |
| Skill invocation | Model-invoked skills run through the `skill` tool; user-invoked ones run through pi's native `/skill:<name>` slash commands (typed, they work whatever `enableSkillCommands` says; the setting, default true, only lists them in autocomplete) — no generated wrapper layer; a bare `/<name>` the vendored skills print is rewritten to `/skill:<name>` by the `host-commands` extension |
| Task roles | Seven roles in three model tiers (**read**: `explore`, `scout`; **reason**: `general`, `designer`, `ultra-verifier`; **review**: `reviewer`, `ultra-scout`, on a different model family from the reason tier), each mapped to the Matt skill it serves — `scout` writes the `research` report, `general` is `implement-spec`'s implementer/merger in a parent-made worktree, `designer` is design-it-twice, `reviewer` is the merge gate and `code-review`'s axes; a child never sees the workflow policy, so the shared child contract has one source (`.pi/policy/CHILD-CONTRACT.md`) that `npm run agents:sync` splices into every role body |
| Session recall | `recall` searches persisted session JSONL (including compaction summaries and task-complete reports) before agents guess about lost context; `expand` indices stay stable while the live session grows, and Esc interrupts a long scan |
| Compaction continuity | Resumes a task that a manual `/compact` interrupted (recall → memory_search → reconcile → continue); automatic compaction never triggers a resume. The workflow policy's phase-boundary rules mirror `PHASE-BOUNDARIES.md` |
| Smart-zone meter | Measures context against ~150k (or the model's context window when smaller) after every turn, ignoring failed and aborted runs; the reading sits in the footer past 60% and the PHASE-BOUNDARIES.md decision order (`/new` > `/skill:handoff` > subagent > `/compact`) toasts once at 85%/100% (`/smartzone`) |
| Write guard | `guard` extension: `write`/`edit` into the vendored tree, `skills-lock.json` (in this repo and inside the installed package), or generated runtime state is refused with what to do instead; a `bash` call without a `timeout` gets 30 minutes (`PI_MYSELF_BASH_TIMEOUT` overrides), since pi's own has none |
| Host command bridge | `host-commands` extension: `/clear` starts a new session like `/new`, and a bare `/<skill>` becomes `/skill:<skill>` unless a prompt or command owns the name |
| Memory | The `memory` skill drives `pi-workspace-memory` records (`state` facts, `event` findings), kept strictly apart from `CONTEXT.md` (domain) and the tracker (work units) — see `PLAN.md` §3 and ADR 0002 |
| Workflow policy | `policy` extension: injects `.pi/policy/WORKFLOW.md` from the installed package as the parent's `<harness>` system-prompt section before every run, so no repo holds a copy that can go stale; task children skip it (their role body carries the child contract), and an old provisioned `APPEND_SYSTEM.md` suppresses it with one notice to run `/setup-pi-myself` |
| Project provisioning | `provision` extension: `/setup-pi-myself` copies the task roles, the one thing pi-task loads only from a repo's own `.pi/`; a rerun is an update — every role is rewritten from the package, only a `model`/`thinking`/`max_turns` the project chose survives, anything else the project changed is refreshed after a `<name>.local` backup, and an old provisioned `APPEND_SYSTEM.md` is removed; `/setup-pi-myself --check` is a read-only doctor (stale roles, a shared review/reason model family, missing companions or tracker docs, a duplicate install, unignored runtime state) |

## The process core

```
skill:grill-with-docs → skill:to-spec → skill:to-tickets → skill:implement  ── one main flow
      ↕ skill:prototype + skill:handoff      (skill:wayfinder for the foggy and huge;
skill:triage ← incoming issues   skill:implement drives  skill:triage for raw issues;
                                 skill:tdd               skill:diagnosing-bugs for hard bugs;
                                 and closes with         skill:improve-codebase-architecture
                                 skill:code-review       for upkeep)
```

Run them as `/skill:<name>` (or ask in conversation); `/skill:ask-matt` routes when the fit is unclear — the map above is its summary. The beta bucket (`pr`, `implement-spec`, `loop-me`, `retro`, `claude-handoff`, `setup-ts-deep-modules`, `writing-beats`/`-fragments`/`-shape`) is registered the same way — `pr` is model-invoked like the promoted set, the rest are human-only. The `harness-catalog` skill's `pi-mapping.md` maps the host mechanisms they name (subagents, session logs, `claude --bg`) onto pi's task roles, `recall`, and background tasks.

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