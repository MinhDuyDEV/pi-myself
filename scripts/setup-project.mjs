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
 *      completion, memory discipline); unlike task roles, this one is ALWAYS
 *      replaced: it is harness policy, not project content. A copy the project
 *      edited is not lost — it is saved beside it as APPEND_SYSTEM.md.local; a
 *      project's own rules belong in its AGENTS.md, which pi always loads.
 *      (Task roles keep the baseline semantics: refreshed only while they
 *      still match what the package last shipped; an edited role is kept.)
 *   3. project settings — `enableSkillCommands` is what exposes user-invoked
 *      skills as `/skill:<name>`.
 *
 * Skills, prompts, and extensions need no such step: the package manifest
 * (pi.skills / pi.prompts / pi.extensions) reaches the session and task
 * children through the PackageManager.
 *
 * Idempotent, and the copies belong to the project: a copy is refreshed only
 * while it still matches what the package last shipped (sha256 per file in
 * `.pi/pi-myself-provisioned.json`); a copy the project edited or deleted is
 * kept, and reported when the package changed that file — except
 * APPEND_SYSTEM.md, which is always replaced (with a .local backup of an
 * edited copy, overwriting the previous backup). Settings are merged key by
 * key (existing keys win, missing harness keys are added); no other paths.
 * Run from any directory; the target is the argument or the current working
 * directory.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
	console.error(`setup-project: no .pi/agents + .pi/APPEND_SYSTEM.md next to this script (${packagePi}) — run from an unmodified pi-myself package`);
	process.exit(1);
}

/** What the package shipped per provisioned file at the last run — how an untouched copy is told apart from a project edit. */
const BASELINE = join(targetPi, "pi-myself-provisioned.json");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function readBaseline() {
	if (!existsSync(BASELINE)) return {};
	try {
		return JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
	} catch {
		console.log(`warning: ${BASELINE} is not valid JSON — every copy that differs from the package is treated as a project edit`);
		return {};
	}
}

const shippedBefore = readBaseline();
const shippedNow = {};

/** [outcome, note?] — a kept copy carries a note only when the package changed that file since the last run. */
function syncFile(source, target, rel) {
	const shipped = sha256(source);
	const previous = shippedBefore[rel];
	shippedNow[rel] = shipped;
	if (!existsSync(target)) {
		if (previous !== undefined) {
			return ["kept", previous === shipped ? undefined : "removed in this project; delete its entry in .pi/pi-myself-provisioned.json to restore it"];
		}
		mkdirSync(join(target, ".."), { recursive: true });
		copyFileSync(source, target);
		return ["created"];
	}
	const current = sha256(target);
	if (current === shipped) return ["unchanged"];
	if (current === previous) {
		copyFileSync(source, target);
		return ["updated"];
	}
	if (previous === undefined) return ["kept", "differs from the package and predates the baseline; delete it and rerun to take the package version"];
	return ["kept", previous === shipped ? undefined : "edited in this project and changed in the package — merge by hand"];
}

const counts = { created: 0, updated: 0, kept: 0, unchanged: 0 };
function record([outcome, note], label) {
	counts[outcome]++;
	if (outcome === "created" || outcome === "updated") console.log(`${outcome.padEnd(8)} ${label}`);
	else if (note) console.log(`${outcome.padEnd(8)} ${label} (${note})`);
}

// 1. task roles
mkdirSync(join(targetPi, "agents"), { recursive: true });
for (const entry of readdirSync(agentsSource).filter((n) => n.endsWith(".md") && isAgentFile(join(agentsSource, n)))) {
	const rel = `agents/${entry}`;
	record(syncFile(join(agentsSource, entry), join(targetPi, rel), rel), rel);
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
		console.log(`updated  ${rel} (project copy saved as APPEND_SYSTEM.md.local; moved its project rules into AGENTS.md if you still need them)`);
	}
}

// 3. project settings (merge; never overwrite a key the project already sets)
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
const missing = Object.entries(HARNESS_SETTINGS).filter(([key]) => !(key in settings));
if (missing.length > 0) {
	for (const [key, value] of missing) settings[key] = value;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	record([settingsExisted ? "updated" : "created"], `settings.json (+${missing.map(([k]) => k).join(", ")})`);
} else {
	counts.unchanged++;
}

// 4. baseline for the next run (skipped in the checkout: the package is not its own consumer)
if (targetRoot !== packageRoot) {
	const files = Object.fromEntries(Object.entries(shippedNow).sort(([a], [b]) => a.localeCompare(b)));
	const note = "Written by /setup-pi-myself: sha256 of each file as the pi-myself package shipped it at the last run. Commit it; edit the provisioned copies freely.";
	const body = `${JSON.stringify({ note, files }, null, "\t")}\n`;
	if (!existsSync(BASELINE) || readFileSync(BASELINE, "utf8") !== body) writeFileSync(BASELINE, body);
}

console.log(`setup-project: ${counts.created} created, ${counts.updated} updated, ${counts.kept} kept, ${counts.unchanged} unchanged in ${targetPi}`);

// 5. memory slug check (pi-workspace-memory keys memory by the git root's folder name,
//    so two repos with the same folder name silently share one memory)
const memory = memorySlugStatus(targetRoot);
console.log(`memory: pi-workspace-memory slug "${memory.slug}" → ${memory.dir}${memory.exists ? " (ALREADY EXISTS)" : " (created on the first memory_write)"}`);
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
	const slug = basename(root).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
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
