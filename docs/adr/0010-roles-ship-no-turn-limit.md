# ADR 0010: Roles ship no `max_turns`

Decided 2026-10-10 (user decision). Supersedes the `max_turns` clause of ADR 0004's decision 4 ("`max_turns` on all seven so a child wraps up before the 30-minute hard timeout"). The rest of ADR 0004 stands, and so does ADR 0005: `max_turns` remains a field the project owns.

## Context

pi-task bounds a background child on a terminal backend two ways: `max_turns`, a soft limit that steers a wrap-up and allows ten grace turns before it settles the task, and `PI_TASK_HARD_TIMEOUT_MINUTES` (default 30), a wall-clock ceiling that stops the child without a result. ADR 0004 put `max_turns` on every role so that a long child would report before the ceiling hit.

Session history in a consuming repository (vector-hub, 2026-09-29 to 2026-10-05, counted from `task-complete` messages) showed something else. Only `general` ever reached its limit: about 4 of roughly 146 runs stopped at 50 turns, and about 6 more hit the 30-minute ceiling. Every turn-limit stop ended in "did not wrap up within 10 further turns": the child was mid-ticket (gates green with a commit pending, or a failing test half-fixed) and did not stop for the wrap-up prompt, so the task settled as `timeout` with `result_valid: false`, and the parent had to resume it anyway. No other role came near its limit.

## Decision

No role in `.pi/agents/` sets `max_turns`. `tests/agents.test.ts` fails if one does.

## Considered options

- **Raise `general` to the test's cap (100) and add a wrap-up clause to the child contract.** Not taken. The user chose to drop the turn limit rather than tune it.
- **Keep the limit on the read and review roles only.** Not taken. They never reached it, so it bounded nothing there.

## Consequences

- A long child is bounded only by `PI_TASK_HARD_TIMEOUT_MINUTES`, which stops it without even the partial text a turn-limit stop returned. With the ceiling set to `0`, a background child runs until it finishes or the user aborts it.
- The ceiling is an environment variable on the user's machine, outside this repository. A user who wants long implementers to finish raises it there.
- A consuming project may add `max_turns` to a role. Provisioning keeps a value the project chose, and drops a value that still equals the one the package shipped before (`tests/setup-project.test.ts`).
