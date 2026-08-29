# Project Map

`pi-myself` is a configuration and extension package for the pi coding agent built around the vendored `mattpocock/skills` core. `package.json` defines registered pi paths; `README.md` is the user-facing overview; `PLAN.md` is the decision record. Verify volatile behavior against tracked files and tests.

## Shipped pi Surface

- `vendor/mattpocock-skills/` — vendored upstream mattpocock/skills (process core; read-only; its `skills/engineering` + `skills/productivity` trees are registered with pi).
- `.pi/extensions/` — runtime extensions: `skill-tool` (the `skill` tool), `tracker` (two backends: `.scratch/` local markdown + GitHub Issues via `gh-*` ops; `/frontier`), `smart-zone` (smart-zone meter + `/smartzone`), `safety/` (command/tool guardrails), `dcp/` (session-history `recall`), `continue-after-compaction`, `tps`, `shortcut-continue`.
- `.pi/settings.json` — dogfood defaults (skill commands, compaction reserves, trust, default tools).
- `.pi/skills/` — our own skills: `memory`, `verification-before-completion`, `typescript-coding-standards`, `api-and-interface-design`, `deprecation-and-migration`, `security-and-hardening`, `source-driven-development`, `browser-tools`.

## Development Support

- `tests/` — catalog, lock, invocation, asset, prompt-contract, and marker tests.
- `.pi/extensions/**/*.test.ts` — extension unit and lifecycle tests, colocated with source.
- `scripts/run-extension-tests.mjs` — discovers and runs Node extension tests.
- `scripts/sync-skills.mjs` — vendored sync + lock integrity (`--check`).
- `package.json` — npm scripts and pi package registration.
- `tsconfig.json` — root/test TypeScript; excludes `.pi/`, `vendor/`, and `pikit-template/`.
- `.pi/extensions/tsconfig.json` — runtime extension TypeScript.
- `.pi/agents/*.md` — pi-task role overrides (not registered through the `pi` field; task tooling discovers them).

## Generated and Runtime State

Not source of truth, do not edit: `node_modules/`, `.pi/node_modules/`, `.pi/npm/`, `.pi/git/`, `.pi/sessions/`, `.pi/dcp-state/`, `.pi/task-exits/`, `.pi/artifacts/`, `.pi/task-session-history.json`, `.pi/sandbox/`. `.scratch/` holds the local-markdown issue tracker — disposable work units, gitignored by default.

## Reference Material

`pikit-template/` is the upstream pikit checkout used as source material for the harness. It is reference-only and gitignored; grep it for provenance, never import from it.

## Sensitive Areas

- `.pi/extensions/safety/` — command and tool safety policy.
- `.pi/extensions/dcp/` — session-history recall.
- `.pi/extensions/skill-tool/` — skill invocation surface and its enum (must equal the model-invoked set; tested).
- `.pi/extensions/tracker/` — local backend writes under `.scratch/` only (slug-validated paths); GitHub backend shells out to `gh` with the repo as cwd and needs `gh auth login`.
- `skills-lock.json` — vendored provenance; regenerate via `npm run sync:skills`, never by hand.
- Package lifecycle scripts and browser helpers — may execute processes or create external side effects.

## Verification

```bash
npm test                      # extensions + skill hygiene tests
npx tsc -p .pi/extensions/tsconfig.json --noEmit
npm run typecheck             # root + tests
npm run sync:check            # vendored lock integrity
```