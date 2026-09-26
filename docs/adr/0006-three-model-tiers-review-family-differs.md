# ADR 0006: Three model tiers, and the review tier runs a different model family from the reason tier

Decided 2026-09-15 ("Roster consolidation" and "Review layer audit", both user decisions, `docs/history.md`); the check reads the role files since 2026-09-26 ("The child layer, made real").

## Context

On 2026-09-15 the roster went from ten roles to seven in two model tiers, **read** and **reason**, so that choosing a model for a task is mechanical rather than a per-role judgment.

The same day's review layer audit asked whether a post-PR review layer would add an independent view. On pi it would not add context independence, since every task child already starts with a fresh context. What adds a different perspective is a different model family, different inputs, or an actor outside the session. At that point all seven roles ran `deepseek-v4-flash`, so `general` (the writer) and `reviewer` (the judge) shared one vendor's blind spots.

## Decision

1. **Three tiers**: **read** (`explore`, `scout`) maps and searches and never changes code; **reason** (`general`, `designer`, `ultra-verifier`) changes or designs; **review** (`reviewer`, `ultra-scout`) judges what the reason tier wrote and is always `readonly: true`.
2. **One model per tier**, set on the `model:` line of each role in it; pi-task has no shared default.
3. **The review tier runs a different model family from the reason tier** (today `opencode-go/kimi-k3` against `opencode-go/deepseek-v4-flash`). `tests/agents.test.ts` fails when a tier runs two models or when the review family equals the reason family, reading both from the role files.

Not taken (2026-09-15): `pi-review-loop` (the same agent re-prompting itself, or a human review UI) and a harness `/skill:pr-review` (deferred until a team repo needs it).

## Consequences

- Changing a tier's model means editing every role in that tier; the family rule constrains the choice.
- The guarantee holds only where a consuming repo leaves `model` alone: provisioning keeps a model the project chose (ADR 0005), and `/setup-pi-myself --check` reports a shared family.
- The rule says nothing about the model driving the session parent; `.pi/agents/README.md` recommends the review family differ from it too.
