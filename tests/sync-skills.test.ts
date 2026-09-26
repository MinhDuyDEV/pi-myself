import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The lock guards the whole vendored tree, not only the registered SKILL.md
// files: a skill's references (PHASE-BOUNDARIES.md, scripts, templates) are
// loaded by the model too, so an edit to one must fail `--check` like an edit
// to the SKILL.md itself. `--relock` rewrites the lock from the tree on disk
// with no network, and never blesses a drifted SKILL.md.

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

	// a reference-file change with every SKILL.md intact is what relock is for
	const fresh = fakeCheckout();
	appendFileSync(join(fresh, PHASE_BOUNDARIES), "\nupstream wording\n");
	const relocked = sync(fresh, "--relock");
	assert.equal(relocked.status, 0, relocked.output);
	const lock = JSON.parse(readFileSync(join(fresh, "skills-lock.json"), "utf8"));
	assert.equal(lock.upstream.head, JSON.parse(lockBefore).upstream.head, "relock keeps the recorded upstream head");
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
