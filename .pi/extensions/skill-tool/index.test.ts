import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import skillToolExtension, { defaultSkillRoots } from "./index.js";

// The `skill` tool is the harness's reason to exist: its listed names must equal
// the model-invoked set, a user-invoked name must be refused with the slash
// command, and the roots must match what pi itself would list for the cwd.

interface RegisteredTool {
	name: string;
	promptGuidelines?: string[];
	parameters?: { properties?: { name?: { anyOf?: Array<{ const?: string }>; type?: string; description?: string } } };
	execute: (
		id: string,
		params: { name?: string },
		signal: undefined,
		onUpdate: undefined,
	) => Promise<{ content: Array<{ text: string }>; details: { loaded: boolean; skill: string | null } }>;
}

function mockPi() {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	return {
		tools,
		commands,
		api: {
			registerTool(tool: RegisteredTool) {
				tools.push(tool);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
		} as never,
	};
}

function skillRoot(spec: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "skill-tool-"));
	for (const [name, description] of Object.entries(spec)) {
		mkdirSync(join(root, name), { recursive: true });
		const userInvoked = description.startsWith("USER:");
		writeFileSync(
			join(root, name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description.replace(/^USER:/, "")}\n${userInvoked ? "disable-model-invocation: true\n" : ""}---\n# ${name}\nbody of ${name}\n`,
		);
	}
	return root;
}

test("skill tool: lists exactly the model-invoked set, loads bodies, refuses user-invoked names", async () => {
	const root = skillRoot({ grilling: "Grill the user.", wayfinder: "USER:Plan a huge chunk of work." });
	process.env.PI_SKILL_TOOL_DIRS = root;
	try {
		const { api, tools, commands } = mockPi();
		skillToolExtension(api);
		assert.deepEqual(commands, ["skills"]);
		const tool = tools.find((t) => t.name === "skill")!;
		const nameSchema = tool.parameters?.properties?.name;
		assert.equal(nameSchema?.anyOf, undefined, "no enum: pi would reject other names before execute runs");
		assert.equal(nameSchema?.type, "string");
		assert.match(nameSchema?.description ?? "", /grilling/, "the model-invoked names stay visible to the model");
		assert.doesNotMatch(nameSchema?.description ?? "", /wayfinder/, "a user-invoked name is not offered");

		const loaded = await tool.execute("1", { name: "grilling" }, undefined, undefined);
		assert.equal(loaded.details.loaded, true);
		assert.match(loaded.content[0].text, /body of grilling/);

		const refused = await tool.execute("2", { name: "wayfinder" }, undefined, undefined);
		assert.equal(refused.details.loaded, false);
		assert.match(refused.content[0].text, /\/skill:wayfinder/, "user-invoked names hand the human the slash command");

		// implement and implement-spec write model-invoked skills as slash commands
		// (`/tdd`, `/code-review`); the guideline reaches every session and child
		// that has this tool, including those that never see the workflow policy.
		assert.ok(
			(tool.promptGuidelines ?? []).some(
				(line) => /slash command/i.test(line) && /\/tdd|\/code-review/.test(line) && /this tool/.test(line),
			),
			"a guideline says a model-invoked skill written as a slash command means calling this tool",
		);

		const unknown = await tool.execute("3", { name: "nope" }, undefined, undefined);
		assert.match(unknown.content[0].text, /Unknown skill "nope"/);
	} finally {
		delete process.env.PI_SKILL_TOOL_DIRS;
		rmSync(root, { recursive: true, force: true });
	}
});

test("skill tool: a user-invoked name passes pi's argument validation and gets the slash-command reply", async () => {
	// pi validates arguments against the schema before `execute`; with an enum,
	// "wayfinder" failed validation and the /skill:wayfinder hand-off never ran.
	const root = skillRoot({ grilling: "Grill the user.", wayfinder: "USER:Plan a huge chunk of work." });
	process.env.PI_SKILL_TOOL_DIRS = root;
	try {
		const { api, tools } = mockPi();
		skillToolExtension(api);
		const tool = tools.find((t) => t.name === "skill")!;
		const args = validateToolArguments(tool as never, {
			type: "toolCall",
			id: "1",
			name: "skill",
			arguments: { name: "wayfinder" },
		}) as { name: string };
		const refused = await tool.execute("1", args, undefined, undefined);
		assert.equal(refused.details.loaded, false);
		assert.match(refused.content[0].text, /\/skill:wayfinder/);
	} finally {
		delete process.env.PI_SKILL_TOOL_DIRS;
		rmSync(root, { recursive: true, force: true });
	}
});

test("skill tool: a body's reference files reach the model with their directory", async () => {
	// `details` is UI-only, so a relative link the body names (`DEEPENING.md`)
	// is unopenable unless the directory travels in the content the model reads.
	const root = skillRoot({ codebase: "Design modules.", plain: "No references here." });
	writeFileSync(join(root, "codebase", "DEEPENING.md"), "# Deepening\n");
	process.env.PI_SKILL_TOOL_DIRS = root;
	try {
		const { api, tools } = mockPi();
		skillToolExtension(api);
		const tool = tools.find((t) => t.name === "skill")!;

		const withReferences = await tool.execute("1", { name: "codebase" }, undefined, undefined);
		assert.match(withReferences.content[0].text, /Reference files in this skill's own directory/);
		assert.match(withReferences.content[0].text, /DEEPENING\.md/, "the model learns which reference files exist");
		assert.match(withReferences.content[0].text, /body of codebase/, "the body still travels");

		// no other .md, but the directory still travels: a body may link a script
		// (wizard's template.sh, diagnosing-bugs' scripts/*.sh)
		writeFileSync(join(root, "plain", "template.sh"), "#!/bin/sh\n");
		const without = await tool.execute("2", { name: "plain" }, undefined, undefined);
		assert.doesNotMatch(without.content[0].text, /Reference files in this skill's own directory/);
		assert.ok(without.content[0].text.includes(`(\`${join(root, "plain")}\`)`), "the skill's directory reaches the model");
	} finally {
		delete process.env.PI_SKILL_TOOL_DIRS;
		rmSync(root, { recursive: true, force: true });
	}
});

test("defaultSkillRoots: project and user skills come before the package's, deduped by real path", () => {
	const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
	const home = mkdtempSync(join(tmpdir(), "skill-tool-home-"));
	mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
	try {
		// checkout layout: cwd is the package root, so its .pi/skills appears once
		const roots = defaultSkillRoots(repoRoot, join(home, ".pi", "agent"), home).map((r) => realpathSync(r));
		const projectSkills = realpathSync(join(repoRoot, ".pi", "skills"));
		const userSkills = realpathSync(join(home, ".pi", "agent", "skills"));
		assert.equal(roots[0], projectSkills, "the project's own skills lead");
		assert.equal(new Set(roots).size, roots.length, "no duplicate roots");
		assert.ok(roots.includes(userSkills), "the user's skills are a root");
		assert.ok(
			roots.some((r) => r.endsWith("/skills/engineering")),
			"the vendored trees are roots",
		);
		// NB: in the checkout layout the project root IS the package root, so its
		// `.pi/skills` is deduped to one entry — the ordering check belongs to the
		// consumer case below

		// a consuming project elsewhere: its own .pi/skills leads, the package's follows
		const project = mkdtempSync(join(tmpdir(), "skill-tool-project-"));
		mkdirSync(join(project, ".pi", "skills"), { recursive: true });
		const consumer = defaultSkillRoots(project, join(home, ".pi", "agent"), home).map((r) => realpathSync(r));
		assert.equal(consumer[0], realpathSync(join(project, ".pi", "skills")));
		const packageSkills = realpathSync(join(repoRoot, ".pi", "skills"));
		assert.ok(consumer.includes(packageSkills), "package skills still reachable");
		assert.ok(consumer.indexOf(packageSkills) > consumer.indexOf(userSkills), "the project's and user's roots precede the package's");
		rmSync(project, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("defaultSkillRoots stops the .agents/skills walk at the git root, as pi does", () => {
	const home = mkdtempSync(join(tmpdir(), "skill-tool-home-"));
	const outer = mkdtempSync(join(tmpdir(), "skill-tool-outer-"));
	const repo = join(outer, "repo");
	try {
		mkdirSync(join(outer, ".agents", "skills"), { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
		mkdirSync(join(repo, "sub"), { recursive: true });
		const roots = defaultSkillRoots(join(repo, "sub"), join(home, ".pi", "agent"), home).map((r) => realpathSync(r));
		assert.ok(roots.includes(realpathSync(join(repo, ".agents", "skills"))), "the repository's own .agents/skills");
		assert.ok(!roots.includes(realpathSync(join(outer, ".agents", "skills"))), "nothing above the git root");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(outer, { recursive: true, force: true });
	}
});

test("defaultSkillRoots includes the .agents/skills roots pi also collects", () => {
	const home = mkdtempSync(join(tmpdir(), "skill-tool-home-"));
	const project = join(home, "deep", "nested", "project");
	try {
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		mkdirSync(join(home, "deep", ".agents", "skills"), { recursive: true });
		mkdirSync(join(project, ".pi", "skills"), { recursive: true });
		const roots = defaultSkillRoots(project, join(home, ".pi", "agent"), home).map((r) => realpathSync(r));
		assert.ok(roots.includes(realpathSync(join(project, ".pi", "skills"))), "project .pi/skills first");
		assert.ok(roots.includes(realpathSync(join(home, "deep", ".agents", "skills"))), "ancestor .agents/skills");
		assert.ok(roots.includes(realpathSync(join(home, ".agents", "skills"))), "user .agents/skills");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
