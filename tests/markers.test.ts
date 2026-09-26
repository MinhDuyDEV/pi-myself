import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

// Release gates on TODO markers (semantics in AGENTS.md):
// no `FIXME:` anywhere in tracked text; `TAG: note` comment form elsewhere.
// Files come from `git ls-files`, never a walk of the working tree: untracked
// scratch, editor state, and local tool config cannot fail the gate, and a
// tracked file deleted but not yet `git rm`-ed is gone, not a crash. Every
// tracked text file counts (scripts in any language, CI YAML, root docs) except
// the vendored upstream tree and the generated lock, which are not ours to mark.
// A marker quoted in backticks is prose about the marker, not a marker.

const ROOT = resolve(import.meta.dirname, "..");
const NOT_OURS = [/^vendor\//, /^skills-lock\.json$/];
const SELF = relative(ROOT, resolve(import.meta.filename)); // this file names the marker by necessity

test("no FIXME marker in tracked text", () => {
	const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter((file) => file && file !== SELF && !NOT_OURS.some((pattern) => pattern.test(file)) && existsSync(join(ROOT, file)));
	assert.ok(tracked.length > 0, "git ls-files returned nothing to scan");
	const offenders: string[] = [];
	for (const file of tracked) {
		const bytes = readFileSync(join(ROOT, file));
		if (bytes.includes(0)) continue; // binary
		bytes
			.toString("utf8")
			.split("\n")
			.forEach((line, index) => {
				if (/(?<!`)FIXME[:\s]/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 80)}`);
			});
	}
	assert.deepEqual(offenders, []);
});
