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
 * No session-start check: the copies belong to the project, which edits them
 * to fit, so a difference from the package is nothing to warn about.
 * Rerunning the command after an upgrade refreshes the task roles the project
 * never touched and keeps the rest (setup-project's baseline).
 * APPEND_SYSTEM.md is the exception: harness policy, always replaced, with
 * the project's edited copy backed up as APPEND_SYSTEM.md.local.
 */

export default function provisionExtension(pi: ExtensionAPI): void {
	const pkg = packageRoot(import.meta.url);

	pi.registerCommand("setup-pi-myself", {
		description: "Provision this repository for pi-myself: task roles, APPEND_SYSTEM.md (harness policy — always replaced, an edited copy backed up as .local), enableSkillCommands (idempotent; keeps project edits to task roles)",
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
