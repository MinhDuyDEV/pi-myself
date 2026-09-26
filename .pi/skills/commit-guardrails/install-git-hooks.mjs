#!/usr/bin/env node
/**
 * install-git-hooks — the repo-local guardrail the vendored `retro` skill asks
 * for: "a repo with no pre-commit hook and no CI job running its check command
 * is itself a finding."
 *
 * Why a hook and not a rule: a prose rule about running the linter depends on
 * the agent remembering; the hook depends on nothing. Git hooks are
 * host-agnostic (the Claude-specific shapes upstream ships do not apply here),
 * and `PI_SESSION_ID` is already exported to bash, so the commit-trailer hook
 * is one line of work rather than a new mechanism.
 *
 * Two hooks, both owning their file outright:
 *   - `pre-commit`        runs the staged-file check (`--command`, default
 *     `npx --no-install biome check --staged --no-errors-on-unmatched`, so a
 *     consumer needs no npm script of its own);
 *   - `prepare-commit-msg` appends `Pi-Session: <id>` (opt-in, `--trailer`),
 *     which ties a commit back to the session that produced it.
 *
 * Idempotent, and it never destroys a hook it did not write: a foreign hook is
 * preserved beside it as `<name>.local` (the same convention `setup-project.mjs`
 * uses for an edited APPEND_SYSTEM.md) before being replaced. `--check` writes
 * nothing and exits non-zero when a hook is missing or stale, which is what the
 * test suite runs.
 *
 * It ships inside this skill rather than in the package's `scripts/`, because a
 * consuming repo receives only the package's skills — and pi's tool result
 * carries a skill's directory, so the model can run this copy by absolute path
 * in any repo.
 *
 * Usage: node install-git-hooks.mjs [--root DIR] [--command CMD] [--trailer] [--check]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Any hook carrying this token is ours to overwrite; one without it is the project's. */
const MARKER = "pi-myself:";

/**
 * What the pre-commit hook runs. The default works in any repo that has Biome
 * and does not depend on the host repo declaring an npm script; a repo with its
 * own gate passes `--command` (this repo uses `npm run --silent lint:staged`).
 */
const DEFAULT_COMMAND = "npx --no-install biome check --staged --no-errors-on-unmatched";

function preCommit(command) {
	return `#!/bin/sh
# Installed by pi-myself (commit-guardrails skill); delete this file to uninstall.
# ${MARKER} pre-commit
set -e
exec ${command}
`;
}

const PREPARE_COMMIT_MSG = `#!/bin/sh
# Installed by pi-myself (commit-guardrails skill); delete this file to uninstall.
# ${MARKER} prepare-commit-msg
# Ties the commit to the pi session that produced it. Skipped when pi exported
# nothing, and for merge/squash commits whose message git generated.
[ -n "$PI_SESSION_ID" ] || exit 0
case "$2" in merge|squash) exit 0 ;; esac
grep -q '^Pi-Session: ' "$1" && exit 0
printf '\\nPi-Session: %s\\n' "$PI_SESSION_ID" >> "$1"
`;

function parseArgs(argv) {
	const options = { root: undefined, command: DEFAULT_COMMAND, trailer: false, check: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--trailer") options.trailer = true;
		else if (arg === "--check") options.check = true;
		else if (arg === "--root" || arg === "--command") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
			if (arg === "--root") options.root = value;
			else options.command = value;
			index += 1;
		} else throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

/** The hooks directory git itself would use, so a worktree or a custom core.hooksPath is honoured. */
function hooksDirFor(root) {
	try {
		const raw = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
		return raw.startsWith("/") ? raw : resolve(root, raw);
	} catch {
		return join(root, ".git", "hooks");
	}
}

function desiredHooks(options) {
	const hooks = [["pre-commit", preCommit(options.command)]];
	if (options.trailer) hooks.push(["prepare-commit-msg", PREPARE_COMMIT_MSG]);
	return hooks;
}

function readHook(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = resolve(options.root ?? process.cwd());
	const hooksDir = hooksDirFor(root);
	const actions = [];

	for (const [name, content] of desiredHooks(options)) {
		const path = join(hooksDir, name);
		const current = readHook(path);
		if (current === content) {
			actions.push(`${options.check ? "ok       " : "unchanged"} ${name}`);
			continue;
		}
		if (current !== undefined && !current.includes(MARKER)) {
			actions.push(`${options.check ? "stale    " : "backup   "} ${name}.local (kept: a hook pi-myself did not write)`);
			if (!options.check) writeFileSync(`${path}.local`, current);
		}
		if (options.check) {
			actions.push(`stale    ${name} (run: npm run hooks:install)`);
			continue;
		}
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(path, content);
		chmodSync(path, 0o755);
		actions.push(`${current === undefined ? "created " : "updated "} ${name}`);
	}

	for (const line of actions) console.log(line);

	if (options.check) {
		const stale = actions.some((line) => line.startsWith("stale") || line.startsWith("backup"));
		if (stale) {
			console.error(`git hooks in ${root} are not installed; run: npm run hooks:install`);
			process.exitCode = 1;
		}
	}
}

try {
	main();
} catch (error) {
	console.error(`install-git-hooks: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
