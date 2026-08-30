# pi-myself

A pi coding-agent harness built around [mattpocock/skills](https://github.com/mattpocock/skills) as the process core: runtime extensions, task-agent roles, slash-command adapters, and hygiene tests — assembled from [pikit](https://github.com/heyhuynhgiabuu/pikit) and rebuilt where Matt's skills need pi-specific support.

The philosophy: **one process, one vocabulary**. Matt's 25 promoted skills are vendored verbatim and are the only process narrative; this package contributes the runtime that makes them first-class in pi — a real `skill` tool, deterministic prompts, delegation roles, session recall, and safety guardrails.

## Install

```bash
pi install git:github.com/MinhDuyDEV/pi-myself
pi install npm:@heyhuynhgiabuu/pi-task
pi install npm:@heyhuynhgiabuu/pi-search        # or any web-research package you already run,
                                                 # e.g. pi-web-access — the harness is name-agnostic
```

Then inside the repository, once:

```text
/setup-pi-myself              # copies the packaged task roles (designer, researcher, ultra-*) into .pi/agents/
/skill:setup-matt-pocock-skills   # per-repo config for the process core (issue tracker, domain docs, triage labels)
```

`pi-task` provides the `task` tool and its built-in roles; pi-myself's roles are provisioned by `/setup-pi-myself` (idempotent — re-run after upgrades to refresh). Any web-research package supplies the tools the scout role uses. Provider auth lives in `~/.pi/agent/auth.json`; no model providers are vendored here.

## What the harness contributes

| Surface | What |
| --- | --- |
| `skill` tool | Extension registering a real skill-invocation tool whose enum is exactly the model-invoked skill set — `Call the Skill tool with "grilling"` works verbatim, and user-invoked skills stay human-only by construction |
| `tracker` tool | Deterministic ops over the tracker `to-tickets`/`triage`/`wayfinder` write by hand — local markdown (`.scratch/`) **and** GitHub Issues via `gh-*` ops on the `gh` CLI (blocked-by refs, triage labels, claims, resolution comments, frontier) |
| Skill invocation | Model-invoked skills run through the `skill` tool; user-invoked ones run through pi's native `/skill:<name>` slash commands (`enableSkillCommands`) — no generated wrapper layer |
| Task roles | `explore` / `scout` / `general` / `reviewer` overrides for `pi-task` plus harness-authored `designer` (design-it-twice parallel candidates), `researcher` (writes the cited research artifact), and `ultra-scout` / `ultra-verifier` (the `/ultra-review` bug-hunt pipeline) — delegation contracts and a 1-writer + 1-reviewer WIP cap |
| Session recall | `recall` searches persisted session JSONL (including compaction summaries) before agents guess about lost context |
| Safety | `tool_call` guardrails (block/confirm), audit log, `/safety` status command |
| Compaction continuity | Auto-resume after compaction; APPEND_SYSTEM phase-boundary rules mirror `PHASE-BOUNDARIES.md` |
| Smart-zone meter | Measures context against ~150k after every turn; boundary-grade warnings carry the PHASE-BOUNDARIES.md decision order (`/smartzone`) |
| Memory | `.pi/MEMORY.md` discipline kept strictly apart from `CONTEXT.md` (domain) and the tracker (work units) — see `PLAN.md` §3 |

## The process core

```
skill:grill-with-docs → skill:to-spec → skill:to-tickets → skill:implement  ── one main flow
      ↕ skill:prototype + skill:handoff      (skill:wayfinder for the foggy and huge;
skill:triage ← incoming issues   skill:implement drives  skill:triage for raw issues;
                                 skill:tdd               skill:diagnosing-bugs for hard bugs;
                                 and closes with         skill:improve-codebase-architecture
                                 skill:code-review       for upkeep)
```

Run them as `/skill:<name>` (or ask in conversation); `/skill:ask-matt` routes when the fit is unclear — the map above is its summary.

## Upgrading the vendored core

```bash
npm run sync:skills    # fast-forward vendor/mattpocock-skills, rehash skills-lock.json, regen wrappers
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
- Add a prompt at `.pi/prompts/<name>.md` (anything not AUTO-GENERATED).
- Add a top-level extension file or one-level extension directory with `index.ts`.
- Process changes belong upstream in mattpocock/skills.

## License

MIT. The vendored `vendor/mattpocock-skills/` tree is [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see its LICENSE. Harness pieces are adapted from [pikit](https://github.com/heyhuynhgiabuu/pikit) (MIT).