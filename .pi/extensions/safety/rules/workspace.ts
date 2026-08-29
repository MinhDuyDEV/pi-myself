/**
 * Safety Rules — Workspace Boundary Enforcement
 *
 * Ported from sandbox.ts. Path-based rules that protect system
 * directories and enforce workspace boundaries.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { block, rule, type RuleSet } from "../types.js";

const HOME = homedir();

const PROTECTED_PATHS = [
	"/System",
	"/Library",
	"/usr",
	"/bin",
	"/sbin",
	"/etc",
	"/var",
	join(HOME, "Library"),
	join(HOME, ".ssh"),
	join(HOME, ".gnupg"),
	join(HOME, ".aws"),
	join(HOME, ".config", "ssh"),
];

// Not protected: /tmp (macOS resolves it under /private; agents need scratch
// space) and regenerable artifacts like node_modules (lockfiles rebuild them).
const DELETE_PROTECTED_PATHS = [
	join(HOME, "Desktop"),
	join(HOME, "Documents"),
	join(HOME, "Downloads"),
	join(HOME, "Pictures"),
	join(HOME, "Music"),
	join(HOME, "Movies"),
	".env",
	".env.local",
	".env.production",
];

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

function expandPath(p: string): string {
	return stripQuotes(p)
		.replace(/^~(?=\/|$)/, HOME)
		.replace(/^\$HOME(?=\/|$)/, HOME);
}

function nearestExistingPath(absolute: string): { existing: string; missingParts: string[] } | null {
	const missingParts: string[] = [];
	let current = absolute;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return null;
		missingParts.unshift(current.slice(parent.length + 1));
		current = parent;
	}
	return { existing: current, missingParts };
}

function canonicalPath(p: string, cwd: string): string {
	const expanded = expandPath(p);
	const absolute = resolve(expanded.startsWith("/") ? expanded : join(cwd, expanded));
	const nearest = nearestExistingPath(absolute);
	return nearest ? resolve(realpathSync.native(nearest.existing), ...nearest.missingParts) : absolute;
}

function matchesProtectedPath(candidate: string, protectedPath: string, cwd: string): boolean {
	const resolved = canonicalPath(candidate, cwd);
	const protectedResolved = canonicalPath(protectedPath, cwd);
	return resolved === protectedResolved || resolved.startsWith(protectedResolved + "/");
}

export function workspaceRules(config?: { additionalProtectedPaths?: string[] }): RuleSet {
	const extraPaths = config?.additionalProtectedPaths ?? [];
	const allProtected = [...PROTECTED_PATHS, ...extraPaths];

	return [
	rule({
		id: "block-protected-path-write",
		description: "Block writing to system-protected paths",
		severity: "critical",
		threat: "workspace-escape",
		targets: ["write", "edit", "bash"],
		check: (ctx) => {
			const targets: string[] = ctx.command
				? extractWriteTargets(ctx.command)
				: ctx.path
					? [ctx.path]
					: [];
			for (const t of targets) {
				for (const pp of allProtected) {
					if (matchesProtectedPath(t, pp, ctx.cwd)) {
						return block("block-protected-path-write", "critical", "workspace-escape",
							`Writing to protected system path: ${pp}. This operation is not allowed.`);
					}
				}
			}
			return null;
		},
	}),
	rule({
			id: "block-git-dir-write",
			description: "Block writing to .git/ directory",
			severity: "critical",
			threat: "sensitive-modification",
			targets: ["write", "edit", "bash"],
			check: (ctx) => {
				if (ctx.path) {
					const resolved = canonicalPath(ctx.path, ctx.cwd);
					if (/\/\.git(\/|$)/.test(resolved)) {
						return block("block-git-dir-write", "critical", "sensitive-modification",
							"Writing to .git/ directory is forbidden. This could inject malicious hooks.");
					}
				}
				if (ctx.command) {
					const targets = extractWriteTargets(ctx.command);
					for (const t of targets) {
						const resolved = canonicalPath(t, ctx.cwd);
						if (/\/\.git(\/|$)/.test(resolved)) {
							return block("block-git-dir-write", "critical", "sensitive-modification",
								"Bash command writes to .git/ directory. This could inject malicious hooks.");
						}
					}
				}
				return null;
			},
		}),
		rule({
			id: "block-protected-path-delete",
			description: "Block deleting user data directories and sensitive files",
			severity: "critical",
			threat: "data-destruction",
			targets: ["bash"],
			check: (ctx) => {
				const cmd = ctx.command!;
				if (!/\brm\s+/.test(cmd)) return null;

				const allDeleteProtected = [...allProtected, ...DELETE_PROTECTED_PATHS];
				const parts = cmd.split(/\s+/).filter((p) => !p.startsWith("-") && p !== "rm");
				for (const part of parts) {
					for (const pp of allDeleteProtected) {
						if (matchesProtectedPath(part, pp, ctx.cwd)) {
							return block("block-protected-path-delete", "critical", "data-destruction",
								`Deleting protected path: ${pp}. This operation is not allowed.`);
						}
					}
				}
				return null;
			},
		}),
	];
}

function extractWriteTargets(command: string): string[] {
	const targets: string[] = [];

	// Output redirection: > file, >> file
	const redirects = command.matchAll(/[12]?>>\s*(\S+)/g);
	for (const m of redirects) targets.push(stripQuotes(m[1]));
	const singles = command.matchAll(/(?<![>12])>\s*(\S+)/g);
	for (const m of singles) targets.push(stripQuotes(m[1]));

	// tee [-a] file
	const tee = command.match(/\btee\s+(?:-a\s+)?(\S+)/);
	if (tee) targets.push(stripQuotes(tee[1]));

	// mv/cp/install target (last argument)
	const mvcp = command.match(/\b(mv|cp|install)\s+.*\s+(\S+)\s*$/);
	if (mvcp) targets.push(stripQuotes(mvcp[2]));

	// dd of=target
	const dd = command.match(/\bdd\b.*\bof=(\S+)/);
	if (dd) targets.push(stripQuotes(dd[1]));

	// sed -i file
	const sed = command.match(/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s+)(?:'[^']*'\s+|"[^"]*"\s+)?(\S+)/);
	if (sed) targets.push(stripQuotes(sed[1]));

	// touch file
	const touch = command.match(/\btouch\s+(\S+)/);
	if (touch) targets.push(stripQuotes(touch[1]));

	return targets;
}
