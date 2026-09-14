---
description: Write or repair the repository's durable agent context from evidence — AGENTS.md (how to work here) and, with --map, PROJECT.md (what lives where)
argument-hint: "[--map]"
---

# Init: $ARGUMENTS

Resolve the repository root first: `ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"`. If that fails and no project files exist here, stop.

Two durable files make a future session understand this repository without re-exploring it:

| File | Answers | Written by |
| --- | --- | --- |
| `AGENTS.md` (or `CLAUDE.md`) | How to work here: real commands, gates, paths that must not be edited, repo-specific constraints | this prompt, always |
| `PROJECT.md` | What lives where: what the repo ships, entry points, subsystem boundaries, generated/runtime state, sensitive areas | this prompt, with `--map` |

Vocabulary and decisions are the third layer and are not written here: `CONTEXT.md` and `docs/adr/` belong to `domain-modeling` (reached through `/skill:grill-with-docs`). Durable host or environment facts discovered on the way are proposed as memory records at the end (the `memory` skill owns that tier); never written into these files.

The prose standard is the `writing-for-agents` skill (load it once before drafting). `verification-before-completion` loads at completion.

## 1. Safety

- Inspect `git status --short` before writing and preserve unrelated changes.
- Read the existing `AGENTS.md` or `CLAUDE.md` before editing; improve in place; never create the second when either exists.
- Preserve the `## Agent skills` block that `/skill:setup-matt-pocock-skills` writes (issue tracker, triage labels, domain docs) verbatim; it is that skill's, not this prompt's.
- Ask before replacing intentional guidance. Never record credentials, tokens, or private identifiers.
- Do not touch `vendor/`, `.pi/skills/`, `.pi/prompts/`, or generated runtime state.

## 2. Discover

Delegate the reading to one `explore` task (read-only, `path:line` evidence); the parent validates and writes. Ask it for:

- package manifests, language and runtime versions, build configuration;
- source entry points and subsystem boundaries with the evidence that makes them boundaries (not directory names alone);
- test locations and the focused/full test, typecheck, lint, and build commands the repo actually declares;
- generated, vendored, sensitive, or runtime-state paths;
- CI commands and contribution rules;
- what the existing `AGENTS.md`/`CLAUDE.md`, README, `PROJECT.md`, `CONTEXT.md`, and `docs/agents/` already say.

Ask for a thorough pass on an unfamiliar or multi-subsystem repo, a medium pass otherwise.

## 3. Validate commands

Gates are the commands the repo declares in `AGENTS.md`, its manifest, build configuration, and CI — never a convention the ecosystem often has. For each command that will appear in guidance, run the narrowest safe form and record the exact command, exit code, and meaningful output; mark what could not be run `UNVERIFIED` with the reason, and an expected-but-absent category `NOT DECLARED`, never `PASS`.

## 4. Write

`AGENTS.md`: compact, evidence-based local deltas only — what the repo ships and its entry points in one paragraph, the validated commands, paths that must not be edited, repo-specific verification and compatibility constraints. Do not copy the harness rules (`.pi/APPEND_SYSTEM.md`), the skill catalog, generic coding advice, or a roadmap into it. Cite source paths for non-obvious claims.

`PROJECT.md` (`--map`): the repository map a new session reads first — shipped surface, development support, generated and runtime state (not source of truth), reference material, sensitive areas, and the verification commands. One line per item, path first, no prose tours. Refresh an existing file in place; drop entries whose paths no longer exist.

## 5. Report

1. Files changed with `path:line` evidence.
2. Each repository claim and its source file.
3. Each validation command, exit code, result; `NOT DECLARED` and `UNVERIFIED` categories.
4. Proposed memory records (host or environment facts), for the user to accept.
5. Remaining uncertainty.

Do not claim initialization succeeded unless the written guidance matches current repository files and every validation result is fresh.
