import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guardExtension, { createGuardExtension } from "../guard.js";

// Two rules prose kept missing get mechanical backing: never write into the
// vendored upstream tree, its lock, or generated runtime state; and never run
// bash without a timeout.

const CHECKOUT = resolve(import.meta.dirname, "..", "..", "..");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Verdict = { block?: boolean; reason?: string } | undefined;

function load(factory: (pi: ExtensionAPI) => void) {
	const handlers = new Map<string, Handler>();
	const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
	factory(pi as unknown as ExtensionAPI);
	const call = async (cwd: string, toolName: string, input: Record<string, unknown>) => {
		const event = { type: "tool_call", toolCallId: "call-1", toolName, input };
		const verdict = (await handlers.get("tool_call")?.(event, { cwd, hasUI: false })) as Verdict;
		return { verdict, input: event.input };
	};
	const write = async (cwd: string, path: string) => (await call(cwd, "write", { path, content: "x" })).verdict;
	const edit = async (cwd: string, path: string) => (await call(cwd, "edit", { path, edits: [{ oldText: "a", newText: "b" }] })).verdict;
	return { call, write, edit };
}

const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway consuming repository: `git init` in a temp dir (on macOS its realpath differs from the tmpdir path). */
function tempRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "guard-repo-"));
	temps.push(repo);
	const init = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
	assert.equal(init.status, 0, init.stderr);
	return repo;
}

test("writing into the vendored upstream tree is blocked and says to go upstream or into the harness layer", async () => {
	const { write, edit } = load(guardExtension);
	for (const path of [
		"vendor/mattpocock-skills/skills/engineering/tdd/SKILL.md",
		"@vendor/mattpocock-skills/README.md",
		join(CHECKOUT, "vendor", "mattpocock-skills", "skills", "x.md"),
		"./.pi/../vendor/mattpocock-skills/y.md",
		pathToFileURL(join(CHECKOUT, "vendor", "mattpocock-skills", "z.md")).href,
	]) {
		const verdict = await write(CHECKOUT, path);
		assert.equal(verdict?.block, true, `write ${path}`);
		assert.match(verdict?.reason ?? "", /vendored upstream/);
		assert.match(verdict?.reason ?? "", /upstream|harness layer/);
		assert.equal((await edit(CHECKOUT, path))?.block, true, `edit ${path}`);
	}
	// From a subdirectory the repository root still anchors the rule.
	assert.equal((await edit(join(CHECKOUT, ".pi", "extensions"), "../../vendor/mattpocock-skills/a.md"))?.block, true);
});

test("editing skills-lock.json is blocked and points at npm run sync:skills", async () => {
	const { edit } = load(guardExtension);
	const verdict = await edit(CHECKOUT, "skills-lock.json");
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /npm run sync:skills/);
});

test("paths that only resemble the protected ones are left alone", async () => {
	const { write } = load(guardExtension);
	for (const path of [
		"vendorx/mattpocock-skills/a.md",
		"vendor/mattpocock-skillsx/a.md",
		"docs/vendor/mattpocock-skills/a.md",
		"skills-lock.json.bak",
		"README.md",
	]) {
		assert.equal(await write(CHECKOUT, path), undefined, path);
	}
});

test("in a consuming repo the vendored tree inside the installed package is protected too", async () => {
	const repo = tempRepo();
	const pkg = mkdtempSync(join(tmpdir(), "guard-pkg-"));
	temps.push(pkg);
	const { write } = load(createGuardExtension(pkg));
	const verdict = await write(repo, join(pkg, "vendor", "mattpocock-skills", "skills", "engineering", "tdd", "SKILL.md"));
	assert.equal(verdict?.block, true);
	assert.match(verdict?.reason ?? "", /vendored upstream/);
	assert.equal((await write(repo, join(pkg, "skills-lock.json")))?.block, true);
	// The consuming repo's own vendor/ tree is protected by the same rule, relative to its root.
	assert.equal((await write(repo, "vendor/mattpocock-skills/a.md"))?.block, true);
	assert.equal(await write(repo, "src/index.ts"), undefined);
});

test("generated runtime state under the repository root is blocked as generated", async () => {
	const repo = tempRepo();
	const { write, edit } = load(guardExtension);
	for (const path of [
		"node_modules/typebox/package.json",
		".pi/node_modules/x/index.js",
		".pi/git/github.com/x/y/README.md",
		".pi/npm/node_modules/z.js",
		".pi/sessions/2026/a.jsonl",
		".pi/task-exits/abc.json",
		".pi/artifacts/out.txt",
		".pi/task-session-history.json",
	]) {
		const verdict = await write(repo, path);
		assert.equal(verdict?.block, true, path);
		assert.match(verdict?.reason ?? "", /generated/, path);
		assert.equal((await edit(repo, path))?.block, true, path);
	}
	// From a subdirectory the repository root still anchors the rule.
	mkdirSync(join(repo, "src"));
	assert.equal((await write(join(repo, "src"), "../.pi/sessions/b.jsonl"))?.block, true);
	// A worktree whose node_modules is a symlink into another checkout: still this repository's node_modules.
	assert.equal((await write(CHECKOUT, "node_modules/typebox/x.js"))?.block, true);
});

test("runtime-state names elsewhere, or nested below the root, are ordinary files", async () => {
	const repo = tempRepo();
	const { write } = load(guardExtension);
	for (const path of [
		"src/node_modules-notes.md",
		"packages/app/.pi/sessions/a.jsonl",
		".pi/sessionsx/a.jsonl",
		".pi/task-session-history.json.bak",
		".pi/extensions/mine.ts",
		".pi/settings.json",
	]) {
		assert.equal(await write(repo, path), undefined, path);
	}
});

test("bash without a timeout gets the 1800-second default; other tools and explicit timeouts are untouched", async () => {
	delete process.env.PI_MYSELF_BASH_TIMEOUT;
	const { call } = load(guardExtension);
	const bare = await call(CHECKOUT, "bash", { command: "npm test" });
	assert.equal(bare.verdict, undefined, "bash is never blocked");
	assert.deepEqual(bare.input, { command: "npm test", timeout: 1800 });
	assert.deepEqual((await call(CHECKOUT, "bash", { command: "sleep 1", timeout: 5 })).input, { command: "sleep 1", timeout: 5 });
	// pi rejects 0 rather than reading it as unlimited; the guard passes it through so the model sees pi's own error.
	assert.deepEqual((await call(CHECKOUT, "bash", { command: "ls", timeout: 0 })).input, { command: "ls", timeout: 0 });
	assert.deepEqual((await call(CHECKOUT, "read", { path: "README.md" })).input, { path: "README.md" });
});

test("PI_MYSELF_BASH_TIMEOUT overrides the default when it is a positive finite number of seconds, read at load", async () => {
	const saved = process.env.PI_MYSELF_BASH_TIMEOUT;
	try {
		process.env.PI_MYSELF_BASH_TIMEOUT = "90";
		const { call } = load(guardExtension);
		process.env.PI_MYSELF_BASH_TIMEOUT = "5";
		assert.equal((await call(CHECKOUT, "bash", { command: "ls" })).input.timeout, 90, "the value at load wins");
		for (const invalid of ["0", "-3", "abc", "Infinity", ""]) {
			process.env.PI_MYSELF_BASH_TIMEOUT = invalid;
			assert.equal(
				(await load(guardExtension).call(CHECKOUT, "bash", { command: "ls" })).input.timeout,
				1800,
				`invalid ${JSON.stringify(invalid)}`,
			);
		}
	} finally {
		if (saved === undefined) delete process.env.PI_MYSELF_BASH_TIMEOUT;
		else process.env.PI_MYSELF_BASH_TIMEOUT = saved;
	}
});

test("a ~/ path is expanded before matching", async () => {
	const home = mkdtempSync(join(tmpdir(), "guard-home-"));
	temps.push(home);
	const pkg = join(home, "pkgs", "pi-myself");
	mkdirSync(pkg, { recursive: true });
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const { write } = load(createGuardExtension(pkg));
		assert.equal((await write(tempRepo(), "~/pkgs/pi-myself/vendor/mattpocock-skills/a.md"))?.block, true);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	}
});
