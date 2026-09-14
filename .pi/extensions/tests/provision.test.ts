import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { packageRoot, resolveRepoRoot } from "../lib/repo-root.js";
import { provisionDrift } from "../provision.js";

const PKG = resolve(import.meta.dirname, "..", "..", "..");

test("packageRoot resolves the pi-myself package from an extension file URL in both layouts", () => {
	const fromTopLevel = packageRoot(new URL("../provision.ts", import.meta.url).href);
	const fromSubdir = packageRoot(new URL("../tracker/index.ts", import.meta.url).href);
	assert.equal(fromTopLevel, PKG);
	assert.equal(fromSubdir, PKG);
});

test("resolveRepoRoot returns the git top-level from a nested cwd, else the cwd itself", () => {
	const repo = mkdtempSync(join(tmpdir(), "repo-root-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const nested = join(repo, "src", "deep");
		mkdirSync(nested, { recursive: true });
		// git prints the real path; macOS tmpdir is a symlink (/var → /private/var)
		assert.equal(realpathSync(resolveRepoRoot(nested)), realpathSync(repo));
		const plain = mkdtempSync(join(tmpdir(), "no-git-"));
		assert.equal(realpathSync(resolveRepoRoot(plain)), realpathSync(plain));
		rmSync(plain, { recursive: true, force: true });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("provisionDrift: no drift in the checkout, missing/stale in a consumer, current after setup-project", () => {
	assert.deepEqual(provisionDrift(PKG, PKG), { missing: [], stale: [] }, "checkout layout is never out of date with itself");

	const project = mkdtempSync(join(tmpdir(), "consumer-"));
	try {
		const before = provisionDrift(PKG, project);
		assert.ok(before.missing.includes("APPEND_SYSTEM.md"));
		assert.ok(before.missing.includes("agents/general.md"));
		assert.deepEqual(before.stale, []);

		execFileSync(process.execPath, [join(PKG, "scripts", "setup-project.mjs"), project]);
		assert.deepEqual(provisionDrift(PKG, project), { missing: [], stale: [] }, "setup-project makes it current");

		const probe = join(project, ".pi", "agents", "reviewer.md");
		writeFileSync(probe, `${readFileSync(probe, "utf8")}\nlocal edit\n`);
		assert.deepEqual(provisionDrift(PKG, project).stale, ["agents/reviewer.md"]);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});
