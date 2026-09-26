# PLAN.md — the pi-myself contract

How pi-myself is shaped now; a change that contradicts this file updates it in the same commit. Reasons for hard-to-reverse decisions: `docs/adr/`. Dated history, not guidance: `docs/history.md`. Surfaces: `README.md`; repo map: `PROJECT.md`.

## 1. Goal

A pi coding-agent harness built around mattpocock/skills as the process core.

- **Core (process)**: the vendored upstream skills, 25 promoted plus the 9 beta skills of `skills/in-progress/`, consumed verbatim, never forked.
- **Harness (runtime)**: extensions, task roles, local skills, prompts, scripts, tests; adapted from pikit (heyhuynhgiabuu/pikit) only where Matt's skills need pi support.

## 2. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Work tracking | **Matt's tracker.** `docs/agents/issue-tracker.md` picks GitHub, GitLab, or local `.scratch/`; the `tracker` tool runs its field operations. pikit's `.pi/artifacts/` files are dropped. |
| D2 | Upstream distribution | **Vendored** at `vendor/mattpocock-skills/`. `scripts/sync-skills.mjs` re-clones it; `skills-lock.json` hashes each registered skill (promoted + beta; beta is user-invoked except `pr`) and digests every vendored file. `misc/`, `deprecated/` unregistered. Never edit it; adapt in the harness layer. |
| D3 | Subagents | **pi-task as-is**; we own the roles in `.pi/agents/` (ADRs 0004–0006). |
| D4 | Memory | **pi-workspace-memory as-is** (global). The harness owns the discipline (`memory` skill, parent-only writes), not the storage (ADR 0002). |
| D5 | Harness scope | **Only what Matt's skills lack on pi.** A local skill or prompt survives only if it encodes a harness mechanism or a host fact the model cannot infer (dropped 2026-09-14: `tps`, `shortcut-continue`, `.pi/cli/`, `/fix`, `api-and-interface-design`, `deprecation-and-migration`; `install-git-hooks` returned 2026-09-26 in `commit-guardrails`, a mechanism). **Stack-companion clause (2026-09-26, user decision, reversible):** `typescript-coding-standards`, `security-and-hardening`, `source-driven-development`, and `test-proof-debt-audit` stay although they carry craft rather than a host fact. The first three are model-invoked and load only when a task touches their domain; the last is human-run. Where a vendored skill owns the overlapping process they defer to it (`codebase-design`, `tdd`, `research`), and no two own one rule (boundary validation is `security-and-hardening`'s). Dropping one is a catalog row and a directory. |

Consequences:

- pikit skills overlapping Matt's are dropped: `grilling`, `test-driven-development`, `improve-codebase-architecture`, `planning-and-task-breakdown`, `code-review-and-quality`, `debugging-and-error-recovery`, `documentation-and-adrs`, `cloudflare`.
- Process prompts (`/create`, `/plan`, `/ship`, `/research`, `/fix`) are dropped: Matt's flow is the only process, routed by `/skill:ask-matt`.
- One flow, one vocabulary: the workflow policy (`.pi/policy/WORKFLOW.md`, ADR 0003) routes process to Matt's skills; harness skills support, never compete.

## 3. Three-tier state boundary

| Tier | Owner | Contents |
|---|---|---|
| **Domain** | Matt's conventions | `CONTEXT.md`, `docs/adr/`, `docs/agents/` (written by `/skill:setup-matt-pocock-skills`) |
| **Work tracking** | Matt's issue tracker | specs, tickets, blocking edges, triage roles; local default `.scratch/<feature>/issues/` (gitignored) |
| **Harness** | pi-myself | `pi-workspace-memory` records (`state` facts, `event` findings; outside git) and `recall` over session history |

Memory distils; it points at `CONTEXT.md`, tracker state, or a report instead of copying them.

## 4. Architecture

```
pi-myself/
├── package.json         # pi.{extensions,skills,prompts}; npm scripts
├── PLAN.md  AGENTS.md  PROJECT.md  README.md  CONTEXT.md
├── docs/                # adr/ (decisions), agents/ (skill config), history.md
├── vendor/mattpocock-skills/   # read-only upstream; guard refuses writes
│   └── skills/          # engineering (18) + productivity (7) promoted; in-progress (9) beta
├── .pi/
│   ├── policy/          # WORKFLOW.md (parent) · CHILD-CONTRACT.md (roles)
│   ├── extensions/      # policy, guard, host-commands, skill-tool/, tracker/,
│   │                    #   dcp/ (recall), continue-after-compaction, smart-zone,
│   │                    #   provision; lib/ = shared helpers
│   ├── skills/          # local skills (listed in PROJECT.md)
│   ├── agents/          # seven task roles in three tiers
│   ├── prompts/         # /verify /init
│   └── settings.json    # dogfood defaults
├── scripts/             # sync-skills, sync-agents, setup-project, run-extension-tests
├── tests/               # repo-level gates (§7)
├── skills-lock.json     # upstream head, per-skill hashes, whole-tree digest
└── .github/workflows/   # quality.yml (npm run check), upstream-freshness.yml (weekly)
```

## 5. Matt-skills → pi gaps

| Gap in pi | Harness answer |
|---|---|
| No Skill tool | `skill-tool`: loads exactly the model-invoked set and names the skill's directory; a user-invoked name returns the `/skill:<name>` command for the human |
| Skills print bare `/<name>`, `/clear` | pi's native `/skill:<name>` (no wrapper layer); `host-commands` rewrites a bare `/<skill>` and registers `/clear` as `/new` |
| Other host mechanisms | `.pi/skills/harness-catalog/pi-mapping.md`, gated |
| No subagents | pi-task and the roles in `.pi/agents/README.md` |
| Tracker ops as freeform prose | `tracker`: local and GitHub backends for every field op the skills name, tied to the vendored templates by `.pi/extensions/tracker/conventions.test.ts`; the PR triage surface (plain `gh pr view`) and GitLab stay prose |
| Smart-zone awareness | `smart-zone`: footer meter past 60% of ~150k, advice toast at 85%/100%; never compacts |
| No write guard | `guard`: refuses `write`/`edit` into the vendored tree, the lock, and runtime state; 30-minute default `bash` timeout. Not a permission system: shell writes pass |
| Context loss after compaction | `dcp/` `recall`; `continue-after-compaction` resumes only a run a manual `/compact` interrupted |
| Harness rules never reach a consuming repo | `policy` injects the workflow policy (ADR 0003); `/setup-pi-myself` copies the roles (ADR 0005) and `--check` is a read-only doctor |

## 6. What we kept from pikit

- **Extensions**: `dcp/` (recall) and `continue-after-compaction`; the rest are harness-authored.
- **Skills**: `security-and-hardening` and `source-driven-development`, compressed, under D5's stack-companion clause; pikit's Matt-overlapping skills are dropped (§2).
- **Prompts**: `/verify` and `/init`, each doing one job no skill does.
- **Tests**: the local-skill description rules and the stale-count gate (§7).
- **Skill content rule**: a local skill keeps a section only if no other loaded text says it.

Dropped: themes, `DESIGN.md`, sprint templates, `bin/cli.js`, `safety/`, `todo.ts`, `herdr-agent-state.ts`; reasons in `docs/history.md`.

## 7. Test gates

`npm run check` (lint, both typechecks, `npm test`, `sync:check`, `agents:check`) is the gate CI runs on Node 22.18.0 and 22.20.0; test names state each rule.

- **Vendored parity** (`tests/upstream-skills.test.ts`): pi frontmatter for both buckets, one registered set everywhere, `.pi/settings.json` resource paths resolve, `Call the Skill tool` targets model-invoked, fresh hashes, beta prose matches the lock.
- **Lock** (`tests/sync-skills.test.ts`, `sync:check`): the whole-tree digest catches any vendored edit, addition, or removal.
- **Skill tool** (`.pi/extensions/skill-tool/`): loadable set = model-invoked set.
- **Roles** (`tests/agents.test.ts`, `tests/sync-agents.test.ts`, `agents:check`): roster, one model per tier, review family ≠ reason family, child-contract block = source, `Load first:`, denies, `max_turns`, tool reachability, a mapping section per spawning skill and row per host token, the catalog's actors and coverage.
- **Local skills** (`tests/local-skills.test.ts`): descriptions, no shadowing, links, reachability.
- **Docs** (`tests/loaded-docs.test.ts`, `tests/docs-counts.test.ts`, `tests/markers.test.ts`): guidance paths resolve, no repeated paragraph, byte budgets, this file ≤ 10,000 bytes, no stale counts, no bare `FIXME`.
- **Also** in `tests/`: prompts, provisioning, git hooks, the ultra-review scaffold, extension layout. Extension tests sit beside their code.

## 8. History

Dated entries, oldest first: `docs/history.md`.

## 9. Deferred / open

- Tracker (low severity): parent map found only via `Part of`/`## Parent` (R11); `create-map` puts `notes` under "Not yet specified", `what` under Notes, and the local op ignores `title` (R15); `gh-show` keeps 30 newest comments (R17); `gh-status` silently strips a second state role (R18); a failed sub-issue link falls back to number order (R19); `gh-list` is open-only (R21). Unverified: `gh-block` re-posts links; a failed `gh repo view` makes own `owner/repo#N` refs foreign.
- `scripts/sync-skills.mjs` deletes the vendored tree before copying the clone, unstaged (S16); verifying a fix needs a live re-clone.
- The GitHub write path has fake-runner tests only (a live run needs a `delete_repo` token).
- GitHub body edits lack `If-Match`; serialise map edits in one session.
- `gh-frontier`/`gh-triage` fail past ~40,000 issues; `gh-triage` reads 40 `needs-info` threads per call; `gh-comment` may target a PR.
- `recall`: cache budget counts source bytes; LRU order untested; files over 40 MB skipped; `expand` indices can shift if a task starts or another process writes an older session (headings show each entry's time).
- `skill-tool` ignores per-directory ignore files pi honours.
- `.scratch/` recall provenance; themes; a cross-project memory tier; `pi-review-loop`, `pi-pretty`, `pi-diff`.
