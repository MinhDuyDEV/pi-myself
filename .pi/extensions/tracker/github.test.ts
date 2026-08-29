import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRun } from "./github.js";
import {
	ghBlockOp,
	ghClaimOp,
	ghCommentOp,
	ghCreateTicketOp,
	ghFrontierOp,
	ghResolveOp,
	ghShowOp,
	ghStatusOp,
	ghTickOp,
	issueRefs,
} from "./github.js";
import { TrackerError } from "./tracker.js";

interface FakeIssue {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	body: string;
	labels?: string[];
	assignees?: string[];
	url?: string;
}

/** A gh CLI fake: supports `issue list` and `issue view` only, with the exact
 * JSON shapes gh 2.x emits. Records mutations via `edits`. */
function fakeGh(issues: FakeIssue[]) {
	const edits: Array<{ number: number; args: string[]; input?: string }> = [];
	const run: GhRun = (_root, args, input) => {
		if (args[0] !== "issue") throw new TrackerError(`unexpected gh call: ${args.join(" ")}`);
		const [, sub, numberOrState] = args;
		if (sub === "list") {
			const state = args[3] === "all" ? "all" : "open";
			return JSON.stringify(issues.filter((i) => (state === "all" ? true : i.state === "OPEN")));
		}
		if (sub === "view") {
			const issue = issues.find((i) => i.number === Number(numberOrState));
			if (!issue) throw new TrackerError(`no issue #${numberOrState}`);
			return JSON.stringify({ ...issue, number: issue.number, comments: [] });
		}
		if (sub === "create") {
			throw new TrackerError("create must be asserted via edits");
		}
		if (sub === "edit" || sub === "close" || sub === "comment") {
			edits.push({ number: Number(numberOrState), args, input });
			return `https://example.test/issues/${numberOrState}/#42`;
		}
		throw new TrackerError(`unexpected gh sub: ${sub}`);
	};
	return { run, edits };
}

const BODY = (refs: string, what = "Do the thing.") =>
	`**What to build:** ${what}\n\n**Blocked by:** ${refs}\n\n**Status:** ready-for-agent\n`;

test("issueRefs parses #refs, drops 'None', handles bare numbers", () => {
	assert.deepEqual(issueRefs(BODY("#1, #3 and #04")), [1, 3, 4]);
	assert.deepEqual(issueRefs(BODY("None (can start immediately)")), []);
	assert.deepEqual(issueRefs("no field at all"), []);
	assert.deepEqual(issueRefs(BODY("#1"), "Part of"), []); // wrong label: empty
	assert.deepEqual(issueRefs("Part of: #7", "Part of"), [7]);
});

test("gh-frontier: closed refs unblock, maps and parents are excluded (with footer), claimed is blocked", () => {
	const withClaim = fakeGh([
		{ number: 1, title: "Spec", state: "OPEN", body: "the spec", labels: [], url: "" },
		{ number: 2, title: "Child A", state: "OPEN", body: "Part of: #1\n\n" + BODY("None"), labels: ["ready-for-agent"], url: "" },
		{ number: 3, title: "Child B", state: "OPEN", body: "Part of: #1\n\n**Blocked by:** #2", labels: ["ready-for-agent"], url: "" },
		{ number: 5, title: "Claimed", state: "OPEN", body: BODY("None"), labels: ["ready-for-agent"], assignees: ["me"], url: "" },
	]);
	const frontier = ghFrontierOp("/tmp", { op: "gh-frontier" }, withClaim.run);
	assert.match(frontier, /- #2 — Child A/);
	assert.doesNotMatch(frontier, /#1 — Spec/);
	assert.match(frontier, /excluded from the frontier as indexes: #1/);
	assert.match(frontier, /#3 — Child B.*waiting on #2/);
	assert.match(frontier, /#5 — Claimed.*claimed/);
});

test("gh-frontier: unknown blocker is conservative (blocks)", () => {
	const { run } = fakeGh([{ number: 9, title: "Dangling", state: "OPEN", body: BODY("#999"), labels: [], url: "" }]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, run);
	assert.doesNotMatch(out, /^- #9 — Dangling$/m);
});

test("gh-create-ticket shapes the body and validates the label", () => {
	const issues: FakeIssue[] = [];
	const { run, edits } = fakeGh(issues);
	const createRun: GhRun = (root, args, input) => {
		if (args[1] === "create") {
			edits.push({ number: 0, args, input });
			return "https://github.com/MinhDuyDEV/pi-myself/issues/42";
		}
		return run(root, args, input);
	};
	const out = ghCreateTicketOp(
		"/tmp",
		{
			op: "gh-create-ticket",
			title: "Add thing",
			what: "A thing.",
			blockedBy: ["#1"],
			status: "ready-for-agent",
			parent: "#1",
		},
		createRun,
	);
	assert.match(out, /issues\/42/);
	const create = edits.find((e) => e.args[1] === "create")!;
	assert.deepEqual(create.args.slice(-2), ["--label", "ready-for-agent"]);
	const body = create.input ?? "";
	assert.match(body, /^Part of: #1/);
	assert.match(body, /\*\*Blocked by:\*\* #1/);
	assert.match(body, /\*\*Status:\*\* ready-for-agent/);

	assert.throws(
		() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "Bad", status: "not sure!" }, createRun),
		/invalid label/,
	);
	assert.throws(
		() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", status: "ready-for-agent" }, createRun),
		/title/,
	);
});

test("gh-claim refuses an already-claimed issue, else assigns @me", () => {
	const free = fakeGh([{ number: 2, title: "T", state: "OPEN", body: "", labels: [], url: "" }]);
	const out = ghClaimOp("/tmp", { op: "gh-claim", ticket: "2" }, free.run);
	assert.match(out, /Claimed/);
	assert.ok(free.edits.some((e) => e.args.includes("--add-assignee") && e.args.includes("@me")));

	const taken = fakeGh([{ number: 3, title: "T", state: "OPEN", body: "", labels: [], assignees: ["sam"], url: "" }]);
	const refused = ghClaimOp("/tmp", { op: "gh-claim", ticket: "3" }, taken.run);
	assert.match(refused, /already claimed by @sam/);
	assert.equal(taken.edits.length, 0);
});

test("gh-resolve closes with an ## Answer comment and carries the gist", () => {
	const { run, edits } = fakeGh([{ number: 4, title: "T", state: "OPEN", body: "", labels: [], url: "" }]);
	ghResolveOp("/tmp", { op: "gh-resolve", ticket: "4", answer: "The answer.", gist: "one line" }, run);
	const close = edits.find((e) => e.args[1] === "close")!;
	const comment = close.args[close.args.indexOf("--comment") + 1];
	assert.match(comment, /## Answer/);
	assert.match(comment, /The answer\./);
	assert.match(comment, /Gist: one line/);
	assert.throws(() => ghResolveOp("/tmp", { op: "gh-resolve", ticket: "4" }, run), /answer/);
});

test("gh-status replaces existing labels; gh-block upserts the body line; gh-tick marks exactly one box", () => {
	const { run, edits } = fakeGh([
		{ number: 5, title: "T", state: "OPEN", body: `${BODY("None")}- [ ] a\n- [ ] b\n` || BODY("None"), labels: ["needs-triage"], url: "" },
	]);
	ghStatusOp("/tmp", { op: "gh-status", ticket: "5", status: "ready-for-agent" }, run);
	const edit = edits.find((e) => e.args[1] === "edit")!;
	assert.ok(edit.args.includes("--add-label") && edit.args.includes("ready-for-agent"));
	assert.ok(edit.args.includes("--remove-label") && edit.args.includes("needs-triage"));

	ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: ["#2", "#3"] }, run);
	const blockEdit = edits.filter((e) => e.args[1] === "edit").pop()!;
	assert.equal(blockEdit.input?.includes("**Blocked by:** #2, #3"), true);

	ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 2 }, run);
	const tickEdit = edits.filter((e) => e.args[1] === "edit").at(-1)!;
	assert.equal(tickEdit.input?.match(/- \[x\]/g)?.length, 1);
	assert.throws(() => ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 9 }, run), /no unchecked criterion #9/);
});

test("gh-show and gh-comment error and comment paths", () => {
	const { run, edits } = fakeGh([{ number: 6, title: "T", state: "OPEN", body: "hello", labels: [], url: "" }]);
	assert.match(ghShowOp("/tmp", { op: "gh-show", ticket: "6" }, run), /#6 — T/);
	assert.throws(() => ghShowOp("/tmp", { op: "gh-show", ticket: "abc" }, run), /issue number/);
	ghCommentOp("/tmp", { op: "gh-comment", ticket: "6", what: "a note" }, run);
	assert.equal(edits.some((e) => e.args[1] === "comment"), true);
});