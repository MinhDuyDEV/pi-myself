# ADR 0009: Models are picked per role, and only the `reviewer` must differ in family from the reason tier

Decided 2026-09-27 (user decision). Supersedes decisions 2 and 3 of ADR 0006 ("one model per tier"; "the review tier runs a different model family from the reason tier"). Its decision 1 — three tiers, the review tier always `readonly: true` — stands.

## Context

ADR 0006 made choosing a model mechanical: one model per tier, and the whole review tier on a family the reason tier does not use. Once the roles moved to a provider with a wider model menu, both rules cost more than they bought:

- **A tier holds workloads of different depth.** In the reason tier, `general` executes one ticket at a time and runs most often, while `designer` and `ultra-verifier` make the judgement calls a cheap model gets wrong. In the read tier, `explore`'s mapping needs less than `scout`'s research. One model per tier forces the expensive model onto the workhorse or the cheap model onto the judgement roles.
- **The family rule bound `ultra-scout` too.** `/skill:ultra-review` runs ten identical scouts. On the reviewer's family they spend the Codex quota the session parent falls back to, the one budget the harness can least afford to drain.

What the family rule actually protects is the merge gate. The workflow policy requires a clean `reviewer` before any merge-ready claim, and `code-review` runs both of its axes on that role. `ultra-review` is an opt-in sweep whose every finding the `ultra-verifier` dispositions; it never gates a merge.

## Decision

1. **A tier may run several models.** Each role's `model:` and `thinking:` lines are picked for that role's workload. The tier still fixes what a role may do: the read tier never changes code, the review tier never writes.
2. **The `reviewer` runs a model family different from every reason-tier role's.** Any reason role may have authored what the reviewer judges, so sharing a family with any one of them shares its blind spots. `tests/agents.test.ts` and the doctor (`/setup-pi-myself --check`) both compare the `reviewer` with each reason-tier role; the family is the leading letters of the model name's last segment (`deepseek` in `vector/ocg/deepseek-v4.1-flash`).
3. **`ultra-scout` and the read tier are not compared.** They may share a family with the reason tier.

## Considered options

- **Keep one model per tier and raise the reason tier to the strong model.** Rejected: `general` runs most often, so the whole reason-tier bill moves to the most expensive model to serve the two roles that need it.
- **Keep the family rule on the whole review tier.** Rejected: it puts ten scouts on the fallback's quota, to protect a sweep that is not the gate.

## Consequences

- Picking a model is a per-role judgement now. The family rule is the one invariant the tests hold, and changing any reason-tier model means checking the `reviewer` against it.
- A blind spot `general` shares with the scouts' family can pass an ultra-review unreported. The `reviewer`, on another family, is what still stands between it and a merge; an ultra-review is extra coverage, never a substitute for that gate.
- The session parent's model is still outside the rule. `.pi/agents/README.md` recommends the `reviewer` differ from it too.
- ADR 0005's caveat carries over: a consuming repository that sets `model` can break the rule, and the doctor reports it there.
