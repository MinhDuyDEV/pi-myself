/**
 * skill-tool — register a real `skill` tool for pi.
 *
 * Why: mattpocock/skills' cross-skill convention ("Call the Skill tool with
 * `grilling`") presumes a Skill tool; pi instead expects the model to infer
 * reading the SKILL.md file. This extension closes the gap with two
 * properties:
 *
 * - The `name` parameter is a literal union over exactly the model-invoked
 *   skill set, so upstream phrasing works verbatim and the model cannot name
 *   a user-invoked skill.
 * - A requested name that belongs to a user-invoked skill returns a message
 *   telling the model to hand the slash command to the human — the
 *   invocation.md invariant ("nothing but the human can fire it") enforced in
 *   the harness rather than in prose.
 *
 * Project-local `.pi/skills` come first in root order and shadow vendored
 * skills by name.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { buildRegistry, type Registry } from "./registry.js";
export { buildRegistry, parseFrontmatter, type Registry, type SkillEntry } from "./registry.js";

/** Shape of the tool's `details` payload across every outcome. */
interface SkillDetails {
	skill: string | null;
	path?: string;
	loaded: boolean;
}

function findRepoRoot(start: string): string {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, "vendor", "mattpocock-skills", ".claude-plugin", "plugin.json"))) return current;
		const parent = join(current, "..");
		if (parent === current) return resolve(start);
		current = parent;
	}
}

export default function skillToolExtension(pi: ExtensionAPI): void {
	const skillRoots = process.env.PI_SKILL_TOOL_DIRS
		? process.env.PI_SKILL_TOOL_DIRS.split(":").filter(Boolean)
		: [
				join(findRepoRoot(process.cwd()), "vendor", "mattpocock-skills", "skills", "engineering"),
				join(findRepoRoot(process.cwd()), "vendor", "mattpocock-skills", "skills", "productivity"),
				join(findRepoRoot(process.cwd()), ".pi", "skills"),
			];
	const registry = buildRegistry(skillRoots);

	if (registry.duplicates.length > 0) {
		console.error(`[skill-tool] duplicate skill names, first source wins: ${[...new Set(registry.duplicates)].join(", ")}`);
	}
	if (registry.modelInvoked.length === 0) {
		console.error("[skill-tool] no model-invoked skills discovered; check the vendored checkout and skill roots.");
	}

	const loadableNames = registry.modelInvoked.map((s) => s.name);

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: `Load a model-invoked skill's full SKILL.md by name (${loadableNames.length} available). One skill per call: a step that needs two skills is two calls.`,
		promptSnippet: "Load a named skill's instructions and follow them.",
		promptGuidelines: [
			'When a workflow says \'Call the Skill tool with "name"\', call this tool with that name and follow the loaded instructions.',
			"User-invoked skills are not available here: direct the human to run the slash command (e.g. /wayfinder) instead of improvising its steps.",
		],
		parameters: Type.Object({
			name:
				loadableNames.length > 0
					? Type.Union(
							loadableNames.map((name) => Type.Literal(name)),
							{ description: "Skill name — exactly the model-invoked skill set." },
						)
					: Type.String({ description: "Skill name (registry unavailable at startup)." }),
		}),
		renderCall: (args, theme) => {
			const requested =
				args && typeof args === "object" && "name" in args
					? String((args as { name: unknown }).name)
					: "";
			return new Text(theme.fg("toolTitle", theme.bold(`⚙ skill ${requested}`)), 0, 0);
		},
		async execute(
			_toolCallId: string,
			params: { name?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
		) {
			const requested = params.name ?? "";
			const skill = registry.modelInvoked.find((s) => s.name === requested);
			const details: SkillDetails = { skill: skill?.name ?? null, loaded: false };
			let text: string;
			if (!skill) {
				text = unavailableText(registry, requested);
			} else {
				try {
					text = readFileSync(skill.skillFile, "utf8");
					details.path = skill.skillFile;
					details.loaded = true;
				} catch (error) {
					text = `Cannot read skill file for "${skill.name}": ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerCommand("skills", {
		description: "List the skill registry: model-loadable vs human-only",
		async handler(_args, ctx: ExtensionCommandContext) {
			const loadable = registry.modelInvoked.map((s) => `  ${s.name} — ${s.description}`);
			const humanOnly = registry.userInvoked.map((s) => `  /${s.name} — ${s.description}`);
			ctx.ui?.notify?.(
				[
					"## `skill` tool — loadable (model-invoked)",
					...(loadable.length > 0 ? loadable : ["  (none discovered)"]),
					"",
					"## Human-only (user-invoked; direct the user to the slash command)",
					...(humanOnly.length > 0 ? humanOnly : ["  (none discovered)"]),
				].join("\n"),
				"info",
			);
		},
	});
}

function unavailableText(registry: Registry, requested: string): string {
	const loadable = registry.modelInvoked.map((s) => s.name);
	const userOnly = registry.userInvoked.some((s) => s.name === requested);
	if (userOnly) {
		return `\`${requested}\` is user-invoked: only the human can run it. Tell them to type \`/${requested}\`; do not re-implement its steps.`;
	}
	return `Unknown skill ${JSON.stringify(requested)}. Loadable through this tool: ${loadable.join(", ") || "(none)"}.`;
}