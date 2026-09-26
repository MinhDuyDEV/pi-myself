# ADR 0004: The child contract is generated into every role body from one source

Supersedes the "Task child contract" section the roster consolidation of 2026-09-15 put in `APPEND_SYSTEM.md` (`docs/history.md`, "Roster consolidation"). Decided 2026-09-26 ("The child layer, made real").

## Context

The roster consolidation of 2026-09-15 moved the rules every task child shares (scope, no spawning, evidence, the report) into one place: a `### Task child contract` section of `APPEND_SYSTEM.md`, so role bodies could hold only purpose, input, rules, and output.

The whole-harness audit of 2026-09-26 found that section bound no one. pi-task passes a role body to the child as `--append-system-prompt`, and that flag suppresses a discovered `APPEND_SYSTEM.md`, so a child receives pi's base prompt, `AGENTS.md`, the skills list, and its role body — nothing of the parent's rules. The same audit found that `skills:` is not a preload: pi-task passes each declared skill's path and loading stays progressive, so a declared skill was never read unless the body said to read it.

## Decision

1. **One source**: `.pi/policy/CHILD-CONTRACT.md` holds every rule a child must follow.
2. **Generated, not copied by hand**: `scripts/sync-agents.mjs` (`npm run agents:sync`) splices the source between `child-contract` markers at the end of every role in `.pi/agents/`. `npm run agents:check` fails on drift and is part of `npm run check`.
3. **The contract carries what a child lacked**: load the skills on the body's `Load first:` line, `memory_search` first, never ask the user (return `blocked` with the question), and pi-task's own `Status:` wording.
4. **Mechanical backing where pi-task allows it** (2026-09-26): `ask_user` denied on every role, `memory_write`/`memory_delete` denied on every role, `tracker` unreachable from the roles that must not change state, and `max_turns` on all seven so a child wraps up before the 30-minute hard timeout.

## Consequences

- Edit the source, never a generated block; provisioned roles carry the block because it is part of the file `/setup-pi-myself` copies.
- A child never sees the workflow policy (ADR 0003 injects it into the parent only), so a rule every child needs belongs in the contract, not the policy.
- The contract rides in every child's context, so it has its own byte budget (2,500) in `tests/loaded-docs.test.ts`, and `tests/agents.test.ts` fails when a role's block differs from the source or a declared skill is missing from its `Load first:` line.
- The roles stay pi-runtime only: pi-task's Claude translator rejects the pi-only tool names the denies and allowlists use (2026-09-26, "Reachability, host-mapping gates, and mechanical child rules").
