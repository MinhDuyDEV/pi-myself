import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
	const here = new URL(".", importMetaUrl).pathname;
	const candidates = [resolve(here, "..", ".."), resolve(here, "..", "..", "..")];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, ".pi", "APPEND_SYSTEM.md")) && existsSync(join(candidate, "package.json"))) return candidate;
	}
	return candidates[0];
}

export function gitTopLevel(cwd: string): string | undefined {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const top = result.stdout.trim();
	return top ? resolve(top) : undefined;
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
	return gitTopLevel(cwd) ?? resolve(cwd);
}
