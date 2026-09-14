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
 * Idempotent: files are re-copied only when content differs; settings are
 * merged key by key (existing keys win, missing harness keys are added); no
 * deletion, no other paths. Run from any directory; the target is the
 * argument or the current working directory.
 */
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

function syncFile(source, target) {
	if (!existsSync(target)) {
		mkdirSync(join(target, ".."), { recursive: true });
		copyFileSync(source, target);
		return "created";
	}
	if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) {
		copyFileSync(source, target);
		return "updated";
	}
	return "unchanged";
}

const agentsSource = join(packagePi, "agents");
const appendSystemSource = join(packagePi, "APPEND_SYSTEM.md");
if (!existsSync(agentsSource) || !existsSync(appendSystemSource)) {
	console.error(`setup-project: no .pi/agents + .pi/APPEND_SYSTEM.md next to this script (${packagePi}) — run from an unmodified pi-myself package`);
	process.exit(1);
}

const counts = { created: 0, updated: 0, unchanged: 0 };
function record(outcome, label) {
	counts[outcome]++;
	if (outcome !== "unchanged") console.log(`${outcome.padEnd(8)} ${label}`);
}

// 1. task roles
mkdirSync(join(targetPi, "agents"), { recursive: true });
for (const entry of readdirSync(agentsSource).filter((n) => n.endsWith(".md") && isAgentFile(join(agentsSource, n)))) {
	record(syncFile(join(agentsSource, entry), join(targetPi, "agents", entry)), `agents/${entry}`);
}

// 2. workflow rules
record(syncFile(appendSystemSource, join(targetPi, "APPEND_SYSTEM.md")), "APPEND_SYSTEM.md");

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
	record(settingsExisted ? "updated" : "created", `settings.json (+${missing.map(([k]) => k).join(", ")})`);
} else {
	counts.unchanged++;
}

console.log(`setup-project: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged in ${targetPi}`);

// 4. memory slug check (pi-memory-md keys memory by the git root's folder name,
//    so two repos with the same folder name silently share one memory)
const memory = memorySlugStatus(targetRoot);
console.log(`memory: pi-memory-md slug "${memory.slug}" → ${memory.dir}${memory.exists ? " (ALREADY EXISTS)" : " (created on the first memory_write)"}`);
if (memory.exists) {
	console.log(
		"warning: a memory directory for this slug already exists before this repository had any session — another checkout with the same folder name may be sharing it; rename the folder if that is not intended.",
	);
}

/** Mirror of pi-memory-md's getProjectSlug / getMemoryDir: folder-name slug under localPath/projects. */
export function memorySlugStatus(root, home = process.env.HOME ?? "") {
	const slug = basename(root).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	let localPath = join(home, ".pi", "memory-md");
	try {
		const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
		const configured = settings?.["pi-memory-md"]?.localPath;
		if (typeof configured === "string" && configured.trim()) localPath = configured.replace(/^~(?=$|\/)/, home);
	} catch {
		/* no user settings: defaults */
	}
	const dir = join(localPath, "projects", slug);
	return { slug, dir, exists: existsSync(join(dir, "records")) };
}
