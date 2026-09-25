import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { gitTopLevel, packageRoot } from "../lib/repo-root.js";

// packageRoot feeds /setup-pi-myself (it locates scripts/setup-project.mjs) and
// the install-layout paths, so it has to resolve in every layout — not only
// where the path happens to be free of spaces.

test("packageRoot resolves the checkout it runs from", () => {
	const entry = join(import.meta.dirname, "..", "tracker", "index.ts");
	assert.equal(packageRoot(pathToFileURL(entry).href), resolve(import.meta.dirname, "..", "..", ".."));
});

test("packageRoot resolves a package installed under a path containing spaces", () => {
	const parent = mkdtempSync(join(tmpdir(), "pkg-root-"));
	const root = join(parent, "my package");
	try {
		mkdirSync(join(root, ".pi", "extensions", "tracker"), { recursive: true });
		writeFileSync(join(root, "package.json"), "{}\n");
		writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "rules\n");
		const entry = join(root, ".pi", "extensions", "tracker", "index.ts");
		writeFileSync(entry, "");
		// `URL.pathname` hands back ".../my%20package/..." and every existsSync
		// probe misses, so the fallback answers `<pkg>/.pi` instead of `<pkg>`.
		assert.equal(packageRoot(pathToFileURL(entry).href), root);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("gitTopLevel resolves the checkout and returns undefined outside one", () => {
	assert.equal(gitTopLevel(import.meta.dirname), resolve(import.meta.dirname, "..", "..", ".."));
	const outside = mkdtempSync(join(tmpdir(), "no-git-"));
	try {
		assert.equal(gitTopLevel(outside), undefined);
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("gitTopLevel treats a hung git as unknown instead of blocking", { skip: process.platform === "win32" }, () => {
	const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
	const script = join(bin, "git");
	const originalPath = process.env.PATH;
	try {
		// A git that never answers: without a bounded spawn this blocks for the
		// whole sleep, so the elapsed-time assertion below is the discriminator.
		writeFileSync(script, "#!/bin/sh\nsleep 5\n");
		chmodSync(script, 0o755);
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

		const started = Date.now();
		assert.equal(gitTopLevel(process.cwd(), 100), undefined);
		assert.ok(Date.now() - started < 2_000, "gitTopLevel must not wait for the hung git");
	} finally {
		process.env.PATH = originalPath;
		rmSync(bin, { recursive: true, force: true });
	}
});

test("gitTopLevel returns undefined when git is not on PATH", () => {
	const originalPath = process.env.PATH;
	try {
		process.env.PATH = "";
		assert.equal(gitTopLevel(process.cwd()), undefined);
	} finally {
		process.env.PATH = originalPath;
	}
});
