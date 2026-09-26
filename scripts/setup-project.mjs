#!/usr/bin/env node
/**
 * setup-project — provision a repository for pi-myself.
 *
 * Why: pi loads three things only from the project (or user) config dir,
 * never from an installed package:
 *
 *   1. task roles — pi-task scans its bundled defaults, ~/.pi/agent/agents,
 *      and <repo>/.pi/agents only;
 *   2. `.pi/APPEND_SYSTEM.md` — the harness workflow rules (routing, WIP cap,
 *      completion, memory discipline);
 *   3. project settings — `enableSkillCommands` is what exposes user-invoked
 *      skills as `/skill:<name>`.
 *
 * Skills, prompts, and extensions need no such step: the package manifest
 * (pi.skills / pi.prompts / pi.extensions) reaches the session and task
 * children through the PackageManager.
 *
 * A rerun is an UPDATE, not a merge. The package owns the role files — the
 * roster, the body, and every frontmatter line that shapes what a child may do
 * (tools, skills, disallowed_tools, readonly, proactive) — so a harness fix
 * lands without anyone re-reading a diff. Two things survive deliberately:
 *
 *   - `model` and `thinking` are carried from the project's copy into the
 *     package's, because the tier models are a local cost/latency choice and
 *     nothing else in the file is;
 *   - a copy the project edited is saved beside itself as `<name>.local` before
 *     it is replaced (the previous backup is overwritten) — the same
 *     convention APPEND_SYSTEM.md uses.
 *
 * The sha256 baseline (`.pi/pi-myself-provisioned.json`) is what tells "the
 * project edited this" apart from "this is the package's own previous
 * version", and only the former earns a backup. In settings.json the harness
 * manages exactly one key (`enableSkillCommands`, without which user-invoked
 * skills have no slash command): it is enforced, with the previous file kept as
 * settings.json.local, and every other key is left exactly as the project set
 * it. A role the project added is never touched. Run from any directory; the
 * target is the argument or the current working directory.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");
const packagePi = join(packageRoot, ".pi");
const targetRoot = resolve(process.argv[2] ?? process.cwd());
const targetPi = join(targetRoot, ".pi");

/** Settings keys the harness needs in the consuming project. Existing values win. */
export const HARNESS_SETTINGS = Object.freeze({ enableSkillCommands: true });

/** pi-task only catalogs .md files with a frontmatter description — same filter here. */
function isAgentFile(path) {
	if (!existsSync(path)) return false;
	return /^---\n/.test(readFileSync(path, "utf8"));
}

const agentsSource = join(packagePi, "agents");
const appendSystemSource = join(packagePi, "APPEND_SYSTEM.md");
if (!existsSync(agentsSource) || !existsSync(appendSystemSource)) {
	console.error(
		`setup-project: no .pi/agents + .pi/APPEND_SYSTEM.md next to this script (${packagePi}) — run from an unmodified pi-myself package`,
	);
	process.exit(1);
}

/** What the package shipped per provisioned file at the last run — how the project's own edit is told apart from the package's previous version. */
const BASELINE = join(targetPi, "pi-myself-provisioned.json");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function readBaseline() {
	if (!existsSync(BASELINE)) return {};
	try {
		return JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
	} catch {
		console.log(`warning: ${BASELINE} is not valid JSON — no copy can be told apart from the package's own, so nothing is backed up`);
		return {};
	}
}

const shippedBefore = readBaseline();
const shippedNow = {};

/** Frontmatter the project owns per role: a rerun takes every other line from the package. */
export const PROJECT_OWNED_FIELDS = Object.freeze(["model", "thinking"]);

/** Value of a frontmatter field, or undefined when the field is absent or empty. */
export function frontmatterField(content, name) {
	const block = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
	if (block === undefined) return undefined;
	return new RegExp(`^${name}:[ \t]*(.*)$`, "m").exec(block)?.[1]?.trim() || undefined;
}

/** The package's role file, carrying the project's `model` and `thinking` over from its own copy. */
export function mergeAgent(source, existing) {
	if (existing === undefined) return source;
	let merged = source;
	for (const field of PROJECT_OWNED_FIELDS) {
		const value = frontmatterField(existing, field);
		if (value === undefined) continue;
		merged = merged.replace(new RegExp(`^${field}:[ \t]*.*$`, "m"), `${field}: ${value}`);
	}
	return merged;
}

/** [outcome, note?] — model/thinking survive; every other project change is refreshed after a .local backup. */
function syncAgent(source, target, rel) {
	const shipped = sha256(source);
	const previous = shippedBefore[rel];
	shippedNow[rel] = shipped;

	const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	const content = mergeAgent(readFileSync(source, "utf8"), existing);

	if (existing === undefined) {
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
		return previous === undefined ? ["created"] : ["created", "was deleted in this project; the roster is harness-owned"];
	}
	// A copy that differs only in model/thinking merges back to itself: no write, no backup.
	if (existing === content) return ["unchanged"];
	const edited = previous !== undefined && sha256(target) !== previous;
	if (edited) writeFileSync(`${target}.local`, existing);
	writeFileSync(target, content);
	return ["updated", edited ? `your copy saved as ${basename(target)}.local` : undefined];
}

const counts = { created: 0, updated: 0, unchanged: 0 };
function record([outcome, note], label) {
	counts[outcome]++;
	if (outcome === "created" || outcome === "updated") console.log(`${outcome.padEnd(8)} ${label}${note ? ` (${note})` : ""}`);
	else if (note) console.log(`${outcome.padEnd(8)} ${label} (${note})`);
}

// 1. task roles — the package owns every line except model and thinking
mkdirSync(join(targetPi, "agents"), { recursive: true });
for (const entry of readdirSync(agentsSource).filter((n) => n.endsWith(".md") && isAgentFile(join(agentsSource, n)))) {
	const rel = `agents/${entry}`;
	record(syncAgent(join(agentsSource, entry), join(targetPi, rel), rel), rel);
}

// 2. workflow rules — harness policy, always replaced; an edited project copy is
// backed up as APPEND_SYSTEM.md.local (the previous backup is replaced)
{
	const rel = "APPEND_SYSTEM.md";
	const target = join(targetPi, rel);
	shippedNow[rel] = sha256(appendSystemSource);
	if (!existsSync(target)) {
		copyFileSync(appendSystemSource, target);
		counts.created++;
		console.log(`created  ${rel}`);
	} else if (sha256(target) === sha256(appendSystemSource)) {
		counts.unchanged++;
	} else {
		copyFileSync(target, `${target}.local`);
		copyFileSync(appendSystemSource, target);
		counts.updated++;
		console.log(
			`updated  ${rel} (project copy saved as APPEND_SYSTEM.md.local; moved its project rules into AGENTS.md if you still need them)`,
		);
	}
}

// 3. project settings — the keys the harness manages are enforced; every other
// key is the project's and is never touched. A value the project had set
// differently is corrected with the previous file saved beside it as .local.
const settingsPath = join(targetPi, "settings.json");
const settingsExisted = existsSync(settingsPath);
let settings = {};
if (settingsExisted) {
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		console.error(`setup-project: ${settingsPath} is not valid JSON (${error.message}); leaving it untouched`);
		process.exit(1);
	}
}
const additions = Object.keys(HARNESS_SETTINGS).filter((key) => !(key in settings));
const corrections = Object.entries(HARNESS_SETTINGS)
	.filter(([key, value]) => key in settings && settings[key] !== value)
	.map(([key, value]) => ({ key, from: settings[key], to: value }));
if (additions.length > 0 || corrections.length > 0) {
	if (corrections.length > 0) writeFileSync(`${settingsPath}.local`, readFileSync(settingsPath, "utf8"));
	Object.assign(settings, HARNESS_SETTINGS);
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	const changed = [
		...additions.map((key) => `+${key}`),
		...corrections.map(({ key, from, to }) => `${key}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`),
	];
	const note = `${changed.join(", ")}${corrections.length > 0 ? "; previous file saved as settings.json.local" : ""}`;
	record([settingsExisted ? "updated" : "created"], `settings.json (${note})`);
} else {
	counts.unchanged++;
}

// 4. baseline for the next run (skipped in the checkout: the package is not its own consumer)
if (targetRoot !== packageRoot) {
	const files = Object.fromEntries(Object.entries(shippedNow).sort(([a], [b]) => a.localeCompare(b)));
	const note =
		"Written by /setup-pi-myself: sha256 of each role and of APPEND_SYSTEM.md as the pi-myself package shipped it at the last run. Commit it; it is how a project edit is told apart from the package's own previous version, which decides whether a copy is backed up as <name>.local before being refreshed.";
	const body = `${JSON.stringify({ note, files }, null, "\t")}\n`;
	if (!existsSync(BASELINE) || readFileSync(BASELINE, "utf8") !== body) writeFileSync(BASELINE, body);
}

console.log(`setup-project: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged in ${targetPi}`);

// 5. memory slug check (pi-workspace-memory keys memory by the git root's folder name,
//    so two repos with the same folder name silently share one memory)
const memory = memorySlugStatus(targetRoot);
console.log(
	`memory: pi-workspace-memory slug "${memory.slug}" → ${memory.dir}${memory.exists ? " (ALREADY EXISTS)" : " (created on the first memory_write)"}`,
);
if (memory.exists) {
	console.log(
		"warning: a memory directory for this slug already exists before this repository had any session — another checkout with the same folder name may be sharing it; rename the folder if that is not intended.",
	);
}

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
