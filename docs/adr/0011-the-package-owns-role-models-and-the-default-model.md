# ADR 0011: The package owns every role's `model` and `thinking`, and the session's default model

Decided 2026-10-10 (user decision). Supersedes decisions 2 and 5 of ADR 0005: the project now owns only `max_turns`, and `settings.json` is no longer left untouched.

## Context

Under ADR 0005 a consuming repository kept any `model` or `thinking` it had set on a role, and a rerun of `/setup-pi-myself` never touched `.pi/settings.json`. So a model change in pi-myself reached only the repositories that had never tuned a role. The session parent's model was not shipped at all: each repository kept whatever its own settings named.

The user wants a single place to pick models: pi-myself's role files and its own `.pi/settings.json`, carried to every repository by a rerun.

## Decision

1. **`model` and `thinking` follow the package.** A rerun writes the package's values into every role (`PACKAGE_OWNED_FIELDS` in `scripts/setup-project.mjs`). A value the project had set is replaced, and the run names it (`replaced your model: …`). It is not backed up, because a changed `model` or `thinking` line alone is not an edit. The baseline hash still leaves out all three lines (`model`, `thinking`, `max_turns`), so existing baselines stay valid.
2. **The project owns only `max_turns`** (`PROJECT_OWNED_FIELDS`). ADR 0010 ships no turn limit, so a project's `max_turns` is its own choice and survives a rerun.
3. **A run writes the session's default model.** `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` are copied from the package's own `.pi/settings.json` into the project's `.pi/settings.json` (`DEFAULT_MODEL_KEYS`). The file is created when it is missing. Every other key is kept, and a replaced value is named. A file that is not a JSON object is never rewritten, a symlinked one is never written through (both are reported, with the keys to set by hand, and the doctor `/setup-pi-myself --check` turns that report into a warning), and the pi-myself checkout is exempt. Both files are parsed as pi parses them, a leading UTF-8 BOM stripped first. No other package setting is copied: the package's `skills` paths, for instance, resolve against the package.

## Consequences

- To change a model for every repository, edit pi-myself and rerun `/setup-pi-myself` in each one. A repository cannot keep its own role model or default model across a rerun. It can only re-set it after each run, or not rerun.
- The `reviewer` family rule (ADR 0009) now holds wherever the package's roles hold it, since a project can no longer keep a model that breaks it across a rerun. The doctor's family check stays for a role edited between runs.
- A rewritten `settings.json` is re-serialised with tab indentation. Its keys keep their order, and the default-model keys come last when new.
- `tests/setup-project.test.ts` pins the behaviour: replaced values named without a backup, a package model change reaching a repository that had set its own, `max_turns` kept, the default model written into a fresh and an existing `settings.json` with other keys kept, an unparseable file left alone, and `--check` writing nothing.
