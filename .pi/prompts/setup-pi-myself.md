---
description: Provision this repository for pi-myself — copy the task-agent roles and APPEND_SYSTEM.md into .pi/ and enable /skill: commands in project settings.
argument-hint: (no arguments)
---

# Setup pi-myself in this repository

Goal: make the three things pi loads only from a project's own `.pi/` available in THIS repository: the seven harness task roles (`explore`, `scout`, `general`, `reviewer`, `designer`, `ultra-scout`, `ultra-verifier`), the workflow rules in `APPEND_SYSTEM.md`, and `enableSkillCommands: true` in `.pi/settings.json`. An installed package contributes none of them automatically. Skills, prompts, and extensions need no provisioning: the package manifest already reaches the session and task children.

## Steps

1. Resolve `$ROOT` (the repository root: `git rev-parse --show-toplevel`) and use it for every path below.
2. Locate the installed pi-myself package root (first match wins; verify it by the presence of both `.pi/agents/` and `vendor/mattpocock-skills/.claude-plugin/plugin.json`):
   - `"$ROOT/.pi/git/github.com/MinhDuyDEV/pi-myself"` (project-local git install)
   - `"$ROOT/.pi/npm/node_modules/pi-myself"` (project-local npm install)
   - `~/.pi/agent/git/github.com/MinhDuyDEV/pi-myself` and `~/.pi/agent/npm/node_modules/pi-myself` (global installs)
3. Run the deterministic provisioning script from the located package:

   ```bash
   node "<package-root>/scripts/setup-project.mjs" "$ROOT"
   ```

4. Report the script's summary verbatim. If it found nothing to copy, say the project was already current.
5. If the package cannot be located, do not improvise: tell the user to install first (`pi install git:github.com/MinhDuyDEV/pi-myself -l`) and stop.

Never write anywhere except `$ROOT/.pi/`. When done, remind the user (once):

- `/skill:setup-matt-pocock-skills` remains the per-repo config for the Matt-skills process core (issue tracker, domain docs, triage labels).
- `pi install git:github.com/sting8k/pi-memory-md` (global, once per machine) provides the memory tools the `memory` skill uses.
- This step is idempotent — re-running it after upgrading pi-myself refreshes the roles and rules; a settings key the project already sets is never overwritten.
