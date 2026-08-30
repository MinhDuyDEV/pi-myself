#!/usr/bin/env node
/**
 * setup-agents — provision pi-myself's task-agent roles into a project.
 *
 * Why: pi-task discovers agents only from three directories (its bundled
 * defaults, ~/.pi/agent/agents, and <repo>/.pi/agents) — an installed
 * pi-myself package is invisible there, so the harness-authored roles
 * (designer, researcher, ultra-scout, ultra-verifier) must be copied into the
 * project's .pi/agents/ once per repository. Skills need no such step: the
 * package manifest (pi.skills) already reaches task children through the
 * PackageManager.
 *
 * Idempotent: re-copy only when content differs; no deletion, no other paths.
 * Run from any directory; the target is the current working directory's repo.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");
const agentsSource = join(packageRoot, ".pi", "agents");
const targetDir = resolve(process.argv[2] ?? process.cwd(), ".pi", "agents");

/** pi-task only catalogs .md files with a frontmatter description — same filter here. */
function isAgentFile(path) {
	if (!existsSync(path)) return false;
	return /^---\n/.test(readFileSync(path, "utf8"));
}

if (!existsSync(agentsSource)) {
	console.error(`setup-agents: no .pi/agents next to this script (${agentsSource}) — run from an unmodified pi-myself package`);
	process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
let created = 0;
let updated = 0;
let unchanged = 0;
for (const entry of readdirSync(agentsSource).filter((n) => n.endsWith(".md") && isAgentFile(join(agentsSource, n)))) {
	const source = join(agentsSource, entry);
	const target = join(targetDir, entry);
	if (!existsSync(target)) {
		copyFileSync(source, target);
		created++;
		console.log(`created  ${entry}`);
	} else if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) {
		copyFileSync(source, target);
		updated++;
		console.log(`updated  ${entry}`);
	} else {
		unchanged++;
	}
}
const total = created + updated + unchanged;
console.log(
	`setup-agents: ${created} created, ${updated} updated, ${unchanged} unchanged in ${targetDir}` +
		(total === 0 ? " (nothing to provision — is this a pi-myself checkout?)" : ""),
);