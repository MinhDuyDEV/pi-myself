import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { packageRoot } from "./lib/repo-root.js";

/**
 * policy — injects the harness's workflow policy (`.pi/policy/WORKFLOW.md`)
 * into the session parent's system prompt before every agent run, as its own
 * `<harness>` section.
 *
 * Why not a copied `.pi/APPEND_SYSTEM.md` any more (ADR 0003): pi discovers
 * that file only in the project's own `.pi/`, so each consuming repo held a
 * copy that went stale between `/setup-pi-myself` runs, and a task child never
 * saw it anyway — pi-task's `--append-system-prompt` suppresses the discovered
 * file. Reading the package's own copy keeps every repo on the installed
 * version with nothing to provision.
 *
 * - Task children are skipped: the child contract spliced into each role body
 *   is what binds them. `PI_TASK_TOOL_DISABLED` is read when the extension
 *   loads, because pi-task's SDK backend sets it in the parent's own process
 *   while an in-process child runs.
 * - A project whose `.pi/APPEND_SYSTEM.md` is an older provisioned copy of this
 *   policy (it carries `STALE_COPY_MARKER`) gets no second copy: the section
 *   is withheld and one notice says to run `/setup-pi-myself`, which migrates
 *   the copy away. A repository's own `APPEND_SYSTEM.md` is left to pi.
 */

/** The custom system-prompt section pi renders after the cwd line (name must match /^[a-z][a-z0-9_-]*$/). */
export const POLICY_SECTION = "harness";

/**
 * The policy's opening line. Older `/setup-pi-myself` runs copied the policy
 * into `.pi/APPEND_SYSTEM.md`, so this line in pi's appended text means a stale
 * copy; scripts/setup-project.mjs detects it by the same string.
 */
export const STALE_COPY_MARKER = "Runtime playbook: which process owns the work";

const STALE_COPY_NOTICE =
	"pi-myself: .pi/APPEND_SYSTEM.md is an old copy of the harness workflow policy, so the current policy is not injected. Run /setup-pi-myself to migrate it (an edited copy is kept as APPEND_SYSTEM.md.local).";

function readPolicy(path: string): { text: string } | { error: string } {
	try {
		const text = readFileSync(path, "utf8").trim();
		return text ? { text } : { error: `${path} is empty` };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** The extension, reading the policy from `workflowPath` (the package's own copy by default). */
export function createPolicyExtension(workflowPath: string): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (process.env.PI_TASK_TOOL_DISABLED === "1") return;
		const policy = readPolicy(workflowPath);
		let noticeShown = false;
		const noticeOnce = (ctx: ExtensionContext, message: string, type: "warning" | "error") => {
			if (noticeShown) return;
			noticeShown = true;
			ctx.ui?.notify?.(message, type);
		};

		pi.on("before_agent_start", (event, ctx) => {
			if ("error" in policy) {
				noticeOnce(
					ctx,
					`pi-myself: workflow policy not injected; cannot read WORKFLOW.md (${policy.error}). Reinstall the package.`,
					"error",
				);
				return;
			}
			if (event.systemPromptOptions.appendSystemPrompt.includes(STALE_COPY_MARKER)) {
				noticeOnce(ctx, STALE_COPY_NOTICE, "warning");
				return;
			}
			event.systemPromptOptions.sections[POLICY_SECTION] = policy.text;
		});
	};
}

export default createPolicyExtension(join(packageRoot(import.meta.url), ".pi", "policy", "WORKFLOW.md"));
