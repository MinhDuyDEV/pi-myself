import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Hygiene gates for OUR skills (.pi/skills) only — the vendored upstream tree
// is governed upstream and never asserted against our conventions here.

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = resolve(ROOT, ".pi", "skills");

const ALLOWED_PREFIXES = [
	"Use when ",
	"Use before ",
	"Use after ",
	"Use INSTEAD OF ",
	"Use during ",
	"Use this skill when ",
	"Use when working with ",
	"ALWAYS ",
	"MUST ",
	"Don't use ",
	"Don't ",
];

const SHADOWED_BY_UPSTREAM = [
	"grilling",
	"test-driven-development",
	"improve-codebase-architecture",
	"code-review",
	"planning-and-task-breakdown",
	"development-lifecycle",
	"documentation-and-adrs",
	"code-review-and-quality",
	"debugging-and-error-recovery",
];

function frontmatterField(frontmatter: string, name: string): string | undefined {
	const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
	if (!m) return undefined;
	let value = m[1].trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1).replace(/\\(["'])/g, "$1");
	}
	return value;
}

function mustFrontmatter(raw: string, label: string): string {
	const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
	if (!frontmatter) throw new Error(`no frontmatter in ${label}`);
	return frontmatter;
}

const skills = readdirSync(SKILLS)
	.filter((entry) => statSync(join(SKILLS, entry)).isDirectory())
	.sort()
	.map((dir) => {
		const skillMd = join(SKILLS, dir, "SKILL.md");
		const raw = readFileSync(skillMd, "utf8");
		const frontmatter = mustFrontmatter(raw, `.pi/skills/${dir}/SKILL.md`);
		return { dir, skillMd, raw, frontmatter };
	});

test("every local skill directory is discoverable by pi", () => {
	assert.ok(skills.length >= 5, "the local skill set looks empty");
	for (const skill of skills) {
		assert.ok(skill.frontmatter, `no frontmatter in .pi/skills/${skill.dir}/SKILL.md`);
		const name = frontmatterField(skill.frontmatter, "name");
		assert.equal(name, skill.dir, `frontmatter name must equal the directory: ${skill.dir}`);
		assert.match(name, /^[a-z0-9][a-z0-9-]*$/, `name violates pi's skill-name rules: ${name}`);
		const description = frontmatterField(skill.frontmatter, "description");
		assert.ok(description, `empty description: ${skill.dir}`);
		assert.ok(description.length <= 500, `description for ${skill.dir} is ${description.length} chars (limit 500)`);
	}
});

test("local skill descriptions are routing-shaped and impersonal", () => {
	const offenders: string[] = [];
	for (const skill of skills) {
		const description = frontmatterField(skill.frontmatter, "description") ?? ""; // empties are reported by the discoverability test
		if (!ALLOWED_PREFIXES.some((p) => description.startsWith(p)))
			offenders.push(`.pi/skills/${skill.dir}: description must start with a routing prefix (Use when… / ALWAYS…)`);
		if (/\b(I|we|I'|I'll|we're|we've|we'll)\b/i.test(description))
			offenders.push(`.pi/skills/${skill.dir}: description uses first person`);
	}
	assert.deepEqual(offenders, []);
});

test("the local set stays harness: nothing shadows the vendored process skills", () => {
	for (const skill of skills) {
		assert.equal(
			SHADOWED_BY_UPSTREAM.includes(skill.dir),
			false,
			`.pi/skills/${skill.dir} duplicates a vendored skill — drop it, the vendored one wins`,
		);
	}
});

test("assets and anchors referenced by local skills resolve", () => {
	const offenders: string[] = [];
	for (const skill of skills) {
		for (const m of skill.raw.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1];
			if (/^(https?:|#|mailto:)/.test(target)) continue;
			const [pathPart, anchor] = target.split("#");
			const resolved = resolve(join(SKILLS, skill.dir), pathPart);
			if (!existsSync(resolved)) offenders.push(`.pi/skills/${skill.dir}/SKILL.md → broken link ${target}`);
			else if (anchor && !readFileSync(resolved, "utf8").includes(anchor))
				offenders.push(`.pi/skills/${skill.dir}/SKILL.md → missing anchor ${target}`);
		}
	}
	assert.deepEqual(offenders, []);
});