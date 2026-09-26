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
 *   - `pre-commit`        runs the staged-file check: `--command`, or, only when
 *     Biome is installed in the repo, `npx --no-install biome check --staged
 *     --no-errors-on-unmatched` (without Biome, npx would resolve an unrelated
 *     package named `biome` and block every commit);
 *   - `prepare-commit-msg` adds `Pi-Session: <id>` (opt-in, `--trailer`)
 *     through `git interpret-trailers`, which places it above a `git commit -v`
 *     scissors line instead of below it, where git would cut it.
 *
 * It never switches off or overwrites a hook it did not write: a foreign hook
 * is moved beside ours as `<name>.local` (a symlink moves as a link, never
 * written through) and ours runs it first, so the project's own check keeps
 * running. It refuses outside a git work tree, and whenever `core.hooksPath`
 * leaves this repository's git directory: inside the work tree those hooks are
 * tracked (husky), elsewhere they are shared (a global hooks folder runs in
 * every repository). It also refuses a second foreign hook rather than
 * overwrite the one already kept as `<name>.local`. `--check` writes
 * nothing and exits non-zero when a hook is missing or stale.
 *
 * It ships inside this skill rather than in the package's `scripts/`, because a
 * consuming repo receives only the package's skills — and pi's tool result
 * carries a skill's directory, so the model can run this copy by absolute path
 * in any repo.
 *
 * Usage: node install-git-hooks.mjs [--root DIR] [--command CMD] [--trailer] [--check]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Any hook carrying this token is ours to overwrite; one without it is the project's. */
const MARKER = "pi-myself:";

/** The staged check used when `--command` is omitted — only valid where Biome is installed. */
const BIOME_COMMAND = "npx --no-install biome check --staged --no-errors-on-unmatched";

/** Runs the project's own hook, moved aside as `<name>.local`, before ours; its failure fails the commit. */
function chainLocal(name) {
	return `local_hook="$(dirname "$0")/${name}.local"
if [ -x "$local_hook" ]; then "$local_hook" "$@" || exit $?; fi`;
}

function preCommit(command) {
	return `#!/bin/sh
# Installed by pi-myself (commit-guardrails skill); delete this file to uninstall.
# ${MARKER} pre-commit
${chainLocal("pre-commit")}
exec ${command}
`;
}

const PREPARE_COMMIT_MSG = `#!/bin/sh
# Installed by pi-myself (commit-guardrails skill); delete this file to uninstall.
# ${MARKER} prepare-commit-msg
# Ties the commit to the pi session that produced it. Skipped when pi exported
# nothing, and for merge/squash commits whose message git generated. A trailer
# is a convenience: failing to add one never blocks the commit.
${chainLocal("prepare-commit-msg")}
[ -n "$PI_SESSION_ID" ] || exit 0
case "$2" in merge|squash) exit 0 ;; esac
git interpret-trailers --in-place --if-exists doNothing --trailer "Pi-Session: $PI_SESSION_ID" "$1" || true
`;

function parseArgs(argv) {
	const options = { root: undefined, command: undefined, trailer: false, check: false };
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

function git(root, ...args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The hooks directory git itself uses (worktrees and core.hooksPath honoured); refuses where writing it would be wrong. */
function hooksDirFor(root) {
	let topLevel;
	try {
		if (git(root, "rev-parse", "--is-inside-work-tree") !== "true") throw new Error("bare repository");
		topLevel = realpathSync(git(root, "rev-parse", "--show-toplevel"));
	} catch {
		throw new Error(`${root} is not inside a git work tree; run it from the repository (or pass --root)`);
	}
	const raw = git(root, "rev-parse", "--git-path", "hooks");
	const hooksDir = isAbsolute(raw) ? raw : resolve(root, raw);
	const gitDir = realpathSync(resolve(root, git(root, "rev-parse", "--git-common-dir")));
	const real = canonicalPath(hooksDir);
	const inside = (parent, child) => {
		const rel = relative(parent, child);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	// Only this repository's own git directory is ours to write: a hooks folder in
	// the work tree is tracked (husky), and one elsewhere is shared — a global
	// core.hooksPath runs in every repository on the machine.
	if (!inside(gitDir, real)) {
		if (inside(topLevel, real)) {
			throw new Error(
				`core.hooksPath points inside the work tree (${real}); those hooks are the repository's own files, so add the check to them by hand instead`,
			);
		}
		throw new Error(
			`core.hooksPath points outside this repository's git directory (${real}); hooks there are shared with other repositories or the whole machine, so add the check there by hand, or unset core.hooksPath for this repository`,
		);
	}
	return hooksDir;
}

/** The real path of the deepest existing ancestor, with the missing tail re-attached (macOS /var → /private/var). */
function canonicalPath(path) {
	const tail = [];
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return path;
		tail.unshift(basename(current));
		current = parent;
	}
	return join(realpathSync(current), ...tail);
}

function resolveCommand(root, command) {
	if (command !== undefined) return command;
	if (existsSync(join(root, "node_modules", ".bin", "biome"))) return BIOME_COMMAND;
	throw new Error("Biome is not installed in this repository (node_modules/.bin/biome); pass the repo's own staged check with --command");
}

function desiredHooks(command, trailer) {
	const hooks = [["pre-commit", preCommit(command)]];
	if (trailer) hooks.push(["prepare-commit-msg", PREPARE_COMMIT_MSG]);
	return hooks;
}

/** `{ exists, link, text }` for a hook path; a dangling link exists as a link with no text. */
function inspect(path) {
	try {
		const link = lstatSync(path).isSymbolicLink();
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			text = undefined;
		}
		return { exists: true, link, text };
	} catch {
		return { exists: false, link: false, text: undefined };
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = resolve(options.root ?? process.cwd());
	const hooksDir = hooksDirFor(root);
	const command = resolveCommand(root, options.command);
	const actions = [];
	let stale = false;

	// Refuse before writing anything: a foreign hook moves to `<name>.local`, so a
	// second foreign hook would overwrite the first one kept there.
	if (!options.check) {
		for (const [name, content] of desiredHooks(command, options.trailer)) {
			const path = join(hooksDir, name);
			const current = inspect(path);
			const foreign = current.exists && (current.link || !current.text?.includes(MARKER)) && current.text !== content;
			if (foreign && inspect(`${path}.local`).exists) {
				throw new Error(
					`${name}.local already holds a hook pi-myself kept earlier, and ${name} is another hook it did not write; merge the two by hand (or move one away), then rerun`,
				);
			}
		}
	}

	for (const [name, content] of desiredHooks(command, options.trailer)) {
		const path = join(hooksDir, name);
		const current = inspect(path);
		if (!current.link && current.text === content) {
			actions.push(`${options.check ? "ok       " : "unchanged"} ${name}`);
			continue;
		}
		const foreign = current.exists && (current.link || !current.text?.includes(MARKER));
		if (options.check) {
			stale = true;
			actions.push(`stale    ${name}${foreign ? " (a hook pi-myself did not write is in its place)" : ""}`);
			continue;
		}
		mkdirSync(hooksDir, { recursive: true });
		if (foreign) {
			// move, never copy or write through: a link stays a link, a script keeps its mode
			renameSync(path, `${path}.local`);
			actions.push(`kept     ${name}.local (a hook pi-myself did not write; the new ${name} runs it first)`);
		}
		writeFileSync(path, content);
		chmodSync(path, 0o755);
		actions.push(`${current.exists && !foreign ? "updated " : "created "} ${name}`);
	}

	for (const line of actions) console.log(line);
	if (stale) {
		console.error(`git hooks in ${root} are not installed or out of date; rerun the installer without --check`);
		process.exitCode = 1;
	}
}

try {
	main();
} catch (error) {
	console.error(`install-git-hooks: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
