# Project Map

`pi-myself` is a configuration and extension package for the pi coding agent built around the vendored `mattpocock/skills` core. `package.json` defines registered pi paths; `README.md` is the user-facing overview; `PLAN.md` is the current-state contract, `docs/adr/` holds decisions with their reasons, and `docs/history.md` the dated history. Verify volatile behavior against tracked files and tests.

## Shipped pi Surface

- `vendor/mattpocock-skills/` — vendored upstream mattpocock/skills (process core; read-only; its `skills/engineering`, `skills/productivity`, and `skills/in-progress` (beta) trees are registered with pi).
- `.pi/extensions/` — runtime extensions: `policy` (injects the workflow policy into the session parent's system prompt), `guard` (refuses write/edit into the vendored tree, the lock, and runtime state; default `bash` timeout), `host-commands` (`/clear`; bare `/<skill>` → `/skill:<skill>`), `skill-tool` (the `skill` tool, whose skill set mirrors pi's own skill loader), `tracker` (two backends: `.scratch/` local markdown + GitHub Issues via `gh-*` ops; locked, atomically-replaced writes; `/frontier`), `smart-zone` (footer meter + `/smartzone`), `dcp/` (session-history `recall`), `continue-after-compaction`, `provision` (`/setup-pi-myself`).
- `.pi/extensions/tracker/conventions.test.ts` — the gate tying the tracker's op set to the vendored tracker templates: a documented operation that is neither wired nor recorded fails the suite.
- `.pi/settings.json` — dogfood defaults (skill commands, compaction reserves, retry).
- `.pi/skills/` — our own skills: `memory` (pi-workspace-memory workflow), `harness-catalog` (the situation-to-command map over every registered skill, plus its `pi-mapping.md` host translations), `commit-guardrails` (the git-hook installer at `install-git-hooks.mjs`), `verification-before-completion`, `typescript-coding-standards`, `security-and-hardening`, `source-driven-development`, `test-proof-debt-audit`, `ultra-review`, `ultra-review-receive`, `repo-refresh`. A skill's own helper scripts live inside its directory, the way `ultra-review/scripts/` already did, because that is what a consuming repo receives.
- `.pi/prompts/` — hand-written slash commands: `/verify`, `/init`.
- `.pi/extensions/provision.ts` — `/setup-pi-myself` command only (no session-start check: rerunning the command is the update path); `.pi/extensions/lib/` holds shared helpers (repo root, package root, pi's agent dir) and is deliberately not an extension.
- `.pi/policy/WORKFLOW.md` — the workflow policy; the `policy` extension injects it from the installed package as the parent's `<harness>` section on every run (ADR 0003), so it is never copied into a consuming repo. Deliberately not an `APPEND_SYSTEM.md`, which pi would also load here. Task children skip it.
- `.pi/policy/CHILD-CONTRACT.md` — the child contract's one source; `scripts/sync-agents.mjs` splices it between the `child-contract` markers at the end of every role in `.pi/agents/`, so provisioned roles carry it too.
- `docs/agents/` — the per-repo skill configuration (`setup-matt-pocock-skills` writes it) `docs/adr/` the decisions, and `docs/history.md` the dated record (not current guidance); the harness's own host translation ships inside the `harness-catalog` skill instead, so a consuming repo gets it with the package.

## Development Support

- `tests/` — catalog, lock, invocation, asset, prompt-contract, marker, and guidance-hygiene (links, duplicates, byte budgets) tests.
- `.pi/extensions/**/*.test.ts` — extension unit and lifecycle tests, colocated with source.
- `scripts/run-extension-tests.mjs` — discovers and runs Node extension tests.
- `scripts/sync-skills.mjs` — vendored sync + lock integrity: per-skill hashes plus a digest of every file under `vendor/mattpocock-skills/` (`--check`; `--relock` only adds that digest to a lock written before it, without a network clone, and refuses any drift).
- `scripts/sync-agents.mjs` — the child-contract splice (`npm run agents:sync`; `--check` is `npm run agents:check`, part of `npm run check`).
- `npm run hooks:install` / `hooks:check` — the repo-local git guardrail, run through the installer shipped in the `commit-guardrails` skill (staged check, optional `--trailer` session id; `--check` verifies without writing).
- `scripts/setup-project.mjs` — provisions and updates a consuming repo (`/setup-pi-myself`): the task roles, plus the removal of an `APPEND_SYSTEM.md` an older run copied. A rerun is an update — each role is rewritten from the package; `model`, `thinking`, and `max_turns` survive only where the project chose them (they differ from what the package shipped last time), and a copy changed in any other line is refreshed after being saved as `<name>.local`. The baseline in the project's `.pi/` (`pi-myself-provisioned.json`: per role, the hash without those three lines plus the shipped values) is what tells an edit or a choice apart from the package's previous version; without an entry, any other difference is backed up. A symlinked role is replaced by a file (the link kept as `.local`; a linked `.pi/` or `.pi/agents/` folder is written into, with a note), a role the package stopped shipping is removed when untouched, a repository's own `APPEND_SYSTEM.md`, a role the project added, and `settings.json` are never touched; project-specific rules belong in the repo's `AGENTS.md`.
- `/setup-pi-myself --check` (provision extension) — a read-only doctor: an untrusted project, roles stale against the package (`setup-project.mjs --check`, a dry run that exits 1 when a run would change anything), review ≠ reason model family in the repo's roles, the `task`/`memory_search`/web-tool companions, `docs/agents/` tracker and domain docs, a duplicate global + project install, and runtime state missing from `.gitignore`; each warning names its fix.
- `.github/workflows/quality.yml` runs `npm run check` on Node 22.18.0 (the `engines` minimum) and 22.20.0; `.github/workflows/upstream-freshness.yml` fails weekly when upstream `mattpocock/skills` main has moved past the lock's head.
- `package.json` — npm scripts and pi package registration.
- `biome.json` — formatter + linter config (tabs, double quotes, `preset: recommended`); excludes `vendor/` and the generated lock, and relaxes two rules for `*.test.ts` only. Takes no comments: Biome silently drops `files.includes` when one is present.
- `tsconfig.json` — root/test TypeScript; excludes `.pi/` and `vendor/`. Strict beyond `strict: true`: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`.
- `.pi/extensions/tsconfig.json` — runtime extension TypeScript (same strict flags).
- `.pi/agents/*.md` — pi-task role overrides (not registered through the `pi` field; task tooling discovers them).

## Generated and Runtime State

Not source of truth, do not edit: `node_modules/`, `.pi/node_modules/`, `.pi/npm/`, `.pi/git/`, `.pi/sessions/`, `.pi/task-exits/`, `.pi/artifacts/`, `.pi/task-session-history.json`, `.pi/sandbox/`. `.scratch/` holds the local-markdown issue tracker — disposable work units, gitignored by default. Memory records live outside the repo under `~/.pi/memory-md/projects/<slug>/` (pi-workspace-memory).

## Sensitive Areas

- `.pi/extensions/dcp/` — session-history recall.
- `.pi/extensions/skill-tool/` — skill invocation surface; its loadable set must equal the model-invoked set (tested).
- `.pi/extensions/tracker/` — local backend writes under `.scratch/` only (slug-validated paths); GitHub backend shells out to `gh` with the repo as cwd and needs `gh auth login`.
- `skills-lock.json` — vendored provenance (upstream head, per-skill hashes, whole-tree digest); regenerate via `npm run sync:skills`, never by hand.
- Package lifecycle scripts and browser helpers — may execute processes or create external side effects.

## Verification

```bash
npm run check                 # lint → both typechecks → tests → sync check → agents check (what CI runs)
npm run lint                  # Biome format + lint (read-only)
npm test                      # extensions + skill hygiene tests
npm run extensions:typecheck  # runtime extensions
npm run typecheck             # root + tests
npm run sync:check            # vendored lock integrity (every vendored file)
npm run agents:check          # every role carries the current child contract
```