import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveRepoRoot } from "../lib/repo-root.js";
import provisionExtension, { SETUP_TIMEOUT_MS, setupReport } from "../provision.js";

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
	assert.deepEqual(events, [], "rerunning the command is the update path — no session-start check of the provisioned copies");
});

test("/setup-pi-myself reports why the script did not finish instead of an empty failure", () => {
	const base = { stdout: "", stderr: "", signal: null, status: null, error: undefined };
	const timedOut = setupReport({
		...base,
		stdout: "created  agents/explore.md\n",
		error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
	});
	assert.equal(timedOut.type, "error");
	assert.match(timedOut.message, new RegExp(`timed out after ${SETUP_TIMEOUT_MS / 1000}s`));
	assert.match(timedOut.message, /created {2}agents\/explore\.md/, "what it did before stopping is still shown");

	const missing = setupReport({ ...base, error: Object.assign(new Error("spawnSync node ENOENT"), { code: "ENOENT" }) });
	assert.match(missing.message, /could not run \(spawnSync node ENOENT\)/);

	const killed = setupReport({ ...base, signal: "SIGKILL" });
	assert.match(killed.message, /failed \(killed by SIGKILL\)/);
	assert.match(setupReport({ ...base, status: 1, stderr: "boom" }).message, /failed \(exit 1\):\nboom/);
});

test("a successful run names the companions the roles depend on", () => {
	const ok = setupReport({ stdout: "setup-project: 7 created\n", stderr: "", signal: null, status: 0, error: undefined });
	assert.equal(ok.type, "info");
	assert.match(ok.message, /setup-project: 7 created/);
	assert.match(ok.message, /pi install npm:@heyhuynhgiabuu\/pi-task/, "the roles are dead without the task tool");
	assert.match(ok.message, /\/skill:setup-matt-pocock-skills/);
});
