# ADR 0003: The workflow policy is injected by an extension, not copied into each repo

Supersedes the copy parts of PLAN.md §5 "Harness rules never reach a consuming repo" (2026-09-14) and of the provisioning decisions of 2026-09-15 and 2026-09-26 as far as they concern `APPEND_SYSTEM.md`. The task-role copy and the `enableSkillCommands` setting are unchanged.

## Context

pi discovers `APPEND_SYSTEM.md` only in a project's own `.pi/` (or the user's agent dir), never inside an installed package, so the harness shipped its workflow rules as `.pi/APPEND_SYSTEM.md` and `/setup-pi-myself` copied the file into every consuming repo. The whole-harness audit of 2026-09-26 found three costs in that design:

1. **A copy goes stale.** A consuming repo ran the policy it was provisioned with until someone reran `/setup-pi-myself`; a `pi update` changed the extensions, roles, and skills under it but not the rules that route to them.
2. **It never reached a task child.** pi-task hands a child its role body through `--append-system-prompt`, and passing that flag suppresses the discovered `APPEND_SYSTEM.md`. The "Task child contract" section therefore bound no one; it now lives in the role bodies (`.pi/policy/CHILD-CONTRACT.md`, spliced by `npm run agents:sync`).
3. **It occupies the repo's own slot.** `APPEND_SYSTEM.md` is the one file a project has for its own appended rules; the harness copy displaced it, and provisioning had to replace the file on every run, backing up whatever the project wrote there.

pi 0.87's `before_agent_start` event exposes the structured `systemPromptOptions`, including custom `sections` (rendered as `<name>` blocks after the working-directory line), so an extension can add text to the system prompt without replacing it.

## Decision

1. **The policy lives in the package at `.pi/policy/WORKFLOW.md`**, a path pi does not discover, so the checkout does not load it twice.
2. **The `policy` extension injects it** into the session parent's `systemPromptOptions.sections.harness` before every agent run, read once from the installed package when the extension loads. Every repo runs the installed version; nothing is provisioned.
3. **Task children are skipped.** The extension reads `PI_TASK_TOOL_DISABLED` at load time: a HerdR or tmux child is a separate pi process started with it set, while pi-task's SDK backend sets it in the parent's own process for an in-process child's lifetime, so reading it per event would starve the parent. A child is bound by the child contract in its role body instead.
4. **A stale provisioned copy wins, loudly.** When pi's appended text contains the policy's opening line ("Runtime playbook: which process owns the work"), the project still carries a copy from an older run: the extension injects nothing (no second, diverging copy) and notifies once to run `/setup-pi-myself`.
5. **`/setup-pi-myself` migrates the copy away.** A `.pi/APPEND_SYSTEM.md` whose hash matches the provisioning baseline, or that carries the opening line, is removed; an edited one is first kept as `APPEND_SYSTEM.md.local`. A repository's own `APPEND_SYSTEM.md` (neither signal) is never touched, and pi keeps appending it beside the injected section.

## Consequences

- A package update reaches the rules immediately; `/setup-pi-myself` is needed only for roles and settings.
- The policy's always-in-context byte budget now applies to `.pi/policy/WORKFLOW.md` (`tests/loaded-docs.test.ts`), and the child contract has a budget of its own because it rides in every child's role body.
- The policy text is identical across repos by construction; project-specific rules belong in the repo's `AGENTS.md` or its own `APPEND_SYSTEM.md`.
- An extension-less run (pi-task's `PI_TASK_CHILD_NO_EXTENSIONS=1`, `--no-extensions`) gets no policy. That is correct for children and a deliberate choice for a parent started that way.
- `packageRoot()` locates the package by `.pi/policy/WORKFLOW.md` beside `package.json` instead of `.pi/APPEND_SYSTEM.md`.
