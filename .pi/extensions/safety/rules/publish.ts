/**
 * Safety Rules — Registry Publish & Database Drop
 *
 * Ported from guardian.ts. 3 rules: npm/cargo publish (merged),
 * docker prune, database drop.
 */

import { confirm, rule, type RuleSet } from "../types.js";

export const publishRules: RuleSet = [
	rule({
		id: "warn-publish",
		description: "Publishing to a public registry",
		severity: "high",
		threat: "registry-publish",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			const npmPublish = /\b(npm|pnpm|yarn)\s+publish\b/.test(cmd);
			const cargoPublish = /\bcargo\s+publish\b/.test(cmd);
			return npmPublish || cargoPublish
				? confirm("warn-publish", "high", "registry-publish",
					"Publishing to a public registry is irreversible. Verify package name, version, and credentials.")
				: null;
		},
	}),

	rule({
		id: "warn-docker-prune",
		description: "Docker system-wide cleanup",
		severity: "high",
		threat: "data-destruction",
		targets: ["bash"],
		check: (ctx) =>
			/\bdocker\s+(system\s+prune|volume\s+prune|container\s+prune)\b/.test(ctx.command!)
				? confirm("warn-docker-prune", "high", "data-destruction",
					"Docker prune detected. Data in unnamed volumes will be permanently lost.")
				: null,
	}),
	rule({
		id: "warn-database-drop",
		description: "Database drop operations",
		severity: "high",
		threat: "data-destruction",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			return /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i.test(cmd) ||
				/\bpsql\b.*\bdrop\b/i.test(cmd) ||
				/\bmysql\b.*\bdrop\b/i.test(cmd)
				? confirm("warn-database-drop", "high", "data-destruction",
					"Database DROP detected. Ensure you have a backup before proceeding.")
				: null;
		},
	}),
];
