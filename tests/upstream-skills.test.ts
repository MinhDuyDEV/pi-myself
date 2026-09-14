import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";

// Parity gates for the vendored tree. Two registered buckets: "promoted"
// (the plugin manifest) and "beta" (every skill under skills/in-progress/,
// which upstream keeps out of the plugin on purpose). Both are registered
// with pi, hashed into the lock, and held to pi's frontmatter rules.

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR = join(ROOT, "vendor", "mattpocock-skills");
const MANIFEST = join(VENDOR, ".claude-plugin", "plugin.json");
const BETA_DIR = join(VENDOR, "skills", "in-progress");
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
const betaDirs: string[] = readdirSync(BETA_DIR)
	.filter((name) => existsSync(join(BETA_DIR, name, "SKILL.md")))
	.sort()
	.map((name) => `skills/in-progress/${name}`);
const registered: Array<{ dir: string; bucket: "promoted" | "beta" }> = [
	...promotedDirs.map((dir) => ({ dir, bucket: "promoted" as const })),
	...betaDirs.map((dir) => ({ dir, bucket: "beta" as const })),
];

test("promoted manifest and in-progress tree are both registered with valid pi frontmatter", () => {
	assert.ok(promotedDirs.length >= 20, `promoted manifest looks truncated: ${promotedDirs.length}`);
	assert.ok(betaDirs.length >= 1, "no beta skills discovered under in-progress/");
	const seen = new Set<string>();
	for (const { dir } of registered) {
		const skillMd = join(VENDOR, dir, "SKILL.md");
		assert.equal(existsSync(skillMd), true, `registered skill missing SKILL.md: ${dir}`);
		const skill = readSkill(skillMd);
		assert.equal(skill.name, basename(dir), `frontmatter name must equal the directory name: ${dir}`);
		assert.match(skill.name, /^[a-z0-9][a-z0-9-]*$/, `name violates pi's skill-name rules: ${skill.name}`);
		assert.ok(skill.description.length > 0);
		assert.ok(skill.description.length <= 1024, `description exceeds pi's 1024-char limit: ${skill.name}`);
		if (seen.has(skill.name)) assert.fail(`duplicate registered name: ${skill.name}`);
		seen.add(skill.name);
	}
});

test("package.json, .pi/settings.json, and the skill tool register the same vendored buckets", () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { pi: { skills: string[] } };
	const settings = JSON.parse(readFileSync(join(ROOT, ".pi", "settings.json"), "utf8")) as { skills: string[] };
	const skillTool = readFileSync(join(ROOT, ".pi", "extensions", "skill-tool", "index.ts"), "utf8");
	for (const bucket of ["engineering", "productivity", "in-progress"]) {
		assert.ok(pkg.pi.skills.includes(`vendor/mattpocock-skills/skills/${bucket}`), `package.json pi.skills lacks ${bucket}`);
		assert.ok(settings.skills.includes(`../vendor/mattpocock-skills/skills/${bucket}`), `.pi/settings.json lacks ${bucket}`);
		assert.match(skillTool, new RegExp(`"${bucket}"`), `skill-tool VENDORED_BUCKETS lacks ${bucket}`);
	}
	for (const unregistered of ["misc", "deprecated"]) {
		assert.ok(!pkg.pi.skills.some((p) => p.endsWith(`/${unregistered}`)), `${unregistered} must stay unregistered`);
	}
});

test("user-invoked skills all declare disable-model-invocation: true", () => {
	for (const { dir } of registered) {
		const skill = readSkill(join(VENDOR, dir, "SKILL.md"));
		if (skill.userInvoked) {
			assert.match(skill.raw, /disable-model-invocation:\s*true/, `${skill.name} classified user-invoked without the flag`);
		}
	}
});

test("cross-skill 'Call the Skill tool' targets exist and are model-invoked", () => {
	const skills = registered.map(({ dir }) => readSkill(join(VENDOR, dir, "SKILL.md")));
	const byName = new Map(skills.map((s) => [s.name, s]));
	const userNames = new Set(skills.filter((s) => s.userInvoked).map((s) => s.name));
	const calls = new Set<string>();

	for (const { dir } of registered) {
		for (const file of markdownUnder(join(VENDOR, dir))) {
			for (const line of file.split("\n")) {
				if (!line.includes("Call the Skill tool")) continue;
				for (const m of line.matchAll(/[`"]([a-z0-9-]+)[`"]/g)) calls.add(m[1]);
			}
		}
	}

	assert.ok(calls.size >= 3, `expected cross-skill calls, found: ${[...calls].join(", ")}`);
	for (const call of calls) {
		assert.ok(byName.has(call), `cross-skill call to unknown skill: ${call}`);
		assert.equal(userNames.has(call), false, `skill ${call} is user-invoked: invocation.md forbids skills calling it`);
	}
});

test("skills-lock.json records both buckets with fresh hashes", () => {
	const lock = JSON.parse(readFileSync(LOCK, "utf8")) as {
		version: number;
		skillCount: number;
		skills: Record<string, { skillFile: string; computedHash: string; modelInvoked: boolean; bucket: string }>;
	};
	assert.equal(lock.version, 2, "lock version 2 carries the bucket field");
	assert.equal(Object.keys(lock.skills).length, registered.length, "lock/registered count mismatch");
	assert.equal(lock.skillCount, registered.length);
	for (const { dir, bucket } of registered) {
		const skillMd = join(VENDOR, dir, "SKILL.md");
		const skill = readSkill(skillMd);
		const locked = lock.skills[skill.name];
		assert.ok(locked, `lock missing registered skill: ${skill.name}`);
		const hash = createHash("sha256").update(readFileSync(skillMd, "utf8")).digest("hex");
		assert.equal(locked.computedHash, hash, `stale hash for ${skill.name} — run npm run sync:skills`);
		assert.equal(locked.skillFile, repoRel(skillMd), `lock path drift for ${skill.name}`);
		assert.equal(locked.modelInvoked, !skill.userInvoked, `lock invocation class drift for ${skill.name}`);
		assert.equal(locked.bucket, bucket, `lock bucket drift for ${skill.name}`);
	}
});

test("assets referenced by registered skills resolve inside the skill directory", () => {
	const offenders: string[] = [];
	for (const { dir } of registered) {
		const skillDir = join(VENDOR, dir);
		const raw = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1];
			if (/^(https?:|#|mailto:)/.test(target)) continue;
			// Assets ship beside SKILL.md as single-segment paths (`PHASE-BOUNDARIES.md`,
			// `./dependency-cruiser.config.cjs`). Prose placeholders (`[title](link)`) and
			// paths into the *target* repo (`./src/packages/README.md`) are not assets.
			const bare = target.split("#")[0].replace(/^\.\//, "");
			if (!/\./.test(bare) || bare.includes("/")) continue;
			const resolved = resolve(skillDir, bare);
			if (!existsSync(resolved)) offenders.push(`${dir}/SKILL.md → ${target}`);
		}
	}
	assert.deepEqual(offenders, []);
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
