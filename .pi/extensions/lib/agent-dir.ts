import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi's user-level locations, resolved the way pi resolves them (a support
 * module: no index.ts here, so pi never loads it as an extension).
 *
 * - `agentDir()`: `PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent` —
 *   mirror of pi's `getAgentDir` (dist/config.js). User skills, settings, and
 *   the default session root live under it.
 * - `defaultSessionDirName(cwd)`: the per-launch-cwd directory name of pi's
 *   default session layout (`--Users-me-repo--`) — mirror of
 *   `getDefaultSessionDirPath` (dist/core/session-manager.js).
 *
 * pi-memory-md is not pi: it hardcodes `~/.pi/agent/settings.json`, so code
 * mirroring pi-memory-md (scripts/setup-project.mjs) must not use this.
 */

export function agentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(home, ".pi", "agent");
	if (configured === "~") return home;
	return configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
}

export function defaultSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
