import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveRepoRoot } from "./lib/repo-root.js";

/**
 * provision — `/setup-pi-myself` runs scripts/setup-project.mjs from this
 * package against the repository root (no path hunting: the extension knows
 * where it lives), copying the one thing pi-task loads only from the project's
 * own `.pi/`: the task roles.
 *
 * No session-start check: rerunning the command IS the update path, and the
 * script owns the outcome. It refreshes the roles from the package — keeping a
 * `model`, `thinking`, or `max_turns` the project chose — backs up a copy the
 * project changed in any other line as `.local` first, and removes an
 * APPEND_SYSTEM.md an older run copied (the `policy` extension injects the
 * workflow now). settings.json is not touched.
 */

/** Long enough for any real provisioning run; a wedged child must not freeze the TUI forever. */
export const SETUP_TIMEOUT_MS = 60_000;

export const NEXT_STEPS =
	"Remaining setup: /skill:setup-matt-pocock-skills in each repo (tracker, domain docs, triage labels). Once per machine: pi install npm:@heyhuynhgiabuu/pi-task (the task tool the roles run on) and pi install git:github.com/sting8k/pi-workspace-memory (memory records).";

/** The notice for one run of the script: its own output on success, the reason it did not finish otherwise. */
export function setupReport(result: Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stdout" | "stderr">): {
	message: string;
	type: "info" | "error";
} {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.error) {
		const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		const reason = timedOut ? `timed out after ${SETUP_TIMEOUT_MS / 1000}s` : `could not run (${result.error.message})`;
		return { message: `setup-project ${reason}; nothing after its last line below was done.${output ? `\n${output}` : ""}`, type: "error" };
	}
	if (result.status !== 0) {
		const how = result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit ${result.status}`;
		return { message: `setup-project failed (${how}):\n${output}`, type: "error" };
	}
	return { message: `${output}\n\n${NEXT_STEPS}`, type: "info" };
}

export default function provisionExtension(pi: ExtensionAPI): void {
	const pkg = packageRoot(import.meta.url);

	pi.registerCommand("setup-pi-myself", {
		description:
			"Provision or update this repository for pi-myself: refresh the task roles (keeping a model, thinking, or max_turns the project chose; a copy changed in any other line is kept as .local) and remove an APPEND_SYSTEM.md an older run copied (the workflow is injected now). A project-added role and settings.json are never touched",
		async handler(_args, ctx) {
			const root = resolveRepoRoot(ctx.cwd);
			const script = join(pkg, "scripts", "setup-project.mjs");
			const result = spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: SETUP_TIMEOUT_MS });
			const { message, type } = setupReport(result);
			ctx.ui?.notify?.(message, type);
		},
	});
}
