#!/usr/bin/env node
// Splice the child contract into every task role.
//
// pi-task hands a child its role body as --append-system-prompt, which also
// suppresses the project's discovered APPEND_SYSTEM.md, so a rule every child
// needs has to ride inside each body. One source (.pi/policy/CHILD-CONTRACT.md),
// one generated block at the end of every role, and a gate:
//
//   node scripts/sync-agents.mjs          rewrite the blocks (npm run agents:sync)
//   node scripts/sync-agents.mjs --check  fail on drift, write nothing (npm run agents:check)
//
// The script treats its own parent directory as the package, like setup-project.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(PACKAGE, ".pi", "policy", "CHILD-CONTRACT.md");
const AGENTS = join(PACKAGE, ".pi", "agents");

const BEGIN_PREFIX = "<!-- child-contract:begin";
const BEGIN = `${BEGIN_PREFIX} — generated from .pi/policy/CHILD-CONTRACT.md by npm run agents:sync; edit the source, not this block -->`;
const END = "<!-- child-contract:end -->";

/** pi-task's own test (helpers.js loadAgentsFromDir): a .md whose frontmatter has no description is not a role. */
function isRole(text) {
	const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	return frontmatter !== undefined && /^description:\s*\S/m.test(frontmatter);
}

/** The role's text with the current block at its end; throws when the role's own text cannot be told apart from the block. */
function splice(file, text, contract) {
	const lines = text.split("\n");
	const begins = lines.flatMap((line, index) => (line.startsWith(BEGIN_PREFIX) ? [index] : []));
	const ends = lines.flatMap((line, index) => (line === END ? [index] : []));
	let own = text;
	if (begins.length > 0 || ends.length > 0) {
		const [begin] = begins;
		const [end] = ends;
		if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined || end < begin) {
			throw new Error(`${file}: expected one child-contract block, found ${begins.length} begin and ${ends.length} end markers`);
		}
		if (lines.slice(end + 1).some((line) => line.trim() !== "")) {
			throw new Error(`${file}: text after the child-contract block; move it above the block, which must end the role`);
		}
		own = lines.slice(0, begin).join("\n");
	}
	return `${own.trimEnd()}\n\n${BEGIN}\n${contract}\n${END}\n`;
}

const check = process.argv.includes("--check");
const contract = readFileSync(SOURCE, "utf8").trim();
const planned = [];
const errors = [];
for (const file of readdirSync(AGENTS)
	.filter((name) => name.endsWith(".md"))
	.sort()) {
	const path = join(AGENTS, file);
	const text = readFileSync(path, "utf8");
	if (!isRole(text)) continue;
	try {
		const next = splice(file, text, contract);
		planned.push({ file, path, text, next });
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
}
if (errors.length > 0) {
	for (const message of errors) console.error(`sync-agents: ${message}`);
	console.error("sync-agents: nothing written.");
	process.exit(1);
}

const stale = planned.filter((role) => role.next !== role.text);
if (check) {
	if (stale.length > 0) {
		console.error(`sync-agents: child contract drifted in ${stale.map((role) => role.file).join(", ")}; run npm run agents:sync`);
		process.exit(1);
	}
	console.log(`sync-agents: clean, ${planned.length} roles carry the current child contract.`);
} else {
	for (const role of stale) writeFileSync(role.path, role.next);
	console.log(
		stale.length > 0
			? `sync-agents: updated ${stale.map((role) => role.file).join(", ")}.`
			: `sync-agents: clean, ${planned.length} roles already current.`,
	);
}
