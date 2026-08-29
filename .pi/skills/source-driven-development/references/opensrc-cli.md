# OpenSrc CLI Reference

Use OpenSrc only when installed dependency files and official web/source retrieval cannot answer a focused implementation question.

Official source: <https://github.com/vercel-labs/opensrc/tree/main/packages/opensrc>

## Safety

- Check `command -v opensrc` first. Do not install it or run an unpinned `npx` package without user approval.
- `opensrc path` and `opensrc fetch` may use the network and write a global cache; obtain approval when that is an external side effect.
- `opensrc remove` and `opensrc clean` delete cache entries. Never run them without explicit confirmation.
- Match the project lockfile version or specify one; never silently inspect `latest` for a version-specific claim.

## Current Commands

```bash
# Print the absolute source path, fetching on cache miss
opensrc path zod
opensrc path zod@3.22.0
opensrc path pypi:requests
opensrc path crates:serde
opensrc path vercel/next.js

# Pre-fetch without printing paths
opensrc fetch zod pypi:requests crates:serde

# Inspect cache metadata
opensrc list
opensrc list --json

# Destructive: require explicit confirmation first
opensrc remove zod        # `rm` is an alias
opensrc clean             # all cached source
opensrc clean --packages  # or --repos, --npm, --pypi, --crates
```

Supported specs include npm (default or `npm:`), PyPI (`pypi:`, `pip:`, `python:`), crates.io (`crates:`, `cargo:`, `rust:`), GitHub (`owner/repo`), GitLab (`gitlab:owner/repo`), and Bitbucket (`bitbucket:owner/repo`).

OpenSrc caches source under `~/.opensrc/`; `OPENSRC_HOME` overrides that location. It auto-detects installed npm versions from project lockfiles when possible. Use `--cwd <project-root>` whenever the current directory is not the target project's root.

## Investigation Pattern

1. State one question and expected distinguishing evidence.
2. Capture the resolved path and exact version.
3. Locate the public entry point with `rg -n`; follow only the relevant call graph.
4. Read implementation, tests, examples, and changelog/history for that behavior.
5. Confirm with a tiny local test before relying on the finding.
6. Cite package version and `path:line`; label unresolved assumptions.
