import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runAllFrontiers, runOp } from "./ops.js";
import type { TrackerParams } from "./params.js";
import { parseTicket, slugify, TrackerError, withFileLock } from "./tracker.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function tempRepo(): string {
	return mkdtempSync(join(tmpdir(), "tracker-ops-"));
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

function op(root: string, params: Omit<TrackerParams, "op"> & { op: TrackerParams["op"] }): string {
	return runOp(root, params as TrackerParams);
}

test("create-ticket writes the to-tickets local template, numbered from 01", () => {
	const root = tempRepo();
	try {
		const text = op(root, {
			op: "create-ticket",
			feature: "alpha-feature",
			title: "Add rate limit",
			what: "Requests over the limit get a 429.",
			blockedBy: [],
		});
		assert.match(text, /Created \.scratch\/alpha-feature\/issues\/01-add-rate-limit\.md/);
		assert.match(text, /\*\*Blocked by:\*\* None \(can start immediately\)/);
		assert.match(text, /\*\*Status:\*\* ready-for-agent/);
		assert.equal(existsSync(join(root, ".scratch", "alpha-feature", "issues", "01-add-rate-limit.md")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("consecutive tickets number up; blockedBy references resolve in the frontier", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "gamma", title: "Schema", what: "Add tables." });
		op(root, { op: "create-ticket", feature: "gamma", title: "API", what: "Serve the tables.", blockedBy: ["01"] });
		op(root, { op: "create-ticket", feature: "gamma", title: "UI", what: "Render the API.", blockedBy: ["02"] });

		const frontier = op(root, { op: "frontier", feature: "gamma" });
		assert.match(frontier, /## Frontier — takeable now/);
		assert.match(frontier, /01 — Schema/);
		assert.match(frontier, /waiting on 01/); // 02 blocked by 01
		assert.match(frontier, /waiting on 02/); // 03 blocked by 02

		op(root, { op: "claim", feature: "gamma", ticket: "1" });
		const afterClaim = op(root, { op: "frontier", feature: "gamma" });
		assert.doesNotMatch(afterClaim, /^- 01 — Schema/m); // claimed tickets leave the frontier

		op(root, { op: "resolve", feature: "gamma", ticket: "01", answer: "Tables land in schema.sql.", gist: "Schema lives in schema.sql" });
		const afterResolve = op(root, { op: "frontier", feature: "gamma" });
		assert.match(afterResolve, /02 — API/); // unblocked by 01 resolving
		assert.doesNotMatch(afterResolve, /waiting on 01/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolve appends ## Answer, sets resolved, and updates the map's Decisions-so-far", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "effort", destination: "A working import pipeline." });
		op(root, { op: "create-ticket", feature: "effort", title: "Pick parser", what: "CSV or TSV?" });
		op(root, {
			op: "resolve",
			feature: "effort",
			ticket: "pick-parser",
			answer: "CSV — every source already emits it.",
			gist: "CSV beats TSV",
		});

		const ticketRaw = readFileSync(join(root, ".scratch", "effort", "issues", "01-pick-parser.md"), "utf8");
		assert.match(ticketRaw, /## Answer/);
		assert.match(ticketRaw, /CSV — every source already emits it\./);
		assert.match(ticketRaw, /\*\*Status:\*\* resolved/);

		const map = readFileSync(join(root, ".scratch", "effort", "map.md"), "utf8");
		assert.match(map, /\[Pick parser\]\(issues\/01-pick-parser\.md\): CSV beats TSV/);

		const frontier = op(root, { op: "frontier", feature: "effort" });
		assert.match(frontier, /\(nothing takeable — blocked or claimed below\)/); // the only ticket resolved
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("tick marks the Nth unchecked criterion; list shows features", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "delta", title: "Ship it", what: "Everything." });
		const file = join(root, ".scratch", "delta", "issues", "01-ship-it.md");
		const ticket = parseTicket(file);
		assert.equal(ticket.totalChecklist, 1); // the template placeholder criterion

		op(root, { op: "tick", feature: "delta", ticket: "01", index: 1 });
		assert.match(readFileSync(file, "utf8") ?? "", /- \[x\]/);
		assert.match(op(root, { op: "list" }), /delta \| 1 \(1\)/);

		assert.throws(() => op(root, { op: "tick", feature: "delta", ticket: "01", index: 5 }), TrackerError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("tick addresses the Nth criterion box, checked or not, and refuses a box already ticked", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "ticks", title: "Three", what: "x", criteria: ["one", "two", "three"] });
		const file = join(root, ".scratch", "ticks", "issues", "01-three.md");
		op(root, { op: "tick", feature: "ticks", ticket: "01", index: 1 });
		op(root, { op: "tick", feature: "ticks", ticket: "01", index: 2 });
		const raw = readFileSync(file, "utf8");
		assert.match(raw, /- \[x\] one\n- \[x\] two\n- \[ \] three/, "positions stay fixed: 1 then 2 marks boxes 1 and 2");
		assert.throws(() => op(root, { op: "tick", feature: "ticks", ticket: "01", index: 1 }), /criterion #1 .* is already checked/);
		assert.equal(readFileSync(file, "utf8"), raw, "a refused tick writes nothing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("create-spec publishes .scratch/<feature>/spec.md once; list shows every ticket of a feature", () => {
	const root = tempRepo();
	try {
		const out = op(root, {
			op: "create-spec",
			feature: "limits",
			title: "Rate limiting",
			what: "## Problem Statement\n\nToo many requests.",
		});
		assert.match(out, /Spec published: \.scratch\/limits\/spec\.md/);
		const spec = readFileSync(join(root, ".scratch", "limits", "spec.md"), "utf8");
		assert.match(spec, /^# Rate limiting\n\n## Problem Statement/);
		assert.throws(() => op(root, { op: "create-spec", feature: "limits", title: "Again", what: "x" }), /spec already exists/);

		op(root, {
			op: "create-ticket",
			feature: "limits",
			title: "Counter",
			what: "Count requests.",
			criteria: ["increments per request", "resets hourly"],
		});
		op(root, { op: "create-ticket", feature: "limits", title: "Reject", what: "Return 429.", blockedBy: ["01"] });
		op(root, { op: "resolve", feature: "limits", ticket: "01", answer: "Done." });
		const list = op(root, { op: "list", feature: "limits" });
		assert.match(list, /id \| title \| status \| category \| type \| blocked by \| criteria/);
		assert.match(list, /01 \| Counter \| resolved \| - \| - \| - \| 0\/2/);
		assert.match(list, /02 \| Reject \| ready-for-agent \| - \| - \| 01 \| 0\/1/);
		assert.match(op(root, { op: "list", feature: "limits", status: "resolved" }), /01 \| Counter/);
		assert.doesNotMatch(op(root, { op: "list", feature: "limits", status: "resolved" }), /02 \| Reject/);
		assert.match(op(root, { op: "list" }), /limits \| 2 \(1\) \| spec\.md/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("wayfinder child: Type line + Question body; out-of-scope closes and gists into the map's Out of scope", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "import", destination: "A working import pipeline.", fog: "encoding handling" });
		const map0 = readFileSync(join(root, ".scratch", "import", "map.md"), "utf8");
		assert.match(map0, /## Not yet specified\n\nencoding handling/);

		const created = op(root, { op: "create-ticket", feature: "import", title: "Which parser?", what: "CSV or TSV?", type: "research" });
		assert.match(created, /\*\*Type:\*\* research/);
		assert.match(created, /## Question\n\nCSV or TSV\?/);
		assert.doesNotMatch(created, /What to build/);
		assert.match(op(root, { op: "frontier", feature: "import" }), /01 — Which parser\? \[research\]/);

		op(root, { op: "create-ticket", feature: "import", title: "TSV support", what: "TSV too?", type: "task" });
		const ruled = op(root, {
			op: "out-of-scope",
			feature: "import",
			ticket: "02",
			answer: "No source emits TSV.",
			gist: "TSV: no source emits it",
		});
		assert.match(ruled, /\*\*Status:\*\* out-of-scope/);
		assert.match(ruled, /## Out of scope\n\nNo source emits TSV\./);
		const map = readFileSync(join(root, ".scratch", "import", "map.md"), "utf8");
		assert.match(
			map,
			/## Out of scope\n\n\(work consciously ruled out of this effort\)\n\n- \[TSV support\]\(issues\/02-tsv-support\.md\): TSV: no source emits it/,
		);
		assert.doesNotMatch(map.split("## Out of scope")[0], /TSV support/, "never into Decisions so far");
		assert.doesNotMatch(op(root, { op: "frontier", feature: "import" }), /02 — TSV support/, "closed tickets leave the frontier");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status: a category role lands on its own line and leaves the state role alone", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "tri", title: "Crash on save", what: "It crashes." });
		op(root, { op: "status", feature: "tri", ticket: "01", status: "bug" });
		op(root, { op: "status", feature: "tri", ticket: "01", status: "needs-info" });
		const raw = readFileSync(join(root, ".scratch", "tri", "issues", "01-crash-on-save.md"), "utf8");
		assert.match(raw, /\*\*Category:\*\* bug/);
		assert.match(raw, /\*\*Status:\*\* needs-info/);
		assert.doesNotMatch(raw, /\*\*Status:\*\* bug/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("frontier holds back needs-triage, needs-info and ready-for-human; ready-for-agent and wayfinder children stay takeable", () => {
	const root = tempRepo();
	try {
		for (const [title, status] of [
			["Untriaged", "needs-triage"],
			["Waiting on reporter", "needs-info"],
			["Human only", "ready-for-human"],
			["Agent ready", "ready-for-agent"],
		] as const) {
			op(root, { op: "create-ticket", feature: "roles", title, what: "x", status });
		}
		// a wayfinder child as the local template describes it: no triage role at all
		writeFileSync(
			join(root, ".scratch", "roles", "issues", "05-which-parser.md"),
			"# 5: Which parser?\n\n**Type:** research\n\n**Blocked by:** None (can start immediately)\n\n## Question\n\nCSV?\n",
		);
		const frontier = op(root, { op: "frontier", feature: "roles" });
		const takeable = [...frontier.matchAll(/^- (\d+) —/gm)].map((m) => m[1]);
		assert.deepEqual(takeable, ["04", "05"]);
		assert.match(frontier, /01 — Untriaged \[needs-triage\]/);
		assert.match(frontier, /02 — Waiting on reporter \[needs-info\]/);
		assert.match(frontier, /03 — Human only \[ready-for-human\]/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runAllFrontiers prints one section per feature; errors name the missing piece", () => {
	const root = tempRepo();
	try {
		assert.match(runAllFrontiers(root), /No features tracked/);
		op(root, { op: "create-ticket", feature: "one", title: "Only ticket", what: "Do a thing." });
		assert.match(runAllFrontiers(root), /## \.scratch\/one/);
		assert.match(runAllFrontiers(root), /01 — Only ticket/);

		assert.throws(
			() => runOp(root, { op: "create-ticket", feature: "two" } as unknown as TrackerParams),
			/"create-ticket" requires "title"/,
		);
		assert.throws(() => runOp(root, { op: "show", feature: "one", ticket: "nope" }), /no ticket matching "nope"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a feature slug that escapes .scratch/ is rejected on every op", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "beta", title: "Real", what: "Inside scratch." });
		// a look-alike feature directory reachable as "../outside"
		mkdirSync(join(root, "outside", "issues"), { recursive: true });
		const leak = join(root, "outside", "issues", "01-leak.md");
		writeFileSync(leak, "# 1: leak\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n");

		const escapes: TrackerParams[] = [
			{ op: "list", feature: "../outside" },
			{ op: "frontier", feature: "../outside" },
			{ op: "show", feature: "../outside", ticket: "01" },
			{ op: "claim", feature: "../outside", ticket: "01" },
			{ op: "tick", feature: "../outside", ticket: "01", index: 1 },
			{ op: "comment", feature: "../outside", ticket: "01", what: "x" },
			{ op: "resolve", feature: "../outside", ticket: "01", answer: "x" },
			{ op: "status", feature: "../outside", ticket: "01", status: "ready-for-human" },
			{ op: "block", feature: "../outside", ticket: "01", blockedBy: ["02"] },
		];
		for (const params of escapes) {
			assert.throws(() => op(root, params), /invalid feature slug/, `${params.op} must reject the slug`);
		}
		// nothing outside .scratch/ was read or written
		assert.match(readFileSync(leak, "utf8"), /\*\*Status:\*\* ready-for-agent/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claim and tick refuse a closed ticket instead of reopening it", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "gone", title: "Done thing", what: "x", criteria: ["one"] });
		op(root, { op: "resolve", feature: "gone", ticket: "01", answer: "shipped" });

		assert.throws(() => op(root, { op: "claim", feature: "gone", ticket: "01" }), /cannot claim 01: it is resolved/);
		assert.throws(() => op(root, { op: "tick", feature: "gone", ticket: "01", index: 1 }), /cannot tick 01: it is resolved/);

		// the status still reads closed and it stays out of the frontier
		const raw = readFileSync(join(root, ".scratch", "gone", "issues", "01-done-thing.md"), "utf8");
		assert.match(raw, /\*\*Status:\*\* resolved/);
		assert.doesNotMatch(op(root, { op: "frontier", feature: "gone" }), /^- 01/m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second claim errors, naming the existing claim, instead of replying Claimed", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "race", title: "Contended", what: "x" });
		assert.match(op(root, { op: "claim", feature: "race", ticket: "01" }), /Claimed/);
		assert.throws(() => op(root, { op: "claim", feature: "race", ticket: "01" }), /cannot claim 01: already claimed \(Status: claimed\)/);

		// an assignee line is a claim too
		op(root, { op: "create-ticket", feature: "race", title: "Assigned", what: "y" });
		const assigned = join(root, ".scratch", "race", "issues", "02-assigned.md");
		writeFileSync(assigned, readFileSync(assigned, "utf8").replace("# 2: Assigned\n", "# 2: Assigned\n\n**Assignee:** sam\n"));
		assert.throws(() => op(root, { op: "claim", feature: "race", ticket: "02" }), /cannot claim 02: already claimed \(assignee: sam\)/);
		assert.match(readFileSync(assigned, "utf8"), /\*\*Status:\*\* ready-for-agent/, "the losing claim writes nothing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claim re-checks under the ticket lock: a resolve landing between read and write is not overwritten", async () => {
	// A child process holds the ticket's lock and, while holding it, lands a
	// resolve. The claim below reads the ticket (still open) before the child's
	// write, then waits on the lock. Checking only that early read wrote
	// `claimed` over the resolve; the check under the lock refuses instead.
	const root = tempRepo();
	const script = join(root, "resolver.ts");
	const heldFlag = join(root, "held.flag");
	try {
		op(root, { op: "create-ticket", feature: "race", title: "Contended", what: "x" });
		const file = join(root, ".scratch", "race", "issues", "01-contended.md");
		writeFileSync(
			script,
			[
				`import { withFileLock } from ${JSON.stringify(join(import.meta.dirname, "tracker.js"))};`,
				'import { readFileSync, writeFileSync } from "node:fs";',
				"const [, , file, held] = process.argv as [string, string, string, string];",
				"withFileLock(file, () => {",
				'\twriteFileSync(held, "held");',
				"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);",
				'\twriteFileSync(file, readFileSync(file, "utf8").replace("**Status:** ready-for-agent", "**Status:** resolved"));',
				"});",
				"",
			].join("\n"),
		);
		const child = spawn(process.execPath, [join(REPO_ROOT, "node_modules", ".bin", "tsx"), script, file, heldFlag], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const exited = new Promise<void>((done) => child.on("exit", () => done()));
		const deadline = Date.now() + 5_000;
		while (!existsSync(heldFlag) && Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 5));
		}
		assert.equal(existsSync(heldFlag), true, "the resolver never acquired the lock");
		assert.throws(() => op(root, { op: "claim", feature: "race", ticket: "01" }), /cannot claim 01: it is resolved/);
		await exited;
		assert.match(readFileSync(file, "utf8"), /\*\*Status:\*\* resolved/, "the resolve survives");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repeated comments extend one ## Comments section", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "talk", title: "Talk", what: "x" });
		op(root, { op: "comment", feature: "talk", ticket: "01", what: "first note" });
		op(root, { op: "comment", feature: "talk", ticket: "01", what: "second note" });
		const raw = readFileSync(join(root, ".scratch", "talk", "issues", "01-talk.md"), "utf8");
		assert.equal(raw.match(/^## Comments$/gm)?.length, 1, "one heading, not one per call");
		assert.match(raw, /first note/);
		assert.match(raw, /second note/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a category role is readable: rendered, filterable, and never clobbers the state role", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "bugs", title: "Crash on save", what: "boom" });
		op(root, { op: "create-ticket", feature: "bugs", title: "Add export", what: "csv" });
		op(root, { op: "status", feature: "bugs", ticket: "01", status: "bug" });
		op(root, { op: "status", feature: "bugs", ticket: "02", status: "enhancement" });

		const raw = readFileSync(join(root, ".scratch", "bugs", "issues", "01-crash-on-save.md"), "utf8");
		assert.match(raw, /\*\*Category:\*\* bug/);
		assert.match(raw, /\*\*Status:\*\* ready-for-agent/, "the state role survives a category write");

		const ticket = parseTicket(join(root, ".scratch", "bugs", "issues", "01-crash-on-save.md"));
		assert.equal(ticket.category, "bug");
		assert.equal(ticket.status, "ready-for-agent");

		// the list shows the category column and filters on it
		const list = op(root, { op: "list", feature: "bugs" });
		assert.match(list, /01 \| Crash on save \| ready-for-agent \| bug \|/);
		assert.match(op(root, { op: "list", feature: "bugs", status: "bug" }), /01 \| Crash on save/);
		assert.doesNotMatch(op(root, { op: "list", feature: "bugs", status: "bug" }), /02 \| Add export/);
		assert.match(op(root, { op: "show", feature: "bugs", ticket: "01" }), /Category: bug/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an invalid wayfinder ticket type is rejected instead of written", () => {
	const root = tempRepo();
	try {
		assert.throws(
			() => op(root, { op: "create-ticket", feature: "wf", title: "Q", what: "?", type: "reserch" }),
			/invalid ticket type "reserch": expected one of research, prototype, grilling, task/,
		);
		assert.equal(existsSync(join(root, ".scratch", "wf", "issues")), false, "nothing is written on a rejected type");
		const created = op(root, { op: "create-ticket", feature: "wf", title: "Q", what: "?", type: "research" });
		assert.match(created, /\*\*Type:\*\* research/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a blocker written as a title containing 'and' still unblocks", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "dep", title: "Tokens and sessions", what: "x" });
		op(root, { op: "create-ticket", feature: "dep", title: "Audit and rotate", what: "y" });
		op(root, { op: "create-ticket", feature: "dep", title: "Ship", what: "z", blockedBy: ["Tokens and sessions"] });
		const ticketFile = join(root, ".scratch", "dep", "issues", "03-ship.md");

		const before = op(root, { op: "frontier", feature: "dep" });
		assert.match(before, /waiting on Tokens and sessions/, "an open title blocker keeps it blocked");

		op(root, { op: "resolve", feature: "dep", ticket: "Tokens and sessions", answer: "done" });
		const after = op(root, { op: "frontier", feature: "dep" });
		assert.match(after, /^- 03 — Ship/m, "the exact title resolves once closed");
		assert.equal(readFileSync(ticketFile, "utf8").includes("and"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ticket numbering never overwrites an existing file", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "num", title: "Same title", what: "first" });
		const first = readFileSync(join(root, ".scratch", "num", "issues", "01-same-title.md"), "utf8");
		op(root, { op: "create-ticket", feature: "num", title: "Same title", what: "second" });

		const second = join(root, ".scratch", "num", "issues", "02-same-title.md");
		assert.equal(existsSync(second), true);
		assert.match(readFileSync(second, "utf8"), /second/);
		assert.equal(readFileSync(join(root, ".scratch", "num", "issues", "01-same-title.md"), "utf8"), first, "01 is untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two creators with different titles never share a ticket number", () => {
	// Deterministic interleaving: another creator holds the allocation lock (it
	// has scanned the directory and picked 01 but not written yet). A creator that
	// scanned without the lock also picked 01 and wrote `01-mine.md` beside the
	// other's `01-other.md` (`wx` only guards the exact name). Under the lock it
	// allocates nothing until the holder is done, then takes 02.
	const root = tempRepo();
	try {
		const dir = join(root, ".scratch", "alloc", "issues");
		mkdirSync(dir, { recursive: true });
		const lock = join(dir, ".next-number.lock");
		writeFileSync(lock, ""); // the other creator is mid-allocation
		assert.throws(
			() => op(root, { op: "create-ticket", feature: "alloc", title: "Mine", what: "x" }),
			/timed out waiting for the tracker lock/,
			"no number is allocated while another creator holds the allocation lock",
		);
		assert.deepEqual(
			readdirSync(dir).filter((f) => f.endsWith(".md")),
			[],
		);

		// the other creator finishes its write with the number it picked, then releases
		writeFileSync(join(dir, "01-other.md"), "# 1: Other\n\n**Status:** ready-for-agent\n");
		rmSync(lock);
		op(root, { op: "create-ticket", feature: "alloc", title: "Mine", what: "x" });
		const numbers = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, 2))
			.sort();
		assert.deepEqual(numbers, ["01", "02"], "every ticket has its own NN");
		assert.equal(existsSync(lock), false, "the allocation lock is released");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ticket and map writes leave no lock or temp files behind", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "clean", destination: "d" });
		op(root, { op: "create-ticket", feature: "clean", title: "T", what: "x" });
		op(root, { op: "resolve", feature: "clean", ticket: "01", answer: "a", gist: "g" });
		op(root, { op: "comment", feature: "clean", ticket: "01", what: "c" });
		op(root, { op: "note", feature: "clean", what: "a note" });
		op(root, { op: "edit", feature: "clean", ticket: "01", title: "T2" });

		const featureDir = join(root, ".scratch", "clean");
		const leftovers = [...walk(featureDir)].filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "no lock or temp residue");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("edit rewrites the title and body but keeps the field lines and criteria", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "ed", title: "Original", what: "old body", criteria: ["one", "two"] });
		const out = op(root, { op: "edit", feature: "ed", ticket: "01", title: "Renamed", what: "new body" });
		assert.match(out, /Edited \.scratch\/ed\/issues\/01-original\.md/);

		const raw = readFileSync(join(root, ".scratch", "ed", "issues", "01-original.md"), "utf8");
		assert.match(raw, /^# 1: Renamed$/m, "the number prefix is preserved");
		assert.match(raw, /\*\*What to build:\*\* new body/);
		assert.match(raw, /\*\*Status:\*\* ready-for-agent/, "field lines survive");
		assert.match(raw, /- \[ \] one[\s\S]*- \[ \] two/, "criteria survive");

		assert.throws(() => op(root, { op: "edit", feature: "ed", ticket: "01" }), /"edit" requires "title" and\/or "what"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("edit replaces a wayfinder ticket's ## Question body", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "wfe", title: "How?", what: "first phrasing", type: "research" });
		op(root, { op: "edit", feature: "wfe", ticket: "01", what: "reworded question" });
		const raw = readFileSync(join(root, ".scratch", "wfe", "issues", "01-how.md"), "utf8");
		assert.match(raw, /## Question\n\nreworded question/);
		assert.equal(raw.includes("first phrasing"), false);
		assert.match(raw, /\*\*Type:\*\* research/);
		assert.match(raw, /\*\*Blocked by:\*\* None/, "field lines survive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("note appends to a named map section and creates it when absent", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "nt", destination: "d" });
		const out = op(root, { op: "note", feature: "nt", what: "fog item", section: "Not yet specified" });
		assert.match(out, /Appended to Not yet specified in \.scratch\/nt\/map\.md/);
		op(root, { op: "note", feature: "nt", what: "a plain note" });

		const map = readFileSync(join(root, ".scratch", "nt", "map.md"), "utf8");
		assert.match(map, /## Not yet specified\n\n\(in-scope fog[^\n]*\)\n\n- fog item/, "appended inside the existing section");
		assert.match(map, /## Notes\n\n\(domain[^\n]*\)\n\n- a plain note/, "the default section is Notes");
		assert.equal(map.match(/^## Notes$/gm)?.length, 1, "no duplicate section");
		assert.equal(existsSync(join(root, ".scratch", "nt", "map.md.lock")), false);

		assert.throws(() => op(root, { op: "note", feature: "missing-map", what: "x" }), /map file missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("slugify never leaves a trailing separator after the length cut", () => {
	const slug = slugify(`${"a".repeat(47)} b`);
	assert.equal(slug.endsWith("-"), false, `got ${slug}`);
	assert.equal(slug, "a".repeat(47));
});

test("local status accepts this repo's mapped label spelling and writes the canonical role", () => {
	const root = tempRepo();
	try {
		mkdirSync(join(root, "docs", "agents"), { recursive: true });
		writeFileSync(
			join(root, "docs", "agents", "triage-labels.md"),
			[
				"| Label in mattpocock/skills | Label in our tracker | Meaning |",
				"| --- | --- | --- |",
				"| `ready-for-agent` | `agent-ready` | ok |",
				"",
			].join("\n"),
		);
		op(root, { op: "create-ticket", feature: "mapped", title: "T", what: "x" });
		// the local spelling is accepted...
		op(root, { op: "status", feature: "mapped", ticket: "01", status: "agent-ready" });
		// ...and the file keeps the canonical role, which closure semantics key on
		const raw = readFileSync(join(root, ".scratch", "mapped", "issues", "01-t.md"), "utf8");
		assert.match(raw, /\*\*Status:\*\* ready-for-agent/);
		// either spelling filters
		assert.match(op(root, { op: "list", feature: "mapped", status: "agent-ready" }), /01 \| T/);
		assert.match(op(root, { op: "list", feature: "mapped", status: "ready-for-agent" }), /01 \| T/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("edit writes a title containing $ literally", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "dollar", title: "Original", what: "x" });
		// `$&` and `$1` are String.replace replacement patterns; the title is data
		op(root, { op: "edit", feature: "dollar", ticket: "01", title: "Cost is $& and $1 too" });
		const raw = readFileSync(join(root, ".scratch", "dollar", "issues", "01-original.md"), "utf8");
		assert.match(raw, /^# 1: Cost is \$& and \$1 too$/m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("note escapes a section name and rejects a malformed one", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "sec", destination: "d" });
		// an unbalanced paren used to reach `new RegExp` and throw a raw SyntaxError
		op(root, { op: "note", feature: "sec", what: "n", section: "Fog (draft" });
		assert.match(readFileSync(join(root, ".scratch", "sec", "map.md"), "utf8"), /## Fog \(draft\n\n- n/);
		assert.throws(() => op(root, { op: "note", feature: "sec", what: "n", section: "bad#heading" }), /invalid map section/);
		assert.throws(() => op(root, { op: "note", feature: "sec", what: "n", section: "two\nlines" }), /invalid map section/);
		// a blank section is not an error: it selects the default
		assert.match(op(root, { op: "note", feature: "sec", what: "plain", section: "   " }), /Appended to Notes/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel processes appending to one map keep every write (the lock is what makes this true)", async () => {
	// wayfinder explicitly expects several sessions on one map. Without the lock
	// this test fails: each worker does repeated read-modify-writes, so the
	// interleavings lose updates (5 workers x 4 writes lost 2+ per run in a
	// probe of the unlocked version).
	const root = tempRepo();
	const worker = join(root, "worker.ts");
	const workers = 5;
	const writesPerWorker = 4;
	try {
		mkdirSync(join(root, ".scratch", "shared"), { recursive: true });
		writeFileSync(join(root, ".scratch", "shared", "map.md"), "# Map: shared\n\n## Notes\n\nnotes\n");
		writeFileSync(
			worker,
			[
				`import { appendMapLine } from ${JSON.stringify(join(import.meta.dirname, "tracker.js"))};`,
				"const root = process.argv[2] as string;",
				"const worker = process.argv[3] as string;",
				"const writes = Number(process.argv[4]);",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: this is generated child-process source; the placeholder is meant to be literal here
				'for (let n = 0; n < writes; n++) appendMapLine(root, "shared", "Notes", `line-${worker}-${n}`);',
				"",
			].join("\n"),
		);
		const failures: string[] = [];
		await Promise.all(
			Array.from({ length: workers }, (_, index) => {
				const child = spawn(
					process.execPath,
					[join(REPO_ROOT, "node_modules", ".bin", "tsx"), worker, root, String(index), String(writesPerWorker)],
					{ cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (chunk) => (stderr += chunk));
				return new Promise<void>((done) => {
					child.on("exit", (code) => {
						if (code !== 0) failures.push(`worker ${index} exit ${code}: ${stderr.slice(0, 200)}`);
						done();
					});
				});
			}),
		);
		assert.deepEqual(failures, []);
		const map = readFileSync(join(root, ".scratch", "shared", "map.md"), "utf8");
		const appended = new Set([...map.matchAll(/^- line-(\d+-\d+)$/gm)].map((match) => match[1]));
		const expected = workers * writesPerWorker;
		assert.equal(appended.size, expected, `expected ${expected} appended lines, got ${appended.size}:\n${map}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLock makes a second writer wait for the holder", async () => {
	// The deterministic counterpart to the parallel-append test: without the lock
	// the second acquisition returns immediately (waited ~0 ms) instead of waiting
	// out the holder, so this fails for the right reason rather than by luck.
	const root = tempRepo();
	const script = join(root, "holder.ts");
	const target = join(root, "guard.txt");
	const heldFlag = join(root, "held.flag");
	const releasedFlag = join(root, "released.flag");
	try {
		writeFileSync(
			script,
			[
				`import { withFileLock } from ${JSON.stringify(join(import.meta.dirname, "tracker.js"))};`,
				'import { writeFileSync } from "node:fs";',
				"const [, , target, held, released] = process.argv;",
				"withFileLock(target as string, () => {",
				'\twriteFileSync(held as string, "held");',
				"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
				'\twriteFileSync(released as string, "released");',
				"});",
				"",
			].join("\n"),
		);
		const child = spawn(process.execPath, [join(REPO_ROOT, "node_modules", ".bin", "tsx"), script, target, heldFlag, releasedFlag], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const deadline = Date.now() + 5_000;
		while (!existsSync(heldFlag) && Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 10));
		}
		assert.equal(existsSync(heldFlag), true, "the holder process never acquired the lock");
		const started = Date.now();
		withFileLock(target, () => {});
		const waited = Date.now() - started;
		assert.ok(waited >= 200, `expected to wait for the holder, waited ${waited}ms`);
		await new Promise<void>((done) => child.on("exit", () => done()));
		assert.equal(existsSync(releasedFlag), true, "the holder did not finish its critical section");
		// the lock is released, not left behind
		assert.equal(existsSync(`${target}.lock`), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── follow-up audit (R7, R9, R10, R12, R13, R20) ─────────────────────────────

test("create-ticket and block reject a blocker that names no ticket of the feature", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "typo", title: "Tokens", what: "x" });
		op(root, { op: "create-ticket", feature: "typo", title: "Sessions", what: "y" });
		const dir = join(root, ".scratch", "typo", "issues");
		assert.throws(
			() => op(root, { op: "create-ticket", feature: "typo", title: "Ship", what: "z", blockedBy: ["07"] }),
			/unknown blocker "07"/,
		);
		assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".md")).length, 2, "nothing is written for a rejected blocker");
		const before = readFileSync(join(dir, "02-sessions.md"), "utf8");
		assert.throws(() => op(root, { op: "block", feature: "typo", ticket: "02", blockedBy: ["Tokns"] }), /unknown blocker "Tokns"/);
		assert.equal(readFileSync(join(dir, "02-sessions.md"), "utf8"), before, "a rejected block writes nothing");

		// ids, slugs, titles, and a conjunction of titles are all real tickets
		op(root, { op: "block", feature: "typo", ticket: "02", blockedBy: ["#1"] });
		op(root, { op: "create-ticket", feature: "typo", title: "Ship", what: "z", blockedBy: ["Tokens and Sessions", "sessions"] });
		assert.match(readFileSync(join(dir, "03-ship.md"), "utf8"), /\*\*Blocked by:\*\* Tokens and Sessions, sessions/);
		// clearing stays possible
		op(root, { op: "block", feature: "typo", ticket: "02", blockedBy: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the frontier names only open or unresolvable blockers, and a claimed ticket shows its claim", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-ticket", feature: "fr", title: "First", what: "x" });
		op(root, { op: "create-ticket", feature: "fr", title: "Second", what: "y", blockedBy: ["01"] });
		op(root, { op: "create-ticket", feature: "fr", title: "Third", what: "z" });
		op(root, { op: "create-ticket", feature: "fr", title: "Fourth", what: "w", blockedBy: ["01", "03"] });
		op(root, { op: "resolve", feature: "fr", ticket: "01", answer: "done" });
		op(root, { op: "claim", feature: "fr", ticket: "02" });
		// a hand-written blocker that names no ticket (a typo, or a title since edited)
		const fifth = join(root, ".scratch", "fr", "issues", "05-fifth.md");
		writeFileSync(fifth, "# 5: Fifth\n\n**What to build:** v\n\n**Blocked by:** 99\n\n**Status:** ready-for-agent\n");

		const frontier = op(root, { op: "frontier", feature: "fr" });
		assert.match(frontier, /^ {2}02 — Second \[claimed\]$/m, "the claim, not a resolved blocker");
		assert.match(frontier, /^ {2}04 — Fourth \(waiting on 03\)$/m, "the resolved blocker is not named");
		assert.match(frontier, /^- 05 — Fifth/m, "an unresolvable blocker does not gate");
		assert.match(frontier, /05 names 99/, "…and is disclosed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a repo configured for GitHub refuses the local ops, naming the gh-* op; /frontier says to use gh-frontier", () => {
	const root = tempRepo();
	const doc = join(root, "docs", "agents", "issue-tracker.md");
	try {
		mkdirSync(join(root, "docs", "agents"), { recursive: true });
		writeFileSync(doc, "# Issue tracker: GitHub\n\nIssues live on GitHub.\n");
		assert.throws(
			() => op(root, { op: "create-ticket", feature: "gh", title: "T", what: "x" }),
			/docs\/agents\/issue-tracker\.md configures GitHub.*use "gh-create-ticket"/,
		);
		assert.equal(existsSync(join(root, ".scratch")), false, "nothing is written to .scratch/");
		assert.throws(() => op(root, { op: "frontier", feature: "gh" }), /use "gh-frontier"/);
		const readout = runAllFrontiers(root);
		assert.doesNotMatch(readout, /No features tracked/);
		assert.match(readout, /gh-frontier/);

		writeFileSync(doc, "# Issue tracker: Local Markdown\n\nIssues live in .scratch/.\n");
		assert.throws(() => op(root, { op: "gh-list" }), /configures Local Markdown.*use "list"/);
		// gh-triage has no local twin: the hint must name an op that exists
		assert.throws(
			() => op(root, { op: "gh-triage" }),
			(error: Error) => /"list" with a "status" filter/.test(error.message) && !/use "triage"/.test(error.message),
		);
		op(root, { op: "create-ticket", feature: "local", title: "T", what: "x" });

		writeFileSync(doc, "# Issue tracker: GitLab\n\nIssues live on GitLab.\n");
		assert.throws(() => op(root, { op: "list", feature: "local" }), /configures GitLab.*CLI recipes/);
		assert.throws(() => op(root, { op: "gh-list" }), /configures GitLab.*CLI recipes/);
		assert.match(runAllFrontiers(root), /GitLab.*CLI recipes/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolve without a gist says the map was not updated, when a map exists", () => {
	const root = tempRepo();
	try {
		op(root, { op: "create-map", feature: "gm", destination: "d" });
		op(root, { op: "create-ticket", feature: "gm", title: "Q", what: "?", type: "research" });
		const out = op(root, { op: "resolve", feature: "gm", ticket: "01", answer: "yes" });
		assert.match(out, /map\.md was NOT updated: no "gist" was given/);

		// no map: a gist is not required, and none is claimed
		op(root, { op: "create-ticket", feature: "plain", title: "Q", what: "?" });
		const plain = op(root, { op: "resolve", feature: "plain", ticket: "01", answer: "yes" });
		assert.doesNotMatch(plain, /map/i);
		op(root, { op: "create-ticket", feature: "plain", title: "R", what: "?" });
		assert.doesNotMatch(
			op(root, { op: "resolve", feature: "plain", ticket: "02", answer: "yes", gist: "g" }),
			/map Decisions-so-far updated/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a wayfinder-typed ticket gets no triage Status by default; an explicit status wins; untyped keeps ready-for-agent", () => {
	const root = tempRepo();
	try {
		const typed = op(root, { op: "create-ticket", feature: "wt", title: "Grill it", what: "?", type: "grilling" });
		assert.doesNotMatch(typed, /\*\*Status:\*\*/);
		const explicit = op(root, {
			op: "create-ticket",
			feature: "wt",
			title: "Human",
			what: "?",
			type: "prototype",
			status: "ready-for-human",
		});
		assert.match(explicit, /\*\*Status:\*\* ready-for-human/);
		assert.match(op(root, { op: "create-ticket", feature: "wt", title: "Build", what: "x" }), /\*\*Status:\*\* ready-for-agent/);
		assert.match(op(root, { op: "frontier", feature: "wt" }), /^- 01 — Grill it \[grilling\]/m, "a role-less child stays takeable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("edit on a body with no Question / What-to-build section reports the section was appended", () => {
	const root = tempRepo();
	try {
		mkdirSync(join(root, ".scratch", "bare", "issues"), { recursive: true });
		const file = join(root, ".scratch", "bare", "issues", "01-bare.md");
		writeFileSync(file, "# 1: Bare\n\n**Status:** ready-for-agent\n\nFree prose only.\n");
		const out = op(root, { op: "edit", feature: "bare", ticket: "01", what: "new text" });
		assert.match(out, /no Question or What-to-build section.*appended/);
		assert.match(readFileSync(file, "utf8"), /Free prose only\.\n\n## What to build\n\nnew text/);
		// a body that has the section is replaced, and says nothing about appending
		op(root, { op: "create-ticket", feature: "bare", title: "Full", what: "old" });
		assert.doesNotMatch(op(root, { op: "edit", feature: "bare", ticket: "02", what: "new" }), /appended/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLock's timeout names the staleness window", () => {
	const root = tempRepo();
	try {
		const target = join(root, "guard.txt");
		writeFileSync(`${target}.lock`, "live-holder");
		assert.throws(() => withFileLock(target, () => {}), /timed out waiting for the tracker lock: .*waited 2s.*older than 10s/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stale-lock steal never deletes a lock another waiter just took", () => {
	// Deterministic interleaving: this waiter judges the lock stale (a crashed
	// writer's), and right after that judgment another waiter steals it and takes
	// a fresh lock. Deleting "the lock" at that point deleted the other waiter's
	// live lock, and both ran their critical sections at once.
	const root = tempRepo();
	const target = join(root, "guard.txt");
	const lock = `${target}.lock`;
	const realStat = fs.statSync;
	try {
		writeFileSync(lock, "crashed-writer");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		let swapped = false;
		(fs as { statSync: unknown }).statSync = (path: fs.PathLike, ...rest: unknown[]) => {
			const result = (realStat as (...args: unknown[]) => fs.Stats)(path, ...rest);
			if (!swapped && path === lock) {
				swapped = true;
				writeFileSync(`${lock}.other`, "other-waiter");
				renameSync(`${lock}.other`, lock); // the other waiter's fresh lock
			}
			return result;
		};
		syncBuiltinESMExports();
		let ran = false;
		assert.throws(
			() =>
				withFileLock(target, () => {
					ran = true;
				}),
			/timed out/,
		);
		assert.equal(swapped, true, "the interleaving was exercised");
		assert.equal(ran, false, "no critical section runs while the other waiter holds the lock");
		assert.equal(readFileSync(lock, "utf8"), "other-waiter", "the other waiter's lock survives");
	} finally {
		(fs as { statSync: unknown }).statSync = realStat;
		syncBuiltinESMExports();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an abandoned lock older than the staleness window is taken over", () => {
	const root = tempRepo();
	try {
		const target = join(root, "guard.txt");
		writeFileSync(`${target}.lock`, "crashed-writer");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${target}.lock`, old, old);
		assert.equal(
			withFileLock(target, () => "ran"),
			"ran",
		);
		assert.equal(existsSync(`${target}.lock`), false);
		assert.deepEqual(
			readdirSync(root).filter((f) => f.includes(".lock")),
			[],
			"no stolen or released lock residue",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a holder whose lock was stolen does not delete the thief's lock", () => {
	const root = tempRepo();
	try {
		const target = join(root, "guard.txt");
		const lock = `${target}.lock`;
		withFileLock(target, () => {
			// the holder overran the staleness window and another writer took over
			rmSync(lock);
			writeFileSync(lock, "thief");
		});
		assert.equal(existsSync(lock), true, "the thief's lock survives the holder's release");
		assert.equal(readFileSync(lock, "utf8"), "thief");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("create-map: notes fills Notes, fog fills Not yet specified, title names the map (R15)", () => {
	const root = tempRepo();
	try {
		op(root, {
			op: "create-map",
			feature: "imp",
			title: "CSV import",
			destination: "d",
			notes: "consult the domain skill",
			fog: "encoding handling",
		});
		const map = readFileSync(join(root, ".scratch", "imp", "map.md"), "utf8");
		assert.match(map, /^# Map: CSV import\n/);
		assert.match(map, /## Notes\n\nconsult the domain skill\n/);
		assert.match(map, /## Not yet specified\n\nencoding handling\n/);

		// `what` still fills Notes when `notes` is absent; no title keeps the feature
		op(root, { op: "create-map", feature: "old", destination: "d", what: "legacy notes" });
		const legacy = readFileSync(join(root, ".scratch", "old", "map.md"), "utf8");
		assert.match(legacy, /^# Map: old\n/);
		assert.match(legacy, /## Notes\n\nlegacy notes\n/);
		assert.match(legacy, /## Not yet specified\n\n\(in-scope fog/);

		// the old call shape (what = Notes, notes = fog) would put the fog into Notes
		assert.throws(
			() => op(root, { op: "create-map", feature: "both", destination: "d", what: "n", notes: "f" }),
			/Notes = "notes" \(or "what"\); Not yet specified = "fog"/,
		);
		assert.equal(existsSync(join(root, ".scratch", "both")), false, "nothing is written");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
