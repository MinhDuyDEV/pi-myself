/**
 * Safety Module — Core Types
 *
 * Domain vocabulary for the safety system. Every concept is named
 * from the security domain, not the implementation.
 */

export type VerdictKind = "block" | "confirm" | "allow";

export type Severity = "critical" | "high" | "medium" | "low";

export type ThreatCategory =
	| "credential-exposure"
	| "data-destruction"
	| "data-integrity"
	| "privilege-escalation"
	| "remote-code-execution"
	| "workspace-escape"
	| "history-rewrite"
	| "sensitive-modification"
	| "network-exfiltration"
	| "registry-publish"
	| "prompt-injection";

export interface Verdict {
	readonly kind: VerdictKind;
	readonly ruleId: string;
	readonly severity: Severity;
	readonly threat: ThreatCategory;
	readonly message: string;
}

/** Convenience constructors */
export function block(
	ruleId: string,
	severity: Severity,
	threat: ThreatCategory,
	message: string,
): Verdict {
	return { kind: "block", ruleId, severity, threat, message };
}

export function confirm(
	ruleId: string,
	severity: Severity,
	threat: ThreatCategory,
	message: string,
): Verdict {
	return { kind: "confirm", ruleId, severity, threat, message };
}

export interface ToolCallContext {
	/** Tool being invoked */
	readonly tool: string;
	/** Normalized bash command (whitespace-collapsed, trimmed). Undefined for non-bash. */
	readonly command?: string;
	/** File path for write/edit tools */
	readonly path?: string;
	/** File content being written/edited. Extracted from write.content or edit.edits[].newText. */
	readonly content?: string;
	/** Primary URL for URL-based tools. */
	readonly url?: string;
	/** Multiple URLs for URL-based tools. */
	readonly urls?: readonly string[];
	/** Working directory */
	readonly cwd: string;
	/** Session identifier */
	readonly sessionId: string;
}

/** A rule is a pure function: context in, verdict out, null = no opinion */
export type RuleFn = (ctx: ToolCallContext) => Verdict | null;

export interface Rule {
	readonly id: string;
	readonly description: string;
	readonly severity: Severity;
	readonly threat: ThreatCategory;
	/** Which tools this rule applies to. "*" = all. */
	readonly targets: ReadonlyArray<string>;
	/** The actual check */
	readonly check: RuleFn;
}

/** Factory — minimal boilerplate to create a rule */
export function rule(opts: {
	id: string;
	description: string;
	severity: Severity;
	threat: ThreatCategory;
	targets: string[];
	check: RuleFn;
}): Rule {
	return Object.freeze(opts);
}

export type RuleSet = ReadonlyArray<Rule>;
