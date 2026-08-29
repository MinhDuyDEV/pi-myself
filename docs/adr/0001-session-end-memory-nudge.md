# ADR 0001: Session-end memory capture — a shutdown-hook nudge plus an in-turn discipline

## Context

An audit of the memory wiring found the gap precisely: the agent reliably knows how to *read* `.pi/MEMORY.md` (skill description in the system prompt, APPEND_SYSTEM foundational rule, task-role frontmatter) and, after our fix, knows *when to save during a turn* (APPEND_SYSTEM: durable learning → tagged bullet before the turn ends). What had no mechanism at all was the **session end**: nothing fired when a session quit, so a session that learned something durable and forgot to save left no trace until the work was needed again. GitHub issue #4 (dogfood round 1) asked for a decision, conditional on a fact: does pi expose a session-end event?

**Fact-finding (2026-08-29, pi docs):** pi fires `session_shutdown` before a session runtime is torn down, with `reason: "quit" | "reload" | "new" | "resume" | "fork"`. The event exists — the conditional resolves to "yes, a hook exists".

## Decision

Three cooperating mechanisms, each doing the one job it can do deterministically:

1. **In-turn saving stays the primary path** (APPEND_SYSTEM, shipped in `2def449`): a turn that surfaces a durable learning ends by appending a tagged bullet.
2. **`memory-nudge` extension (new)**: snapshots `.pi/MEMORY.md` at `session_start`; on `session_shutdown` with `reason: "quit"`, if the file was unchanged (or absent), it reminds — addressed to the human and the next session. It never writes MEMORY.md itself: judging "durable" is a judgment call, and a gate that fires on every quiet quit would train people to ignore it.
3. **`/remember` prompt (hand-written)**: an on-demand review pass that walks the memory skill — for the end of a session where something was learned and the in-turn save was missed.

Rejected: writing MEMORY.md automatically at teardown (the "durable" judgment can't be made after the agent is gone); an `agent_end` idle heuristic (fires per turn, not per session — the wrong grain, per pi's own docs distinguishing `agent_end` from `agent_settled`/teardown).

## Consequences

- A quiet session that captured nothing gets one reminder line instead of silence; a session that saved leaves no noise.
- Sessions on repos without `.pi/MEMORY.md` get told how to start one — the layer no longer dies silently in unseeded projects (the original audit finding).
- **Verification (2026-08-29):** the chain is live end to end — in `pi --mode rpc` headless, a quit session emits exactly `{"type":"extension_ui_request","method":"notify","message":"memory: no durable learnings appended this session (.pi/MEMORY.md does not exist yet — create it when the first real one appears, or run /remember)","notifyType":"info"}`. In the interactive TUI the full-screen renderer swallows that last-frame notify before restoring the terminal (stderr fallback doesn't trigger there because `ctx.hasUI` is true) — so in the TUI this backstop is best-effort, and the in-turn save plus `/remember` remain the mechanisms that actually matter. Recorded so nobody mistakes the TUI silence for a broken hook.
- If pi later ships a richer session-summary hook, this extension is the natural place to grow it without changing the in-turn discipline.