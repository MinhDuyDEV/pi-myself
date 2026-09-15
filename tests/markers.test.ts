import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { test } from "node:test";

// Release gates on TODO markers (semantics in AGENTS.md):
// no `FIXME:` anywhere in tracked source; `TAG: note` comment form elsewhere.
// Files come from `git ls-files`, never a walk of the working tree: untracked
// scratch, editor state, and local tool config cannot fail the gate, and a
// tracked file deleted but not yet `git rm`-ed is gone, not a crash.

const ROOT = resolve(import.meta.dirname, "..");
const SCAN_DIRS = [".pi/extensions", ".pi/skills", ".pi/prompts", "scripts", "tests"];
const TEXT_EXTS = new Set([".ts", ".mjs", ".md", ".json", ".sh"]);
const SELF = relative(ROOT, resolve(import.meta.filename)); // this file names the marker by necessity

test("no FIXME marker in tracked source", () => {
	const tracked = execFileSync("git", ["ls-files", "--", ...SCAN_DIRS], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter((file) => file && file !== SELF && TEXT_EXTS.has(extname(file)) && existsSync(join(ROOT, file)));
	assert.ok(tracked.length > 0, "git ls-files returned nothing to scan");
	const offenders: string[] = [];
	for (const file of tracked) {
		readFileSync(join(ROOT, file), "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (/FIXME[:\s]/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 80)}`);
			});
	}
	assert.deepEqual(offenders, []);
});
