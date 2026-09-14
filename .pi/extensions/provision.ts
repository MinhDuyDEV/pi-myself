import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageRoot, resolveRepoRoot } from "./lib/repo-root.js";

/**
 * provision — keeps a consuming repository's copies of what pi only loads
 * from the project's own `.pi/` (task roles, APPEND_SYSTEM.md, the
 * enableSkillCommands setting) in step with the installed package.
 *
 * - `/setup-pi-myself` runs scripts/setup-project.mjs from this package
 *   against the repository root (no path hunting: the extension knows where
 *   it lives).
 * - On session_start it compares the package's agents + APPEND_SYSTEM.md
 *   with the project's copies and notifies once when they drifted — the
 *   thing `pi update --extensions` cannot do for copied files.
 *
 * In the checkout layout (project root == package root) both are no-ops.
 */

export interface DriftReport {
	missing: string[];
	stale: string[];
}

/** Files setup-project would create or refresh; empty lists mean current. */
export function provisionDrift(pkg: string, project: string): DriftReport {
	const report: DriftReport = { missing: [], stale: [] };
	if (resolveSame(pkg, project)) return report;
	const pairs: Array<[string, string]> = [[join(pkg, ".pi", "APPEND_SYSTEM.md"), "APPEND_SYSTEM.md"]];
	const agentsDir = join(pkg, ".pi", "agents");
	if (existsSync(agentsDir)) {
		for (const name of readdirSync(agentsDir)) {
			if (!name.endsWith(".md")) continue;
			const source = join(agentsDir, name);
			if (!/^---\n/.test(readFileSync(source, "utf8"))) continue; // README etc.
			pairs.push([source, join("agents", name)]);
		}
	}
	for (const [source, rel] of pairs) {
		const target = join(project, ".pi", rel);
		if (!existsSync(target)) report.missing.push(rel);
		else if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) report.stale.push(rel);
	}
	return report;
}

function resolveSame(a: string, b: string): boolean {
	try {
		return readFileSync(join(a, "package.json"), "utf8") === readFileSync(join(b, "package.json"), "utf8") && join(a) === join(b);
	} catch {
		return false;
	}
}

export default function provisionExtension(pi: ExtensionAPI): void {
	const pkg = packageRoot(import.meta.url);

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const drift = provisionDrift(pkg, resolveRepoRoot(ctx.cwd));
		const count = drift.missing.length + drift.stale.length;
		if (count === 0) return;
		const detail = [...drift.missing.map((f) => `${f} (missing)`), ...drift.stale.map((f) => `${f} (stale)`)].join(", ");
		ctx.ui.notify(`pi-myself: ${count} provisioned file(s) out of date — run /setup-pi-myself. ${detail}`, "warning");
	});

	pi.registerCommand("setup-pi-myself", {
		description: "Provision this repository for pi-myself: task roles, APPEND_SYSTEM.md, enableSkillCommands (idempotent)",
		async handler(_args, ctx) {
			const root = resolveRepoRoot(ctx.cwd);
			const script = join(pkg, "scripts", "setup-project.mjs");
			const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			ctx.ui?.notify?.(
				result.status === 0
					? `${output}\n\nRemaining per-repo setup: /skill:setup-matt-pocock-skills (tracker, domain docs, triage labels); pi install git:github.com/sting8k/pi-memory-md once per machine for memory.`
					: `setup-project failed (exit ${result.status}):\n${output}`,
				result.status === 0 ? "info" : "error",
			);
		},
	});
}
