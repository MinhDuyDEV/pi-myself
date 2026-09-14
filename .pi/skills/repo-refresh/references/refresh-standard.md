# Repository Refresh Standard

The baseline every refreshed repository is held to. Where a repository runs Matt Pocock's skills through pi-myself, the canonical owners below are fixed by that process and are never cleanup targets.

## Current truth

- Current documents describe the current system. Git owns narrative history.
- One contract has one canonical owner. Other documents link to it rather than restating it.
- Use one documentation index. Avoid indexes of indexes.
- Keep folders only when they express a durable ownership boundary with multiple current documents.
- Do not keep `archive/`, `completed/`, `review/`, `packet/`, `old/`, or `postmortem/` collections by default. Retain a postmortem only when it remains an active operational control or legally required record.
- Merge current facts before deleting their stale containers.
- A document modified before a user-supplied date is presumed suspect, not presumed disposable.

## Canonical owners in a pi-myself repository

Three tiers, each with one owner (PLAN.md §3 of the harness). Refresh consolidates *into* these; it never removes or relocates them.

| Tier | Owner | Files |
| --- | --- | --- |
| How to work here | `/init` | `AGENTS.md` (or `CLAUDE.md`; never both), `PROJECT.md` |
| Domain | `domain-modeling` (via `grill-with-docs`) | `CONTEXT.md` (or `CONTEXT-MAP.md` + per-context `CONTEXT.md`), `docs/adr/` |
| Process configuration | `setup-matt-pocock-skills` | `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md`, the `## Agent skills` block in `AGENTS.md` |
| Work tracking | the configured tracker | `.scratch/<feature>/{spec.md,map.md,issues/}` for the local backend; GitHub or GitLab issues otherwise |
| Harness runtime | pi-myself | `.pi/agents/`, `.pi/APPEND_SYSTEM.md`, `.pi/settings.json`, `.pi/skills/`, `.pi/prompts/` (provisioned copies are refreshed by `/setup-pi-myself`, not edited) |

Everything else under `docs/` is a candidate: parallel doctrine, contract, observability, project, and miscellaneous trees whose content belongs to an owner above get merged into it and deleted. Research reports the `research` skill wrote stay where the repo keeps notes unless superseded by an ADR or spec. Durable operational knowledge that belongs to no tracked file goes to memory (`memory_write`), not to a new document.

## Plans and trackers

- Plans are temporary execution authority, not permanent historical records. Delete completed and superseded plans after their durable decisions reached `docs/adr/` or the owner doc; a wayfinder map whose destination is reached is closed, not archived.
- Nonterminal tickets must have a current premise, owner, consumer, and completion condition; a ticket that lost its premise is resolved with the reason or ruled out of scope through the `tracker` tool.
- Terminal tickets keep their identity and dependency fields plus a compact closeout (`## Answer`, resolution comment); diaries, review transcripts, stale artifact paths, and references to deleted plans are removed from the prose the tool does not own.
- Generated roadmaps and frontier readouts are views, never independent truth.

## Tests and proof

A retained mandatory proof route must name: the current risk; the production behaviour or machine contract; the current consumer; an observation capable of failing when the behaviour disappears; an oracle independent enough not to reproduce the implementation; the reason cheaper ordinary testing is insufficient.

Delete, replace, or demote machinery that checks source text, metadata, filenames, or artifact presence as a proxy for runtime behaviour; pins retired values solely to prove their retirement; reproduces production logic in a mock, simulator, or validator and proves only the replica; runs broad expensive workflows for a narrow local risk; exists because an earlier ticket demanded evidence but protects no current contract; duplicates compiler, type-system, linter, framework, or ordinary unit-test guarantees; cannot fail under a credible removal of the claimed behaviour; produces large retained reports no current release or operator consumes.

Keep historical compatibility vectors only when the old value remains a current public, security, wire, storage, migration, or machine contract. Hygiene tests that guard a repository's own conventions (skill frontmatter, lock integrity, layout) are machine contracts of that repository and stay.

## Strong cleanup rules

- Prefer deletion over deprecation inside a single-owner repository.
- Do not leave forwarding documents for renamed internal paths; update callers.
- Do not create a debt register to excuse debt that can be removed now.
- Do not retain a mechanism because deleting it would make an old proof fail.
- Do not create new abstractions merely to preserve a stale interface.
- Empty folders, obsolete taxonomy, dead commands, and reproducible reports are cleanup failures, not harmless residue.
- When uncertain, preserve unique current truth but delete redundant narrative.

## Evidence for the refresh

The refresh itself needs only proportionate verification: references resolve; canonical owners are unique; retained tracker and plan schemas are valid; changed tooling tests pass; generated material matches its producer where tracking is intentional; the declared acceptance gates still exercise the contracts affected by the cleanup.

Line-count reduction is useful reporting, not proof of correctness. A smaller repository is successful only when it retains every current product, operational, compatibility, security, and contributor contract.
