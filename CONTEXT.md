# pi-myself

A pi coding-agent harness built around Matt Pocock's skills as the process core. Plans and decisions: `PLAN.md`. Repo map: `PROJECT.md`. Behavior rules: `AGENTS.md`.

## Language

**Vendored tree**:
`vendor/mattpocock-skills/` — the upstream mattpocock/skills checkout living in this repo, consumed verbatim. It is read-only by rule: process improvements go upstream or into the harness layer. Upgraded only by `scripts/sync-skills.mjs`.
_Avoid_: "skills/" alone (ambiguous with `.pi/skills/`), "fork" (we never fork the text)

**Promoted skill**:
One of the 25 skills listed in the vendored `.claude-plugin/plugin.json` (the `skills/engineering` + `skills/productivity` trees).

**Beta skill**:
A skill under the vendored `skills/in-progress/` tree. Upstream keeps them out of the plugin and they may change or vanish without warning; pi-myself registers them anyway (all user-invoked, `/skill:<name>`), locks them under `bucket: beta`, and supplies the roles and tools they name. `misc/` and `deprecated/` stay unregistered.
_Avoid_: "experimental skill", "unstable"

**Registered set**:
Promoted + beta: what `package.json`, `.pi/settings.json`, the `skill` tool, and `skills-lock.json` all agree on.

**Harness layer**:
Everything pi-myself adds around the vendored tree: `.pi/` (extensions, skills, agents, prompts, settings, APPEND_SYSTEM.md) plus `scripts/` and `tests/`. The harness adapts pi to Matt's skills; it never introduces a second process.
_Avoid_: "the framework", "runtime config"

**Backend (tracker)**:
Which issue-tracker implementation the `tracker` tool uses: the **local backend** (`.scratch/<feature>/issues/NN-<slug>.md` + `map.md`, the local-markdown convention) or the **GitHub backend** (`gh-*` ops over the `gh` CLI, issues in `MinhDuyDEV/pi-myself`). `docs/agents/issue-tracker.md` names the one in play.
_Avoid_: "mode", "driver"

**Prompt**:
A hand-written slash command at `.pi/prompts/<name>.md` (`/verify`, `/init`, `/remember`, `/setup-pi-myself`). Skills are never wrapped: pi exposes each one natively as `/skill:<name>`.
_Avoid_: "wrapper" (the generated wrapper layer was removed 2026-08-30), "alias"

**Memory record**:
One identity-addressed Markdown file the `pi-memory-md` extension keeps under `~/.pi/memory-md/projects/<slug>/records/` — `state.<id>` for a fact still true, `event.<id>` for a finding tied to a moment. The harness tier of distilled knowledge; outside git, per machine.
_Avoid_: "MEMORY.md" (retired, ADR 0002), "note"

**Lock**:
`skills-lock.json` — the vendored tree's provenance record: upstream head + sha256 and bucket per registered SKILL.md. Drift between the lock and the tree fails `npm run sync:check`.

**Issue**:
A single tracked unit of work in the **issue tracker** (GitHub Issues here): a bug, task, spec, or slice produced by `to-tickets`.
_Avoid_: "ticket" (except for a **Decision ticket**)

**Decision ticket**:
A wayfinder unit — a child issue of a `wayfinder:map` holding a question whose resolution is a decision, not a slice of a build. On GitHub it carries a `wayfinder:<type>` label and a `Part of: #NN` line.
_Avoid_: "decision issue"

**Triage role**:
A canonical state-machine label applied to an issue during triage (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), mapped to real label strings via `docs/agents/triage-labels.md`.

**Frontier**:
The takeable edge of the tracker: issues that are open, unclaimed (no assignee), not a map, and whose every `**Blocked by:**` reference is closed. First by number wins.

**Smart zone**:
The ~150k-token window within which the model still reasons sharply (ask-matt's PHASE-BOUNDARIES.md). The `smart-zone` meter shows the reading in the footer past 60%, toasts the decision order once when crossing 85%/100%, and never compacts on its own.

## Relationships

- The **vendored tree** holds the promoted skills; the **harness layer** loads and supports them.
- A **memory record** is written only by the session parent; task roles propose records in their result.
- The **tracker tool** has two **backends**; `docs/agents/issue-tracker.md` selects which one the skills use.
- The **lock** records the **vendored tree**'s state; `sync-skills.mjs` rewrites both together.
- An **issue** carries one **triage role** at a time; a **decision ticket** is an issue of a wayfinder map.

## Flagged ambiguities

- "skills" was overloaded: the vendored `skills/engineering|productivity` trees vs our own `.pi/skills/` layer. Resolved: always say **vendored tree** for the former and **local skills** for the latter.
- "status" meant both a tracker field ("Status: claimed") and a GitHub label. Resolved: locally it is the `Status:` line; on GitHub it is a **label** (triage role); the `gh-status` op replaces all existing role labels.
- "dogfood" as a noun ("the dogfood round") means: running Matt's flow on this repo to plan this repo's work, using the harness being built. Kept as project jargon.