import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared root resolution for the harness extensions (a support module: no
 * index.ts here, so pi never loads it as an extension).
 *
 * - `packageRoot(importMetaUrl)`: the pi-myself package directory that owns
 *   the calling extension file — valid in the checkout and in every install
 *   layout (project-local git/npm, global, local path).
 * - `resolveRepoRoot(cwd)`: the consuming repository's root — the git
 *   top-level when cwd is inside a git checkout, else cwd. Never the package
 *   root: a package installed under `<repo>/.pi/git/...` must not make the
 *   tracker or provisioning target itself.
 */

export function packageRoot(importMetaUrl: string): string {
	// <pkg>/.pi/extensions/<file>.ts or <pkg>/.pi/extensions/<dir>/index.ts
	// fileURLToPath, not `URL.pathname`: a package installed under a path with a
	// space arrives percent-encoded (`My%20Projects`), every existsSync below
	// then fails, and the fallback returns `<pkg>/.pi` — the wrong root for a
	// subdirectory extension such as tracker/index.ts.
	const here = fileURLToPath(new URL(".", importMetaUrl));
	// A tuple, so the fallback below is a `string` and not `string | undefined`.
	const candidates = [resolve(here, "..", ".."), resolve(here, "..", "..", "..")] as const;
	for (const candidate of candidates) {
		if (existsSync(join(candidate, ".pi", "APPEND_SYSTEM.md")) && existsSync(join(candidate, "package.json"))) return candidate;
	}
	return candidates[0];
}

/** Git discovery runs synchronously on the recall path; a wedged git (an
 * interactive credential prompt, a stalled network mount) must surface as
 * "unknown" instead of blocking every scope:"project" search. */
const GIT_TOP_LEVEL_TIMEOUT_MS = 5_000;

export function gitTopLevel(cwd: string, timeoutMs: number = GIT_TOP_LEVEL_TIMEOUT_MS): string | undefined {
	try {
		const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: timeoutMs });
		// A timeout and an absent git both set `result.error`; from the exit
		// status alone neither is distinguishable from "not a repository". All
		// three mean the same thing here: the root is unknown.
		if (result.error || result.status !== 0) return undefined;
		const top = result.stdout.trim();
		return top ? resolve(top) : undefined;
	} catch {
		return undefined;
	}
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
	return gitTopLevel(cwd) ?? resolve(cwd);
}
