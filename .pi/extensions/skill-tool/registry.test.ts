import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { buildRegistry, parseFrontmatter } from "./registry.js";

function makeSkillRoot(spec: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "skill-registry-"));
	for (const [file, content] of Object.entries(spec)) {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function cleanup(root: string): void {
	rmSync(root, { recursive: true, force: true });
}

const MODEL_SKILL = `---
name: alpha
description: "Use when the model should act: quoted, with colon and \\"escapes\\"."
---

Alpha body.
`;

const USER_SKILL = `---
name: beta
description: Human-facing one-liner for the slash command.
disable-model-invocation: true
---

Beta body.
`;

test("parseFrontmatter reads the invocation fields", () => {
	const parsed = parseFrontmatter(MODEL_SKILL);
	assert.equal(parsed.name, "alpha");
	assert.equal(parsed.description, "Use when the model should act: quoted, with colon and \"escapes\".");
	assert.equal(parsed.userInvoked, false);

	const user = parseFrontmatter(USER_SKILL);
	assert.equal(user.userInvoked, true);
});

test("parseFrontmatter tolerates missing frontmatter", () => {
	assert.deepEqual(parseFrontmatter("no frontmatter here"), { userInvoked: false });
});

test("buildRegistry classifies and skips invalid entries", () => {
	const root = makeSkillRoot({
		"skills/alpha/SKILL.md": MODEL_SKILL,
		"skills/beta/SKILL.md": USER_SKILL,
		"skills/broken/SKILL.md": "---\ndescription: no name\n---\n",
		"skills/unnamed/SKILL.md": "---\nname: Bad Name\ndescription: reject uppercase and spaces\n---\n",
		"notes/readme.md": "not a skill",
	});
	try {
		const registry = buildRegistry([join(root, "skills")]);
		assert.deepEqual(
			registry.skills.map((s) => s.name),
			["alpha", "beta"],
		);
		assert.deepEqual(registry.modelInvoked.map((s) => s.name), ["alpha"]);
		assert.deepEqual(registry.userInvoked.map((s) => s.name), ["beta"]);
		assert.equal(registry.modelInvoked[0].skillFile.endsWith("skills/alpha/SKILL.md"), true);
	} finally {
		cleanup(root);
	}
});

test("buildRegistry: first source wins, later duplicates recorded", () => {
	const first = makeSkillRoot({ "a/mine/SKILL.md": MODEL_SKILL.replace("name: alpha", "name: mine") });
	const second = makeSkillRoot({ "b/other/SKILL.md": MODEL_SKILL.replace("name: alpha", "name: mine") });
	try {
		const registry = buildRegistry([join(first, "a"), join(second, "b")]);
		assert.equal(registry.skills.length, 1);
		assert.equal(registry.skills[0].directory, join(first, "a", "mine"));
		assert.deepEqual(registry.duplicates, ["mine"]);
	} finally {
		cleanup(first);
		cleanup(second);
	}
});

test("vendored registry: full promoted set plus local skills", () => {
	const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
	const manifest = join(repoRoot, "vendor", "mattpocock-skills", ".claude-plugin", "plugin.json");
	if (!existsSync(manifest)) return; // registry tests above still coverage-check the mechanics

	const registry = buildRegistry([
		join(repoRoot, "vendor", "mattpocock-skills", "skills", "engineering"),
		join(repoRoot, "vendor", "mattpocock-skills", "skills", "productivity"),
		join(repoRoot, ".pi", "skills"),
	]);

	const names = new Set(registry.skills.map((s) => s.name));
	assert.equal(registry.skills.length, 34, `expected 34 skills (25 vendored + 9 local), got ${registry.skills.length}`);
	for (const promoted of ["wayfinder", "grilling", "tdd", "implement", "code-review", "setup-matt-pocock-skills", "handoff"]) {
		assert.ok(names.has(promoted), `missing promoted skill ${promoted}`);
	}
	for (const local of ["memory", "verification-before-completion", "browser-tools"]) {
		assert.ok(names.has(local), `missing local skill ${local}`);
	}
	// invocation invariant: every user-invoked skill is absent from the model-invoked set
	const modelNames = new Set(registry.modelInvoked.map((s) => s.name));
	for (const userSkill of registry.userInvoked) {
		assert.equal(modelNames.has(userSkill.name), false, `user-invoked ${userSkill.name} leaked into the model-invoked set`);
	}
	assert.deepEqual(
		relative(repoRoot, registry.modelInvoked.find((s) => s.name === "memory")!.skillFile).split("\\").join("/"),
		".pi/skills/memory/SKILL.md",
	);
});