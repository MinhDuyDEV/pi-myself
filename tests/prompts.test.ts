import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const PROMPTS = join(ROOT, ".pi", "prompts");
const PROMPTS_WE_WRITE = new Set(["verify.md", "fix.md", "init.md"]);
const DROPPED_PROCESS_RE = /\/create|\/plan\b|\/ship\b/;

function frontmatterOf(content: string, file: string): string {
	const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(fm, `${file} has frontmatter`);
	return fm;
}

function frontmatterField(frontmatter: string, name: string): string | undefined {
	const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
	if (!m) return undefined;
	let value = m[1].trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1).replace(/\\(["'])/g, "$1");
	}
	return value;
}

function lock(): {
	skills: Record<string, { skillFile: string; computedHash: string; modelInvoked: boolean }>;
} {
	return JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8"));
}

test("hand-written prompts keep the evidence contract and stay off the dropped process", () => {
	for (const file of PROMPTS_WE_WRITE) {
		const path = join(PROMPTS, file);
		assert.equal(existsSync(path), true, `missing hand-written prompt ${file}`);
		const content = readFileSync(path, "utf8");
		const fm = frontmatterOf(content, file);
		assert.ok(frontmatterField(fm, "description"), `${file} needs a description`);
		assert.ok(frontmatterField(fm, "argument-hint"), `${file} needs an argument-hint`);
		assert.match(content, /NOT DECLARED/, `${file} lost the NOT DECLARED ≠ PASS rule`);
		assert.doesNotMatch(content, /\.pi\/artifacts\//, `${file} references the dropped artifacts system`);
		assert.doesNotMatch(content, DROPPED_PROCESS_RE, `${file} routes to a dropped prompt (/create, /plan, /ship)`);
	}
});

test("no generated wrappers remain: user-invoked skills run via pi's native /skill: commands", () => {
	const offenders = readdirSync(PROMPTS).filter((file) =>
		readFileSync(join(PROMPTS, file), "utf8").includes("AUTO-GENERATED"),
	);
	assert.deepEqual(offenders, [], "AUTO-GENERATED prompt wrappers are gone — pi's /skill:<name> is the single invocation surface");
});