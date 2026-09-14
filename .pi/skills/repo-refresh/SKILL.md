---
name: repo-refresh
description: Use when the user explicitly asks to refresh, audit, or clean a whole repository of stale documentation, completed plans, terminal tickets, dead proof machinery, scripts, and generated debris around current production truth; not for routine housekeeping, module deepening, a single test's proof audit, or redesigning working architecture.
disable-model-invocation: true
---

# Repository Refresh

Refresh the named repository around current production truth. This is an explicit, repository-wide cleanup workflow, not routine housekeeping and not an excuse to redesign working production architecture.

## Invocation and mode

Never run this implicitly; only `/skill:repo-refresh` starts it. Choose the mode from the user's wording:

- `audit`: inspect and report; the default for a bare invocation.
- `apply`: audit, perform the authorized cleanup, and verify. Words such as refresh, clean, fix, remove, or consolidate authorize this mode.
- `verify`: validate an earlier refresh without expanding its scope.

An age threshold identifies suspects, never automatic deletion targets. If the user supplies none, use repository evidence, current consumers, and ownership rather than inventing one.

Read [references/refresh-standard.md](references/refresh-standard.md) before auditing or changing anything: it names which files are canonical owners in a repository that runs Matt Pocock's skills, so the cleanup never eats the process's own configuration.

## Boundaries

- Read the complete instruction hierarchy (`AGENTS.md`, `PROJECT.md`, `CONTEXT.md`, `docs/agents/`) before acting; inspect the worktree first and preserve unrelated changes.
- Repository law may add stricter constraints, but it may not justify keeping stale duplication, dead proof, or history disguised as current truth.
- Do not create branches, commits, pull requests, issues, or external messages unless separately requested.
- Do not change production behaviour merely to simplify cleanup; report a production defect separately unless its repair was also authorized.
- Git is the archive. Do not create archives, backup directories, migration diaries, or compatibility copies inside the repository.
- Never touch `vendor/`, installed packages, or generated runtime state under `.pi/`; never edit tracker records by hand where the `tracker` tool owns the fields.

## Procedure

### 1. Establish the current contract

Identify product entry points and owners; the canonical architecture, product, process, and operational documents; active plans and nonterminal work; test, benchmark, validator, gate, and artifact owners; generated files and their producers; the commands that actually define acceptance. Delegate the reading to an `explore` task when the repo is large. Do not trust filenames, folder names, issue state, timestamps, or claims of "authoritative" without checking current code and consumers.

### 2. Inventory the repository

Build a compact ledger covering governing docs, duplicates, indexes, archives, reviews, and postmortems; active, terminal, orphaned, and superseded plans or tickets; tests and proof routes, including custom task-runner machinery; scripts, fixtures, snapshots, reports, generated outputs, tracked build debris; dead paths, links, commands, owner names, cross-references; surfaces so large or fragmented that they hide one current contract. For every suspect record its owner, production consumer, unique current information, replacement destination, and deletion consequence.

### 3. Classify before changing

Exactly one disposition per suspect:

| Disposition | Meaning |
| --- | --- |
| `KEEP` | Current, uniquely owned truth or proportionate proof |
| `MERGE` | Unique current truth belongs in another canonical owner |
| `REWRITE` | The owner remains valid but history or duplication obscures it |
| `DEMOTE` | Useful only as a non-gating diagnostic or closeout record |
| `DELETE` | Stale, duplicated, generated debris, dead proof, or Git-owned history |
| `BLOCKED` | Deletion would cross an unresolved product, compatibility, legal, or operational decision |

Age, size, ugliness, and low coverage are supporting signals, not dispositions. A single test whose proof route is disputed goes through `/skill:test-proof-debt-audit`, which shares this method at claim level.

### 4. Apply a coherent cut (`apply` mode only)

1. Merge unique current truth into its canonical owner.
2. Update live references and instruction routing.
3. Delete superseded sources in the same change.
4. Compact terminal tracker records through the `tracker` tool (`resolve` / `gh-resolve`, `out-of-scope` / `gh-out-of-scope`, `comment`) to identity, dependency fields, disposition, and concise closeout evidence; never hand-edit the fields the tool owns.
5. Keep only active plans; delete completed execution diaries and review packets once their durable decisions reached `docs/adr/` or the owner doc.
6. Remove or demote proof with no current risk, independent oracle, production consumer, or deletion sensitivity.
7. Remove tests that pin retired implementation detail or repository history without a current public, security, compatibility, or machine contract.
8. Remove dead scripts, unowned fixtures, stale tracked reports, and reproducible generated output unless distribution requires tracking it.
9. Prefer fewer canonical folders and one documentation index; do not preserve empty taxonomy.

Make edits in dependency order so the repository never temporarily has two sources of truth.

### 5. Verify the result

Run validation proportionate to the changed surfaces: a stale link and path scan; tracker consistency (`tracker list` / `gh-list`) when a tracker exists; plan and instruction references; generator/source parity for retained generated assets; targeted tests for changed tooling; formatting or whitespace checks; and the smallest declared gate whose contract changed. Gates are the commands the repo declares; an absent category is `NOT DECLARED`, never `PASS`. In `apply` mode, hand the diff to one read-only `reviewer` task before reporting. Do not add a new proof framework to prove the cleanup.

## Completion

Report the structural outcome with before/after inventory; merged, deleted, rewritten, and deliberately retained surfaces; proof machinery removed or demoted and why; validation actually run and any unavailable checker; blocked decisions and remaining current debt. Do not claim completion while live references point to removed material, two documents own the same contract, completed plans remain active, or a mandatory proof route has no named current risk and consumer.
