import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The provisioning script is the only path by which an installed pi-myself
// package makes its task roles visible in a consuming repo — pi-task loads them
// from the project config dir only. The workflow rules are no longer copied:
// the policy extension injects them, and a copy an older run provisioned is
// migrated away. Keep it honest: package content, pi-task's frontmatter
// requirement, idempotency, the project-owned fields (model, thinking,
// max_turns), and never losing what the project wrote.

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
	return { root, script: join(root, "scripts", "setup-project.mjs") };
}

function packagedAgentFiles(): string[] {
	const agents = join(ROOT, ".pi", "agents");
	return readdirSync(agents).filter((name) => {
		// pi-task only catalogs .md files with frontmatter — same filter the script applies
		return name.endsWith(".md") && /^---\n/.test(readFileSync(join(agents, name), "utf8"));
	});
}

test("setup-project provisions exactly the packaged agent files, and no APPEND_SYSTEM.md", () => {
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

	assert.ok(
		!existsSync(join(target, ".pi", "APPEND_SYSTEM.md")),
		"the workflow policy is injected by the policy extension, never copied into the project",
	);
});

test("setup-project leaves settings.json alone: pi defaults enableSkillCommands to true and it only drives autocomplete", () => {
	// pi 0.87.1: getEnableSkillCommands() is `?? true`, and a typed /skill:<name>
	// expands whatever the setting says, so a project's `false` is a choice.
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	mkdirSync(join(target, ".pi"), { recursive: true });
	const settingsPath = join(target, ".pi", "settings.json");
	const original = `{\n  "theme": "dark",\n  "enableSkillCommands": false\n}\n`;
	writeFileSync(settingsPath, original);
	const output = runScript(target);
	assert.equal(readFileSync(settingsPath, "utf8"), original, "byte-identical: no key forced, no reformatting");
	assert.ok(!existsSync(`${settingsPath}.local`));
	assert.doesNotMatch(output, /settings\.json/);

	const fresh = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(fresh);
	assert.ok(!existsSync(join(fresh, ".pi", "settings.json")), "a fresh project needs no settings file");
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

	// the repo's own memory, written after provisioning, is not a collision: no warning on a rerun
	mkdirSync(join(home, ".pi", "memory-md", "projects", "my-app", "records"), { recursive: true });
	const rerun = runScript(target, home);
	assert.match(rerun, /"my-app" → .* \(ALREADY EXISTS\)/);
	assert.doesNotMatch(rerun, /warning: a memory directory/, "only a first run can tell a shared slug from the repo's own memory");

	// a first run that finds records already there is the collision worth naming
	const twin = join(mkdtempSync(join(tmpdir(), "pi-myself-project-")), "My App");
	mkdirSync(twin, { recursive: true });
	assert.match(runScript(twin, home), /warning: a memory directory for this slug already exists/);

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

test("setup-project is idempotent and a rerun keeps the project's model and thinking without a backup", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	const baseline = JSON.parse(readFileSync(join(target, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.deepEqual(
		Object.keys(baseline.files).sort(),
		packagedAgentFiles()
			.map((name) => `agents/${name}`)
			.sort(),
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

/** What older runs copied into a project: the workflow policy, whose opening line is the stale-copy marker. */
const OLD_POLICY =
	"# Workflow\n\nRuntime playbook: which process owns the work, when to delegate, how to complete.\n\n## Layering\n\n- old rules\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A project an older setup-project provisioned: its APPEND_SYSTEM.md copy and, optionally, the baseline that recorded it. */
function provisionedBefore(appendSystem: string, baseline?: string): string {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	mkdirSync(join(target, ".pi"), { recursive: true });
	writeFileSync(join(target, ".pi", "APPEND_SYSTEM.md"), appendSystem);
	if (baseline !== undefined) {
		writeFileSync(join(target, ".pi", "pi-myself-provisioned.json"), JSON.stringify({ files: { "APPEND_SYSTEM.md": sha(baseline) } }));
	}
	return target;
}

test("setup-project removes the workflow copy an older run provisioned, backing up only a project edit", () => {
	// untouched copy: removed outright, nothing to keep
	const clean = provisionedBefore(OLD_POLICY, OLD_POLICY);
	const append = join(clean, ".pi", "APPEND_SYSTEM.md");
	assert.match(runScript(clean), /removed\s+APPEND_SYSTEM\.md \(the workflow policy is now injected by the pi-myself policy extension\)/);
	assert.ok(!existsSync(append), "a stale copy would suppress the injected policy");
	assert.ok(!existsSync(`${append}.local`), "an untouched copy holds nothing of the project's");
	const baseline = JSON.parse(readFileSync(join(clean, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.ok(!("APPEND_SYSTEM.md" in baseline.files), "the baseline stops tracking a file the package no longer ships");
	assert.doesNotMatch(runScript(clean), /APPEND_SYSTEM/, "a migrated project is not reported again");

	// edited copy, with or without a baseline to prove it: the edit is kept beside the removal
	for (const target of [
		provisionedBefore(`${OLD_POLICY}\n# project rule\n`, OLD_POLICY),
		provisionedBefore(`${OLD_POLICY}\n# project rule\n`),
	]) {
		const edited = join(target, ".pi", "APPEND_SYSTEM.md");
		assert.match(runScript(target), /removed\s+APPEND_SYSTEM\.md \(.*your copy saved as APPEND_SYSTEM\.md\.local/);
		assert.ok(!existsSync(edited));
		assert.ok(readFileSync(`${edited}.local`, "utf8").includes("# project rule"), "move a project rule into AGENTS.md from the backup");
	}
});

test("setup-project leaves a repository's own APPEND_SYSTEM.md alone", () => {
	// no marker and no baseline entry: the file is the project's, and pi keeps appending it
	const target = provisionedBefore("Project rule: answer in French.\n");
	const output = runScript(target);
	assert.equal(readFileSync(join(target, ".pi", "APPEND_SYSTEM.md"), "utf8"), "Project rule: answer in French.\n");
	assert.doesNotMatch(output, /APPEND_SYSTEM/);
	assert.ok(!existsSync(join(target, ".pi", "APPEND_SYSTEM.md.local")));
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

test("setup-project backs up a differing copy when there is no baseline to compare against", () => {
	// A repo that already had a same-named role before its first provisioning:
	// nothing proves the difference is an old package version, so it is kept.
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	rmSync(join(target, ".pi", "pi-myself-provisioned.json"));
	const probe = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(probe, `${readFileSync(probe, "utf8")}\nproject rule\n`);

	assert.match(runScript(target), /updated\s+agents\/reviewer\.md \(your copy saved as reviewer\.md\.local\)/);
	assert.ok(readFileSync(probe, "utf8").includes("Do not modify files."), "the package's body is back");
	assert.ok(!readFileSync(probe, "utf8").includes("project rule"), "an update is an update: the wrapper text is gone");
	assert.ok(readFileSync(`${probe}.local`, "utf8").includes("project rule"), "nothing is dropped silently");
	assert.ok(existsSync(join(target, ".pi", "pi-myself-provisioned.json")), "the run records a baseline");

	// a copy that differs only in project-owned fields is not a difference worth a backup
	rmSync(join(target, ".pi", "pi-myself-provisioned.json"));
	rmSync(`${probe}.local`);
	writeFileSync(probe, readFileSync(probe, "utf8").replace(/^model: .*$/m, "model: local/reviewer"));
	assert.match(runScript(target), /\b0 created, 0 updated\b/);
	assert.ok(!existsSync(`${probe}.local`));
});

/** Every path under `dir` with its content (a link as its target): what "wrote nothing" is measured against. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
		const path = join(dir, name);
		const stat = lstatSync(path);
		out[name] = stat.isSymbolicLink() ? `-> ${readlinkSync(path)}` : stat.isDirectory() ? "<dir>" : readFileSync(path, "utf8");
	}
	return out;
}

function runCheck(args: string[], script = SCRIPT): { status: number | null; stdout: string } {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
	return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

test("setup-project --check reports what a run would do, writes nothing, and exits 1 until the project is current", () => {
	const fresh = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	const first = runCheck([fresh, "--check"]);
	assert.equal(first.status, 1, "an unprovisioned project is not current");
	assert.match(first.stdout, /^\[check\] created\s+agents\/reviewer\.md$/m, "today's line, marked as a dry run");
	assert.match(first.stdout, /setup-project --check: \d+ created, 0 updated, 0 unchanged/);
	assert.deepEqual(snapshot(fresh), {}, "a check writes no role, no baseline, not even .pi/");

	runScript(fresh);
	const current = runCheck(["--check", fresh]);
	assert.equal(current.status, 0, `a just-provisioned project is current:\n${current.stdout}`);
	assert.match(current.stdout, /setup-project --check: 0 created, 0 updated, \d+ unchanged/);

	// a package update, a project edit, and an older run's APPEND_SYSTEM copy: all reported, none applied
	const pkg = fakePackage();
	const target = provisionedBefore(OLD_POLICY);
	runScript(target, undefined, pkg.script);
	writeFileSync(join(target, ".pi", "APPEND_SYSTEM.md"), OLD_POLICY);
	appendFileSync(join(target, ".pi", "agents", "reviewer.md"), "\nproject rule\n");
	appendFileSync(join(pkg.root, ".pi", "agents", "general.md"), "\nupstream change\n");
	const before = snapshot(target);
	const stale = runCheck([target, "--check"], pkg.script);
	assert.equal(stale.status, 1);
	assert.match(stale.stdout, /^\[check\] updated\s+agents\/general\.md$/m);
	assert.match(stale.stdout, /^\[check\] updated\s+agents\/reviewer\.md \(your copy saved as reviewer\.md\.local\)$/m);
	assert.match(stale.stdout, /^\[check\] removed\s+APPEND_SYSTEM\.md/m);
	assert.deepEqual(snapshot(target), before, "no role, .local, baseline, or APPEND_SYSTEM change");
});

/** Rewrite one frontmatter field of a role file in place (a package role or a project copy). */
function setField(path: string, field: string, value: string): void {
	const text = readFileSync(path, "utf8");
	assert.match(text, new RegExp(`^${field}: `, "m"), `${path} has no ${field} line to change`);
	writeFileSync(path, text.replace(new RegExp(`^${field}: .*$`, "m"), `${field}: ${value}`));
}

test("a package model change reaches a repo that never chose its own; a repo's own choice survives the update", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const agents = join(target, ".pi", "agents");
	setField(join(agents, "reviewer.md"), "model", "local/reviewer");
	setField(join(agents, "reviewer.md"), "max_turns", "12");

	for (const name of ["explore.md", "reviewer.md"]) {
		setField(join(pkg.root, ".pi", "agents", name), "model", "vendor/new-model");
		appendFileSync(join(pkg.root, ".pi", "agents", name), "\nupstream change\n");
	}
	const upgraded = runScript(target, undefined, pkg.script);

	const explore = readFileSync(join(agents, "explore.md"), "utf8");
	assert.match(explore, /^model: vendor\/new-model$/m, "a value the project never changed follows the package");
	const reviewer = readFileSync(join(agents, "reviewer.md"), "utf8");
	assert.match(reviewer, /^model: local\/reviewer$/m, "the project's own model survives");
	assert.match(reviewer, /^max_turns: 12$/m, "max_turns is project-owned too");
	assert.ok(reviewer.includes("upstream change"), "the body update lands beside the kept values");
	assert.doesNotMatch(upgraded, /\.local/, "tuning project-owned fields never costs a backup, even across a package update");
	assert.ok(!existsSync(join(agents, "reviewer.md.local")));
});

test("a baseline written by an older version (bare hashes) migrates without losing the package's model change", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const agents = join(target, ".pi", "agents");
	// the old format: file → sha256 of the package file as shipped
	const files = Object.fromEntries(
		packagedAgentFiles().map((name) => [`agents/${name}`, sha(readFileSync(join(pkg.root, ".pi", "agents", name), "utf8"))]),
	);
	writeFileSync(join(target, ".pi", "pi-myself-provisioned.json"), JSON.stringify({ files }));
	setField(join(agents, "reviewer.md"), "model", "local/reviewer"); // a project choice the old baseline cannot see

	setField(join(pkg.root, ".pi", "agents", "explore.md"), "model", "vendor/new-model");
	setField(join(pkg.root, ".pi", "agents", "reviewer.md"), "model", "vendor/new-model");
	runScript(target, undefined, pkg.script);

	assert.match(readFileSync(join(agents, "explore.md"), "utf8"), /^model: vendor\/new-model$/m, "an untouched copy takes the new model");
	assert.match(readFileSync(join(agents, "reviewer.md"), "utf8"), /^model: local\/reviewer$/m, "a changed copy keeps its model");
	const baseline = JSON.parse(readFileSync(join(target, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.equal(typeof baseline.files["agents/explore.md"], "object", "the baseline is rewritten in the current format");
	assert.equal(baseline.files["agents/explore.md"].model, "vendor/new-model", "and records what the package shipped");
});

test("a role the package stops shipping is removed when untouched and kept, reported, when the project edited it", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const agents = join(target, ".pi", "agents");
	appendFileSync(join(agents, "designer.md"), "\nproject rule\n");
	rmSync(join(pkg.root, ".pi", "agents", "designer.md"));
	rmSync(join(pkg.root, ".pi", "agents", "explore.md"));

	const output = runScript(target, undefined, pkg.script);
	assert.match(output, /removed\s+agents\/explore\.md \(pi-myself no longer ships this role\)/);
	assert.ok(!existsSync(join(agents, "explore.md")), "an untouched copy of a dropped role goes");
	assert.match(output, /kept\s+agents\/designer\.md \(pi-myself no longer ships this role; your edits make it the project's now\)/);
	assert.ok(readFileSync(join(agents, "designer.md"), "utf8").includes("project rule"));
	const baseline = JSON.parse(readFileSync(join(target, ".pi", "pi-myself-provisioned.json"), "utf8"));
	assert.ok(!("agents/designer.md" in baseline.files) && !("agents/explore.md" in baseline.files));
	assert.doesNotMatch(runScript(target, undefined, pkg.script), /designer|explore/, "reported once");
});

test("a project value for a field the package role lacks is inserted into the frontmatter, never lost", () => {
	const pkg = fakePackage();
	const role = join(pkg.root, ".pi", "agents", "scout.md");
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const copy = join(target, ".pi", "agents", "scout.md");
	setField(copy, "thinking", "low");
	// the package drops its thinking line; a body line that looks like a field stays untouched
	writeFileSync(
		role,
		readFileSync(role, "utf8")
			.replace(/^thinking: .*\n/m, "")
			.replace("## Output", "thinking: prose\n\n## Output"),
	);

	runScript(target, undefined, pkg.script);
	const merged = readFileSync(copy, "utf8");
	const frontmatter = merged.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	assert.match(frontmatter, /^thinking: low$/m, "the project's thinking survives the package dropping the line");
	assert.ok(merged.includes("thinking: prose\n\n## Output"), "only the frontmatter is edited");
});

test("a symlinked role is replaced by a file and the link kept as .local; the shared target is never written", () => {
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const shared = join(mkdtempSync(join(tmpdir(), "pi-myself-shared-")), "reviewer.md");
	const copy = join(target, ".pi", "agents", "reviewer.md");
	writeFileSync(shared, `${readFileSync(copy, "utf8")}\nshared rule\n`);
	rmSync(copy);
	symlinkSync(shared, copy);
	const before = readFileSync(shared, "utf8");
	appendFileSync(join(pkg.root, ".pi", "agents", "reviewer.md"), "\nupstream change\n");

	const output = runScript(target, undefined, pkg.script);
	assert.equal(readFileSync(shared, "utf8"), before, "the file outside the repo is untouched");
	assert.ok(!lstatSync(copy).isSymbolicLink(), "the role is a regular file now");
	assert.ok(readFileSync(copy, "utf8").includes("upstream change"));
	assert.ok(lstatSync(`${copy}.local`).isSymbolicLink(), "the project's link is kept beside it");
	assert.match(output, /updated\s+agents\/reviewer\.md \(your symlink kept as reviewer\.md\.local\)/);

	// the next backup must not follow that link: edit the role, update the package, rerun
	appendFileSync(copy, "\nproject rule\n");
	appendFileSync(join(pkg.root, ".pi", "agents", "reviewer.md"), "\nsecond upstream change\n");
	const again = runScript(target, undefined, pkg.script);
	assert.equal(readFileSync(shared, "utf8"), before, "a later backup never writes through the kept link");
	assert.ok(!lstatSync(`${copy}.local`).isSymbolicLink(), "the new backup is a regular file");
	assert.ok(readFileSync(`${copy}.local`, "utf8").includes("project rule"));
	assert.match(again, /updated\s+agents\/reviewer\.md \(your copy saved as reviewer\.md\.local\)/);
});

test("a symlinked .pi/agents folder is written into, and the run says it lies outside the repository", () => {
	// A folder link is the project's chosen location (roles shared across repos,
	// say): provisioning writes there, but never silently.
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	const shared = mkdtempSync(join(tmpdir(), "pi-myself-shared-agents-"));
	mkdirSync(join(target, ".pi"), { recursive: true });
	symlinkSync(shared, join(target, ".pi", "agents"));
	const output = runScript(target);
	assert.match(output, /note: \.pi\/agents resolves to .*pi-myself-shared-agents-.* outside this repository/);
	assert.ok(existsSync(join(shared, "reviewer.md")), "the roles land in the linked folder");
	assert.ok(lstatSync(join(target, ".pi", "agents")).isSymbolicLink(), "the folder link itself is left alone");
});

test("migrating a stale APPEND_SYSTEM.md never overwrites an earlier backup", () => {
	// An older version's first run saved the repo's own APPEND_SYSTEM.md as .local;
	// the edited stale copy must land beside it, not on top of it.
	const target = provisionedBefore(`${OLD_POLICY}\n# project rule\n`, OLD_POLICY);
	const earlier = join(target, ".pi", "APPEND_SYSTEM.md.local");
	writeFileSync(earlier, "Project rule: answer in French.\n");
	const output = runScript(target);
	assert.equal(readFileSync(earlier, "utf8"), "Project rule: answer in French.\n", "the earlier backup is untouched");
	assert.match(output, /removed\s+APPEND_SYSTEM\.md \(.*your copy saved as APPEND_SYSTEM\.md\.local\.2/);
	assert.ok(readFileSync(`${earlier}.2`, "utf8").includes("# project rule"));
});

test("a role's kept project values are reported when they differ from what the package ships", () => {
	// S4 left repos with values an older version never updated; a v1 baseline
	// cannot tell those from a choice, so every kept value that differs from the
	// package's is named on each run instead of being kept silently.
	const pkg = fakePackage();
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target, undefined, pkg.script);
	const reviewer = join(target, ".pi", "agents", "reviewer.md");
	setField(reviewer, "model", "local/reviewer");
	const shipped = /^model: (.*)$/m.exec(readFileSync(join(pkg.root, ".pi", "agents", "reviewer.md"), "utf8"))?.[1];
	const output = runScript(target, undefined, pkg.script);
	assert.match(
		output,
		new RegExp(
			`agents/reviewer\\.md \\(kept your model: local/reviewer; the package ships ${shipped?.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`,
		),
	);
	assert.match(output, /\b0 created, 0 updated\b/, "reporting a kept value is not a change");
	assert.doesNotMatch(output, /agents\/explore\.md/, "a role that follows the package is not mentioned");
});

test("a consuming repo ignores its whole .pi/ with one line; the package checkout is exempt", () => {
	// ADR 0008: the declaration, the baseline, the roles and pi's runtime state are
	// all local to the machine that installed the harness, so one line covers them.
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	runScript(target);
	const ignore = readFileSync(join(target, ".gitignore"), "utf8");
	assert.match(ignore, /^\.pi\/\*$/m, "one line covers declaration, baseline, roles and runtime state");
	// The comment names what added the line and nothing else: the ADR it comes
	// from lives in this package, not in the repository that reads the file.
	assert.match(ignore, /^# pi-myself: /m, "the line is marked, so a reader knows what added it");

	// appended once, never edited or duplicated
	assert.match(runScript(target), /\b0 created, 0 updated\b/, "a rerun adds nothing");
	assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), ignore);

	// a repo that already ignores .pi/ another way keeps its own spelling
	const settled = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	writeFileSync(join(settled, ".gitignore"), "node_modules/\n.pi/\n");
	runScript(settled);
	assert.equal(readFileSync(join(settled, ".gitignore"), "utf8"), "node_modules/\n.pi/\n");

	// the checkout is not its own consumer: there .pi/ is the package source
	const pkg = fakePackage();
	runScript(pkg.root, undefined, pkg.script);
	assert.ok(!existsSync(join(pkg.root, ".gitignore")), "the checkout's .pi/ is source and must stay tracked");

	// --check names the line and still writes nothing
	const fresh = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	const check = runCheck([fresh, "--check"]);
	assert.match(check.stdout, /^\[check\] created\s+\.gitignore \(/m, "the dry run names the ignore line");
	assert.ok(!existsSync(join(fresh, ".gitignore")), "a check writes nothing");
});

// mattpocock/skills renamed the domain glossary (CONTEXT.md → GLOSSARY.md) and
// reads only the new name, so a file left under the old one is a glossary
// nothing consults. The move is the one upstream prescribes, so a run makes it.
const GLOSSARY_TEXT = "# Shop\n\nSells things.\n\n## Language\n\n**Order**:\nA request to buy.\n";
const OLD_DOMAIN_DOC = "- **`CONTEXT.md`** at the repo root, or\n- **`CONTEXT-MAP.md`** at the repo root if it exists\n";
const NEW_DOMAIN_DOC = "- **`GLOSSARY.md`** at the repo root, or\n- **`GLOSSARY-MAP.md`** at the repo root if it exists\n";

test("a glossary still named CONTEXT.md moves to GLOSSARY.md, and the domain doc's pointer follows", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	writeFileSync(join(target, "CONTEXT.md"), GLOSSARY_TEXT);
	mkdirSync(join(target, "docs", "agents"), { recursive: true });
	writeFileSync(join(target, "docs", "agents", "domain.md"), OLD_DOMAIN_DOC);

	// the dry run names both changes and makes neither
	const check = runCheck([target, "--check"]);
	assert.equal(check.status, 1, "a pending move is a pending change");
	assert.match(check.stdout, /^\[check\] updated\s+GLOSSARY\.md \(moved from CONTEXT\.md/m);
	assert.match(check.stdout, /^\[check\] updated\s+docs\/agents\/domain\.md \(/m);
	assert.ok(existsSync(join(target, "CONTEXT.md")) && !existsSync(join(target, "GLOSSARY.md")), "a check moves nothing");
	assert.equal(readFileSync(join(target, "docs", "agents", "domain.md"), "utf8"), OLD_DOMAIN_DOC);

	const output = runScript(target);
	assert.match(output, /^updated\s+GLOSSARY\.md \(moved from CONTEXT\.md/m);
	assert.ok(!existsSync(join(target, "CONTEXT.md")), "the old name is gone");
	assert.equal(readFileSync(join(target, "GLOSSARY.md"), "utf8"), GLOSSARY_TEXT, "moved, never rewritten");
	assert.equal(readFileSync(join(target, "docs", "agents", "domain.md"), "utf8"), NEW_DOMAIN_DOC, "the pointer names what the skills read");

	// a rerun has nothing left to do
	assert.doesNotMatch(runScript(target), /GLOSSARY|domain\.md/);
	assert.equal(runCheck([target, "--check"]).status, 0, "current once moved");
});

test("a tracked glossary moves with git mv, so the rename is staged and its history follows", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	// a machine's signing or hook settings must not decide this test
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: target, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(target, "CONTEXT.md"), GLOSSARY_TEXT);
	git("add", "CONTEXT.md");
	git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "glossary");

	assert.match(runScript(target), /^updated\s+GLOSSARY\.md \(moved from CONTEXT\.md with git mv/m);
	assert.match(
		git("status", "--porcelain"),
		/^R {2}CONTEXT\.md -> GLOSSARY\.md$/m,
		"a staged rename, not a delete beside an untracked file",
	);
});

test("a move never overwrites: an existing GLOSSARY.md, a multi-context map, and a linked domain doc are kept and named", () => {
	// both names present: which one is current is a judgement, so nothing is touched
	const both = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	writeFileSync(join(both, "CONTEXT.md"), "old\n");
	writeFileSync(join(both, "GLOSSARY.md"), "new\n");
	assert.match(runScript(both), /^kept\s+CONTEXT\.md \(GLOSSARY\.md already exists/m);
	assert.equal(readFileSync(join(both, "CONTEXT.md"), "utf8"), "old\n");
	assert.equal(readFileSync(join(both, "GLOSSARY.md"), "utf8"), "new\n");
	assert.equal(runCheck([both, "--check"]).status, 0, "nothing a run would change, so the project is current");

	// a multi-context layout is a map plus the per-context files it links to: moved by hand
	const mapped = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	const map = "# Context Map\n\n- [Ordering](./src/ordering/CONTEXT.md): orders\n";
	writeFileSync(join(mapped, "CONTEXT-MAP.md"), map);
	assert.match(runScript(mapped), /^kept\s+CONTEXT-MAP\.md \(a multi-context layout is moved by hand/m);
	assert.equal(readFileSync(join(mapped, "CONTEXT-MAP.md"), "utf8"), map);
	assert.ok(!existsSync(join(mapped, "GLOSSARY-MAP.md")));

	// a linked domain doc is the project's chosen location: never replaced by a file
	const linked = mkdtempSync(join(tmpdir(), "pi-myself-project-"));
	const shared = join(mkdtempSync(join(tmpdir(), "pi-myself-shared-")), "domain.md");
	writeFileSync(shared, OLD_DOMAIN_DOC);
	mkdirSync(join(linked, "docs", "agents"), { recursive: true });
	symlinkSync(shared, join(linked, "docs", "agents", "domain.md"));
	assert.match(runScript(linked), /^kept\s+docs\/agents\/domain\.md \(a symlink/m);
	assert.ok(lstatSync(join(linked, "docs", "agents", "domain.md")).isSymbolicLink(), "still the project's link");
	assert.equal(readFileSync(shared, "utf8"), OLD_DOMAIN_DOC, "the shared target is never written");
});
