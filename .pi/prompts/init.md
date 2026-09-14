---
description: Initialize concise repository-local agent guidance from current repository evidence
argument-hint: "[--deep]"
---

# Init: $ARGUMENTS

Resolve the repository root first: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. If that fails and no project files exist here, stop.

Initialize or repair the repository's local agent context. Treat current files and validated commands as authoritative; do not create a parallel project database.

The prose standard for anything written here is the `writing-for-agents` skill (load it once before drafting or rewriting guidance). `verification-before-completion` loads at completion as the gate.

## 1. Parse Arguments

| Argument | Default | Description |
| --- | --- | --- |
| `--deep` | false | Inspect history and subsystem boundaries in addition to the normal repository pass |

No flags means core project guidance only. Durable project facts discovered on the way are not written here: propose them as memory records at the end (the `memory` skill owns that tier) and let the user decide.

## 2. Safety and Idempotency

- Inspect `git status --short` before writing and preserve unrelated changes.
- Read the existing `AGENTS.md` (or `CLAUDE.md` — never create the second one when either exists) before editing; improve in place.
- Do not create nested `AGENTS.md` files or any memory file by default.
- Ask before replacing intentional guidance or recording personal preferences.
- Never record credentials, tokens, private identifiers, or inferred personal details.
- Do not touch `vendor/mattpocock-skills/`, `.pi/skills/`, `.pi/prompts/` (except repo-local usage notes), or generated runtime state.

## 3. Discover Repository Reality

Inspect the narrowest files that establish:

- package manifests, language versions, and build configuration;
- source entry points and meaningful subsystem boundaries;
- test locations and focused/full test commands;
- generated, vendored, sensitive, or runtime-state paths;
- CI commands and repository-specific contribution rules;
- existing `AGENTS.md`/`CLAUDE.md`, README, project map, and (when present) `CONTEXT.md` + `docs/agents/` skill configuration.

With `--deep`, also inspect recent history and search for subsystem-specific conventions. Do not turn directory names into architecture claims without code evidence.

## 4. Validate Commands

Derive candidate gates from the nearest `AGENTS.md`, package manifest, build configuration, and CI files. Never invent a conventional command merely because the ecosystem often has one. For each command retained in guidance:

1. Run the narrowest safe form when practical.
2. Record the exact command, exit code, and meaningful output.
3. Mark commands that cannot be run as `UNVERIFIED` with the reason.
4. Mark expected-but-absent categories as `NOT DECLARED`, never `PASS`.

## 5. Update `AGENTS.md`

Keep the repository-local file compact and evidence-based. Include only useful local deltas:

- what the repository ships and where its entry points live
- real install, focused-test, full-test, typecheck, lint, and build commands when declared
- generated or sensitive paths that must not be edited
- repository-specific verification and compatibility constraints
- a small vocabulary section only where domain terms are ambiguous (fuller treatment belongs to `domain-modeling` + `CONTEXT.md`)

Do not copy the harness constitution (`.pi/APPEND_SYSTEM.md`), the skill catalog, generic coding advice, or a speculative roadmap into this file. Cite source paths for non-obvious claims. If nested `AGENTS.md`s look justified under `--deep`, report candidates and rationale; ask before creating files.

## 6. Verify and Report

Review the diff and report:

1. Files changed with `path:line` evidence
2. Repository claims and their source files
3. Each exact validation command, exit code, and meaningful result
4. `NOT DECLARED` and `UNVERIFIED` gate categories
5. Candidate nested guidance not created
6. Remaining uncertainty or blockers

Do not claim initialization succeeded unless the resulting guidance matches current repository files and every reported validation result is fresh.