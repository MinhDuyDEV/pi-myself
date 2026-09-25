import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	assert.equal(parsed.description, 'Use when the model should act: quoted, with colon and "escapes".');
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
		// pi falls back to the containing directory's name, so a described skill
		// without a frontmatter name still loads
		"skills/broken/SKILL.md": "---\ndescription: no name in frontmatter\n---\n",
		"skills/unnamed/SKILL.md": "---\nname: Bad Name\ndescription: reject uppercase and spaces\n---\n",
		"skills/silent/SKILL.md": "---\nname: silent\n---\n",
		"notes/readme.md": "not a skill",
	});
	try {
		const registry = buildRegistry([join(root, "skills")]);
		assert.deepEqual(
			registry.skills.map((s) => s.name),
			["alpha", "beta", "broken"],
		);
		assert.deepEqual(
			registry.modelInvoked.map((s) => s.name),
			["alpha", "broken"],
		);
		assert.deepEqual(
			registry.userInvoked.map((s) => s.name),
			["beta"],
		);
		assert.equal(registry.modelInvoked[0]?.skillFile.endsWith("skills/alpha/SKILL.md"), true);
		// a skipped skill is named in the diagnostics, never silently dropped
		assert.ok(
			registry.diagnostics.some((d) => d.includes("unnamed") && d.includes("skill-name rules")),
			`expected an unnamed diagnostic, got ${JSON.stringify(registry.diagnostics)}`,
		);
		assert.ok(
			registry.diagnostics.some((d) => d.includes("silent") && d.includes("no description")),
			`expected a no-description diagnostic, got ${JSON.stringify(registry.diagnostics)}`,
		);
	} finally {
		cleanup(root);
	}
});

test("frontmatter parsing survives CRLF, a BOM, and a block-scalar description", () => {
	// A CRLF checkout used to drop every skill: the opening `---\n` never matched.
	const crlf = "---\r\nname: gamma\r\ndescription: Windows checkout\r\n---\r\n\r\nBody.\r\n";
	const parsedCrlf = parseFrontmatter(crlf);
	assert.equal(parsedCrlf.name, "gamma");
	assert.equal(parsedCrlf.description, "Windows checkout");

	const bom = `\uFEFF${MODEL_SKILL}`;
	assert.equal(parseFrontmatter(bom).name, "alpha");

	const folded = "---\nname: folded\ndescription: >-\n  Use when the description\n  wraps across lines.\n---\n";
	assert.equal(parseFrontmatter(folded).description, "Use when the description wraps across lines.");

	const literal = "---\nname: literal\ndescription: |\n  line one\n  line two\n---\n";
	assert.equal(parseFrontmatter(literal).description, "line one\nline two");

	// `True` is a YAML boolean; `yes` is a string in YAML 1.2, so it is not
	assert.equal(parseFrontmatter("---\nname: t\ndescription: d\ndisable-model-invocation: True\n---\n").userInvoked, true);
	assert.equal(parseFrontmatter("---\nname: t\ndescription: d\ndisable-model-invocation: yes\n---\n").userInvoked, false);
});

test("the walk matches pi: CRLF skills load, hidden and node_modules dirs do not", () => {
	const root = makeSkillRoot({
		"skills/gamma/SKILL.md": "---\r\nname: gamma\r\ndescription: CRLF skill\r\n---\r\n",
		"skills/.hidden/SKILL.md": "---\nname: hidden\ndescription: must not load\n---\n",
		"skills/node_modules/pkg/SKILL.md": "---\nname: dep\ndescription: must not load\n---\n",
	});
	try {
		const registry = buildRegistry([join(root, "skills")]);
		assert.deepEqual(
			registry.skills.map((s) => s.name),
			["gamma"],
		);
	} finally {
		cleanup(root);
	}
});

test("the walk matches pi: a loose .md at a passed root loads, and SKILL.md stops descent", () => {
	const root = makeSkillRoot({
		"skills/loose.md": "---\nname: loose\ndescription: a root-level skill file\n---\n",
		"skills/pkg/SKILL.md": "---\nname: pkg\ndescription: a declared skill\n---\n",
		// inside a skill root, so pi never looks at it
		"skills/pkg/nested/SKILL.md": "---\nname: nested\ndescription: must not load\n---\n",
	});
	try {
		const registry = buildRegistry([join(root, "skills")]);
		assert.deepEqual(
			registry.skills.map((s) => s.name),
			["loose", "pkg"],
		);
	} finally {
		cleanup(root);
	}
});

test("a skill file that cannot be read is reported, not silently dropped", () => {
	const root = mkdtempSync(join(tmpdir(), "skill-registry-unreadable-"));
	try {
		mkdirSync(join(root, "skills", "ghost"), { recursive: true });
		writeFileSync(join(root, "skills", "ghost", "SKILL.md"), "---\nname: ghost\ndescription: d\n---\n");
		const registry = buildRegistry([join(root, "skills")], (path) => {
			if (path.includes("ghost")) throw new Error("EACCES: permission denied");
			return readFileSync(path, "utf8");
		});
		assert.deepEqual(registry.skills, []);
		assert.ok(
			registry.diagnostics.some((d) => d.includes("ghost") && d.includes("EACCES")),
			`expected an unreadable diagnostic, got ${JSON.stringify(registry.diagnostics)}`,
		);
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
		join(repoRoot, "vendor", "mattpocock-skills", "skills", "in-progress"),
		join(repoRoot, ".pi", "skills"),
	]);

	const names = new Set(registry.skills.map((s) => s.name));
	const localCount = readdirSync(join(repoRoot, ".pi", "skills")).filter((d) =>
		existsSync(join(repoRoot, ".pi", "skills", d, "SKILL.md")),
	).length;
	const lock = JSON.parse(readFileSync(join(repoRoot, "skills-lock.json"), "utf8")) as {
		skillCount: number;
		skills: Record<string, { modelInvoked: boolean; bucket: string }>;
	};
	assert.equal(
		registry.skills.length,
		lock.skillCount + localCount,
		`expected ${lock.skillCount + localCount} skills (${lock.skillCount} vendored + ${localCount} local), got ${registry.skills.length}`,
	);
	for (const promoted of ["wayfinder", "grilling", "tdd", "implement", "code-review", "setup-matt-pocock-skills", "handoff"]) {
		assert.ok(names.has(promoted), `missing promoted skill ${promoted}`);
	}
	// The invocation class comes from the lock, not a hand-kept list: the sync
	// that added the beta `pr` skill made it model-invoked, which a hardcoded
	// subset of beta names could not notice.
	const modelNames = new Set(registry.modelInvoked.map((s) => s.name));
	const userNames = new Set(registry.userInvoked.map((s) => s.name));
	for (const [name, meta] of Object.entries(lock.skills)) {
		assert.ok(names.has(name), `registered skill missing from the registry: ${name}`);
		if (meta.modelInvoked) assert.ok(modelNames.has(name), `${name} is model-invoked in the lock but the skill tool cannot load it`);
		else assert.ok(userNames.has(name), `${name} is user-invoked in the lock but the skill tool would load it`);
	}
	assert.deepEqual(
		Object.entries(lock.skills)
			.filter(([, meta]) => meta.bucket === "beta" && meta.modelInvoked)
			.map(([name]) => name),
		["pr"],
		"beta bucket: `pr` is the only model-invoked one — when upstream changes this, update the beta prose in README.md, CONTEXT.md, and .pi/APPEND_SYSTEM.md",
	);
	for (const local of ["memory", "verification-before-completion", "source-driven-development"]) {
		assert.ok(names.has(local), `missing local skill ${local}`);
	}
	// invocation invariant: every user-invoked skill is absent from the model-invoked set
	for (const userSkill of registry.userInvoked) {
		assert.equal(modelNames.has(userSkill.name), false, `user-invoked ${userSkill.name} leaked into the model-invoked set`);
	}
	assert.deepEqual(
		relative(repoRoot, registry.modelInvoked.find((s) => s.name === "memory")!.skillFile)
			.split("\\")
			.join("/"),
		".pi/skills/memory/SKILL.md",
	);
});
