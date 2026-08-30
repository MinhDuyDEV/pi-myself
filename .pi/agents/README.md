# Agent roster

Specialist agents for the `task` tool. Each file is the agent's **role prompt**, appended to the child's normal system prompt via `--append-system-prompt`. Task children still load the `AGENTS.md` context chain and `APPEND_SYSTEM.md` for their cwd like any pi session, so do not re-paste repo rules in the task `prompt`; pass only task-specific rules and scope.

The **session agent** is always the parent. Task agents match **OpenCode-style** builtins where applicable — `explore`, `scout`, `general`, `reviewer` (these also exist as pi-task's package defaults when this package is not installed) — plus harness-authored specialists: `designer`, `researcher`, and the ultra-review pipeline pair `ultra-scout` / `ultra-verifier` (serving the local `/skill:ultra-review` + `/skill:ultra-review-receive` skills).

The parent routes from `APPEND_SYSTEM.md`; task agents inherit the `AGENTS.md` context files for their cwd, so the task prompt should add assignment-specific rules (scope, authority, verification) rather than repeat repo rules.

## Agent file template

```yaml
---
description: Use when the parent needs this role; not for a cheaper direct tool.
# proactive: true
# hidden: true
# readonly: true
tools: read, grep, find, bash
disallowed_tools: edit, write, apply_patch
---
```

pi-task parses frontmatter line-by-line rather than as full YAML. Keep descriptions on one line and tool lists comma-separated; folded blocks and YAML mappings are not supported.

### What pi-task implements

| Field | Enforced? |
| ----- | --------- |
| `description` | Yes — task tool catalog |
| `tools` / `disallowed_tools` | Yes |
| `hidden` / `proactive` / `readonly` | Yes |
| `model`, `thinking` | Yes — passed to child `pi` |
| `skills` | Yes — resolved against Pi's skill registry; an unknown name fails the task |
| `fast` | Yes — Fast Mode default for the child |

## Task agents (`task` tool)

| Agent | Use for | Do not use when |
|-------|---------|-----------------|
| `scout` | External research, web/docs, citations | In-repo mapping (`explore`) |
| `explore` | Read-only code exploration, path:line | Single known file (`read`) |
| `general` | Multi-step tasks, implementation, parallel tracks | Trivial 1–2 file parent work |
| `reviewer` | Post-change audit, path:line evidence | Before code exists |
| `designer` | One design candidate under a stated constraint (design-it-twice parallel pattern) | Implementation or audit |
| `researcher` | Resolve a research assignment and write one cited report file | Answer-only questions (`scout`) |
| `ultra-scout` | Max-recall static bug-hunt candidate (one of 10, identically prompted) | Anything mutating; consolidation |
| `ultra-verifier` | Disposition + owner-clean fix pass over an ultra-review report | Launching scout batches |

## Pick by task

| Task shape | Agent |
|------------|-------|
| How does X work in this repo? | `explore` |
| Best practice / docs for Y? | `scout` |
| Implement or multi-step delegated work | `general` |
| Review diff / changes | `reviewer` |
| Design candidate for an interface (several in parallel) | `designer` |
| Research ticket that must land as a cited file | `researcher` |
| One bug-hunt scout in a /skill:ultra-review round | `ultra-scout` |
| Verify + remediate an ultra-review report | `ultra-verifier` |
| Product from short prompt | Workflow-style orchestration with `task` |

## Prompt template (parent → `task`)

Include: goal, non-goals, write/read policy, expected output, stop condition, verification recipe.

**Resume:** `task_id` / `conversation_id` from a prior run.

## Proactive delegation

**All eight roles** use `proactive: true`. Parent rules: `APPEND_SYSTEM.md`.

## Final message XML

Task agents end with `<result>`. Parent must verify artifacts — never ship on subagent summary alone.