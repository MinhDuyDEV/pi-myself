# ADR 0005: Provisioning is an update; the project owns only `model`, `thinking`, and `max_turns`

Supersedes the "Provisioned copies are the project's" decision of 2026-09-15 (`docs/history.md`), including its "refresh drift" rules for task roles. Decided 2026-09-26 in two steps: "Provisioning becomes an update" (user decision) and "Provisioning keeps what the project wrote" (audit S1–S15, baseline v2).

**Note (2026-09-27):** the consequence "the baseline file must be committed" is narrowed by ADR 0008 — a consuming repository ignores its own `.pi/` wholesale, so the baseline is per machine. Decisions 3 and 4 below (baseline v2, nothing dropped silently) are unchanged.

**Note (2026-10-01):** a run also follows upstream's rename of the domain glossary (user decision): a root `CONTEXT.md` is moved to `GLOSSARY.md`, with `git mv` when git tracks it, and the pointer in `docs/agents/domain.md` is renamed with it. It is the one write outside `.pi/` and `.gitignore`, and decision 4 governs it: nothing already under the new name is overwritten and a linked `domain.md` is not replaced. The repository's own context file is never edited; the doctor names a mention it still carries.

**Note (2026-10-02):** a glossary split per context moves whole (user decision, after a consuming repository turned out to use one): `CONTEXT-MAP.md` to `GLOSSARY-MAP.md`, each per-context `CONTEXT.md` the map links to, and those links. The map is what says which files are glossaries, so a `CONTEXT.md` it does not list, or one reached through a link out of the repository, is never moved; a context holding both names is kept and stays linked until a human merges it, and the next run then brings the link along.

## Context

pi-task loads task roles only from a repository's own `.pi/agents/`, never from an installed package, so `/setup-pi-myself` (`scripts/setup-project.mjs`) copies the roles into every consuming repo. From 2026-09-15 a rerun was a conservative merge: a role the project had touched or deleted was kept, so a harness fix could sit behind a stale copy until someone read a diff and merged by hand.

The first fix (2026-09-26) made a rerun rewrite every role from the package and keep only `model` and `thinking`. The audit that followed the same day found it still lost or overrode project choices: a model-only tune counted as an edit (S3), a tier-model change never reached a repo that had not chosen its own (S4), a role with no baseline entry was overwritten without a backup (S1), and forcing `enableSkillCommands` in `settings.json` overrode a deliberate `false` for nothing, since pi 0.87.1 defaults it to true and expands a typed `/skill:` either way (S11).

## Decision

1. **A rerun is an update.** Every role is rewritten from the package: description, `tools`, `skills`, `disallowed_tools`, `readonly`, `proactive`, and the body. A deleted role is restored, because the roster is harness-owned; a role the project added is never touched.
2. **The project owns three fields**: `model`, `thinking`, `max_turns` (`PROJECT_OWNED_FIELDS` in `scripts/setup-project.mjs`). A value survives only when the project chose it; a value still equal to what the package shipped last time follows the package.
3. **Baseline v2**: `.pi/pi-myself-provisioned.json` records, per role, the sha256 of the shipped file without those three lines plus the values shipped for them. A v1 baseline (bare hashes) migrates.
4. **Nothing is dropped silently.** A copy that differs from the package's previous version in any other line is saved as `<name>.local` before it is replaced; so is a copy with no baseline entry. A symlinked role is replaced by a file, the link kept as `<name>.local`. A role the package stops shipping is removed when untouched and kept, reported, when edited.
5. **`settings.json` is not touched.**

## Consequences

- A plain upgrade writes no backup files, and a model-only tune is never reported as an edit. A kept `model`, `thinking`, or `max_turns` that differs from the package's is named on every run, because a v1 baseline cannot tell a choice from a value an older version failed to update.
- No write follows a link at a file's own path: a linked role is replaced by a file with the link kept as `<name>.local`, and a later backup replaces that link rather than writing through it (review A, 2026-09-26). A linked `.pi/` or `.pi/agents/` folder is the project's chosen location: it is written into, and a run names it when it resolves outside the repository (the doctor's roles check relays that note).
- A project that sets `model` opts out of the package's tier choices, so the review-family ≠ reason-family rule (ADR 0006) holds only where models are left alone; `/setup-pi-myself --check` reports a shared family in the repo's own roles.
- The baseline file must be committed; without it every difference is treated as an edit and backed up.
- Per-project rules belong in the repo's `AGENTS.md`, not in an edited role.
- `tests/setup-project.test.ts` pins the contract: idempotency, owned-field survival without a backup, backups of other edits, restore, removal, the v1 migration, and the dry-run `--check`.
