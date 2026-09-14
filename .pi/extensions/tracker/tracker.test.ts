import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAllFrontiers, runOp } from "./ops.js";
import type { TrackerParams } from "./params.js";
import { TrackerError, parseTicket } from "./tracker.js";

function tempRepo(): string {
	return mkdtempSync(join(tmpdir(), "tracker-ops-"));
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
		op(root, { op: "resolve", feature: "effort", ticket: "pick-parser", answer: "CSV — every source already emits it.", gist: "CSV beats TSV" });

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
		const raw = readFileSync(file, "utf8");
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
		const out = op(root, { op: "create-spec", feature: "limits", title: "Rate limiting", what: "## Problem Statement\n\nToo many requests." });
		assert.match(out, /Spec published: \.scratch\/limits\/spec\.md/);
		const spec = readFileSync(join(root, ".scratch", "limits", "spec.md"), "utf8");
		assert.match(spec, /^# Rate limiting\n\n## Problem Statement/);
		assert.throws(() => op(root, { op: "create-spec", feature: "limits", title: "Again", what: "x" }), /spec already exists/);

		op(root, { op: "create-ticket", feature: "limits", title: "Counter", what: "Count requests.", criteria: ["increments per request", "resets hourly"] });
		op(root, { op: "create-ticket", feature: "limits", title: "Reject", what: "Return 429.", blockedBy: ["01"] });
		op(root, { op: "resolve", feature: "limits", ticket: "01", answer: "Done." });
		const list = op(root, { op: "list", feature: "limits" });
		assert.match(list, /01 \| Counter \| resolved \| - \| - \| 0\/2/);
		assert.match(list, /02 \| Reject \| ready-for-agent \| - \| 01 \| 0\/1/);
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
		const ruled = op(root, { op: "out-of-scope", feature: "import", ticket: "02", answer: "No source emits TSV.", gist: "TSV: no source emits it" });
		assert.match(ruled, /\*\*Status:\*\* out-of-scope/);
		assert.match(ruled, /## Out of scope\n\nNo source emits TSV\./);
		const map = readFileSync(join(root, ".scratch", "import", "map.md"), "utf8");
		assert.match(map, /## Out of scope\n\n\(work consciously ruled out of this effort\)\n\n- \[TSV support\]\(issues\/02-tsv-support\.md\): TSV: no source emits it/);
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