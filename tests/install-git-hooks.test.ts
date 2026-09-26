import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The guardrail installer: what it writes, that it is idempotent, that the
// project's own hook keeps running, and where it refuses to write at all. Every
// root is a real `git init` repository, because the git paths (worktrees,
// core.hooksPath, symlinked hooks) are where the installer can do damage.

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, ".pi", "skills", "commit-guardrails", "install-git-hooks.mjs");
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_NOSYSTEM: "1",
	HOME: tmpdir(),
};

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A fresh repository; `biome: true` fakes an installed Biome so the default command is allowed. */
function makeRoot({ biome = false } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "pi-myself-hooks-"));
	git(root, "init", "-q");
	if (biome) {
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", ".bin", "biome"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(root, "node_modules", ".bin", "biome"), 0o755);
	}
	return root;
}

/** Run the installer; a non-zero exit is a result, not a crash. */
function run(root: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env: GIT_ENV });
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const hookPath = (root: string, name: string) => join(root, ".git", "hooks", name);
const hook = (root: string, name: string) => readFileSync(hookPath(root, name), "utf8");

/** Commit one new file with a message; returns git's exit status (non-zero = a hook blocked it). */
function commit(root: string): number {
	writeFileSync(join(root, `f${Date.now()}${Math.random()}`), "x\n");
	git(root, "add", "-A");
	return spawnSync("git", ["-C", root, "commit", "-q", "-m", "c"], { env: GIT_ENV }).status ?? 1;
}

test("installs a pre-commit hook that runs the staged check", () => {
	const root = makeRoot({ biome: true });
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	const content = hook(root, "pre-commit");
	assert.match(content, /biome check --staged/, "with Biome installed, the default needs no npm script in the host repo");
	assert.match(content, /pi-myself:/, "the marker is what makes the hook ours to refresh");
	assert.equal(run(root, "--check").status, 0, "an installed hook passes --check");
});

test("without Biome in the repo, the default is refused: npx would fetch an unrelated package and block every commit", () => {
	const root = makeRoot();
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--command/);
	assert.equal(existsSync(hookPath(root, "pre-commit")), false);
	assert.equal(run(root, "--command", "true").status, 0, "a named command needs no Biome");
});

test("--command bakes the repo's own gate into the hook", () => {
	const root = makeRoot({ biome: true });
	run(root, "--command", "npm test");
	assert.match(hook(root, "pre-commit"), /exec npm test/);
	// The check compares against what this command would write, so a hook
	// installed with another command is stale, not silently accepted.
	assert.equal(run(root, "--check").status, 1);
	assert.equal(run(root, "--command", "npm test", "--check").status, 0);
});

test("is idempotent and never backs up its own hook", () => {
	const root = makeRoot({ biome: true });
	run(root);
	const first = hook(root, "pre-commit");
	const second = run(root);
	assert.equal(second.status, 0);
	assert.match(second.stdout, /unchanged/, "a second run reports the hook as unchanged");
	assert.equal(hook(root, "pre-commit"), first);
	assert.equal(existsSync(hookPath(root, "pre-commit.local")), false, "our own hook is not backed up");
});

test("a hook the project wrote keeps running: it moves beside ours and ours runs it first", () => {
	const root = makeRoot();
	assert.equal(commit(root), 0, "a commit passes with no hook at all");
	writeFileSync(hookPath(root, "pre-commit"), "#!/bin/sh\necho 'project check failed' >&2\nexit 1\n");
	chmodSync(hookPath(root, "pre-commit"), 0o755);
	assert.equal(commit(root), 1, "the project's hook blocks this commit before install");

	const installed = run(root, "--command", "true");
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(installed.stdout, /kept\s+pre-commit\.local/);
	assert.match(hook(root, "pre-commit.local"), /project check failed/);
	assert.equal(commit(root), 1, "installing the guardrail must not switch the project's check off");

	writeFileSync(hookPath(root, "pre-commit.local"), "#!/bin/sh\nexit 0\n");
	assert.equal(commit(root), 0, "and the chain passes when the project's check passes");
});

test("a symlinked hook is moved as a link, never written through", () => {
	const root = makeRoot();
	const shared = join(mkdtempSync(join(tmpdir(), "pi-myself-shared-")), "pre-commit");
	writeFileSync(shared, "#!/bin/sh\nexit 0\n");
	chmodSync(shared, 0o755);
	symlinkSync(shared, hookPath(root, "pre-commit"));

	assert.equal(run(root, "--command", "true").status, 0);
	assert.equal(readFileSync(shared, "utf8"), "#!/bin/sh\nexit 0\n", "the link's target is untouched");
	assert.ok(lstatSync(hookPath(root, "pre-commit.local")).isSymbolicLink());
	assert.ok(!lstatSync(hookPath(root, "pre-commit")).isSymbolicLink());
});

test("refuses core.hooksPath inside the work tree: those hooks are the repository's own tracked files", () => {
	const root = makeRoot();
	mkdirSync(join(root, ".husky"));
	writeFileSync(join(root, ".husky", "pre-commit"), "npm test\n");
	git(root, "config", "core.hooksPath", ".husky");
	const result = run(root, "--command", "true");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /core\.hooksPath points inside the work tree/);
	assert.equal(readFileSync(join(root, ".husky", "pre-commit"), "utf8"), "npm test\n");
	assert.equal(existsSync(join(root, ".husky", "pre-commit.local")), false);
});

test("refuses a core.hooksPath outside the repository's git directory: those hooks are shared", () => {
	// A machine-wide hooks folder (git-secrets, gitleaks setups) runs in every
	// repository; writing this repo's command there breaks commits everywhere.
	const shared = mkdtempSync(join(tmpdir(), "pi-myself-global-hooks-"));
	writeFileSync(join(shared, "pre-commit"), "#!/bin/sh\nexit 0\n");
	const globalConfig = join(mkdtempSync(join(tmpdir(), "pi-myself-gitconfig-")), "config");
	writeFileSync(globalConfig, `[core]\n\thooksPath = ${shared}\n`);
	const root = makeRoot();
	const env = { ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig };
	const viaGlobal = spawnSync(process.execPath, [SCRIPT, "--root", root, "--command", "true"], { encoding: "utf8", env });
	assert.equal(viaGlobal.status, 1, viaGlobal.stdout);
	assert.match(viaGlobal.stderr, /core\.hooksPath points outside this repository's git directory/);
	assert.equal(readFileSync(join(shared, "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n", "the shared hook is untouched");
	assert.equal(existsSync(join(shared, "pre-commit.local")), false);

	// the same through the repository's own config, pointing at an absolute path outside it
	const local = makeRoot();
	git(local, "config", "core.hooksPath", shared);
	const viaLocal = run(local, "--command", "true");
	assert.equal(viaLocal.status, 1);
	assert.match(viaLocal.stderr, /outside this repository's git directory/);
});

test("a second foreign hook never overwrites the first one kept as .local", () => {
	const root = makeRoot();
	writeFileSync(hookPath(root, "pre-commit"), "#!/bin/sh\necho first\n");
	chmodSync(hookPath(root, "pre-commit"), 0o755);
	assert.equal(run(root, "--command", "true").status, 0);
	// something replaces our hook with its own
	writeFileSync(hookPath(root, "pre-commit"), "#!/bin/sh\necho second\n");
	const result = run(root, "--command", "true");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pre-commit\.local already holds/);
	assert.match(hook(root, "pre-commit.local"), /echo first/, "the first project hook is kept");
	assert.match(hook(root, "pre-commit"), /echo second/, "and the second is left where it is");
});

test("refuses outside a git work tree instead of inventing .git/hooks", () => {
	const plain = mkdtempSync(join(tmpdir(), "pi-myself-no-git-"));
	const result = run(plain, "--command", "true");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not inside a git work tree/);
	assert.equal(existsSync(join(plain, ".git")), false);
});

test("adds the session trailer hook only when asked, and the trailer survives git commit -v", () => {
	const root = makeRoot();
	run(root, "--command", "true");
	assert.equal(existsSync(hookPath(root, "prepare-commit-msg")), false);
	run(root, "--command", "true", "--trailer");
	const trailer = hook(root, "prepare-commit-msg");
	assert.match(trailer, /PI_SESSION_ID/, "the trailer reads the id pi exports to bash");
	assert.match(trailer, /interpret-trailers/);

	// -v puts a scissors line and the diff in the message file; git cuts below it,
	// so a trailer appended at the end of the file would be lost
	writeFileSync(join(root, "a"), "a\n");
	git(root, "add", "a");
	const status = spawnSync("git", ["-C", root, "commit", "-q", "-v", "-e", "-m", "subject"], {
		env: { ...GIT_ENV, GIT_EDITOR: "true", PI_SESSION_ID: "abc-123" },
	}).status;
	assert.equal(status, 0);
	assert.match(git(root, "log", "-1", "--format=%B"), /^Pi-Session: abc-123$/m);
});

test("--check reports a missing hook and writes nothing", () => {
	const root = makeRoot({ biome: true });
	const result = run(root, "--check");
	assert.equal(result.status, 1, "a fresh checkout fails the check, which is what CI would want");
	assert.equal(existsSync(hookPath(root, "pre-commit")), false);
});
