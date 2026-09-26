# pi-myself

A pi coding-agent harness built around Matt Pocock's skills as the process core. Current-state contract: `PLAN.md`; decisions and their reasons: `docs/adr/`; dated history: `docs/history.md`. Repo map: `PROJECT.md`. Behavior rules: `AGENTS.md`.

## Language

**Vendored tree**:
`vendor/mattpocock-skills/` — the upstream mattpocock/skills checkout living in this repo, consumed verbatim. It is read-only by rule: process improvements go upstream or into the harness layer. Upgraded only by `scripts/sync-skills.mjs`.
_Avoid_: "skills/" alone (ambiguous with `.pi/skills/`), "fork" (we never fork the text)

**Promoted skill**:
One of the 25 skills listed in the vendored `.claude-plugin/plugin.json` (the `skills/engineering` + `skills/productivity` trees).

**Beta skill**:
A skill under the vendored `skills/in-progress/` tree. Upstream keeps them out of the plugin and they may change or vanish without warning; pi-myself registers them anyway (user-invoked via `/skill:<name>`, except `pr`, which is model-invoked), locks them under `bucket: beta`, and supplies the roles and tools they name. `misc/` and `deprecated/` stay unregistered.
_Avoid_: "experimental skill", "unstable"

**Registered set**:
Promoted + beta: what `package.json`, `.pi/settings.json`, the `skill` tool, and `skills-lock.json` all agree on.

**Harness layer**:
Everything pi-myself adds around the vendored tree: `.pi/` (extensions, skills, agents, policy, prompts, settings) plus `scripts/` and `tests/`. The harness adapts pi to Matt's skills; it never introduces a second process.
_Avoid_: "the framework", "runtime config"

**Backend (tracker)**:
Which issue-tracker implementation the `tracker` tool uses: the **local backend** (`.scratch/<feature>/issues/NN-<slug>.md` + `map.md`, the local-markdown convention) or the **GitHub backend** (`gh-*` ops over the `gh` CLI, issues in `MinhDuyDEV/pi-myself`). `docs/agents/issue-tracker.md` names the one in play, and the tool refuses the other op family (both, for GitLab or any backend it does not implement).
_Avoid_: "mode", "driver"

**Prompt**:
A hand-written slash command at `.pi/prompts/<name>.md` (`/verify`, `/init`). Skills are never wrapped: pi exposes each one natively as `/skill:<name>` (a bare `/<name>` is rewritten to it by the `host-commands` input handler, not a wrapper); `/setup-pi-myself` is an extension command, not a prompt.
_Avoid_: "wrapper" (the generated wrapper layer was removed 2026-08-30), "alias"

**Workflow policy**:
The session parent's runtime rules (layering, skill invocation, routing, task roles, completion, memory): `.pi/policy/WORKFLOW.md`, injected by the `policy` extension from the installed package as the `<harness>` system-prompt section before every run (ADR 0003). Never copied into a consuming repo; task children never see it.
_Avoid_: "APPEND_SYSTEM" (the copied file it replaced; a repo's own `.pi/APPEND_SYSTEM.md` is something else, which pi still appends)

**Child contract**:
The rules every task child obeys (scope, no spawning, no questions to the user, no memory writes, evidence, `blocked`, the `Status:` report line). One source, `.pi/policy/CHILD-CONTRACT.md`, spliced by `npm run agents:sync` into the end of each role body. Beside its role body a child gets only pi's base prompt, `AGENTS.md`, and the skills list: the **workflow policy** is injected into the parent only (ADR 0004).
_Avoid_: "child rules in the workflow policy" (a child never sees it)

**Model tier**:
One of three groups of task roles that run one model: **read** (`explore`, `scout`), **reason** (`general`, `designer`, `ultra-verifier`), **review** (`reviewer`, `ultra-scout`). The **review family** (the review tier's model vendor) must differ from the **reason family**, so a judge does not share its author's blind spots (ADR 0006).
_Avoid_: "tier" alone (see Flagged ambiguities)

**Stack companion**:
A local skill that carries craft rather than a host fact — `typescript-coding-standards`, `security-and-hardening`, `source-driven-development` (model-invoked, loaded by domain) and `test-proof-debt-audit` (human-run) — kept under D5's stack-companion clause (PLAN.md §2), and deferring to a vendored skill wherever one owns the overlapping process.
_Avoid_: "textbook skill"

**Provisioning baseline**:
`.pi/pi-myself-provisioned.json` in a consuming repo: per role, the hash of what the package shipped without its project-owned lines, plus the `model`, `thinking`, and `max_turns` it shipped. It tells a project's edit or choice apart from the package's previous version (ADR 0005).

**Doctor**:
`/setup-pi-myself --check`: a read-only report on a repo's harness setup, one `ok`/`warn` line per check, each warning with its fix.

**Host token**:
A command, file, or mechanism a vendored skill names that pi lacks or names differently (`/clear`, `/handoff`, `CLAUDE.md`, `claude --bg`, a script that reads stdin). Each needs a row in `pi-mapping.md`'s host table; `tests/agents.test.ts` fails on one without it.

**Memory record**:
One identity-addressed Markdown file the `pi-workspace-memory` extension keeps under `<localPath>/projects/<slug>/records/` (`localPath` defaults to `~/.pi/memory-md`) — `state.<id>` for a fact still true, `event.<id>` for a finding tied to a moment. The harness tier of distilled knowledge; outside git, per machine.
_Avoid_: "MEMORY.md" (retired, ADR 0002), "note"

**Lock**:
`skills-lock.json` — the vendored tree's provenance record: upstream head, sha256 and bucket per registered SKILL.md, and a digest over every vendored file. Drift between the lock and the tree fails `npm run sync:check`.

**Issue**:
A single tracked unit of work in the **issue tracker** (GitHub Issues here): a bug, task, spec, or slice produced by `to-tickets`.
_Avoid_: "ticket" (except for a **Decision ticket**)

**Decision ticket**:
A wayfinder unit — a child issue of a `wayfinder:map` holding a question whose resolution is a decision, not a slice of a build. On GitHub it carries a `wayfinder:<type>` label and a `Part of: #NN` line.
_Avoid_: "decision issue"

**Triage role**:
A canonical state-machine label applied to an issue during triage (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), mapped to real label strings via `docs/agents/triage-labels.md`.
In the local backend a state role lives on the `Status:` line and a category role (`bug`/`enhancement`) on its own `Category:` line, so a state change never clobbers the category; the file keeps the canonical role and the mapped spelling is accepted as input.

**Frontier**:
The takeable edge of the tracker: issues that are open, unclaimed (no assignee, no `Status: claimed`), not a map, not held back by a triage state role (`needs-triage`, `needs-info`, `ready-for-human`), and whose every `**Blocked by:**` reference is closed. First by number wins.

**Smart zone**:
The ~150k-token window within which the model still reasons sharply (ask-matt's PHASE-BOUNDARIES.md), capped by the model's context window when that is smaller. The `smart-zone` meter shows the reading in the footer past 60%, toasts the decision order once when crossing 85%/100%, skips failed and aborted runs, and never compacts on its own.

## Relationships

- The **vendored tree** holds the promoted skills; the **harness layer** loads and supports them.
- A **memory record** is written only by the session parent; task roles propose records in their result.
- The **tracker tool** has two **backends**; `docs/agents/issue-tracker.md` selects which one the skills use.
- The **lock** records the **vendored tree**'s state; `sync-skills.mjs` rewrites both together.
- An **issue** carries one **triage role** at a time; a **decision ticket** is an issue of a wayfinder map.

## Flagged ambiguities

- "skills" was overloaded: the vendored `skills/engineering|productivity` trees vs our own `.pi/skills/` layer. Resolved: always say **vendored tree** for the former and **local skills** for the latter.
- "status" meant both a tracker field ("Status: claimed") and a GitHub label. Resolved: locally it is the `Status:` line; on GitHub it is a **label** (triage role); the `gh-status` op replaces all existing role labels.
- "tier" meant both the three-tier **state boundary** (PLAN.md §3: domain, work tracking, harness) and a **model tier** of task roles. Resolved: say "state tier" or "model tier", never "tier" alone.
- "dogfood" as a noun ("the dogfood round") means: running Matt's flow on this repo to plan this repo's work, using the harness being built. Kept as project jargon.