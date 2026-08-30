---
description: Provision this repository for pi-myself — copy the packaged task-agent roles into .pi/agents/ so the task tool can use them here.
argument-hint: (no arguments)
---

# Setup pi-myself in this repository

Goal: make the harness-authored task roles (`designer`, `researcher`, `ultra-scout`, `ultra-verifier`, plus the refined `explore`/`scout`/`general`/`reviewer`) available to the `task` tool in THIS repository. pi-task discovers agents only from its bundled defaults, `~/.pi/agent/agents/`, and `<repo>/.pi/agents/` — an installed pi-myself package contributes none of them automatically. Skills need no provisioning: the package manifest already reaches task children.

## Steps

1. Resolve `$ROOT` per APPEND_SYSTEM (the repository root) and use it for every path below.
2. Locate the installed pi-myself package root (first match wins; verify it by the presence of both `.pi/agents/` and `vendor/mattpocock-skills/.claude-plugin/plugin.json`):
   - `"$ROOT/.pi/git/github.com/MinhDuyDEV/pi-myself"` (project-local git install)
   - `"$ROOT/.pi/npm/node_modules/pi-myself"` (project-local npm install)
   - `~/.pi/agent/git/github.com/MinhDuyDEV/pi-myself` and `~/.pi/agent/npm/node_modules/pi-myself` (global installs)
3. Run the deterministic provisioning script from the located package:

   ```bash
   node "<package-root>/scripts/setup-agents.mjs" "$ROOT"
   ```

4. Report the script's summary verbatim. If it found nothing to copy, say the roles were already current.
5. If the package cannot be located, do not improvise: tell the user to install first (`pi install git:github.com/MinhDuyDEV/pi-myself`) and stop.

Never write anywhere except `$ROOT/.pi/agents/`. When done, remind the user (once):

- `/setup-matt-pocock-skills` remains the per-repo config for the Matt-skills process core (issue tracker, domain docs, triage labels).
- This step is idempotent — re-running it after upgrading pi-myself refreshes the roles.