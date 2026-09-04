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

// Subdirectory taxonomy: pi loads only top-level *.ts plus <subdir>/index.ts,
// so subdirs are either full extensions (have index.ts: dcp, skill-tool,
// tracker) or support code for a wrapper file beside them — deliberately
// WITHOUT index.ts, which pi would load as a second extension. Pin the support
// list so a new non-index subdir is a conscious decision; stray test files at
// the top level are covered by the guard above.
const SUPPORT_DIRS = new Set<string>([]);

test("extension subdirectory layout stays known", () => {
	const offenders: string[] = [];
	for (const name of readdirSync(EXTENSIONS)) {
		const path = join(EXTENSIONS, name);
		if (!statSync(path).isDirectory() || name === "node_modules" || name === "tests") continue;
		if (readdirSync(path).includes("index.ts")) continue;
		if (SUPPORT_DIRS.has(name)) continue;
		offenders.push(name);
	}
	assert.deepEqual(offenders, []);
});