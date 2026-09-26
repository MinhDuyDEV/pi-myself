# Project Map

`pi-myself` is a configuration and extension package for the pi coding agent built around the vendored `mattpocock/skills` core. `package.json` defines registered pi paths; `README.md` is the user-facing overview; `PLAN.md` is the decision record. Verify volatile behavior against tracked files and tests.

## Shipped pi Surface

- `vendor/mattpocock-skills/` — vendored upstream mattpocock/skills (process core; read-only; its `skills/engineering` + `skills/productivity` trees are registered with pi).
- `.pi/extensions/` — runtime extensions: `skill-tool` (the `skill` tool, whose enum mirrors pi's own skill loader), `tracker` (two backends: `.scratch/` local markdown + GitHub Issues via `gh-*` ops; locked, atomically-replaced writes; `/frontier`), `smart-zone` (footer meter + `/smartzone`), `dcp/` (session-history `recall`), `continue-after-compaction`, `provision` (`/setup-pi-myself`).
- `.pi/extensions/tracker/conventions.test.ts` — the gate tying the tracker's op set to the vendored tracker templates: a documented operation that is neither wired nor recorded fails the suite.
- `.pi/settings.json` — dogfood defaults (skill commands, compaction reserves, retry).
- `.pi/skills/` — our own skills: `memory` (pi-workspace-memory workflow), `harness-catalog` (the situation-to-command map over every registered skill, plus its `pi-mapping.md` host translations), `commit-guardrails` (the git-hook installer at `install-git-hooks.mjs`), `verification-before-completion`, `typescript-coding-standards`, `security-and-hardening`, `source-driven-development`, `test-proof-debt-audit`, `ultra-review`, `ultra-review-receive`, `repo-refresh`. A skill's own helper scripts live inside its directory, the way `ultra-review/scripts/` already did, because that is what a consuming repo receives.
- `.pi/prompts/` — hand-written slash commands: `/verify`, `/init`, `/remember`.
- `.pi/extensions/provision.ts` — `/setup-pi-myself` command only (no session-start check: the provisioned copies are the project's to edit); `.pi/extensions/lib/` holds shared helpers (repo root, package root, pi's agent dir) and is deliberately not an extension.
- `.pi/APPEND_SYSTEM.md` — the workflow rules; provisioned into consuming repos by `scripts/setup-project.mjs` because pi loads it only from a project's own `.pi/`.
- `docs/agents/` — the per-repo skill configuration (`setup-matt-pocock-skills` writes it) and `docs/adr/` the decisions; the harness's own host translation ships inside the `harness-catalog` skill instead, so a consuming repo gets it with the package.

## Development Support

- `tests/` — catalog, lock, invocation, asset, prompt-contract, marker, and guidance-hygiene (links, duplicates, byte budgets) tests.
- `.pi/extensions/**/*.test.ts` — extension unit and lifecycle tests, colocated with source.
- `scripts/run-extension-tests.mjs` — discovers and runs Node extension tests.
- `scripts/sync-skills.mjs` — vendored sync + lock integrity (`--check`).
- `npm run hooks:install` / `hooks:check` — the repo-local git guardrail, run through the installer shipped in the `commit-guardrails` skill (staged check, optional `--trailer` session id; `--check` verifies without writing).
- `scripts/setup-project.mjs` — provisions a consuming repo: task roles, `APPEND_SYSTEM.md`, `enableSkillCommands` (idempotent; `/setup-pi-myself`). A rerun refreshes task-role copies still matching what the package last shipped (hash baseline in the project's `.pi/`); edited or deleted roles are kept. `APPEND_SYSTEM.md` is harness policy and is always replaced — an edited copy is backed up as `APPEND_SYSTEM.md.local`; project-specific rules belong in the repo's `AGENTS.md`.
- `package.json` — npm scripts and pi package registration.
- `biome.json` — formatter + linter config (tabs, double quotes, `preset: recommended`); excludes `vendor/` and the generated lock, and relaxes two rules for `*.test.ts` only. Takes no comments: Biome silently drops `files.includes` when one is present.
- `tsconfig.json` — root/test TypeScript; excludes `.pi/` and `vendor/`. Strict beyond `strict: true`: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`.
- `.pi/extensions/tsconfig.json` — runtime extension TypeScript (same strict flags).
- `.pi/agents/*.md` — pi-task role overrides (not registered through the `pi` field; task tooling discovers them).

## Generated and Runtime State

Not source of truth, do not edit: `node_modules/`, `.pi/node_modules/`, `.pi/npm/`, `.pi/git/`, `.pi/sessions/`, `.pi/task-exits/`, `.pi/artifacts/`, `.pi/task-session-history.json`, `.pi/sandbox/`. `.scratch/` holds the local-markdown issue tracker — disposable work units, gitignored by default. Memory records live outside the repo under `~/.pi/memory-md/projects/<slug>/` (pi-workspace-memory).

## Sensitive Areas

- `.pi/extensions/dcp/` — session-history recall.
- `.pi/extensions/skill-tool/` — skill invocation surface and its enum (must equal the model-invoked set; tested).
- `.pi/extensions/tracker/` — local backend writes under `.scratch/` only (slug-validated paths); GitHub backend shells out to `gh` with the repo as cwd and needs `gh auth login`.
- `skills-lock.json` — vendored provenance; regenerate via `npm run sync:skills`, never by hand.
- Package lifecycle scripts and browser helpers — may execute processes or create external side effects.

## Verification

```bash
npm run check                 # lint → both typechecks → tests → sync check (what CI runs)
npm run lint                  # Biome format + lint (read-only)
npm test                      # extensions + skill hygiene tests
npm run extensions:typecheck  # runtime extensions
npm run typecheck             # root + tests
npm run sync:check            # vendored lock integrity
```