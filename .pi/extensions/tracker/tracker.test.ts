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