import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import skillToolExtension, { defaultSkillRoots } from "./index.js";

// The `skill` tool is the harness's reason to exist: the enum must equal the
// model-invoked set, a user-invoked name must be refused with the slash
// command, and the roots must match what pi itself would list for the cwd.

interface RegisteredTool {
	name: string;
	parameters?: { properties?: { name?: { anyOf?: Array<{ const?: string }> } } };
	execute: (id: string, params: { name?: string }, signal: undefined, onUpdate: undefined) => Promise<{ content: Array<{ text: string }>; details: { loaded: boolean; skill: string | null } }>;
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

test("skill tool: enum is exactly the model-invoked set, loads bodies, refuses user-invoked names", async () => {
	const root = skillRoot({ grilling: "Grill the user.", wayfinder: "USER:Plan a huge chunk of work." });
	process.env.PI_SKILL_TOOL_DIRS = root;
	try {
		const { api, tools, commands } = mockPi();
		skillToolExtension(api);
		assert.deepEqual(commands, ["skills"]);
		const tool = tools.find((t) => t.name === "skill")!;
		const enumNames = tool.parameters?.properties?.name?.anyOf?.map((o) => o.const);
		assert.deepEqual(enumNames, ["grilling"], "enum lists only model-invoked skills");

		const loaded = await tool.execute("1", { name: "grilling" }, undefined, undefined);
		assert.equal(loaded.details.loaded, true);
		assert.match(loaded.content[0].text, /body of grilling/);

		const refused = await tool.execute("2", { name: "wayfinder" }, undefined, undefined);
		assert.equal(refused.details.loaded, false);
		assert.match(refused.content[0].text, /\/skill:wayfinder/, "user-invoked names hand the human the slash command");

		const unknown = await tool.execute("3", { name: "nope" }, undefined, undefined);
		assert.match(unknown.content[0].text, /Unknown skill "nope"/);
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
		const roots = defaultSkillRoots(repoRoot, join(home, ".pi", "agent")).map((r) => realpathSync(r));
		assert.equal(roots[0], realpathSync(join(repoRoot, ".pi", "skills")));
		assert.equal(roots[1], realpathSync(join(home, ".pi", "agent", "skills")));
		assert.equal(new Set(roots).size, roots.length, "no duplicate roots");
		assert.ok(roots.some((r) => r.endsWith("/skills/engineering")));

		// a consuming project elsewhere: its own .pi/skills leads, the package's follows
		const project = mkdtempSync(join(tmpdir(), "skill-tool-project-"));
		mkdirSync(join(project, ".pi", "skills"), { recursive: true });
		const consumer = defaultSkillRoots(project, join(home, ".pi", "agent")).map((r) => realpathSync(r));
		assert.equal(consumer[0], realpathSync(join(project, ".pi", "skills")));
		assert.ok(consumer.includes(realpathSync(join(repoRoot, ".pi", "skills"))), "package skills still reachable");
		rmSync(project, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
