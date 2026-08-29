import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// pi auto-loads every top-level .ts file under .pi/extensions/ as an extension.
// Test files must live in a subdirectory without an index.ts (tests/) or beside
// their owner *inside* an extension dir (e.g. skill-tool/), never at the top
// level — this guard keeps a stray test from breaking every pi startup.

const ROOT = resolve(import.meta.dirname, "..");
const EXTENSIONS = join(ROOT, ".pi", "extensions");

test("no test files at the extension top level (pi would load them as extensions)", () => {
	const offenders = readdirSync(EXTENSIONS).filter((name) => /\.(test|spec)\.ts$|\.test\.mjs$/.test(name));
	assert.deepEqual(offenders, []);
});

test("every one-level extension subdirectory without index.ts holds no loadable .ts", () => {
	const offenders: string[] = [];
	for (const name of readdirSync(EXTENSIONS)) {
		const path = join(EXTENSIONS, name);
		if (!statSync(path).isDirectory() || name === "node_modules" || name === "tests") continue;
		const entries = readdirSync(path);
		if (entries.includes("index.ts")) continue;
		for (const entry of entries) {
			if (/\.ts$/.test(entry)) offenders.push(`${name}/${entry}`);
		}
	}
	assert.deepEqual(offenders, []);
});