---
description: Review this session for durable learnings and record them as pi-memory-md records (state for facts still true, event for findings)
argument-hint: "[focus: what to review]"
---

# Remember: $ARGUMENTS

Follow the memory skill. If the `memory_write` tool is missing, stop and say the host has no `pi-memory-md` installed.

1. Run `memory_search` without a query to see what the project already remembers; then search the topics this session touched.
2. Review THIS session's work: what did we learn that a future session should not have to rediscover — patterns, gotchas, debugging outcomes, environment facts, decisions with their reasons?
3. For each durable item, write ONE record with `memory_write`: `kind: "state"` when it will still be true tomorrow (update the existing record in place if one matches), `kind: "event"` for a finding tied to a moment. Use structured fields (`summary`, `claims`, `facts`, `concepts`), not prose dumps. Nothing durable surfaced? Say so and write nothing.
4. Vocabulary goes to `CONTEXT.md`, tradeoff decisions to `docs/adr/`, work to the tracker, research reports to repo files — not to memory.
5. Report the record ids you wrote, the ones you updated, and what you deliberately skipped, with one line of why.
