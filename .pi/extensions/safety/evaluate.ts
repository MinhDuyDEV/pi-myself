/**
 * Safety Module — Evaluator
 *
 * Runs a RuleSet against a ToolCallContext: every applicable rule runs,
 * and the most severe verdict wins (critical > high > medium > low).
 * All fired verdicts are returned for the audit log.
 */

import { forTool, severityRank, sortBySeverity } from "./compose.js";
import type { RuleSet, ToolCallContext, Verdict } from "./types.js";

export interface EvalResult {
	/** The winning verdict, or null if all rules passed. */
	readonly verdict: Verdict | null;
	/** Every rule that fired (for audit log). */
	readonly fired: ReadonlyArray<Verdict>;
}

export function evaluate(
	rules: RuleSet,
	ctx: ToolCallContext,
): EvalResult {
	const applicable = sortBySeverity(forTool(rules, ctx.tool));
	const fired: Verdict[] = [];
	let worst: Verdict | null = null;

	for (const rule of applicable) {
		const verdict = rule.check(ctx);
		if (verdict) {
			fired.push(verdict);
			if (!worst || severityRank(verdict.severity) > severityRank(worst.severity)) {
				worst = verdict;
			}
		}
	}
	return { verdict: worst, fired };
}
