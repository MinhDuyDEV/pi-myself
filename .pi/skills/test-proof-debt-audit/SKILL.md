---
name: test-proof-debt-audit
description: Use when a specific behavioral claim and its cited proof route (test, validator, benchmark, or gate) must be audited for proof debt; not for ordinary implementation, failing tests, weak coverage, or the presence of mocks.
disable-model-invocation: true
---

# Test Proof Debt Audit

Audit one claim and one proof route: the specific test, validator, benchmark, or
gate the user cites, plus the production code path that supposedly makes the
claim true. Report what the proof actually observes and whether it would survive
the claimed behavior disappearing.

## Audit steps

Each step is done only when its completion criterion is met.

1. **Name the claim** and the production behavior that makes it true.
   - Done when: the claim is one falsifiable statement naming the exact
     production code path that should make it true.
2. **Identify the cited proof**.
   - Done when: you can state what the proof observes — behavior,
     machine-readable contract, performance, or proxy text/metadata.
3. **Apply deletion sensitivity**: would the proof still pass if the claimed
   behavior disappeared?
   - Done when: you have a concrete answer (yes → proof debt; no → proof
     observes the behavior).
4. **Check independent truth**: do expected values come from the current
   contract, spec, or oracle — not from the code under test or repository
   history?
   - Done when: every expected value is traced to its source and classified as
     independent or history-derived.
5. **Choose a disposition** from the table below.
6. **Pressure-test the disposition** before finalizing: delete the claimed
   behavior and run the proof; remove the expected value and check it still
   passes; derive the expected value from the current contract instead of
   history; substitute a different input and see whether the proof
   distinguishes it. A disposition that does not survive these probes is not
   final.
   - Done when: the disposition survives its counter-probe or is revised.

## Dispositions

| Disposition | Meaning |
| --- | --- |
| `keep` | Proof observes behavior with independent expected values. |
| `replace` | Proof is derivable from the current contract; swap in a current-boundary case. |
| `demote` | Evidence only for lint or closeout, not runtime behavior. |
| `closeout-only` | Record for a completed change; never a current gate. |
| `delete` | History-only expected values or dead proof with no current use. |
| `escalate` | Proof debt hides a real behavioral gap; name the owning decision. |

## Gates

- **History-only expected values are proof debt.** A current test must not name
  or pin a retired width, tag, field, version, byte sequence, or identifier
  merely to prove its rejection. Ask whether the test can be derived from the
  current contract without repository history; if not, `replace` it with
  current-boundary cases, `demote` it to closeout-only evidence, or `delete`
  it — unless the historical value is itself a current public
  machine/security contract.
- **Proxy evidence** can support lint or closeout but cannot prove runtime
  behavior. Mocks and replicas prove only their own boundary unless the claim
  is explicitly about that boundary.
- **Weak proof does not authorize an architecture redesign.** Report the gap
  and the smallest proof that would cover it; change production code only when
  asked.
- **Assessment only**: report and stop. Modify proof or production code only
  when the user requests the change.

## Report

State: location, claimed behavior, actual observation, disconfirming scenario,
and smallest replacement.

For batch bug hunting across a branch or diff, run `/skill:ultra-review`; this skill
audits one named claim and its proof route.