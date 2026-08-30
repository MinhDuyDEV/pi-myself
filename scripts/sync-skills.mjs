#!/usr/bin/env node
/**
 * sync-skills.mjs — the gate for the vendored mattpocock/skills tree.
 *
 * Sync mode (default):
 *   1. Shallow-clone the upstream default branch into a temp dir.
 *   2. Replace the vendored tree (`vendor/mattpocock-skills/`) with it, minus .git.
 *   3. Hash every promoted SKILL.md (list sourced from .claude-plugin/plugin.json)
 *      into skills-lock.json.
 *
 * Check mode (--check):
 *   Recompute everything without writing (no network); exit 1 with a drift
 *   summary when the working tree and the lock disagree.
 *
 * User-invoked skills are invoked by the human through pi's native
 * `/skill:<name>` commands (settings enableSkillCommands) — no generated
 * prompt wrappers are maintained here.
 *
 * The vendored tree is never patched here: it has no .git, so there is nothing
 * to fast-forward — the tree is always exactly what the last sync produced.
 * Process changes belong upstream in mattpocock/skills; harness changes belong
 * in .pi/.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE = join(ROOT, "vendor", "mattpocock-skills");
const MANIFEST = join(CLONE, ".claude-plugin", "plugin.json");
const LOCK = join(ROOT, "skills-lock.json");
const UPSTREAM_REPO = "mattpocock/skills";
const UPSTREAM_REF = "main";
const CHECK = process.argv.includes("--check");

function die(message) {
	console.error(`sync-skills: ${message}`);
	process.exit(1);
}

// ── vendored frontmatter (YAML subset: the fields we consume only) ─────────

function readSkill(skillMd) {
	const content = readFileSync(skillMd, "utf8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) die(`no frontmatter in ${rel(ROOT, skillMd)}`);
	const field = (name) => {
		const m = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
		if (!m) return undefined;
		let value = m[1].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1).replace(/\\(["'])/g, "$1");
		}
		return value;
	};
	return {
		name: field("name"),
		description: field("description"),
		userInvoked: field("disable-model-invocation") === "true",
	};
}

function rel(from, to) {
	return relative(from, to).split("\\").join("/");
}

// ── promoted set (source of truth: .claude-plugin/plugin.json) ──────────────

function readPromoted() {
	if (!existsSync(MANIFEST)) die(`vendored clone missing ${rel(ROOT, MANIFEST)} — is skills/ a mattpocock/skills checkout?`);
	const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
		die(`${rel(ROOT, MANIFEST)} declares no skills`);
	}
	const promoted = [];
	const seen = new Set();
	for (const entry of manifest.skills) {
		const skillMd = resolve(join(CLONE, entry.replace(/^\.\//, "")), "SKILL.md");
		if (!existsSync(skillMd)) die(`promoted skill missing SKILL.md: ${entry}`);
		const skill = readSkill(skillMd);
		if (!skill.name) die(`promoted skill has no name in frontmatter: ${entry}`);
		if (!skill.description) die(`promoted skill has no description: ${entry}`);
		if (seen.has(skill.name)) die(`duplicate promoted skill name: ${skill.name}`);
		seen.add(skill.name);
		promoted.push({ entry, skillMd, skill });
	}
	return promoted;
}

// ── lock building ────────────────────────────────────────────────────────────

function buildLock(head) {
	const promoted = readPromoted();
	const skills = {};
	for (const { skillMd, skill } of promoted) {
		skills[skill.name] = {
			skillFile: rel(ROOT, skillMd),
			computedHash: createHash("sha256").update(readFileSync(skillMd, "utf8")).digest("hex"),
			modelInvoked: !skill.userInvoked,
		};
	}
	return {
		version: 1,
		upstream: { repo: UPSTREAM_REPO, ref: UPSTREAM_REF, head },
		promotedManifest: rel(ROOT, MANIFEST),
		skillCount: promoted.length,
		skills,
	};
}

// ── upstream plumbing ────────────────────────────────────────────────────────

// ── upstream plumbing ────────────────────────────────────────────────────────

const UPSTREAM_URL = "https://github.com/mattpocock/skills.git";

function git(args, cwd, label) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		die(`git ${args.join(" ")} (${label ?? cwd ?? "."}) failed:\n${(result.stderr || result.stdout || "").trim()}`);
	}
	return result.stdout.trim();
}

function syncUpstream() {
	const temp = mkdtempSync(join(tmpdir(), "sync-skills-"));
	try {
		git(["clone", "--quiet", "--depth", "1", UPSTREAM_URL, "upstream"], temp, "clone");
		const cloneDir = join(temp, "upstream");
		const head = git(["rev-parse", "HEAD"], cloneDir, "rev-parse");
		rmSync(CLONE, { recursive: true, force: true });
		cpSync(cloneDir, CLONE, { recursive: true });
		rmSync(join(CLONE, ".git"), { recursive: true, force: true });
		return head;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

// ── modes ─────────────────────────────────────────────────────────────────────

if (CHECK) {
	if (!existsSync(LOCK)) die("check mode: skills-lock.json is missing. Run `npm run sync:skills` once to generate it.");
	const lock = JSON.parse(readFileSync(LOCK, "utf8"));
	const drift = [];

	const computed = buildLock(lock.upstream?.head ?? "unknown");
	for (const [name, meta] of Object.entries(lock.skills)) {
		const computedMeta = computed.skills[name];
		if (!computedMeta) drift.push(`${name}: in lock but not in the promoted manifest`);
		else if (computedMeta.computedHash !== meta.computedHash)
			drift.push(`${name}: SKILL.md hash drifted (locked ${meta.computedHash.slice(0, 12)}, tree ${computedMeta.computedHash.slice(0, 12)})`);
	}
	for (const name of Object.keys(computed.skills).filter((s) => !lock.skills[s])) {
		drift.push(`${name}: promoted in the vendored manifest but missing from the lock`);
	}
	if (lock.skillCount !== Object.keys(lock.skills).length) drift.push("skillCount field inconsistent with the skills map");

	if (drift.length === 0) {
		console.log(`sync-skills: clean. ${lock.skillCount} promoted skills @ ${lock.upstream.head.slice(0, 12)}.`);
	} else {
		for (const line of drift) console.error(`  ${line}`);
		console.error(`\nsync-skills: ${drift.length} drift item(s). Run \`npm run sync:skills\` to reconcile.`);
		process.exit(1);
	}
} else {
	console.log("sync-skills: cloning upstream…");
	const head = syncUpstream();
	const lockValue = buildLock(head);
	writeFileSync(LOCK, `${JSON.stringify(lockValue, null, "\t")}\n`);

	console.log(`sync-skills: vendored ${lockValue.skillCount} promoted skills @ ${head.slice(0, 12)}.`);
}