/**
 * Safety Module — Composition Operators
 *
 * All operators return new RuleSet instances (never mutate).
 * Think array combinators for security rules.
 */

import type { RuleSet, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
	critical: 3,
	high: 2,
	medium: 1,
	low: 0,
};

/** Severity as a number (critical=3 … low=0) for comparison. */
export function severityRank(s: Severity): number {
	return SEVERITY_ORDER[s];
}

/** Concatenate rulesets. */
export function merge(...sets: RuleSet[]): RuleSet {
	return sets.flat();
}

/** Remove rules by ID. */
export function exclude(set: RuleSet, ...ids: string[]): RuleSet {
	const idSet = new Set(ids);
	return set.filter((r) => !idSet.has(r.id));
}

/** Only rules targeting a specific tool (or "*"). */
export function forTool(set: RuleSet, tool: string): RuleSet {
	return set.filter((r) => r.targets.includes("*") || r.targets.includes(tool));
}

/** Sort rules by severity descending (critical first). Stable sort. */
export function sortBySeverity(set: RuleSet): RuleSet {
	return [...set].sort(
		(a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
	);
}

/** List all rule descriptors (for /safety command). */
export function describe(
	set: RuleSet,
): Array<{
	id: string;
	description: string;
	severity: Severity;
	threat: string;
	targets: readonly string[];
}> {
	return set.map((r) => ({
		id: r.id,
		description: r.description,
		severity: r.severity,
		threat: r.threat,
		targets: r.targets,
	}));
}
