/**
 * Safety Rules — System Modifications
 *
 * Ported from guardian.ts. 1 rule: dangerous chmod.
 */

import { confirm, rule, type RuleSet } from "../types.js";

export const systemRules: RuleSet = [
	rule({
		id: "warn-chmod-dangerous",
		description: "Dangerous permission changes (world-writable, setuid)",
		severity: "medium",
		threat: "sensitive-modification",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			if (!/\bchmod\b/.test(cmd)) return null;
			return /\bchmod\s+(-R\s+)?(777|776|767|766|o\+w|a\+w)\b/.test(cmd) ||
				/\bchmod\s+.*\+s\b/.test(cmd)
				? confirm("warn-chmod-dangerous", "medium", "sensitive-modification",
					"Dangerous permission change. World-writable or setuid/setgid permissions create security risks.")
				: null;
		},
	}),
];

