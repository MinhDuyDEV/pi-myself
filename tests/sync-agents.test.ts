import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// scripts/sync-agents.mjs splices .pi/policy/CHILD-CONTRACT.md into every task
// role, because a child receives its role body and none of the parent's
// workflow rules. The script treats its own parent directory as the package,
// so each test runs a copy against a throwaway tree.

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "sync-agents.mjs");
const BEGIN = /^<!-- child-contract:begin[^\n]*-->$/m;
const END = "<!-- child-contract:end -->";

function fakePackage(contract: string, roles: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-myself-agents-"));
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, ".pi", "policy"), { recursive: true });
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	copyFileSync(SCRIPT, join(root, "scripts", "sync-agents.mjs"));
	writeFileSync(join(root, ".pi", "policy", "CHILD-CONTRACT.md"), contract);
	for (const [file, text] of Object.entries(roles)) writeFileSync(join(root, ".pi", "agents", file), text);
	return root;
}

function run(root: string, ...args: string[]) {
	return spawnSync(process.execPath, [join(root, "scripts", "sync-agents.mjs"), ...args], { encoding: "utf8" });
}

const role = (body: string) => `---\ndescription: a role\nmodel: m\n---\n\n# Role\n\n${body}`;
const readRole = (root: string, file: string) => readFileSync(join(root, ".pi", "agents", file), "utf8");

test("the package's roles carry the current contract", () => {
	const result = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a role without the block gets it at the end, and a rerun changes nothing", () => {
	const root = fakePackage("## Child contract\n\n- rule one\n", { "a.md": role("Rules.\n") });
	assert.equal(run(root).status, 0);
	const once = readRole(root, "a.md");
	assert.match(once, BEGIN);
	assert.ok(once.endsWith(`\n## Child contract\n\n- rule one\n${END}\n`), once);
	assert.ok(once.includes("Rules.\n\n<!-- child-contract:begin"), "one blank line separates the body from the block");
	assert.equal(run(root).status, 0);
	assert.equal(readRole(root, "a.md"), once, "idempotent");
	assert.equal(run(root, "--check").status, 0);
});

test("--check names a drifted role and writes nothing; a sync replaces only the block", () => {
	const root = fakePackage("## Child contract\n\n- rule one\n", { "a.md": role("Rules.\n") });
	run(root);
	writeFileSync(join(root, ".pi", "policy", "CHILD-CONTRACT.md"), "## Child contract\n\n- rule two\n");
	const before = readRole(root, "a.md");
	const check = run(root, "--check");
	assert.equal(check.status, 1);
	assert.match(`${check.stdout}${check.stderr}`, /a\.md/);
	assert.equal(readRole(root, "a.md"), before, "--check is read-only");
	assert.equal(run(root).status, 0);
	const after = readRole(root, "a.md");
	assert.ok(after.includes("- rule two") && !after.includes("- rule one"), after);
	assert.ok(after.startsWith(role("Rules.\n")), "the role's own text is untouched");
});

test("a file pi-task would not load as a role is left alone", () => {
	// pi-task skips a .md whose frontmatter has no description (loadAgentsFromDir).
	const readme = "# Roles\n\nNotes for humans.\n";
	const root = fakePackage("## Child contract\n\n- rule\n", { "README.md": readme, "a.md": role("x\n") });
	assert.equal(run(root).status, 0);
	assert.equal(readRole(root, "README.md"), readme);
});

test("text after the block, or a second block, stops the sync before any write", () => {
	const block = "<!-- child-contract:begin -->\n## Child contract\n\n- old\n<!-- child-contract:end -->\n";
	const trailing = role(`Rules.\n\n${block}\nAppended by hand.\n`);
	const doubled = role(`Rules.\n\n${block}\n${block}`);
	for (const text of [trailing, doubled]) {
		const root = fakePackage("## Child contract\n\n- new\n", { "a.md": role("clean\n"), "b.md": text });
		const result = run(root);
		assert.notEqual(result.status, 0, "refuses to guess where the role's own text ends");
		assert.match(result.stderr, /b\.md/);
		assert.equal(readRole(root, "b.md"), text);
		assert.equal(readRole(root, "a.md"), role("clean\n"), "no role is written when any role is malformed");
	}
});
