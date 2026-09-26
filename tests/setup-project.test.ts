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

test("setup-project enforces the settings key it manages and leaves every other key alone", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	mkdirSync(join(target, ".pi"), { recursive: true });
	const settingsPath = join(target, ".pi", "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ theme: "dark", enableSkillCommands: false }));
	const first = runScript(target);
	const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(merged.theme, "dark", "a key the harness does not manage survives");
	assert.equal(merged.enableSkillCommands, true, "the harness-managed key is enforced, not merged");
	assert.match(first, /settings\.json \(enableSkillCommands: false → true; previous file saved as settings\.json\.local\)/);
	assert.equal(
		JSON.parse(readFileSync(`${settingsPath}.local`, "utf8")).enableSkillCommands,
		false,
		"the corrected value is kept in the backup",
	);

	// settled: the correction is reported once, and no further backup is written
	writeFileSync(`${settingsPath}.local`, "sentinel");
	assert.match(runScript(target), /\b0 created, 0 updated, \d+ unchanged\b/);
	assert.equal(readFileSync(`${settingsPath}.local`, "utf8"), "sentinel", "an untouched settings file is never re-backed-up");

	const fresh = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(fresh);
	const created = JSON.parse(readFileSync(join(fresh, ".pi", "settings.json"), "utf8"));
	assert.equal(created.enableSkillCommands, true, "a fresh project gets /skill: commands enabled");
	assert.ok(!existsSync(join(fresh, ".pi", "settings.json.local")), "adding a missing key is not a correction");
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

test("setup-project is idempotent and a rerun keeps only model and thinking from the project's copy", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	const baseline = JSON.parse(readFileSync(join(target, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.deepEqual(
		Object.keys(baseline.files).sort(),
		[...packagedAgentFiles().map((name) => `agents/${name}`), "APPEND_SYSTEM.md"].sort(),
	);
	assert.match(runScript(target), /\b0 created, 0 updated, \d+ unchanged\b/, "re-run must be a no-op");

	// the two fields a project tunes survive a rerun; the merge reproduces the
	// file exactly, so tuning them is not an "edit" that needs a backup
	const reviewer = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(
		reviewer,
		readFileSync(reviewer, "utf8")
			.replace(/^model: .*$/m, "model: local/reviewer")
			.replace(/^thinking: .*$/m, "thinking: low"),
	);
	assert.match(runScript(target), /\b0 created, 0 updated, \d+ unchanged\b/);
	const kept = readFileSync(reviewer, "utf8");
	assert.match(kept, /^model: local\/reviewer$/m, "the project's model survives");
	assert.match(kept, /^thinking: low$/m, "the project's thinking survives");
	assert.ok(!existsSync(`${reviewer}.local`), "tuning a project-owned field is not an edit to back up");
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

test("setup-project takes a package update everywhere, backing up what the project changed", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const agents = join(target, ".pi", "agents");

	// a body edit is no longer an exemption: it is refreshed after a backup, and
	// a deleted role comes back, because the roster and the body are the harness's
	writeFileSync(join(agents, "reviewer.md"), `${readFileSync(join(agents, "reviewer.md"), "utf8")}\nproject rule\n`);
	rmSync(join(agents, "designer.md"));
	writeFileSync(join(agents, "my-role.md"), "---\ndescription: a role this project added\n---\nbody\n");

	for (const name of ["general.md", "reviewer.md", "designer.md"])
		appendFileSync(join(pkg.root, ".pi", "agents", name), "\nupstream change\n");
	writeFileSync(join(pkg.root, ".pi", "agents", "new-role.md"), "---\ndescription: a role the package added\n---\nbody\n");
	const upgraded = runScript(target, undefined, pkg.script);

	assert.match(upgraded, /updated\s+agents\/general\.md/);
	assert.ok(readFileSync(join(agents, "general.md"), "utf8").includes("upstream change"), "an untouched copy takes the update");
	assert.match(upgraded, /updated\s+agents\/reviewer\.md \(your copy saved as reviewer\.md\.local\)/);
	assert.ok(readFileSync(join(agents, "reviewer.md"), "utf8").includes("upstream change"), "a body edit is refreshed too");
	assert.ok(readFileSync(`${join(agents, "reviewer.md")}.local`, "utf8").includes("project rule"), "and the edit is kept beside it");
	assert.match(upgraded, /created\s+agents\/designer\.md \(was deleted in this project/);
	assert.ok(existsSync(join(agents, "designer.md")), "a deleted role is restored");
	assert.match(upgraded, /created\s+agents\/new-role\.md/);
	assert.ok(existsSync(join(agents, "my-role.md")), "a role the project added is not the harness's to delete");

	const settled = runScript(target, undefined, pkg.script);
	assert.match(settled, /\b0 created, 0 updated\b/);
	assert.doesNotMatch(settled, /^updated/m, "a refreshed copy is reported once, not on every run");
});

test("setup-project refreshes a differing copy when there is no baseline to compare against", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	rmSync(join(target, ".pi", "pi-myself-provisioned.json"));
	const probe = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(probe, `${readFileSync(probe, "utf8")}\nproject rule\n`);

	assert.match(runScript(target), /updated\s+agents\/reviewer\.md/);
	assert.ok(readFileSync(probe, "utf8").includes("Do not modify files."), "the package's body is back");
	assert.ok(!readFileSync(probe, "utf8").includes("project rule"), "an update is an update: the wrapper text is gone");
	assert.ok(!existsSync(`${probe}.local`), "with no baseline an edit cannot be told from an old version, so nothing is backed up");
	assert.ok(existsSync(join(target, ".pi", "pi-myself-provisioned.json")), "the run records a baseline");
});
