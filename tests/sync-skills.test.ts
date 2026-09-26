import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
