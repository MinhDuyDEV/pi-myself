import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const PROMPTS = join(ROOT, ".pi", "prompts");
const PROMPTS_WE_WRITE = new Set(["verify.md", "init.md"]);
// /fix was dropped 2026-09-14: it re-narrated diagnosing-bugs + tdd + codebase-design.
const DROPPED_PROCESS_RE = /\/create|\/plan\b|\/ship\b|\/fix\b/;

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
		assert.doesNotMatch(content, /\.pi\/MEMORY\.md/, `${file} references the retired .pi/MEMORY.md memory file (memory lives in pi-workspace-memory now)`);
		assert.doesNotMatch(content, DROPPED_PROCESS_RE, `${file} routes to a dropped prompt (/create, /plan, /ship, /fix)`);
	}
});

test("/verify drives the tracker tool instead of hand-editing tickets or shelling out to gh", () => {
	const content = readFileSync(join(PROMPTS, "verify.md"), "utf8");
	for (const op of ["show", "tick", "comment", "status"]) {
		assert.match(content, new RegExp(`tracker ${op}\\b|gh-${op}\\b`), `verify.md must record through the tracker op '${op}'`);
	}
	assert.doesNotMatch(content, /gh issue (view|comment|edit)/, "verify.md must not bypass the tracker tool with raw gh commands");
	assert.doesNotMatch(content, /--test\b|--review\b/, "verify.md must not re-narrate tdd / code-review behind flags");
});

test("/init writes both durable context files and protects the setup skill's block", () => {
	const content = readFileSync(join(PROMPTS, "init.md"), "utf8");
	assert.match(content, /PROJECT\.md/, "init.md must know the repository map file");
	assert.match(content, /## Agent skills/, "init.md must preserve the block setup-matt-pocock-skills writes");
	assert.match(content, /`explore` task/, "init.md delegates discovery to the explore role");
});

test("no generated wrappers remain: user-invoked skills run via pi's native /skill: commands", () => {
	const offenders = readdirSync(PROMPTS).filter((file) =>
		readFileSync(join(PROMPTS, file), "utf8").includes("AUTO-GENERATED"),
	);
	assert.deepEqual(offenders, [], "AUTO-GENERATED prompt wrappers are gone — pi's /skill:<name> is the single invocation surface");
});