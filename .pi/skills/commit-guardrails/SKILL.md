---
name: commit-guardrails
description: Use when the repo's check command is not wired to anything that runs it automatically, or when the user asks for a local pre-commit guardrail — installs the staged-check hook and names what it deliberately leaves to CI.
disable-model-invocation: true
---

# Commit Guardrails

Install the repo-local guardrail: `install-git-hooks.mjs`, beside this file, writes a `pre-commit` hook that
runs the staged lint and format check, and on request a `prepare-commit-msg` hook that appends the
pi session id to the commit message.

## Run it

The installer lives beside this file, so it works in any repo that has pi-myself installed — use the
skill directory pi reported when it loaded this skill:

```bash
node "<this skill's directory>/install-git-hooks.mjs" --command "npm run lint:staged"   # the repo's own staged check
node "<this skill's directory>/install-git-hooks.mjs" --command "npm test" --trailer
node "<this skill's directory>/install-git-hooks.mjs" --command "npm test" --check     # verify, write nothing
```

`--command` may be omitted only where Biome is installed in the repo (`node_modules/.bin/biome`); the
default is then `npx --no-install biome check --staged --no-errors-on-unmatched`. Without Biome the
installer refuses rather than write a hook that blocks every commit.

In the pi-myself checkout the same thing is wired to npm scripts: `npm run hooks:install`,
`npm run hooks:install -- --trailer`, `npm run hooks:check`.

## Scope, on purpose

- Covered: staged files pass Biome's check before the commit object exists (the default command), or
  whatever `--command` names. That is the class of mistake a fast hook can actually prevent.
- Not covered: typecheck, tests, the vendored lock, whole-tree scans. Those stay with `npm run
  check`, which is what CI runs. A hook that ran everything would be slow enough that people learn
  to type `--no-verify`, which is worse than no hook.
- A hook pi-myself did not write is moved beside the installed one as `<name>.local` (a symlink moves
  as a link) and the installed hook runs it first, so the project's own check keeps blocking; a hook
  carrying the pi-myself marker is ours and is refreshed in place.
- It refuses outside a git work tree, and whenever `core.hooksPath` leaves the repository's git
  directory: inside the work tree those hooks are tracked (husky), elsewhere they are shared by other
  repositories or the whole machine; add the check there by hand. It also refuses a second foreign
  hook rather than overwrite the one already kept as `<name>.local`.

## When there is no guardrail at all

The vendored `retro` skill treats a repo whose check command nothing runs as a finding. Answer it by
wiring the command that already exists, at the cheapest scope that still catches real mistakes —
never by inventing a second check system beside it.
