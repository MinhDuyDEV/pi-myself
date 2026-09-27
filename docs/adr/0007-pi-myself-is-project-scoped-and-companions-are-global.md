# ADR 0007: pi-myself installs project-scoped; its companion packages install globally

Decided 2026-09-27 (user decision).

## Context

pi resolves packages from two settings scopes — the user's `~/.pi/agent/settings.json` and a repository's `.pi/settings.json`, the latter gated behind project trust — and dedupes them by identity: an npm package by name, a git package by host and path with the ref ignored, a local package by its resolved absolute path. Project wins, so the same source declared in both scopes loads once. Two *different* identities for one piece of code do not dedupe, and pi 0.87.1 then fails hard: duplicate tool names from two loaded extensions land in the extension error list, and startup exits rather than picking a winner.

The two halves of this harness differ in kind, which is what the scope rule follows from. pi-myself carries **process**: the `policy` extension injects the workflow policy into every parent turn, and `guard` adds a default `bash` timeout and refuses writes into vendored and runtime state. A companion package carries **host capability**: `pi-task` registers the `task` tool, the web-research package registers web tools, and neither writes a system-prompt section. `pi-workspace-memory` is the one exception, and a small one — it appends the project's memory catalog as a message on the first turn, keyed by the git root's folder name, and its `injection` setting can turn that off.

The README had framed the rule as a conflict ("loads two copies of the extensions and conflicts the `tracker`/`skill` tools"). That understated it and named the wrong cause: a same-identity pair is deduped and harmless, while a genuinely duplicated pair does not conflict so much as stop pi from starting.

## Decision

1. **pi-myself is installed project-scoped** (`pi install <source> -l`), in each repository that should use the harness. It must not appear in the user settings file.
2. **Companion packages are installed globally**, once per machine: `pi-task`, `pi-workspace-memory`, and whichever web-research package the host runs.
3. **The rule is the split, not the package list**: process-bearing text is opt-in per repository, which project scope and trust already enforce; host tools are machine-wide, because a tool registration asks nothing of a repository that does not use it.
4. **The doctor reports a global pi-myself as a warning** naming `pi remove <source>`, and the roles stay per-repository — pi-task reads a repository's own `.pi/agents/` first, and a role set belongs to the harness version that generated it (ADR 0005).

## Consequences

- A repository gets the harness only when it declares the package and is trusted; the workflow policy never reaches a repository that did not opt in. This is why the harness needs no separate opt-in gate in code.
- `pi update --extensions` refreshes pi-myself and every global companion in one pass, which is the reason the split is convenient rather than merely tidy.
- A companion's version is one version for every repository on the machine. The roles are validated against the installed `pi-task` (`tests/agents.test.ts`), so a companion upgrade can invalidate them everywhere at once, with no per-repository pin to roll back to. The doctor does not report companion versions yet.
- Provisioning stays per-repository: `/setup-pi-myself` copies the roles into `.pi/agents/` after each package update.
- Two identities for one package remain possible by hand (a global git install beside a checkout) and remain fatal; the doctor's install-scope check is the guard against it, not a dedupe of our own.
