#!/usr/bin/env node
/**
 * setup-project — provision a repository for pi-myself.
 *
 * Why: pi-task discovers task roles only in its bundled defaults,
 * ~/.pi/agent/agents, and <repo>/.pi/agents — never inside an installed
 * package — so the roles are copied into the project. Nothing else is: skills,
 * prompts, and extensions reach the session through the package manifest, and
 * the workflow policy is injected by the `policy` extension (ADR 0003). Older
 * runs copied that policy into `.pi/APPEND_SYSTEM.md`; this script removes such
 * a copy (an edited one is kept as APPEND_SYSTEM.md.local) and never touches a
 * repository's own APPEND_SYSTEM.md. settings.json is not touched either: pi
 * defaults `enableSkillCommands` to true, and it only drives autocomplete. The
 * one file a run may add to is .gitignore: a consuming repository ignores its
 * own .pi/ wholesale (ADR 0008), and the line is appended once, never edited.
 *
 * A rerun is an UPDATE, not a merge. The package owns each role file — the
 * roster, the body, and every frontmatter line that shapes what a child may do
 * (tools, skills, disallowed_tools, readonly, proactive) — so a harness fix
 * lands without anyone re-reading a diff. Two things survive deliberately:
 *
 *   - the project-owned fields (`model`, `thinking`, `max_turns`) keep the
 *     project's value when the project chose it, i.e. when it differs from what
 *     the package shipped last time; a value the project never touched follows
 *     the package, so a tier-model change reaches every repo;
 *   - a copy the project changed in any other line is saved beside itself as
 *     `<name>.local` before it is replaced (the previous backup is overwritten).
 *
 * The baseline (`.pi/pi-myself-provisioned.json`) records, per role, the sha256
 * of the package file with the project-owned lines removed plus the values the
 * package shipped for those fields. It is what tells "the project edited this"
 * apart from "this is the package's own previous version" — only the former
 * earns a backup — and what makes a role the package stopped shipping
 * removable. Without a baseline entry, a copy differing from the package in
 * anything but the project-owned fields is backed up: nothing is dropped
 * silently. A symlinked role is never written through: the link is kept as
 * `<name>.local` and a regular file takes its place. A role the project added
 * is never touched. Run from any directory; the target is the argument or the
 * current working directory.
 *
 * `--check` (anywhere in argv) is the dry run: every line a real run would
 * print, prefixed `[check]`, and nothing written — no role, no `.local`, no
 * baseline, no APPEND_SYSTEM.md removal. It exits 1 when a real run would
 * change anything, 0 when the project is current.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");
const packagePi = join(packageRoot, ".pi");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const targetRoot = resolve(argv.find((arg) => arg !== "--check") ?? process.cwd());
const targetPi = join(targetRoot, ".pi");

/** Frontmatter a project owns per role; every other line comes from the package. */
export const PROJECT_OWNED_FIELDS = Object.freeze(["model", "thinking", "max_turns"]);

/**
 * ADR 0008: a consuming repository's `.pi/` is local state — the declaration,
 * the baseline, the roles, and pi's runtime state — so one ignore line covers
 * all of it. `.pi/*` rather than `.pi/`: the directory itself stays includable,
 * so a team that wants the declaration shared can add `!.pi/settings.json`
 * without fighting the pattern. The package checkout is exempt, because there
 * `.pi/` is the package source.
 */
const GITIGNORE_MARKER = "# pi-myself: .pi/ is local harness state, not source (ADR 0008)";
const GITIGNORE_LINE = ".pi/*";
/** Any of these already covers the repository's `.pi/`. */
export const GITIGNORE_COVERING_LINES = Object.freeze([".pi/*", "/.pi/*", ".pi/", "/.pi/", ".pi"]);

/** Does this `.gitignore` text already ignore the repository's `.pi/`? */
export function ignoresPiState(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.some((line) => !line.startsWith("#") && GITIGNORE_COVERING_LINES.includes(line));
}

/**
 * Whether two roots are the same directory. A string comparison is not enough:
 * `/var/...` and `/private/var/...` are one directory on macOS, so a checkout
 * reached through a symlink would stop looking like the package and the run
 * would ignore the package's own source.
 */
function sameRoot(a, b) {
	try {
		return realpathSync.native(a) === realpathSync.native(b);
	} catch {
		return a === b;
	}
}

/**
 * The workflow policy's opening line (the policy extension's STALE_COPY_MARKER;
 * a test pins the two together). A project's APPEND_SYSTEM.md carrying it is a
 * copy an older run of this script provisioned.
 */
const STALE_COPY_MARKER = "Runtime playbook: which process owns the work";

const agentsSource = join(packagePi, "agents");
if (!existsSync(agentsSource)) {
	console.error(`setup-project: no .pi/agents next to this script (${packagePi}) — run from an unmodified pi-myself package`);
	process.exit(1);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Every write goes through these: under --check they only count as a pending change. */
let pendingWrites = 0;
const fsWrite = {
	mkdir(path) {
		if (!CHECK) mkdirSync(path, { recursive: true });
	},
	/** Never through a link at the file's own path: a link at `path` (an earlier
	 * backup of a linked role, say) is removed, not followed. A linked `.pi/` or
	 * `.pi/agents/` folder is written into, and step 0 says so. */
	write(path, text) {
		pendingWrites++;
		if (CHECK) return;
		if (lstatExists(path) && lstatSync(path).isSymbolicLink()) rmSync(path);
		writeFileSync(path, text);
	},
	rename(from, to) {
		pendingWrites++;
		if (!CHECK) renameSync(from, to);
	},
	remove(path) {
		pendingWrites++;
		if (!CHECK) rmSync(path);
	},
};
const LINE_PREFIX = CHECK ? "[check] " : "";

/** pi-task only catalogs .md files with frontmatter — same filter here. */
function isAgentFile(path) {
	return existsSync(path) && /^---\n/.test(readFileSync(path, "utf8"));
}

/** `{ block, rest }`: the frontmatter lines and everything after the closing `---`, or undefined when the text has none. */
function splitFrontmatter(text) {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	if (match === null) return undefined;
	return { block: match[1], rest: text.slice(match[0].length) };
}

/** Value of a frontmatter field, or undefined when the field is absent or empty. */
export function frontmatterField(content, name) {
	const block = splitFrontmatter(content)?.block;
	if (block === undefined) return undefined;
	return new RegExp(`^${name}:[ \t]*(.*)$`, "m").exec(block)?.[1]?.trim() || undefined;
}

/** The role without its project-owned lines: what an edit is measured against. */
export function normalizedHash(content) {
	const parts = splitFrontmatter(content);
	if (parts === undefined) return sha256(content);
	const kept = parts.block.split("\n").filter((line) => !PROJECT_OWNED_FIELDS.some((field) => line.startsWith(`${field}:`)));
	return sha256(`---\n${kept.join("\n")}\n---${parts.rest}`);
}

/** The package's role with `values` substituted into its frontmatter; a field the package lacks is inserted. */
export function withFields(source, values) {
	const parts = splitFrontmatter(source);
	if (parts === undefined) return source;
	let block = parts.block;
	for (const [field, value] of Object.entries(values)) {
		const line = new RegExp(`^${field}:[ \t]*.*$`, "m");
		block = line.test(block) ? block.replace(line, `${field}: ${value}`) : `${block}\n${field}: ${value}`;
	}
	return `---\n${block}\n---${parts.rest}`;
}

/** What the package shipped for one role: the normalized hash and the project-owned values. */
function shippedRecord(source) {
	const record = { sha256: normalizedHash(source) };
	for (const field of PROJECT_OWNED_FIELDS) {
		const value = frontmatterField(source, field);
		if (value !== undefined) record[field] = value;
	}
	return record;
}

const BASELINE = join(targetPi, "pi-myself-provisioned.json");
const hadBaseline = existsSync(BASELINE);

/**
 * `files` maps a role to the record the package shipped at the last run. A bare
 * string is the older format: the sha256 of the package file as shipped, with
 * no record of its project-owned values.
 */
function readBaseline() {
	if (!hadBaseline) return {};
	try {
		return JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
	} catch {
		console.log(
			`warning: ${BASELINE} is not valid JSON — no copy can be told apart from the package's own, so every differing copy is backed up`,
		);
		return {};
	}
}

const shippedBefore = readBaseline();
const shippedNow = {};

/** Did the project change `existing` in a line it does not own, relative to what the package shipped before? */
function editedByProject(existing, previous, source) {
	if (typeof previous === "string") {
		// older baseline: an exact copy of the old package file is untouched; so is
		// a copy that already matches the new package apart from project-owned lines
		return sha256(existing) !== previous && normalizedHash(existing) !== normalizedHash(source);
	}
	if (previous === undefined) return normalizedHash(existing) !== normalizedHash(source);
	return normalizedHash(existing) !== previous.sha256;
}

/** The project-owned values the project chose: those that differ from what the package shipped before. */
function projectChoices(existing, previous) {
	const choices = {};
	for (const field of PROJECT_OWNED_FIELDS) {
		const value = frontmatterField(existing, field);
		if (value === undefined) continue;
		if (typeof previous === "string") {
			// older baseline: an exact copy of the old package file chose nothing
			if (sha256(existing) === previous) continue;
		} else if (previous !== undefined && value === previous[field]) continue;
		choices[field] = value;
	}
	return choices;
}

/** [outcome, note?] for one packaged role. */
function syncAgent(sourcePath, target, rel) {
	const source = readFileSync(sourcePath, "utf8");
	const previous = shippedBefore[rel];
	shippedNow[rel] = shippedRecord(source);

	const link = lstatExists(target) && lstatSync(target).isSymbolicLink();
	const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	if (existing === undefined && !link) {
		fsWrite.mkdir(join(target, ".."));
		fsWrite.write(target, source);
		return previous === undefined ? ["created"] : ["created", "was deleted in this project; the roster is harness-owned"];
	}
	const choices = existing === undefined ? {} : projectChoices(existing, previous);
	const content = existing === undefined ? source : withFields(source, choices);
	// A kept value that differs from the package's is named on every run: an older
	// baseline cannot tell a choice from a value an older version failed to update.
	const kept = Object.entries(choices)
		.filter(([field, value]) => value !== frontmatterField(source, field))
		.map(([field, value]) => `kept your ${field}: ${value}; the package ships ${frontmatterField(source, field) ?? "none"}`);
	const withKept = (note) => [note, ...kept].filter(Boolean).join("; ") || undefined;
	if (!link && existing === content) return ["unchanged", withKept(undefined)];
	if (link) {
		// never write through a link: keep the project's link, put a file in its place
		fsWrite.rename(target, `${target}.local`);
		fsWrite.write(target, content);
		return ["updated", withKept(`your symlink kept as ${basename(target)}.local`)];
	}
	const edited = editedByProject(existing, previous, source);
	if (edited) fsWrite.write(`${target}.local`, existing);
	fsWrite.write(target, content);
	return ["updated", withKept(edited ? `your copy saved as ${basename(target)}.local` : undefined)];
}

/** `<path>.local`, or the first free `<path>.local.N` when an earlier backup that differs is already there. */
function freeBackupPath(path, text) {
	let candidate = `${path}.local`;
	for (let n = 2; lstatExists(candidate); n++) {
		if (!lstatSync(candidate).isSymbolicLink() && readFileSync(candidate, "utf8") === text) break;
		candidate = `${path}.local.${n}`;
	}
	return candidate;
}

/** A dangling symlink fails existsSync; lstat still sees it. */
function lstatExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

const counts = { created: 0, updated: 0, removed: 0, kept: 0, unchanged: 0 };
function record([outcome, note], label) {
	counts[outcome]++;
	if (outcome !== "unchanged" || note) console.log(`${LINE_PREFIX}${outcome.padEnd(8)} ${label}${note ? ` (${note})` : ""}`);
}

// 0. a linked .pi/ or .pi/agents/ folder is the project's chosen location (roles
// shared across repositories, say): it is written into, but never silently.
for (const folder of [targetPi, join(targetPi, "agents")]) {
	if (!existsSync(folder)) continue;
	const real = realpathSync.native(folder);
	const root = realpathSync.native(targetRoot);
	const rel = relative(root, real);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		console.log(
			`note: ${relative(targetRoot, folder)} resolves to ${real}, outside this repository; ${CHECK ? "a run writes" : "provisioning writes"} there`,
		);
	}
}

// 1. task roles — the package owns every line except the project's own choices
fsWrite.mkdir(join(targetPi, "agents"));
const packaged = readdirSync(agentsSource).filter((name) => name.endsWith(".md") && isAgentFile(join(agentsSource, name)));
for (const entry of packaged) {
	const rel = `agents/${entry}`;
	record(syncAgent(join(agentsSource, entry), join(targetPi, rel), rel), rel);
}

// 2. roles the package stopped shipping — an untouched copy goes; an edited one
// is the project's now and is left in place. Either way the baseline forgets it.
for (const [rel, previous] of Object.entries(shippedBefore)) {
	if (!rel.startsWith("agents/") || packaged.includes(rel.slice("agents/".length))) continue;
	const target = join(targetPi, rel);
	if (!existsSync(target) || lstatSync(target).isSymbolicLink()) continue;
	const existing = readFileSync(target, "utf8");
	const untouched = typeof previous === "string" ? sha256(existing) === previous : normalizedHash(existing) === previous.sha256;
	if (untouched) {
		fsWrite.remove(target);
		record(["removed", "pi-myself no longer ships this role"], rel);
	} else {
		record(["kept", "pi-myself no longer ships this role; your edits make it the project's now"], rel);
	}
}

// 3. workflow rules — injected by the policy extension now, so a copy an older
// run provisioned is removed (pi would append it and the extension would then
// withhold the current policy). Stale = the hash the baseline recorded, or the
// policy's opening line; an edited stale copy is kept as APPEND_SYSTEM.md.local.
// A repository's own APPEND_SYSTEM.md has neither and is left alone.
{
	const rel = "APPEND_SYSTEM.md";
	const target = join(targetPi, rel);
	if (existsSync(target)) {
		const text = readFileSync(target, "utf8");
		const unedited = typeof shippedBefore[rel] === "string" && sha256(text) === shippedBefore[rel];
		if (unedited || text.includes(STALE_COPY_MARKER)) {
			// a one-time migration: an earlier .local may hold the repo's own pre-harness file, so it is never overwritten
			const backup = unedited ? undefined : freeBackupPath(target, text);
			if (backup !== undefined) fsWrite.write(backup, text);
			fsWrite.remove(target);
			const note = backup === undefined ? "" : `; your copy saved as ${basename(backup)} — move its project rules into AGENTS.md`;
			record(["removed", `the workflow policy is now injected by the pi-myself policy extension${note}`], rel);
		}
	}
}

// 4. .pi/ is local state in a consuming repository (ADR 0008). The checkout is
// exempt: there .pi/ holds the package source, and only the runtime paths inside
// it are ignored.
if (!sameRoot(targetRoot, packageRoot)) {
	const rel = ".gitignore";
	const target = join(targetRoot, rel);
	const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
	if (!ignoresPiState(existing)) {
		const prefix = existing === "" ? "" : existing.endsWith("\n") ? `${existing}\n` : `${existing}\n\n`;
		fsWrite.write(target, `${prefix}${GITIGNORE_MARKER}\n${GITIGNORE_LINE}\n`);
		record([existing === "" ? "created" : "updated", "pi state (.pi/) is local, not source"], rel);
	}
}

// 5. baseline for the next run (skipped in the checkout: the package is not its own consumer)
if (!sameRoot(targetRoot, packageRoot)) {
	const files = Object.fromEntries(Object.entries(shippedNow).sort(([a], [b]) => a.localeCompare(b)));
	const note =
		"Written by /setup-pi-myself: per role, the sha256 of the file pi-myself shipped (model, thinking and max_turns lines removed) and the values it shipped for those fields. It tells a project edit apart from the package's own previous version (only an edit is backed up as <name>.local) and a project's own model/thinking/max_turns apart from the package's default (only the project's choice is kept). Local state, never committed: .pi/ is gitignored in a consuming repository (ADR 0008).";
	const body = `${JSON.stringify({ note, version: 2, files }, null, "\t")}\n`;
	if (!existsSync(BASELINE) || readFileSync(BASELINE, "utf8") !== body) {
		if (CHECK) console.log(`${LINE_PREFIX}updated  pi-myself-provisioned.json (the baseline a real run records)`);
		fsWrite.write(BASELINE, body);
	}
}

const extra = ["removed", "kept"]
	.filter((outcome) => counts[outcome] > 0)
	.map((outcome) => `, ${counts[outcome]} ${outcome}`)
	.join("");
const summary = `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged${extra} in ${targetPi}`;
if (CHECK) {
	const verdict = pendingWrites > 0 ? "stale: run /setup-pi-myself to apply" : "current";
	console.log(`setup-project --check: ${summary} — dry run, nothing written; ${verdict}`);
} else {
	console.log(`setup-project: ${summary}`);
}

// 6. memory slug check (pi-workspace-memory keys memory by the git root's folder
//    name, so two repos with the same folder name silently share one memory).
//    Only a first run can tell: afterwards the records are this repo's own.
const memory = memorySlugStatus(targetRoot);
console.log(
	`memory: pi-workspace-memory slug "${memory.slug}" → ${memory.dir}${memory.exists ? " (ALREADY EXISTS)" : " (created on the first memory_write)"}`,
);
if (memory.exists && !hadBaseline) {
	console.log(
		"warning: a memory directory for this slug already exists before this repository had any session — another checkout with the same folder name may be sharing it; rename the folder if that is not intended.",
	);
}

if (CHECK && pendingWrites > 0) process.exitCode = 1;

/**
 * Mirror of pi-workspace-memory's getProjectSlug / getMemoryDir / loadSettings: folder-name slug
 * under localPath/projects. The settings block is `pi-workspace-memory`, falling back to the
 * whole legacy `pi-memory-md` block only when the new key is absent (the package was renamed).
 */
export function memorySlugStatus(root, home = process.env.HOME ?? "") {
	const slug =
		basename(root)
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project";
	let localPath = join(home, ".pi", "memory-md");
	try {
		const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
		const configured = (settings?.["pi-workspace-memory"] ?? settings?.["pi-memory-md"])?.localPath;
		if (typeof configured === "string" && configured.trim()) localPath = configured.replace(/^~(?=$|\/)/, home);
	} catch {
		/* no user settings: defaults */
	}
	const dir = join(localPath, "projects", slug);
	return { slug, dir, exists: existsSync(join(dir, "records")) };
}
