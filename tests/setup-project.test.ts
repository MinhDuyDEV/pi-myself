import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The provisioning script is the only path by which an installed pi-myself
// package makes its task roles, workflow rules (APPEND_SYSTEM.md), and the
// settings key that exposes /skill: commands visible in a consuming repo — pi
// loads all three from the project config dir only. Keep it honest: package
// content, pi-task's frontmatter requirement, idempotency, user-edit
// protection for files, user-value protection for settings.

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "setup-project.mjs");

function runScript(target: string): string {
	return execFileSync(process.execPath, [SCRIPT, target], { encoding: "utf8" });
}

function packagedAgentFiles(): string[] {
	const agents = join(ROOT, ".pi", "agents");
	return readdirSync(agents).filter((name) => {
		// pi-task only catalogs .md files with frontmatter — same filter the script applies
		return name.endsWith(".md") && /^---\n/.test(readFileSync(join(agents, name), "utf8"));
	});
}

test("setup-project provisions exactly the packaged agent files plus APPEND_SYSTEM.md", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);

	const provisioned = readdirSync(join(target, ".pi", "agents"));
	assert.deepEqual(provisioned.sort(), packagedAgentFiles().sort(), "provisioned set must equal the packaged set");
	for (const name of ["designer.md", "researcher.md", "ultra-scout.md", "ultra-verifier.md"]) {
		assert.ok(provisioned.includes(name), `missing harness role ${name}`);
	}
	for (const name of provisioned) {
		const source = readFileSync(join(ROOT, ".pi", "agents", name), "utf8");
		const copy = readFileSync(join(target, ".pi", "agents", name), "utf8");
		assert.equal(copy, source, `${name} drifted from the package during provisioning`);
		assert.match(copy, /^description: PROACTIVE/m, `${name} must keep a catalog-visible description`);
	}

	assert.equal(
		readFileSync(join(target, ".pi", "APPEND_SYSTEM.md"), "utf8"),
		readFileSync(join(ROOT, ".pi", "APPEND_SYSTEM.md"), "utf8"),
		"APPEND_SYSTEM.md must be provisioned verbatim",
	);
});

test("setup-project adds enableSkillCommands without touching keys the project already sets", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	mkdirSync(join(target, ".pi"), { recursive: true });
	writeFileSync(join(target, ".pi", "settings.json"), JSON.stringify({ theme: "dark", enableSkillCommands: false }));
	runScript(target);
	const merged = JSON.parse(readFileSync(join(target, ".pi", "settings.json"), "utf8"));
	assert.equal(merged.theme, "dark", "unrelated keys survive");
	assert.equal(merged.enableSkillCommands, false, "an explicit project value wins over the harness default");

	const fresh = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(fresh);
	const created = JSON.parse(readFileSync(join(fresh, ".pi", "settings.json"), "utf8"));
	assert.equal(created.enableSkillCommands, true, "a fresh project gets /skill: commands enabled");
});

test("setup-project is idempotent and refreshes file drift", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);

	const again = runScript(target);
	assert.match(again, /\b0 created, 0 updated\b/, "re-run must be a no-op");

	const probe = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(probe, `${readFileSync(probe, "utf8")}\ndrift: true\n`);
	const refreshed = runScript(target);
	assert.match(refreshed, /updated\s+agents\/reviewer\.md/, "a drifted role must be refreshed");
	assert.ok(!readFileSync(probe, "utf8").includes("drift: true"), "refresh must restore package content");
});
