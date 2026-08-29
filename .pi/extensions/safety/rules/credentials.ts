/**
 * Safety Rules — Credential & Sensitive File Protection
 *
 * Rules: credential-variable echo block, sensitive file read/write guards,
 * bash secret-file reads, .env write warning.
 */

import { block, confirm, rule, type RuleSet } from "../types.js";

const SENSITIVE_PATH_PATTERNS = [
	/(^|\/)\.env($|\.)/,
	/(^|\/)\.ssh\//,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.netrc$/,
	/(^|\/)\.pgpass$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
];

function isSensitivePath(path: string): boolean {
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export const credentialRules: RuleSet = [
	rule({
		id: "no-credential-echo",
		description: "Block echoing credential variables to stdout/files",
		severity: "critical",
		threat: "credential-exposure",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			const lower = cmd.toLowerCase();
			if (lower.includes("example") || lower.includes("placeholder")) return null;

			// Only actual variable interpolation counts — prose that merely
			// mentions credential words (docs, TODO text) must not be blocked.
			const interpolatesCredential =
				/\$\{?[a-z0-9_]*(api[_-]?key|secret|password|token|credential)[a-z0-9_]*\}?/i.test(cmd);

			return interpolatesCredential
				? block("no-credential-echo", "critical", "credential-exposure",
					"Potential credential exposure. Shell interpolation may echo a secret to stdout or files.")
				: null;
		},
	}),
	rule({
		id: "block-sensitive-file-read",
		description: "Block reading known secret stores",
		severity: "critical",
		threat: "credential-exposure",
		targets: ["read"],
		check: (ctx) => {
			const path = ctx.path ?? "";
			return isSensitivePath(path)
				? block("block-sensitive-file-read", "critical", "credential-exposure",
					`Reading sensitive file is forbidden: ${path}.`)
				: null;
		},
	}),
	rule({
		id: "warn-sensitive-file",
		description: "Warn on writing to sensitive files",
		severity: "medium",
		threat: "credential-exposure",
		targets: ["write", "edit"],
		check: (ctx) => {
			const path = ctx.path ?? "";
			return isSensitivePath(path) || /(^|\/)\.gitconfig$/.test(path)
				? confirm("warn-sensitive-file", "medium", "credential-exposure",
					`Writing to sensitive file: ${path}. This file may contain credentials or security configuration.`)
				: null;
		},
	}),
	rule({
		id: "block-secret-read-bash",
		description: "Block shell commands that read known secret stores",
		severity: "critical",
		threat: "credential-exposure",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			const readsSensitiveFile = /\b(cat|grep|rg|sed|awk|less|more|head|tail)\b[^;&|]*(\.env($|\.)|\.npmrc|\.netrc|\.pgpass|\.aws\/credentials|\.ssh\/|id_(rsa|dsa|ecdsa|ed25519))/.test(cmd);
			return readsSensitiveFile
				? block("block-secret-read-bash", "critical", "credential-exposure",
					"Reading secret files is forbidden.")
				: null;
		},
	}),
	rule({
		id: "warn-env-write-bash",
		description: "Warn on writing to .env files via bash",
		severity: "medium",
		threat: "credential-exposure",
		targets: ["bash"],
		check: (ctx) => {
			const cmd = ctx.command!;
			return /[>|]\s*\.env/.test(cmd) || /\btee\b.*\.env/.test(cmd)
				? confirm("warn-env-write-bash", "medium", "credential-exposure",
					"Writing to .env files may expose or overwrite credentials.")
				: null;
		},
	}),
];
