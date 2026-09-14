---
name: memory
description: ALWAYS check durable project memory (memory_search) before non-trivial work and record durable learnings with memory_write; state records for facts still true, event records for findings.
---

# Memory

Durable project knowledge lives in the `pi-memory-md` extension: per-project records under `~/.pi/memory-md/projects/<project-slug>/records/`, reached through the `memory_search`, `memory_read`, `memory_write`, and `memory_delete` tools. The extension injects the newest records' metadata into the first turn; everything else is on demand.

If the memory tools are absent from the tool list, the host has not installed `pi-memory-md` (`pi install git:github.com/sting8k/pi-memory-md`). Say so once and continue without memory; never fall back to an ad-hoc file.

## When to load

**ALWAYS** at the start of any task that:

- involves a decision, design choice, or architectural call
- references prior work, past sessions, or "what we did before"
- touches the host, install layout, tooling, or environment
- the user mentions "memory", "before", "last time", "we used to", or similar

For trivial edits, single-line fixes, or pure code questions with no project context — skip.

## Workflow

```text
START: memory_search({ query: "<task keywords>", searchIn: "all" })
READ:  memory_read({ path: "@<id>", view: "knowledge" })      # full only when the notes matter
END:   memory_write({ path: "records/<kind>.<slug>.md", kind, description, summary, claims, facts })
```

- Search with two or three distinct keywords; the search is regex and multi-term OR.
- Read the `knowledge` view first; it carries summary, concepts, claims, facts, relations without the prose.
- Write structured fields (`summary`, `claims`, `facts`, `concepts`), not a prose dump. One record per learning.

## Record kinds

| Kind | Use for | ID rule |
| --- | --- | --- |
| `state` | Facts still true tomorrow: environment, host behaviour, install layout, conventions, active architecture | No dates in the id; update in place, never snapshot |
| `event` | Findings with a moment: a debugging outcome, an investigation, a benchmark, a decision with its reason | Append-only; a date in the id is fine |

When unsure, write an `event`. Merge a cluster of related records with `memory_write({ supersedes: ["@a", "@b"] })` and the distilled content; never delete to tidy.

## Boundary with the other tiers

- Project **vocabulary** belongs in `CONTEXT.md` (domain-modeling), not here.
- **Decisions with real tradeoffs** belong in `docs/adr/`, not here.
- **Work units** belong in the issue tracker, not here.
- **Research reports** the `research` skill produces belong in the repo as files; memory may hold a one-line `event` pointing at the path.
- Memory holds distilled operational knowledge: patterns, gotchas, environment facts, debugging outcomes. Nothing that already lives in a tracked file.

## Who writes

The session parent alone calls `memory_write` and `memory_delete`. Task children (any `task` role) return proposed records in their result; the parent decides what is durable. Memory is local to this machine and is not in git: anything a collaborator must know goes into a tracked file instead.

## When NOT to use

- Session-internal scratch work — use the conversation.
- Ephemeral task tracking — use the issue tracker.
- Project rules — those go in `AGENTS.md`.
- Secrets, tokens, credential paths — never; the tool refuses to inject them and you should not write them.
