---
name: memory
description: ALWAYS read durable project context from `<repo-root>/.pi/MEMORY.md`; append learnings to it. File-based, on-demand, observable.
---

# Memory

Durable project knowledge lives in `<repo-root>/.pi/MEMORY.md`. Resolve the repository root before reading or writing it. Read it on demand when relevant, append to it when new learnings surface.

## When to load

**ALWAYS** at the start of any task that:

- involves a decision, design choice, or architectural call
- references prior work, past sessions, or "what we did before"
- is in a project the user has memory for (`<repo-root>/.pi/MEMORY.md` exists)
- the user mentions "memory", "before", "last time", "we used to", or similar

For trivial edits, single-line fixes, or pure code questions with no project context — skip.

## Where memory lives

- `<repo-root>/.pi/MEMORY.md` — project-specific memory (per repository root)
- `~/.pi/MEMORY.md` — global personal memory (cross-project, cross-session)

The user creates and owns these files. They are not part of this skill.

Sections in MEMORY.md: architecture, decisions, patterns, gotchas. Grep-friendly keywords.

## Boundary with the domain layer

- Project **vocabulary and ubiquitous language** belong in `CONTEXT.md` (domain-modeling), not here.
- **Decisions with real tradeoffs** belong in `docs/adr/` (ADRs), not here.
- **Work units** belong in the issue tracker (`.scratch/` or the configured tracker), not here.
- MEMORY.md holds distilled operational knowledge: patterns, gotchas, environment facts, past debugging outcomes.

## Usage

**Resolve the repository root once:**

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
```

**Recall prior context:**

```bash
rg -n "<topic>" "$ROOT/.pi/MEMORY.md"
```

For a small file, use the `read` tool with the absolute path `$ROOT/.pi/MEMORY.md`.

**Save a new learning this session:**

1. Resolve `<repo-root>` and check for duplicates: `rg -n "<topic>" <repo-root>/.pi/MEMORY.md`
2. If the learning is durable, append a bullet via `edit` using the resolved absolute path. Keep entries short.

**Compact when the file grows:**

- Read the file, then rewrite, dropping low-signal entries.
- Target: under 5KB. If it grows past that, compact.

## Conventions for entries

- One bullet per learning, with type tag in brackets: `[decision]`, `[bugfix]`, `[pattern]`, `[feature]`, `[discovery]`, `[learning]`, `[warning]`.
- Prefer concise titles; narrative only when essential.

## When NOT to use

- For session-internal scratch work — use the conversation, not MEMORY.md.
- For ephemeral task tracking — use the issue tracker, not MEMORY.md.
- For project rules — those go in `AGENTS.md`, not MEMORY.md.