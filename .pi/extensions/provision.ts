import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveRepoRoot } from "./lib/repo-root.js";

/**
 * provision — `/setup-pi-myself` runs scripts/setup-project.mjs from this
 * package against the repository root (no path hunting: the extension knows
 * where it lives), copying what pi only loads from the project's own `.pi/`
 * (task roles, APPEND_SYSTEM.md, the enableSkillCommands setting).
 *
 * No session-start check: rerunning the command IS the update path, and the
 * script owns the outcome. It refreshes the task roles from the package —
 * keeping only each role's `model` and `thinking`, which are the project's
 * cost/latency choice — always replaces APPEND_SYSTEM.md (harness policy), and
 * enforces `enableSkillCommands` in settings.json, backing up an edited copy as
 * .local first. A copy the project changed outside those two role fields is
 * refreshed too, after its own .local backup, so a harness fix never waits
 * behind a stale copy.
 */

export default function provisionExtension(pi: ExtensionAPI): void {
	const pkg = packageRoot(import.meta.url);

	pi.registerCommand("setup-pi-myself", {
		description:
			"Provision or update this repository for pi-myself: refresh the task roles (keeping each role's model and thinking), replace APPEND_SYSTEM.md (an edited copy backed up as .local), enforce enableSkillCommands (previous settings.json kept as .local; a project-added role is never touched)",
		async handler(_args, ctx) {
			const root = resolveRepoRoot(ctx.cwd);
			const script = join(pkg, "scripts", "setup-project.mjs");
			const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			ctx.ui?.notify?.(
				result.status === 0
					? `${output}\n\nRemaining per-repo setup: /skill:setup-matt-pocock-skills (tracker, domain docs, triage labels); pi install git:github.com/sting8k/pi-workspace-memory once per machine for memory.`
					: `setup-project failed (exit ${result.status}):\n${output}`,
				result.status === 0 ? "info" : "error",
			);
		},
	});
}
