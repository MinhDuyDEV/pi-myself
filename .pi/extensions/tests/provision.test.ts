import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveRepoRoot } from "../lib/repo-root.js";
import provisionExtension from "../provision.js";

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

test("provision registers /setup-pi-myself and never checks the provisioned copies at session start", () => {
	const events: string[] = [];
	const commands: string[] = [];
	const pi = { on: (event: string) => events.push(event), registerCommand: (name: string) => commands.push(name) };
	provisionExtension(pi as unknown as ExtensionAPI);
	assert.deepEqual(commands, ["setup-pi-myself"]);
	assert.deepEqual(events, [], "agents and APPEND_SYSTEM.md are the project's to edit — no warning hook of any kind");
});
