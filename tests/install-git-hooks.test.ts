import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The guardrail installer: what it writes, that it is idempotent, and that it
// never destroys a hook the project wrote itself.

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, ".pi", "skills", "commit-guardrails", "install-git-hooks.mjs");

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-myself-hooks-"));
	mkdirSync(join(root, ".git", "hooks"), { recursive: true });
	return root;
}

/** Run the installer; a non-zero exit is a result, not a crash. */
function run(root: string, ...args: string[]): { status: number; stdout: string } {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout };
	} catch (error) {
		const failed = error as { status?: number; stdout?: string };
		return { status: failed.status ?? 1, stdout: failed.stdout ?? "" };
	}
}

const hook = (root: string, name: string) => readFileSync(join(root, ".git", "hooks", name), "utf8");

test("installs a pre-commit hook that runs the staged check", () => {
	const root = makeRoot();
	const result = run(root);
	assert.equal(result.status, 0);
	const content = hook(root, "pre-commit");
	assert.match(content, /biome check --staged/, "the default command is portable: it needs no npm script in the host repo");
	assert.match(content, /pi-myself:/, "the marker is what makes the hook ours to refresh");
	assert.equal(run(root, "--check").status, 0, "an installed hook passes --check");
});

test("--command bakes the repo's own gate into the hook", () => {
	const root = makeRoot();
	run(root, "--command", "npm test");
	assert.match(hook(root, "pre-commit"), /exec npm test/);
	// The check compares against what this command would write, so a hook
	// installed with another command is stale, not silently accepted.
	assert.equal(run(root, "--check").status, 1);
	assert.equal(run(root, "--command", "npm test", "--check").status, 0);
});

test("is idempotent and never backs up its own hook", () => {
	const root = makeRoot();
	run(root);
	const first = hook(root, "pre-commit");
	const second = run(root);
	assert.equal(second.status, 0);
	assert.match(second.stdout, /unchanged/, "a second run reports the hook as unchanged");
	assert.equal(hook(root, "pre-commit"), first);
	assert.equal(existsSync(join(root, ".git", "hooks", "pre-commit.local")), false, "our own hook is not backed up");
});

test("keeps a hook pi-myself did not write, beside the installed one", () => {
	const root = makeRoot();
	const foreign = "#!/bin/sh\necho project hook\n";
	writeFileSync(join(root, ".git", "hooks", "pre-commit"), foreign);
	run(root);
	assert.equal(readFileSync(join(root, ".git", "hooks", "pre-commit.local"), "utf8"), foreign);
	assert.match(hook(root, "pre-commit"), /biome check --staged/);
});

test("adds the session trailer hook only when asked", () => {
	const root = makeRoot();
	run(root);
	assert.equal(existsSync(join(root, ".git", "hooks", "prepare-commit-msg")), false);
	run(root, "--trailer");
	const trailer = hook(root, "prepare-commit-msg");
	assert.match(trailer, /PI_SESSION_ID/, "the trailer reads the id pi exports to bash");
	assert.match(trailer, /Pi-Session: /);
});

test("--check reports a missing hook and writes nothing", () => {
	const root = makeRoot();
	const result = run(root, "--check");
	assert.equal(result.status, 1, "a fresh checkout fails the check, which is what CI would want");
	assert.equal(existsSync(join(root, ".git", "hooks", "pre-commit")), false);
});
