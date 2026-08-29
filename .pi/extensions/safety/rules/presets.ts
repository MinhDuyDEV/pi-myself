/**
 * Safety Rules — Presets
 *
 * Default rule composition. One function to get all rules.
 */

import { merge } from "../compose.js";
import type { RuleSet } from "../types.js";
import { credentialRules } from "./credentials.js";
import { destructiveRules } from "./destructive.js";
import { gitRules } from "./git.js";
import { injectionRules } from "./injection.js";
import { networkRules } from "./network.js";
import { publishRules } from "./publish.js";
import { systemRules } from "./system.js";
import { workspaceRules } from "./workspace.js";

export interface PresetConfig {
	additionalProtectedPaths?: string[];
}

export function defaultRules(config?: PresetConfig): RuleSet {
	return merge(
		gitRules,
		credentialRules,
		destructiveRules,
		publishRules,
		systemRules,
		networkRules,
		injectionRules,
		workspaceRules(config),
	);
}
