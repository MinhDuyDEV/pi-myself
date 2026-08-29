
import { severityRank } from "../compose.js";
import { block, confirm, rule, type RuleSet, type Severity } from "../types.js";

const THREAT_PATTERNS: Array<{
	id: string;
	pattern: RegExp;
	severity: Severity;
	description: string;
}> = [
	// Critical: direct instruction override
	{
		id: "prompt_injection",
		pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i,
		severity: "critical",
		description: "Instruction override attempt",
	},
	{
		id: "sys_prompt_override",
		pattern: /system\s+prompt\s+override/i,
		severity: "critical",
		description: "System prompt override attempt",
	},
	{
		id: "disregard_rules",
		pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
		severity: "critical",
		description: "Rule disregard attempt",
	},
	{
		id: "bypass_restrictions",
		pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have|do\s+not\s+have)\s+(restrictions|limits|rules)/i,
		severity: "critical",
		description: "Restriction bypass attempt",
	},
	// High: deception / exfiltration
	{
		id: "deception_hide",
		pattern: /do\s+not\s+tell\s+the\s+user/i,
		severity: "high",
		description: "User deception attempt",
	},
	{
		id: "exfil_curl",
		pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/i,
		severity: "high",
		description: "Credential exfiltration via curl",
	},
	{
		id: "read_secrets",
		pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
		severity: "high",
		description: "Secret file read attempt",
	},
	// Medium: steganographic / hidden content
	{
		id: "html_comment_injection",
		pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
		severity: "medium",
		description: "Suspicious HTML comment injection",
	},
	{
		id: "hidden_div",
		pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i,
		severity: "medium",
		description: "Hidden HTML div injection",
	},
	{
		id: "translate_execute",
		pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i,
		severity: "medium",
		description: "Translate-and-execute attack",
	},
];

const INVISIBLE_CHARS = new Set([
	"\u200B", // zero-width space
	"\u200C", // zero-width non-joiner
	"\u200D", // zero-width joiner
	"\u2060", // word joiner
	"\uFEFF", // byte order mark
	"\u202A", // left-to-right embedding
	"\u202B", // right-to-left embedding
	"\u202C", // pop directional formatting
	"\u202D", // left-to-right override
	"\u202E", // right-to-left override
]);

/** Paths that get injected into the system prompt or agent context. */
const CONTEXT_FILE_PATTERNS: RegExp[] = [
	/AGENTS\.md$/i,
	/\.cursorrules$/i,
	/SOUL\.md$/i,
	/\.hermes\.md$/i,
	/HERMES\.md$/i,
	/\.pi\/agents\//,
	/\.pi\/prompts\//,
	/\.pi\/skills\//,
	/\.pi\/templates\//,
	/\.pi\/memory\//,
	/\.pi\/MEMORY\.md$/i,
	/\.pi\/APPEND_SYSTEM\.md$/,
];

export function isContextFile(path: string): boolean {
	return CONTEXT_FILE_PATTERNS.some((p) => p.test(path));
}

interface InjectionScanResult {
	/** True if any threat was detected */
	detected: boolean;
	/** Individual findings */
	findings: string[];
	/** Highest severity found */
	severity: Severity;
}

/**
 * Scan content for prompt injection patterns and invisible unicode.
 * Reusable by both safety rules (file writes) and memory injection.
 */
export function scanForInjection(
	content: string,
	_filename: string,
): InjectionScanResult {
	const findings: string[] = [];
	let maxSeverity: Severity = "low";

	for (const { id, pattern, severity, description } of THREAT_PATTERNS) {
		if (pattern.test(content)) {
			findings.push(`${id}: ${description}`);
			if (severityRank(severity) > severityRank(maxSeverity)) {
				maxSeverity = severity;
			}
		}
	}

	const invisibleFound: string[] = [];
	for (const char of INVISIBLE_CHARS) {
		if (content.includes(char)) {
			invisibleFound.push(`U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
		}
	}
	if (invisibleFound.length > 0) {
		findings.push(`invisible_unicode: ${invisibleFound.join(", ")}`);
		if (severityRank("high") > severityRank(maxSeverity)) {
			maxSeverity = "high";
		}
	}

	return {
		detected: findings.length > 0,
		findings,
		severity: findings.length > 0 ? maxSeverity : "low",
	};
}

export const injectionRules: RuleSet = [
	rule({
		id: "block-injection-context-file",
		description: "Block prompt injection in context files (AGENTS.md, .cursorrules, skills, prompts)",
		severity: "critical",
		threat: "prompt-injection",
		targets: ["write", "edit"],
		check: (ctx) => {
			const path = ctx.path ?? "";
			if (!isContextFile(path)) return null;

			const content = ctx.content;
			if (!content) return null;

			const result = scanForInjection(content, path);
			if (!result.detected) return null;

			// Critical/high findings → block
			if (result.severity === "critical" || result.severity === "high") {
				return block(
					"block-injection-context-file",
					"critical",
					"prompt-injection",
					`Potential prompt injection in context file: ${path}\n` +
					`Findings: ${result.findings.join("; ")}`,
				);
			}

			// Medium findings → confirm
			return confirm(
				"block-injection-context-file",
				"medium",
				"prompt-injection",
				`Suspicious content in context file: ${path}\n` +
				`Findings: ${result.findings.join("; ")}`,
			);
		},
	}),
];
