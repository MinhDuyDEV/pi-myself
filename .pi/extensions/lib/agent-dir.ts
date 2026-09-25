import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi's user-level locations, resolved the way pi resolves them (a support
 * module: no index.ts here, so pi never loads it as an extension).
 *
 * - `agentDir()`: `PI_CODING_AGENT_DIR` or `~/.pi/agent` — mirror of pi's
 *   `getAgentDir` (dist/config.js → `normalizePath` in dist/utils/paths.js).
 *   pi reads the variable verbatim (no trim) and expands `~`, `~/`, and — on
 *   win32 only — `~\`; an empty value falls back to the default. User skills,
 *   settings, and the default session root live under it.
 * - `defaultSessionDirName(cwd)`: the per-launch-cwd directory name of pi's
 *   default session layout (`--Users-me-repo--`) — mirror of
 *   `getDefaultSessionDirPath` (dist/core/session-manager.js).
 *
 * pi-workspace-memory is not pi: it hardcodes `~/.pi/agent/settings.json`, so code
 * mirroring pi-workspace-memory (scripts/setup-project.mjs) must not use this.
 */

export function agentDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	// pi does not trim: a whitespace-only value is a path pi will try to use.
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"))) {
		return join(home, configured.slice(2));
	}
	return configured;
}

export function defaultSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
