import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR = join(ROOT, "vendor", "mattpocock-skills");
const MANIFEST = join(VENDOR, ".claude-plugin", "plugin.json");
const LOCK = join(ROOT, "skills-lock.json");

function repoRel(path: string): string {
	return relative(ROOT, path).split("\\").join("/");
}

function field(frontmatter: string, name: string): string | undefined {
	const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
	if (!m) return undefined;
	let value = m[1].trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1).replace(/\\(["'])/g, "$1");
	}
	return value;
}

function readSkill(path: string): { name: string; description: string; userInvoked: boolean; raw: string } {
	const raw = readFileSync(path, "utf8");
	const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, `no frontmatter in ${repoRel(path)}`);
	const name = field(frontmatter, "name");
	const description = field(frontmatter, "description");
	assert.ok(name, `missing name in ${repoRel(path)}`);
	assert.ok(description, `missing description in ${repoRel(path)}`);
	return { name, description, userInvoked: field(frontmatter, "disable-model-invocation") === "true", raw };
}

const promotedDirs: string[] = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { skills: string[] }).skills.map((entry) =>
	entry.replace(/^\.\//, ""),
);

test("the promoted manifest matches the vendored tree with valid pi frontmatter", () => {
	assert.ok(promotedDirs.length >= 20, `promoted manifest looks truncated: ${promotedDirs.length}`);
	const seen = new Set<string>();
	for (const dir of promotedDirs) {
		const skillMd = join(VENDOR, dir, "SKILL.md");
		assert.equal(existsSync(skillMd), true, `promoted skill missing SKILL.md: ${dir}`);
		const skill = readSkill(skillMd);
		assert.equal(skill.name, basename(dir), `frontmatter name must equal the directory name: ${dir}`);
		assert.match(skill.name, /^[a-z0-9][a-z0-9-]*$/, `name violates pi's skill-name rules: ${skill.name}`);
		assert.ok(skill.description.length > 0);
		assert.ok(skill.description.length <= 1024, `description exceeds pi's 1024-char limit: ${skill.name}`);
		if (seen.has(skill.name)) assert.fail(`duplicate promoted name: ${skill.name}`);
		seen.add(skill.name);
	}
});

test("user-invoked skills all declare disable-model-invocation: true", () => {
	for (const dir of promotedDirs) {
		const skill = readSkill(join(VENDOR, dir, "SKILL.md"));
		if (skill.userInvoked) {
			assert.match(skill.raw, /disable-model-invocation:\s*true/, `${skill.name} classified user-invoked without the flag`);
		}
	}
});

test("cross-skill 'Call the Skill tool' targets exist and are model-invoked", () => {
	const skills = promotedDirs.map((dir) => readSkill(join(VENDOR, dir, "SKILL.md")));
	const byName = new Map(skills.map((s) => [s.name, s]));
	const userNames = new Set(skills.filter((s) => s.userInvoked).map((s) => s.name));
	const calls = new Set<string>();

	for (const dir of promotedDirs) {
		for (const file of markdownUnder(join(VENDOR, dir))) {
			for (const line of file.split("\n")) {
				if (!line.includes("Call the Skill tool")) continue;
				for (const m of line.matchAll(/"([a-z0-9-]+)"/g)) calls.add(m[1]);
			}
		}
	}

	assert.ok(calls.size >= 3, `expected cross-skill calls, found: ${[...calls].join(", ")}`);
	for (const call of calls) {
		assert.ok(byName.has(call), `cross-skill call to unknown skill: ${call}`);
		assert.equal(userNames.has(call), false, `skill ${call} is user-invoked: invocation.md forbids skills calling it`);
	}
});

test("skills-lock.json records the promoted set with fresh hashes", () => {
	const lock = JSON.parse(readFileSync(LOCK, "utf8")) as {
		skills: Record<string, { skillFile: string; computedHash: string; modelInvoked: boolean }>;
	};
	assert.equal(Object.keys(lock.skills).length, promotedDirs.length, "lock/manifest count mismatch");
	for (const dir of promotedDirs) {
		const skillMd = join(VENDOR, dir, "SKILL.md");
		const skill = readSkill(skillMd);
		const locked = lock.skills[skill.name];
		assert.ok(locked, `lock missing promoted skill: ${skill.name}`);
		const hash = createHash("sha256").update(readFileSync(skillMd, "utf8")).digest("hex");
		assert.equal(locked.computedHash, hash, `stale hash for ${skill.name} — run npm run sync:skills`);
		assert.equal(locked.skillFile, repoRel(skillMd), `lock path drift for ${skill.name}`);
		assert.equal(locked.modelInvoked, !skill.userInvoked, `lock invocation class drift for ${skill.name}`);
	}
});

function markdownUnder(root: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) out.push(...markdownUnder(path));
		else if (name.endsWith(".md")) out.push(readFileSync(path, "utf8"));
	}
	return out;
}