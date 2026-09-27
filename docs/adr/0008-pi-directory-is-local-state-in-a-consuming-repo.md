# ADR 0008: In a consuming repository, `.pi/` is local state and is not committed

Decided 2026-09-27 (user decision). Narrows ADR 0005, whose consequence "the baseline file must be committed" falls.

## Context

A consuming repository's `.pi/` holds four kinds of thing, and only the first was ever a deliberate commit:

- the **declaration** (`.pi/settings.json`) — the `pi install … -l` entry that makes pi load the package;
- the **baseline** (`.pi/pi-myself-provisioned.json`) — what the package shipped last run, which tells a project edit apart from the package's own previous version (ADR 0005);
- the **roles** (`.pi/agents/`) — copies `/setup-pi-myself` writes, owned and rewritten by the harness;
- **runtime state** — pi-task's `task-registry.json` and `task-session-history.json`, its `artifacts/`, and pi's `sessions/`, `git/`, `npm/`.

ADR 0005 asked for the baseline to be committed so that a teammate's first run would not treat every customised role as an edit. That reason only holds for a shared repository, and it costs a generated file in every diff: the roles are rewritten wholesale on each update, and the baseline is rewritten with them. ADR 0007 already made the harness a per-repository installation of a shared package; the companions live in the global settings and one `pi update --extensions` refreshes them. The declaration is the last piece still pretending `.pi/` is source.

The two `.pi/` directories are not the same thing, and the rule has to say so: in the pi-myself checkout `.pi/extensions`, `.pi/skills`, `.pi/policy`, `.pi/prompts`, and `.pi/agents/` **are** the package source and stay tracked.

## Decision

1. **A consuming repository ignores `.pi/*`** — one line, which covers the declaration, the baseline, the roles, and every runtime path at once. `.pi/*` rather than `.pi/`: the directory itself stays includable, so a team that wants the declaration shared can add `!.pi/settings.json` without fighting the pattern.
2. **`/setup-pi-myself` ensures the line**, idempotently: it appends a marked block only when no existing line already covers `.pi/`, and `--check` reports it without writing.
3. **The baseline is per machine.** It is created by the first run in a clone and never travels; the update semantics of ADR 0005 §3 are unchanged by this.
4. **The package checkout is exempt.** Its `.pi/` is source, so the doctor's gitignore check keeps naming the individual runtime paths there and offers `.pi/*` only in a consuming repository.
5. **A clone does not declare the harness.** Each developer and each CI job runs `pi install git:github.com/MinhDuyDEV/pi-myself -l` once, then `/setup-pi-myself` and `/reload`.

## Consequences

- No generated file enters a diff: an update rewrites the roles on each machine instead of producing a review of them.
- A role customised through `model`, `thinking`, or `max_turns` is now per machine. A team that wants one shared must re-include `.pi/agents/` (or the whole `.pi/`) explicitly, which is the trade the rule makes visible rather than silent.
- The harness reaches a repository only where someone installed it, which is the same shape ADR 0007 gives the companions and the same guarantee project trust already enforces.
- On a machine with no baseline, a role copy that differs from the package is still backed up as `<name>.local` rather than overwritten (ADR 0005 §4), so the first run after a hand-copied role is noisy but never lossy.
- `/setup-pi-myself --check` reports the ignore line as one of its findings, so a repository that predates this decision is told what to add.
