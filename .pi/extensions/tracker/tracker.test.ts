import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		op(root, { op: "create-map", feature: "import", destination: "A working import pipeline.", notes: "encoding handling" });
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
		assert.match(raw, /\*\*Status:\*\* ready-for-agent/);
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
