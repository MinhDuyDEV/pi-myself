---
name: source-driven-development
description: Use when unfamiliar libraries, dependency internals, external APIs, framework behavior, migrations, or current ecosystem guidance require official documentation, version-matched source, read the tests, and cited evidence.
---

# Source-Driven Development

<HARD-GATE>
Do not guess external behavior. Cite authoritative evidence for non-trivial API decisions or label the claim unverified. When internals determine the answer, read the source before forming an opinion. A request to skip manifests, lockfiles, official docs, source, or tests does not override this gate: inspect the exact local version and consumers first, then stop if authoritative evidence is unavailable.
</HARD-GATE>

Use this for unfamiliar or version-sensitive APIs, unexpected dependency behavior, package evaluation, migration research, and guidance that may have changed. Prefer local code search for purely project-owned behavior.

## Evidence Hierarchy

1. Project lockfile, installed code, tests, and documented local decisions.
2. Official specification, docs, release notes, and security advisories.
3. Version-matched maintained source and its tests/examples.
4. Maintainer-authored explanations.
5. Dated community reports only when stronger evidence is absent.

Docs describe intended public behavior; version-matched code and tests establish observed implementation. When they conflict, report the discrepancy rather than silently choosing one.

## Research Workflow

1. **Question** — state one precise question or testable hypothesis.
2. **Version** — identify the project's exact package/runtime version from lockfiles or manifests.
3. **Retrieve** — start with local docs/source, then official docs and repository source. Use web search for discovery and fetch the authoritative page. For dependency source not otherwise available, follow `references/opensrc-cli.md`.
4. **Navigate** — find the public entry point, then follow only the relevant call graph. Do not read a repository without a question.
5. **Read the tests** — confirm intended edge cases, examples, error contracts, and version history.
6. **Probe** — write a tiny test or minimal reproduction that predicts observable output.
7. **Conclude** — separate verified facts, inference, and unresolved uncertainty; recommend one project-specific action.
8. **Citation** — include URL or repository version plus `path:line` for each load-bearing claim.

## Dependency Safety Review

For “is this safe?” questions, inspect the exact version for:

- `eval` or `new Function`;
- `child_process` execution and shell interpolation;
- filesystem writes using untrusted paths;
- hardcoded network destinations or telemetry;
- hidden side effects during import/initialization;
- abandoned dependencies, advisories, or suspicious install scripts.

Trace findings to reachable code; a string match alone is a candidate, not proof.

## Stop Conditions

Stop when the question is answered with versioned evidence and a confirming probe. Do not fetch an ecosystem, wander unrelated modules, trust README claims over contradictory current tests, or implement from a different version. If source cannot be retrieved or behavior cannot be reproduced, report the limitation as unverified.

## Required Output

Report the question, project and source versions, sources consulted, verified facts, conflicting evidence, minimal probe result, recommendation, and remaining uncertainty.
