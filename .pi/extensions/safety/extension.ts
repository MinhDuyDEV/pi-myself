/**
 * Safety Extension — Unified Entry Point
 *
 * One tool_call hook, one audit log, one /safety command.
 * See safety/ directory for the composable rule system; /safety prints
 * the live rule count and list.
 *
 * CAPABILITIES:
 *   - Block (hard deny, terminating) for critical threats
 *   - Confirm (soft deny with prompt) for high/medium threats
 *   - Bash command interception
 *   - File write/edit interception
 *   - Protected path enforcement
 *   - Unified audit trail
 */

import { AuditLog } from "./audit.js";
import { describe, exclude } from "./compose.js";
import { contextFromEvent } from "./context.js";
import { evaluate } from "./evaluate.js";
import type { RuleSet, Verdict } from "./types.js";
import { defaultRules } from "./rules/presets.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type BlockResult = { block: true; reason: string; terminate?: boolean };

function makeBlockResult(message: string): BlockResult {
	return { block: true, reason: message };
}

function formatVerdict(verdict: Verdict): string {
	const prefix = verdict.kind === "block" ? "[safety] BLOCKED" : "[safety]";
	return `${prefix} (${verdict.severity.toUpperCase()}): ${verdict.message}\n\nRule: ${verdict.ruleId}\nThreat: ${verdict.threat}`;
}

function confirmVerdict(
	message: string,
	ctx?: ExtensionContext,
): BlockResult | undefined | Promise<BlockResult | undefined> {
	const confirm = ctx?.ui?.confirm;
	if (typeof confirm !== "function") {
		return makeBlockResult(`${message}\n\nNo confirmation UI available; blocked by default.`);
	}
	return Promise.resolve(confirm("Safety confirmation", message)).then((ok) => ok ? undefined : makeBlockResult(message));
}

export default function safetyExtension(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const audit = new AuditLog();

	// 1. Build the ruleset
	const rules = defaultRules();

	// 2. Apply disabled rules from env (comma-separated)
	let activeRules: RuleSet = rules;
	const disabledEnv = process.env.PI_SAFETY_DISABLED_RULES;
	const disabledRuleIds = disabledEnv?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
	if (disabledRuleIds.length > 0) {
		activeRules = exclude(rules, ...disabledRuleIds);
	}

	// 3. Single tool_call hook
	pi.on("tool_call", (event: unknown, hookCtx?: ExtensionContext) => {
		const ctx = contextFromEvent(event, cwd);
		if (!ctx) return;

		const { verdict, fired } = evaluate(activeRules, ctx);

		// Audit all fired rules
		for (const v of fired) {
			audit.append({
				timestamp: Date.now(),
				ruleId: v.ruleId,
				severity: v.severity,
				threat: v.threat,
				kind: v.kind,
				tool: ctx.tool,
				detail: (ctx.command ?? ctx.path ?? "").slice(0, 200),
				sessionId: ctx.sessionId,
			});
		}

		if (!verdict) return;

		const message = formatVerdict(verdict);
		if (verdict.kind === "block") return { ...makeBlockResult(message), terminate: true };
		if (verdict.kind === "confirm") return confirmVerdict(`${message}\n\nProceed?`, hookCtx);
	});

	// 4. Unified /safety command
	pi.registerCommand("safety", {
		description: "Show active safety rules, audit log, and posture",
		async handler(_args: unknown, ctx: ExtensionCommandContext) {
			const allRules = describe(activeRules);
			const stats = audit.stats();
			const recentBlocks = audit.query({ kind: "block" }).slice(-5);
			const recentConfirms = audit.query({ kind: "confirm" }).slice(-5);

			const lines = [
				"## Safety Status\n",
				`**Active rules**: ${allRules.length}`,
				`  Critical: ${allRules.filter((r) => r.severity === "critical").length}`,
				`  High: ${allRules.filter((r) => r.severity === "high").length}`,
				`  Medium: ${allRules.filter((r) => r.severity === "medium").length}`,
				`  Low: ${allRules.filter((r) => r.severity === "low").length}`,
				"",
				`**Audit log**: ${stats.total} events`,
				`  Blocked: ${stats.blocked}`,
				`  Confirmed: ${stats.confirmed}`,
			];

			if (disabledRuleIds.length > 0) {
				lines.push(
					"",
					"### Disabled Rules",
					...disabledRuleIds.map((id) => `  ${id}`),
				);
			}

			if (recentBlocks.length > 0) {
				lines.push("", "### Recent Blocks");
				for (const e of recentBlocks) {
					const time = new Date(e.timestamp).toLocaleTimeString();
					lines.push(`  ${time} [${e.severity}] ${e.ruleId}: ${e.detail.slice(0, 60)}`);
				}
			}

			if (recentConfirms.length > 0) {
				lines.push("", "### Recent Confirmations");
				for (const e of recentConfirms) {
					const time = new Date(e.timestamp).toLocaleTimeString();
					lines.push(`  ${time} [${e.severity}] ${e.ruleId}: ${e.detail.slice(0, 60)}`);
				}
			}

			lines.push("", "### Rules");
			for (const r of allRules) {
				lines.push(`  [${r.severity.toUpperCase()}] ${r.id}: ${r.description} (${r.threat})`);
			}

			const output = lines.join("\n").trim();
			ctx.ui?.notify?.(output, "info");
		},
	});
}
