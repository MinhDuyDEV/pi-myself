import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { test } from "node:test";

// Release gates on TODO markers (semantics in AGENTS.md):
// no `FIXME:` anywhere in tracked source; `TAG: note` comment form elsewhere.

const ROOT = resolve(import.meta.dirname, "..");
const SCAN_DIRS = [".pi/extensions", ".pi/skills", ".pi/prompts", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const TEXT_EXTS = new Set([".ts", ".mjs", ".md", ".json", ".sh"]);

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...filesUnder(path));
		else if (TEXT_EXTS.has(extname(path))) out.push(path);
	}
	return out;
}

test("no FIXME marker in tracked source", () => {
	const offenders: string[] = [];
	for (const dir of SCAN_DIRS) {
		for (const path of filesUnder(resolve(ROOT, dir))) {
			if (path === resolve(import.meta.filename)) continue; // this file names FIXME by necessity
			const text = readFileSync(path, "utf8");
			const lines = text.split("\n");
			lines.forEach((line, index) => {
				if (/FIXME[:\s]/.test(line)) offenders.push(`${path.slice(ROOT.length + 1)}:${index + 1}: ${line.trim().slice(0, 80)}`);
			});
		}
	}
	assert.deepEqual(offenders, []);
});