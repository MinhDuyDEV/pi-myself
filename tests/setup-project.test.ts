import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

function runScript(target: string, home?: string, script = SCRIPT): string {
	return execFileSync(process.execPath, [script, target], { encoding: "utf8", env: { ...process.env, ...(home ? { HOME: home } : {}) } });
}

/** A copy of the package's provisioned surface that a test can "upgrade"; the script treats its own parent as the package. */
function fakePackage(): { root: string; script: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-myself-pkg-"));
	mkdirSync(join(root, "scripts"));
	copyFileSync(SCRIPT, join(root, "scripts", "setup-project.mjs"));
	cpSync(join(ROOT, ".pi", "agents"), join(root, ".pi", "agents"), { recursive: true });
	copyFileSync(join(ROOT, ".pi", "APPEND_SYSTEM.md"), join(root, ".pi", "APPEND_SYSTEM.md"));
	return { root, script: join(root, "scripts", "setup-project.mjs") };
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
	for (const name of ["designer.md", "ultra-scout.md", "ultra-verifier.md"]) {
		assert.ok(provisioned.includes(name), `missing harness role ${name}`);
	}
	for (const name of provisioned) {
		const source = readFileSync(join(ROOT, ".pi", "agents", name), "utf8");
		const copy = readFileSync(join(target, ".pi", "agents", name), "utf8");
		assert.equal(copy, source, `${name} drifted from the package during provisioning`);
		assert.match(copy, /^description: \S.+/m, `${name} must keep a catalog-visible description`);
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

test("setup-project reports the pi-workspace-memory slug and warns when that slug already has records", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-myself-home-"));
	const target = join(mkdtempSync(join(tmpdir(), "pi-myself-project-")), "My App");
	mkdirSync(target, { recursive: true });
	const fresh = runScript(target, home);
	assert.match(
		fresh,
		/memory: pi-workspace-memory slug "my-app" → .*\/\.pi\/memory-md\/projects\/my-app \(created on the first memory_write\)/,
	);
	assert.doesNotMatch(fresh, /warning: a memory directory/);

	mkdirSync(join(home, ".pi", "memory-md", "projects", "my-app", "records"), { recursive: true });
	const shared = runScript(target, home);
	assert.match(shared, /"my-app" → .* \(ALREADY EXISTS\)/);
	assert.match(shared, /warning: a memory directory for this slug already exists/);

	// a configured localPath is honoured under the current key, and under the legacy key as a fallback
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ "pi-workspace-memory": { localPath: "~/custom-memory" } }));
	assert.match(runScript(target, home), /\/custom-memory\/projects\/my-app \(created on the first memory_write\)/);
	writeFileSync(settingsPath, JSON.stringify({ "pi-memory-md": { localPath: "~/legacy-memory" } }));
	assert.match(runScript(target, home), /\/legacy-memory\/projects\/my-app \(created on the first memory_write\)/);
	writeFileSync(
		settingsPath,
		JSON.stringify({ "pi-workspace-memory": { localPath: "~/new-memory" }, "pi-memory-md": { localPath: "~/legacy-memory" } }),
	);
	assert.match(runScript(target, home), /\/new-memory\/projects\/my-app /, "the current key wins over the legacy key");
});

test("setup-project is idempotent and never overwrites or restores a task role the project edited or deleted", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	const baseline = JSON.parse(readFileSync(join(target, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.deepEqual(
		Object.keys(baseline.files).sort(),
		[...packagedAgentFiles().map((name) => `agents/${name}`), "APPEND_SYSTEM.md"].sort(),
	);
	assert.match(runScript(target), /\b0 created, 0 updated, 0 kept\b/, "re-run must be a no-op");

	const edited = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(edited, `${readFileSync(edited, "utf8")}\nproject rule\n`);
	const rerun = runScript(target);
	assert.match(rerun, /\b0 created, 0 updated, 1 kept\b/);
	assert.ok(readFileSync(edited, "utf8").includes("project rule"), "a project edit survives");
});

test("setup-project always replaces APPEND_SYSTEM.md, backing up a project-edited copy as .local", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const append = join(target, ".pi", "APPEND_SYSTEM.md");

	// a project edit is not lost: it is backed up beside the replacement
	writeFileSync(append, `${readFileSync(append, "utf8")}\n# project rule\n`);
	assert.match(runScript(target, undefined, pkg.script), /updated\s+APPEND_SYSTEM\.md \(project copy saved as APPEND_SYSTEM\.md\.local/);
	assert.ok(
		readFileSync(append, "utf8").includes("read-only tasks carry no cap"),
		"the harness policy copy is replaced with the package's",
	);
	assert.ok(readFileSync(`${append}.local`, "utf8").includes("# project rule"), "the project edit survives in the .local backup");

	// idempotent while untouched: a matching copy reports unchanged, no backup
	assert.match(runScript(target, undefined, pkg.script), /\b0 created, 0 updated\b/);
	assert.ok(
		!existsSync(`${append}.local`) || readFileSync(`${append}.local`, "utf8").includes("# project rule"),
		"no fresh backup of an untouched copy",
	);

	// a package upgrade reaches a previously untouched copy without any backup
	appendFileSync(join(pkg.root, ".pi", "APPEND_SYSTEM.md"), "\n# upstream policy change\n");
	assert.match(runScript(target, undefined, pkg.script), /updated\s+APPEND_SYSTEM\.md/);
	assert.ok(readFileSync(append, "utf8").includes("# upstream policy change"), "a policy upgrade replaces an untouched copy");
	assert.ok(
		!readFileSync(`${append}.local`, "utf8").includes("# upstream policy change"),
		"the backup holds the project's own text, not the package's",
	);

	// a second project edit overwrites the previous backup: one .local, the latest project text
	writeFileSync(append, `${readFileSync(append, "utf8")}\n# newer project rule\n`);
	runScript(target, undefined, pkg.script);
	assert.ok(readFileSync(`${append}.local`, "utf8").includes("# newer project rule"), "the backup is the latest project text");
});

test("setup-project takes a package update into untouched copies and names the kept ones", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const agents = join(target, ".pi", "agents");
	writeFileSync(join(agents, "reviewer.md"), `${readFileSync(join(agents, "reviewer.md"), "utf8")}\nproject rule\n`);
	rmSync(join(agents, "designer.md"));

	for (const name of ["general.md", "reviewer.md", "designer.md"])
		appendFileSync(join(pkg.root, ".pi", "agents", name), "\nupstream change\n");
	writeFileSync(join(pkg.root, ".pi", "agents", "new-role.md"), "---\ndescription: a role the package added\n---\nbody\n");
	const upgraded = runScript(target, undefined, pkg.script);

	assert.match(upgraded, /updated\s+agents\/general\.md/);
	assert.ok(readFileSync(join(agents, "general.md"), "utf8").includes("upstream change"), "an untouched copy takes the update");
	assert.match(upgraded, /kept\s+agents\/reviewer\.md \(edited in this project and changed in the package/);
	const reviewer = readFileSync(join(agents, "reviewer.md"), "utf8");
	assert.ok(reviewer.includes("project rule") && !reviewer.includes("upstream change"), "an edited copy is left as the project wrote it");
	assert.match(upgraded, /kept\s+agents\/designer\.md \(removed in this project/);
	assert.ok(!existsSync(join(agents, "designer.md")), "a deleted copy is not brought back");
	assert.match(upgraded, /created\s+agents\/new-role\.md/);

	const settled = runScript(target, undefined, pkg.script);
	assert.match(settled, /\b0 created, 0 updated\b/);
	assert.doesNotMatch(settled, /^kept/m, "a kept copy is reported once per package change, not on every run");
});

test("setup-project keeps a differing copy that predates the baseline", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	rmSync(join(target, ".pi", "pi-myself-provisioned.json"));
	const probe = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(probe, `${readFileSync(probe, "utf8")}\nproject rule\n`);

	assert.match(runScript(target), /kept\s+agents\/reviewer\.md \(differs from the package and predates the baseline/);
	assert.ok(readFileSync(probe, "utf8").includes("project rule"));
	assert.ok(existsSync(join(target, ".pi", "pi-myself-provisioned.json")), "the run records a baseline");
});
