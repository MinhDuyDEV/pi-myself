import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The lock guards the whole vendored tree, not only the registered SKILL.md
// files: a skill's references (PHASE-BOUNDARIES.md, scripts, templates) are
// loaded by the model too, so an edit to one must fail `--check` like an edit
// to the SKILL.md itself. `--relock` only adds the digest to a lock that has
// none, with no network: it never blesses a drifted file, SKILL.md or not.

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR_REL = join("vendor", "mattpocock-skills");

/** A copy of the checkout's sync surface; the script treats its own parent as the root. */
function fakeCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-myself-sync-"));
	mkdirSync(join(root, "scripts"));
	copyFileSync(join(ROOT, "scripts", "sync-skills.mjs"), join(root, "scripts", "sync-skills.mjs"));
	cpSync(join(ROOT, VENDOR_REL), join(root, VENDOR_REL), { recursive: true, verbatimSymlinks: true });
	copyFileSync(join(ROOT, "skills-lock.json"), join(root, "skills-lock.json"));
	return root;
}

function sync(root: string, ...args: string[]): { status: number | null; output: string } {
	// no test may reach the network: an https clone fails fast instead of re-vendoring upstream
	const env = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };
	const result = spawnSync(process.execPath, [join(root, "scripts", "sync-skills.mjs"), ...args], { encoding: "utf8", env });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const PHASE_BOUNDARIES = join(VENDOR_REL, "skills", "engineering", "ask-matt", "PHASE-BOUNDARIES.md");

test("sync-skills --check fails when a vendored file other than a SKILL.md is edited", () => {
	const root = fakeCheckout();
	const clean = sync(root, "--check");
	assert.equal(clean.status, 0, `an untouched copy is clean:\n${clean.output}`);

	appendFileSync(join(root, PHASE_BOUNDARIES), "\nlocal patch\n");
	const edited = sync(root, "--check");
	assert.equal(edited.status, 1, `a patched reference file must fail the check:\n${edited.output}`);
	assert.match(edited.output, /skills\/engineering\/ask-matt\/PHASE-BOUNDARIES\.md/, "the drifted path is named");
});

test("sync-skills --check fails when a file is added to or removed from the vendored tree", () => {
	const added = fakeCheckout();
	writeFileSync(join(added, VENDOR_REL, "skills", "engineering", "tdd", "EXTRA.md"), "smuggled\n");
	const addedRun = sync(added, "--check");
	assert.equal(addedRun.status, 1, `an added file must fail the check:\n${addedRun.output}`);
	assert.match(addedRun.output, /added.*skills\/engineering\/tdd\/EXTRA\.md/);

	const removed = fakeCheckout();
	execFileSync("rm", [join(removed, PHASE_BOUNDARIES)]);
	const removedRun = sync(removed, "--check");
	assert.equal(removedRun.status, 1);
	assert.match(removedRun.output, /missing.*skills\/engineering\/ask-matt\/PHASE-BOUNDARIES\.md/);
});

test("sync-skills --relock records the tree without a clone, and refuses when a SKILL.md drifted", () => {
	const root = fakeCheckout();
	const lockBefore = readFileSync(join(root, "skills-lock.json"), "utf8");
	appendFileSync(join(root, VENDOR_REL, "skills", "engineering", "tdd", "SKILL.md"), "\nlocal patch\n");
	const refused = sync(root, "--relock");
	assert.equal(refused.status, 1, `relock must not bless an edited skill:\n${refused.output}`);
	assert.match(refused.output, /tdd: SKILL\.md hash drifted/);
	assert.equal(readFileSync(join(root, "skills-lock.json"), "utf8"), lockBefore, "a refused relock writes nothing");

	// once the lock digests the tree, a reference-file edit is drift too: relock
	// would otherwise re-open, one command away, the gap the digest closed
	const edited = fakeCheckout();
	appendFileSync(join(edited, PHASE_BOUNDARIES), "\nlocal wording\n");
	const editedLock = readFileSync(join(edited, "skills-lock.json"), "utf8");
	const refusedTree = sync(edited, "--relock");
	assert.equal(refusedTree.status, 1, `relock must not bless an edited reference file:\n${refusedTree.output}`);
	assert.match(refusedTree.output, /changed.*PHASE-BOUNDARIES\.md/);
	assert.equal(readFileSync(join(edited, "skills-lock.json"), "utf8"), editedLock, "a refused relock writes nothing");

	// a tree section missing its digest was edited by hand: relock must not treat
	// it as a pre-digest lock and record a digest over whatever the tree holds now
	const handEdited = fakeCheckout();
	const partial = JSON.parse(readFileSync(join(handEdited, "skills-lock.json"), "utf8"));
	delete partial.vendorTree.digest;
	writeFileSync(join(handEdited, "skills-lock.json"), `${JSON.stringify(partial, null, "\t")}\n`);
	const partialLock = readFileSync(join(handEdited, "skills-lock.json"), "utf8");
	const refusedPartial = sync(handEdited, "--relock");
	assert.equal(refusedPartial.status, 1, refusedPartial.output);
	assert.match(refusedPartial.output, /vendorTree section is incomplete/);
	assert.equal(readFileSync(join(handEdited, "skills-lock.json"), "utf8"), partialLock);
	// and --check must not send that lock to the relock that refuses it
	const checkedPartial = sync(handEdited, "--check");
	assert.equal(checkedPartial.status, 1);
	assert.match(checkedPartial.output, /restore skills-lock\.json from git/);
	assert.doesNotMatch(checkedPartial.output, /--relock/);

	// what relock is for: a lock written before the digest existed gets one
	const fresh = fakeCheckout();
	const old = JSON.parse(readFileSync(join(fresh, "skills-lock.json"), "utf8"));
	delete old.vendorTree;
	writeFileSync(join(fresh, "skills-lock.json"), `${JSON.stringify(old, null, "\t")}\n`);
	const relocked = sync(fresh, "--relock");
	assert.equal(relocked.status, 0, relocked.output);
	const lock = JSON.parse(readFileSync(join(fresh, "skills-lock.json"), "utf8"));
	assert.equal(lock.upstream.head, JSON.parse(lockBefore).upstream.head, "relock keeps the recorded upstream head");
	assert.equal(lock.vendorTree.digest, JSON.parse(lockBefore).vendorTree.digest, "the added digest is the tree's");
	assert.equal(sync(fresh, "--check").status, 0, "the relocked tree checks clean");
});

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_NOSYSTEM: "1",
	HOME: tmpdir(),
};

/** A local stand-in for mattpocock/skills: `main` holds one promoted skill and a
 * relative AGENTS.md -> CLAUDE.md link, while the repository's default branch
 * (its HEAD) is `next`, so a clone that does not ask for `main` vendors the
 * wrong tree. */
function fakeUpstream(): { dir: string; main: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-myself-upstream-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
	const skill = join(dir, "skills", "engineering", "demo", "SKILL.md");
	git("init", "--quiet", "--initial-branch", "main");
	mkdirSync(join(dir, ".claude-plugin"));
	writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ skills: ["./skills/engineering/demo"] })}\n`);
	mkdirSync(join(dir, "skills", "engineering", "demo"), { recursive: true });
	writeFileSync(skill, "---\nname: demo\ndescription: The main branch's skill.\n---\n");
	writeFileSync(join(dir, "CLAUDE.md"), "guidance\n");
	symlinkSync("CLAUDE.md", join(dir, "AGENTS.md"));
	git("add", "-A");
	git("commit", "--quiet", "-m", "main");
	const main = git("rev-parse", "HEAD");
	git("checkout", "--quiet", "-b", "next");
	writeFileSync(skill, "---\nname: demo\ndescription: The next branch's skill.\n---\n");
	git("commit", "--quiet", "-am", "next");
	return { dir, main };
}

/** A real sync (clone included) whose https remote git itself rewrites to the
 * local fake: the script runs unchanged and no test reaches the network. */
function syncFrom(root: string, upstream: string, nodeArgs: string[] = []): { status: number | null; output: string } {
	const env = {
		...GIT_ENV,
		GIT_ALLOW_PROTOCOL: "file",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.file://${upstream}.insteadOf`,
		GIT_CONFIG_VALUE_0: "https://github.com/mattpocock/skills.git",
	};
	const result = spawnSync(process.execPath, [...nodeArgs, join(root, "scripts", "sync-skills.mjs")], { encoding: "utf8", env });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("sync-skills vendors upstream's main branch whole: the lock's ref is what was cloned, and nothing is left beside the tree", () => {
	const upstream = fakeUpstream();
	const root = fakeCheckout();
	const result = syncFrom(root, upstream.dir);
	assert.equal(result.status, 0, result.output);
	const vendor = join(root, VENDOR_REL);
	assert.match(
		readFileSync(join(vendor, "skills", "engineering", "demo", "SKILL.md"), "utf8"),
		/main branch's skill/,
		"the lock records ref main, so main is what gets vendored — not the default branch",
	);
	const lock = JSON.parse(readFileSync(join(root, "skills-lock.json"), "utf8"));
	assert.equal(lock.upstream.ref, "main");
	assert.equal(lock.upstream.head, upstream.main, "the recorded head is main's commit");
	assert.equal(existsSync(join(vendor, ".git")), false, "the clone's .git is not vendored");
	assert.equal(readlinkSync(join(vendor, "AGENTS.md")), "CLAUDE.md", "a relative link stays relative");
	assert.equal(existsSync(join(vendor, "skills", "engineering", "tdd")), false, "the old tree is replaced, not merged into");
	assert.deepEqual(readdirSync(join(root, "vendor")), ["mattpocock-skills"], "no staging or previous tree is left behind");
	const checked = sync(root, "--check");
	assert.equal(checked.status, 0, `the new lock checks clean:\n${checked.output}`);
});

test("a sync that fails before its new tree is complete leaves the vendored tree exactly as it was", {
	skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false,
}, () => {
	const upstream = fakeUpstream();
	const root = fakeCheckout();
	const lockBefore = readFileSync(join(root, "skills-lock.json"), "utf8");
	// a read-only vendor/ is a deterministic failure while the new tree is being
	// written: nothing beside the vendored tree can be created or removed
	chmodSync(join(root, "vendor"), 0o555);
	let result: { status: number | null; output: string };
	try {
		result = syncFrom(root, upstream.dir);
	} finally {
		chmodSync(join(root, "vendor"), 0o755);
	}
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /left as it was/, "the failure says the tree was not touched");
	assert.equal(existsSync(join(root, PHASE_BOUNDARIES)), true, "the vendored files are still there");
	assert.equal(readFileSync(join(root, "skills-lock.json"), "utf8"), lockBefore, "the lock is not rewritten");
	assert.equal(sync(root, "--check").status, 0, "the tree still matches its lock");
});

test("a swap that fails after the old tree was moved aside moves it back", () => {
	const upstream = fakeUpstream();
	const root = fakeCheckout();
	const lockBefore = readFileSync(join(root, "skills-lock.json"), "utf8");
	// the second rename is the new tree going into place, after the old one moved aside
	const preload = join(root, "fail-second-rename.mjs");
	writeFileSync(
		preload,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const rename = fs.renameSync;",
			"let calls = 0;",
			'fs.renameSync = (from, to) => { calls += 1; if (calls === 2) throw new Error("injected rename failure"); return rename(from, to); };',
			"syncBuiltinESMExports();",
			"",
		].join("\n"),
	);
	const result = syncFrom(root, upstream.dir, ["--import", preload]);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /could not swap in the new tree \(injected rename failure\); the vendored tree was left as it was/);
	assert.equal(existsSync(join(root, PHASE_BOUNDARIES)), true, "the previous tree is back in place");
	assert.deepEqual(readdirSync(join(root, "vendor")), ["mattpocock-skills"], "the work folder is cleaned up");
	assert.equal(readFileSync(join(root, "skills-lock.json"), "utf8"), lockBefore, "the lock is not rewritten");
	assert.equal(sync(root, "--check").status, 0, "the tree still matches its lock");
});

test("the committed lock lists exactly the files git tracks under the vendored tree", () => {
	const lock = JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8"));
	const tracked = execFileSync("git", ["ls-files", "--", VENDOR_REL], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter(Boolean)
		.map((path) => path.slice(`${VENDOR_REL}/`.length))
		.sort();
	assert.ok(lock.vendorTree, "skills-lock.json has no vendorTree digest — run node scripts/sync-skills.mjs --relock");
	assert.equal(lock.vendorTree.fileCount, tracked.length);
	assert.deepEqual(Object.keys(lock.vendorTree.files).sort(), tracked);
	assert.match(lock.vendorTree.digest, /^[0-9a-f]{64}$/);
});
