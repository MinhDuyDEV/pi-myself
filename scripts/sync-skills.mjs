#!/usr/bin/env node
/**
 * sync-skills.mjs — the gate for the vendored mattpocock/skills tree.
 *
 * Sync mode (default):
 *   1. Shallow-clone upstream's `main` (the ref the lock records) into a temp dir.
 *   2. Replace the vendored tree (`vendor/mattpocock-skills/`) with it, minus
 *      .git: the copy is staged beside the tree and swapped in by rename, so a
 *      sync that fails or is interrupted never leaves half a tree. An
 *      interrupted run may leave a `vendor/.sync-skills-*` folder behind; once
 *      `--check` is clean it can be deleted.
 *   3. Hash every registered SKILL.md into skills-lock.json: the promoted set
 *      (listed in .claude-plugin/plugin.json) plus the beta set (every skill
 *      under skills/in-progress/).
 *
 *   4. Digest the whole vendored tree into skills-lock.json's `vendorTree`:
 *      every file's sha256 by sorted relative path (a symlink as its link
 *      text), the file count, and one digest over the list. A skill's
 *      references are loaded by the model too, so an edit to any vendored file
 *      is drift, not only an edit to a SKILL.md.
 *
 * Check mode (--check):
 *   Recompute everything without writing (no network); exit 1 with a drift
 *   summary naming the first changed, added, or missing paths when the working
 *   tree and the lock disagree.
 *
 * Relock mode (--relock):
 *   Add the whole-tree digest to a lock written before it existed, keeping the
 *   recorded upstream head (no network). It refuses — writing nothing — when
 *   any registered SKILL.md differs from its recorded hash, and, once the lock
 *   has a digest, when any vendored file differs: it never blesses a change.
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
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const RELOCK = process.argv.includes("--relock");

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

// ── registered set ───────────────────────────────────────────────────────────
// Two buckets: "promoted" (source of truth: .claude-plugin/plugin.json — the
// engineering + productivity trees) and "beta" (every SKILL.md under
// skills/in-progress/, which upstream keeps out of the plugin on purpose).
// misc/ and deprecated/ stay unregistered.

const BETA_DIR = join(CLONE, "skills", "in-progress");

function readRegistered() {
	if (!existsSync(MANIFEST)) die(`vendored clone missing ${rel(ROOT, MANIFEST)} — is skills/ a mattpocock/skills checkout?`);
	const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
		die(`${rel(ROOT, MANIFEST)} declares no skills`);
	}
	const registered = [];
	const seen = new Set();
	const add = (entry, bucket) => {
		const skillMd = resolve(join(CLONE, entry.replace(/^\.\//, "")), "SKILL.md");
		if (!existsSync(skillMd)) die(`${bucket} skill missing SKILL.md: ${entry}`);
		const skill = readSkill(skillMd);
		if (!skill.name) die(`${bucket} skill has no name in frontmatter: ${entry}`);
		if (!skill.description) die(`${bucket} skill has no description: ${entry}`);
		if (seen.has(skill.name)) die(`duplicate skill name across buckets: ${skill.name}`);
		seen.add(skill.name);
		registered.push({ entry, skillMd, skill, bucket });
	};
	for (const entry of manifest.skills) add(entry, "promoted");
	if (existsSync(BETA_DIR)) {
		for (const name of readdirSync(BETA_DIR).sort()) {
			if (existsSync(join(BETA_DIR, name, "SKILL.md"))) add(`./skills/in-progress/${name}`, "beta");
		}
	}
	return registered;
}

// ── lock building ────────────────────────────────────────────────────────────

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** [relative path, sha256] for every file under `dir`; a symlink hashes as its link text, never followed. */
function treeFiles(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		const relPath = `${prefix}${entry.name}`;
		if (entry.isSymbolicLink()) out.push([relPath, sha256(`symlink:${readlinkSync(path)}`)]);
		else if (entry.isDirectory()) out.push(...treeFiles(path, `${relPath}/`));
		else out.push([relPath, sha256(readFileSync(path))]);
	}
	return out;
}

/** `{ fileCount, digest, files }` for the vendored tree: `digest` hashes the sorted `path NUL sha256` lines. */
function treeDigest() {
	const entries = treeFiles(CLONE).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const digest = sha256(entries.map(([path, hash]) => `${path}\0${hash}\n`).join(""));
	return { fileCount: entries.length, digest, files: Object.fromEntries(entries) };
}

const SHOWN_PATHS = 5;

function firstPaths(paths) {
	const shown = paths.slice(0, SHOWN_PATHS).join(", ");
	return paths.length > SHOWN_PATHS ? `${shown}, … and ${paths.length - SHOWN_PATHS} more` : shown;
}

/** Drift lines between the locked tree digest and the tree on disk. */
function treeDrift(locked, computed) {
	const root = rel(ROOT, CLONE);
	if (locked === undefined) return ["vendorTree: the lock has no whole-tree digest (run node scripts/sync-skills.mjs --relock)"];
	if (!locked.files || !locked.digest)
		return [
			"vendorTree: the lock's tree section is incomplete (edited by hand?); restore skills-lock.json from git or run npm run sync:skills",
		];
	if (locked.digest === computed.digest && locked.fileCount === computed.fileCount) return [];
	const changed = [];
	const missing = [];
	for (const [path, hash] of Object.entries(locked.files)) {
		if (!(path in computed.files)) missing.push(`${root}/${path}`);
		else if (computed.files[path] !== hash) changed.push(`${root}/${path}`);
	}
	const added = Object.keys(computed.files)
		.filter((path) => !(path in locked.files))
		.map((path) => `${root}/${path}`);
	const drift = [];
	if (changed.length > 0) drift.push(`vendorTree: ${changed.length} file(s) changed: ${firstPaths(changed)}`);
	if (added.length > 0) drift.push(`vendorTree: ${added.length} file(s) added: ${firstPaths(added)}`);
	if (missing.length > 0) drift.push(`vendorTree: ${missing.length} file(s) missing: ${firstPaths(missing)}`);
	if (drift.length === 0) drift.push("vendorTree: digest or fileCount disagrees with the lock's own file list (a hand-edited lock?)");
	return drift;
}

function buildLock(head) {
	const registered = readRegistered();
	const skills = {};
	for (const { skillMd, skill, bucket } of registered) {
		skills[skill.name] = {
			skillFile: rel(ROOT, skillMd),
			computedHash: createHash("sha256").update(readFileSync(skillMd, "utf8")).digest("hex"),
			modelInvoked: !skill.userInvoked,
			bucket,
		};
	}
	return {
		version: 2,
		upstream: { repo: UPSTREAM_REPO, ref: UPSTREAM_REF, head },
		promotedManifest: rel(ROOT, MANIFEST),
		betaDir: rel(ROOT, BETA_DIR),
		skillCount: registered.length,
		skills,
		vendorTree: treeDigest(),
	};
}

/** Drift lines between the lock's registered skills and the tree's. */
function skillDrift(lock, computed) {
	const drift = [];
	for (const [name, meta] of Object.entries(lock.skills)) {
		const computedMeta = computed.skills[name];
		if (!computedMeta) drift.push(`${name}: in lock but neither promoted in the manifest nor present under in-progress/`);
		else if (computedMeta.computedHash !== meta.computedHash)
			drift.push(
				`${name}: SKILL.md hash drifted (locked ${meta.computedHash.slice(0, 12)}, tree ${computedMeta.computedHash.slice(0, 12)})`,
			);
		else if (computedMeta.bucket !== meta.bucket) drift.push(`${name}: bucket moved (${meta.bucket} → ${computedMeta.bucket})`);
	}
	for (const name of Object.keys(computed.skills).filter((s) => !lock.skills[s])) {
		drift.push(`${name}: ${computed.skills[name].bucket} in the vendored tree but missing from the lock`);
	}
	if (lock.skillCount !== Object.keys(lock.skills).length) drift.push("skillCount field inconsistent with the skills map");
	return drift;
}

function writeLock(lockValue) {
	writeFileSync(LOCK, `${JSON.stringify(lockValue, null, "\t")}\n`);
}

// ── upstream plumbing ────────────────────────────────────────────────────────

const UPSTREAM_URL = "https://github.com/mattpocock/skills.git";

/** Throws rather than exiting: an exit here skipped the caller's `finally`, so a
 * failed clone leaked its temp folder and never said what it left behind. */
function git(args, cwd, label) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} (${label ?? cwd ?? "."}) failed:\n${(result.stderr || result.stdout || "").trim()}`);
	}
	return result.stdout.trim();
}

function syncUpstream() {
	const temp = mkdtempSync(join(tmpdir(), "sync-skills-"));
	try {
		const cloneDir = join(temp, "upstream");
		let head;
		try {
			// `--branch`: the lock records UPSTREAM_REF, so that is what is cloned;
			// a bare clone takes whatever upstream's default branch is at the time.
			git(["clone", "--quiet", "--depth", "1", "--branch", UPSTREAM_REF, UPSTREAM_URL, "upstream"], temp, "clone");
			head = git(["rev-parse", "HEAD"], cloneDir, "rev-parse");
		} catch (error) {
			throw new Error(`${error.message}\nthe vendored tree was left as it was`);
		}
		replaceVendoredTree(cloneDir);
		return head;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

/** Replace the vendored tree with `source` minus its .git, never leaving half a
 * tree. Deleting first and copying after meant a failed or interrupted copy
 * left an empty or partial tree. The copy is staged in a work folder beside the
 * tree (the same filesystem, so each rename is one atomic step); only a complete
 * copy is swapped in, and the old tree is moved aside first and deleted last.
 * Throws, with the state of the tree in the message, when it cannot finish. */
function replaceVendoredTree(source) {
	const tree = rel(ROOT, CLONE);
	let work;
	try {
		// the first sync of a repository has no vendor/ folder to stage beside
		mkdirSync(dirname(CLONE), { recursive: true });
		work = mkdtempSync(join(dirname(CLONE), ".sync-skills-"));
		// verbatimSymlinks: upstream's AGENTS.md -> CLAUDE.md is a relative link;
		// the default (false) rewrites it to an absolute path inside the temp
		// clone, which dangles the moment the temp dir is removed.
		cpSync(source, join(work, "new"), {
			recursive: true,
			verbatimSymlinks: true,
			filter: (path) => path !== join(source, ".git"),
		});
	} catch (error) {
		if (work) rmSync(work, { recursive: true, force: true });
		throw new Error(`could not stage the new tree beside ${tree} (${error.message}); the vendored tree was left as it was`);
	}
	const previous = join(work, "previous");
	try {
		if (existsSync(CLONE)) renameSync(CLONE, previous);
		renameSync(join(work, "new"), CLONE);
	} catch (error) {
		// throws, keeping the work folder, when the previous tree cannot go back
		if (existsSync(previous)) movePreviousTreeBack(previous, `could not swap in the new tree (${error.message})`);
		rmSync(work, { recursive: true, force: true });
		throw new Error(`could not swap in the new tree (${error.message}); the vendored tree was left as it was`);
	}
	try {
		rmSync(work, { recursive: true, force: true });
	} catch (error) {
		// the new tree is in place; only the cleanup is left
		console.error(`sync-skills: the previous tree could not be deleted (${error.message}); delete ${rel(ROOT, work)} by hand`);
	}
}

/** After a failed swap moved the tree aside to `previous`: move it back, or
 * throw naming where it is. Deleting the work folder at that point would delete
 * the only copy, so a tree folder that reappeared meanwhile (another writer) is
 * never overwritten or cleaned up around: the previous tree stays put. */
function movePreviousTreeBack(previous, failure) {
	const tree = rel(ROOT, CLONE);
	const stranded = `the previous tree is at ${rel(ROOT, previous)}: move it to ${tree}, or run git checkout -- ${tree}`;
	if (existsSync(CLONE)) throw new Error(`${failure}, and ${tree} was recreated meanwhile; ${stranded}`);
	try {
		renameSync(previous, CLONE);
	} catch (error) {
		throw new Error(`${failure}, nor could the previous tree be moved back (${error.message}); ${stranded}`);
	}
}

// ── modes ─────────────────────────────────────────────────────────────────────

if (CHECK || RELOCK) {
	if (!existsSync(LOCK)) die("skills-lock.json is missing. Run `npm run sync:skills` once to generate it.");
	const lock = JSON.parse(readFileSync(LOCK, "utf8"));
	const computed = buildLock(lock.upstream?.head ?? "unknown");
	const drift = skillDrift(lock, computed);

	if (RELOCK) {
		// Once the lock digests the tree, any vendored change is drift: blessing
		// it here would re-open, one command away, the gap the digest closed.
		// Relock exists only to add the digest to a lock written before it.
		// Only a lock with no tree section at all predates the digest; a section
		// missing its digest or file list was edited by hand.
		if (lock.vendorTree !== undefined && !(lock.vendorTree?.digest && lock.vendorTree?.files)) {
			die(
				"relock refused, nothing written: skills-lock.json's vendorTree section is incomplete (edited by hand?). Restore the lock from git, or run `npm run sync:skills`.",
			);
		}
		if (lock.vendorTree !== undefined) drift.push(...treeDrift(lock.vendorTree, computed.vendorTree));
		if (drift.length > 0) {
			for (const line of drift) console.error(`  ${line}`);
			die(
				`relock refused, nothing written: the vendored tree differs from the lock in ${drift.length} item(s), and a relock never blesses a change. Restore the files (git checkout -- ${rel(ROOT, CLONE)}), or run \`npm run sync:skills\` to re-vendor upstream.`,
			);
		}
		if (lock.vendorTree !== undefined) {
			console.log("sync-skills: the lock already digests the tree and nothing drifted; relock wrote nothing.");
			process.exit(0);
		}
		writeLock(computed);
		console.log(
			`sync-skills: relocked ${computed.vendorTree.fileCount} vendored files (digest ${computed.vendorTree.digest.slice(0, 12)}) @ ${computed.upstream.head.slice(0, 12)}; every registered SKILL.md matched its recorded hash.`,
		);
	} else {
		drift.push(...treeDrift(lock.vendorTree, computed.vendorTree));
		if (drift.length === 0) {
			const beta = Object.values(lock.skills).filter((s) => s.bucket === "beta").length;
			console.log(
				`sync-skills: clean. ${lock.skillCount} registered skills (${lock.skillCount - beta} promoted + ${beta} beta), ${lock.vendorTree.fileCount} vendored files (digest ${lock.vendorTree.digest.slice(0, 12)}) @ ${lock.upstream.head.slice(0, 12)}.`,
			);
		} else {
			for (const line of drift) console.error(`  ${line}`);
			console.error(
				`\nsync-skills: ${drift.length} drift item(s). Restore the vendored files (git checkout -- ${rel(ROOT, CLONE)}) or run \`npm run sync:skills\` to reconcile.`,
			);
			process.exit(1);
		}
	}
} else {
	console.log("sync-skills: cloning upstream…");
	let head;
	try {
		head = syncUpstream();
	} catch (error) {
		// the lock is written only after a sync succeeds
		die(`${error.message}\n(skills-lock.json was not changed)`);
	}
	const lockValue = buildLock(head);
	writeLock(lockValue);

	console.log(`sync-skills: vendored ${lockValue.skillCount} registered skills @ ${head.slice(0, 12)}.`);
}
