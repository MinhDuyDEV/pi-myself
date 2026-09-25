import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRun } from "./github.js";
import {
	ghBlockOp,
	ghClaimOp,
	ghCommentOp,
	ghCreateMapOp,
	ghCreateSpecOp,
	ghCreateTicketOp,
	ghEditOp,
	ghFrontierOp,
	ghListOp,
	ghMapNoteOp,
	ghOutOfScopeOp,
	ghResolveOp,
	ghRun,
	ghShowOp,
	ghStatusOp,
	ghTickOp,
	ghTriageOp,
	issueRefs,
	parentRefs,
} from "./github.js";
import { TrackerError } from "./tracker.js";

interface FakeIssue {
	number: number;
	title: string;
	/** `MERGED` is what `gh issue view` reports for a merged PR. */
	state: "OPEN" | "CLOSED" | "MERGED";
	body: string;
	labels?: string[];
	assignees?: string[];
	author?: string;
	url?: string;
	createdAt?: string;
	comments?: Array<{ author: string; body: string; createdAt?: string }>;
	/** REST-only extras */
	pull_request?: boolean;
	openBlockers?: number;
	subIssues?: number;
	nativeSupport?: boolean;
}

/** A gh CLI fake covering what the backend uses: `issue list/view/create/
 * edit/close/comment` in gh's `--json` shapes, `label list/create`, and `gh api`
 * for the REST listing (with dependency / sub-issue summaries), per-issue
 * comments, sub-issue order, database ids, issue state, and the native-edge
 * POSTs/DELETEs. Mutations are recorded in `edits`, `posts`, `deletions`,
 * `createdLabels`. */
function fakeGh(
	issues: FakeIssue[],
	options: {
		nativeSupport?: boolean;
		labels?: string[];
		subIssueOrder?: Record<number, number[]>;
		/** What `gh repo view --json nameWithOwner` answers. */
		repoSlug?: string;
	} = {},
) {
	const edits: Array<{ number: number; args: string[]; input?: string }> = [];
	const posts: string[] = [];
	const deletions: string[] = [];
	const createdLabels: string[] = [];
	/** Native `blocked_by` edges per child, keyed by database id (1000 + number). */
	const nativeEdges = new Map<number, Set<number>>();
	const labels = new Set(
		options.labels ?? ["bug", "enhancement", "needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
	);
	let nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
	const graphqlShape = (i: FakeIssue) => ({
		number: i.number,
		title: i.title,
		state: i.state,
		body: i.body,
		labels: (i.labels ?? []).map((name) => ({ name })),
		assignees: (i.assignees ?? []).map((login) => ({ login })),
		author: { login: i.author ?? "reporter" },
		url: i.url ?? `https://example.test/issues/${i.number}`,
		createdAt: i.createdAt ?? "2026-01-01T00:00:00Z",
		comments: (i.comments ?? []).map((c) => ({
			author: { login: c.author },
			body: c.body,
			createdAt: c.createdAt ?? "2026-01-02T00:00:00Z",
		})),
	});
	/** `gh issue list --json comments` silently stops at 100 comments (verified
	 * against gh 2.87.3 on a 148-comment issue). Modelling that here is what keeps
	 * the triage path off the list endpoint: with it, a 120-comment issue must
	 * still show a reporter reply that lands after the hundredth comment. */
	const listShape = (i: FakeIssue) => ({ ...graphqlShape(i), comments: graphqlShape(i).comments.slice(0, 100) });
	const restShape = (i: FakeIssue) => ({
		number: i.number,
		id: 1000 + i.number,
		title: i.title,
		state: i.state === "OPEN" ? "open" : "closed",
		body: i.body,
		labels: (i.labels ?? []).map((name) => ({ name })),
		assignees: (i.assignees ?? []).map((login) => ({ login })),
		user: { login: i.author ?? "reporter" },
		html_url: i.url ?? `https://example.test/issues/${i.number}`,
		created_at: i.createdAt ?? "2026-01-01T00:00:00Z",
		...(i.pull_request ? { pull_request: { url: "x" } } : {}),
		issue_dependencies_summary: { blocked_by: i.openBlockers ?? 0 },
		sub_issues_summary: { total: i.subIssues ?? 0 },
	});
	const run: GhRun = (_root, args, input) => {
		if (args[0] === "repo") {
			if (args[1] === "view" && args.includes("nameWithOwner")) return options.repoSlug ?? "example/repo";
			throw new TrackerError(`unexpected gh repo call: ${args.join(" ")}`);
		}
		if (args[0] === "label") {
			if (args[1] === "list") return JSON.stringify([...labels].map((name) => ({ name })));
			if (args[1] === "create") {
				const name = args[2] ?? "";
				if (labels.has(name)) throw new TrackerError(`label ${name} already exists`);
				labels.add(name);
				createdLabels.push(name);
				return "";
			}
			throw new TrackerError(`unexpected gh label sub: ${args[1]}`);
		}
		if (args[0] === "api") {
			const path = args.find((a) => a.startsWith("repos/")) ?? "";
			if (args.includes("POST")) {
				if (options.nativeSupport === false) throw new TrackerError("gh api: HTTP 404 Not Found");
				posts.push(`${path} ${args[args.length - 1]}`);
				const blockedBy = /issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
				if (blockedBy) {
					const child = Number(blockedBy[1]);
					const id = Number((args[args.length - 1] ?? "").replace("issue_id=", ""));
					const edges = nativeEdges.get(child) ?? new Set<number>();
					edges.add(id);
					nativeEdges.set(child, edges);
				}
				return "{}";
			}
			if (args.includes("DELETE")) {
				if (options.nativeSupport === false) throw new TrackerError("gh api: HTTP 404 Not Found");
				const removed = /issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/.exec(path);
				if (!removed) throw new TrackerError(`unexpected DELETE ${path}`);
				nativeEdges.get(Number(removed[1]))?.delete(Number(removed[2]));
				deletions.push(path);
				return "";
			}
			const nativeFor = /issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
			if (nativeFor) {
				if (options.nativeSupport === false) throw new TrackerError("gh api: HTTP 404 Not Found");
				const ids = [...(nativeEdges.get(Number(nativeFor[1])) ?? [])];
				return JSON.stringify([ids.map((id) => ({ id, number: id - 1000 }))]);
			}
			const commentsFor = /issues\/(\d+)\/comments(?:\?|$)/.exec(path);
			if (commentsFor) {
				const issue = issues.find((i) => i.number === Number(commentsFor[1]));
				if (!issue) throw new TrackerError(`no issue ${path}`);
				return JSON.stringify([
					(issue.comments ?? []).map((c) => ({
						user: { login: c.author },
						body: c.body,
						created_at: c.createdAt ?? "2026-01-02T00:00:00Z",
					})),
				]);
			}
			const subIssuesFor = /issues\/(\d+)\/sub_issues(?:\?|$)/.exec(path);
			if (subIssuesFor) {
				return JSON.stringify((options.subIssueOrder?.[Number(subIssuesFor[1])] ?? []).map((number) => ({ number })));
			}
			if (/issues\?state=/.test(path)) {
				const state = /state=all/.test(path) ? "all" : "open";
				return JSON.stringify([issues.filter((i) => (state === "all" ? true : i.state === "OPEN")).map(restShape)]);
			}
			const m = /issues\/(\d+)$/.exec(path);
			const issue = issues.find((i) => i.number === Number(m?.[1]));
			if (!issue) throw new TrackerError(`no issue ${path}`);
			// the backend uses --jq for the database id and for an issue's state
			const jq = args.includes("--jq") ? args[args.indexOf("--jq") + 1] : undefined;
			if (jq === ".state") return issue.state.toLowerCase();
			if (jq === ".id" || jq === undefined) return String(1000 + issue.number);
			throw new TrackerError(`unexpected --jq ${jq}`);
		}
		if (args[0] !== "issue") throw new TrackerError(`unexpected gh call: ${args.join(" ")}`);
		const [, sub, numberOrFlag] = args;
		if (sub === "list") {
			const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : undefined;
			return JSON.stringify(issues.filter((i) => i.state === "OPEN" && (!label || (i.labels ?? []).includes(label))).map(listShape));
		}
		if (sub === "view") {
			const issue = issues.find((i) => i.number === Number(numberOrFlag));
			if (!issue) throw new TrackerError(`no issue #${numberOrFlag}`);
			return JSON.stringify(graphqlShape(issue));
		}
		if (sub === "create") {
			const number = nextNumber++;
			edits.push({ number, args, input });
			issues.push({
				number,
				title: args[args.indexOf("--title") + 1],
				state: "OPEN",
				body: input ?? "",
				labels: args.filter((_, i) => args[i - 1] === "--label"),
			});
			return `https://example.test/issues/${number}`;
		}
		if (sub === "edit" || sub === "close" || sub === "comment") {
			edits.push({ number: Number(numberOrFlag), args, input });
			return "";
		}
		throw new TrackerError(`unexpected gh sub: ${sub}`);
	};
	return { run, edits, posts, deletions, createdLabels, issues, nativeEdges, labels };
}

const BODY = (refs: string, what = "Do the thing.") =>
	`## What to build\n\n${what}\n\n## Acceptance criteria\n\n- [ ] a\n- [ ] b\n\n**Blocked by:** ${refs}\n`;

test("issueRefs / parentRefs read every spelling the skills write", () => {
	assert.deepEqual(issueRefs(BODY("#1, #3 and #04")), [1, 3, 4]);
	assert.deepEqual(issueRefs(BODY("None (can start immediately)")), []);
	assert.deepEqual(issueRefs("## Blocked by\n\n- #7\n- #9\n\n## Other\n#5"), [7, 9], "to-tickets section form");
	assert.deepEqual(issueRefs("no field at all"), []);
	// A digit run in prose is not an issue number. Scanning every run read the
	// "4567" below as a blocker, and an unresolvable blocker used to hide the
	// ticket from the frontier permanently.
	assert.deepEqual(issueRefs("## Blocked by\n\nBlocked by #12. Also needs the migration in PR 4567.\n"), [12], "prose digits ignored");
	assert.deepEqual(issueRefs("## Blocked by\n\n3 days of work\n"), [], "a bare count is not a blocker");
	assert.deepEqual(issueRefs("## Blocked by\n\n- 12\n- 34\n"), [12, 34], "a bare-id list still resolves");
	assert.deepEqual(issueRefs(BODY("-")), [], "wayfinder's empty placeholder");
	assert.deepEqual(issueRefs(BODY("n/a")), []);
	assert.deepEqual(parentRefs("Part of: #7\n\n## What"), [7], "this repo's line form");
	assert.deepEqual(parentRefs("Part of #8\n"), [8], "wayfinder fallback (no colon)");
	assert.deepEqual(parentRefs("## Parent\n\n#9\n\n## What to build"), [9], "to-tickets section form");
	assert.deepEqual(parentRefs(BODY("#1")), []);
});

test("gh-frontier: native blocked_by count, body refs, maps, parents (sub-issues or Part of), PRs, claim", () => {
	const gh = fakeGh([
		{ number: 1, title: "Spec", state: "OPEN", body: "the spec", labels: ["ready-for-agent"], subIssues: 2 },
		{ number: 2, title: "Child A", state: "OPEN", body: `Part of: #1\n\n${BODY("None")}`, labels: ["ready-for-agent"] },
		{ number: 3, title: "Child B", state: "OPEN", body: "Part of: #1\n\n**Blocked by:** #2", labels: ["ready-for-agent"] },
		{ number: 4, title: "Native-blocked", state: "OPEN", body: BODY("None"), openBlockers: 1 },
		{ number: 5, title: "Claimed", state: "OPEN", body: BODY("None"), assignees: ["me"] },
		{ number: 6, title: "A PR", state: "OPEN", body: "diff", pull_request: true },
		{ number: 7, title: "Map", state: "OPEN", body: "## Destination", labels: ["wayfinder:map"] },
		{ number: 8, title: "Unblocked by closed", state: "OPEN", body: BODY("#9") },
		{ number: 9, title: "Done", state: "CLOSED", body: "" },
	]);
	const frontier = ghFrontierOp("/tmp", { op: "gh-frontier" }, gh.run);
	assert.match(frontier, /^- #2 — Child A/m);
	assert.match(frontier, /^- #8 — Unblocked by closed/m, "a closed blocker unblocks");
	assert.doesNotMatch(frontier, /#1 — Spec/, "parents are indexes");
	assert.doesNotMatch(frontier, /#6 — A PR/, "pull requests are not tickets");
	assert.match(frontier, /#3 — Child B.*waiting on #2/);
	assert.match(frontier, /#4 — Native-blocked.*waiting on 1 native blocker/);
	assert.match(frontier, /#5 — Claimed.*claimed/);
	assert.match(frontier, /excluded from the frontier as indexes: #1, #7/);

	const scoped = ghFrontierOp("/tmp", { op: "gh-frontier", parent: "#1" }, gh.run);
	assert.match(scoped, /children of #1/);
	assert.match(scoped, /^- #2 — Child A/m);
	assert.doesNotMatch(scoped, /#8 — Unblocked by closed/, "outside the parent's children");
});

test("gh-frontier: a blocker ref that names no issue is not gating, and is disclosed", () => {
	// A `Blocked by: #999` that resolves to nothing (a typo, another repo's number,
	// a deleted issue) used to read as an open blocker forever: the ticket never
	// reached the frontier and nothing said why. It does not gate now — but the
	// reference is still reported, so a typo gets noticed.
	const { run } = fakeGh([{ number: 9, title: "Dangling", state: "OPEN", body: BODY("#999") }]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, run);
	assert.match(out, /^- #9 — Dangling$/m, "an unresolvable ref does not wedge the ticket");
	assert.match(out, /not gating: #9 names #999 — no such issue or PR in this repo/);
});

test("gh-frontier: a blocker that names a PR follows the PR's state", () => {
	// Issues and PRs share one number space, so `Blocked by: #6` may name a PR;
	// dropping PRs from the index made every such reference unresolvable.
	const openPr = fakeGh([
		{ number: 5, title: "Needs the PR", state: "OPEN", body: BODY("#6") },
		{ number: 6, title: "A PR", state: "OPEN", body: "diff", pull_request: true },
	]);
	const blocked = ghFrontierOp("/tmp", { op: "gh-frontier" }, openPr.run);
	assert.doesNotMatch(blocked, /^- #5 — Needs the PR$/m, "an open PR gates like an open issue");
	assert.match(blocked, /#5 — Needs the PR.*waiting on #6/);

	const closedPr = fakeGh([
		{ number: 5, title: "Needs the PR", state: "OPEN", body: BODY("#6") },
		{ number: 6, title: "A PR", state: "CLOSED", body: "diff", pull_request: true },
	]);
	assert.match(ghFrontierOp("/tmp", { op: "gh-frontier" }, closedPr.run), /^- #5 — Needs the PR$/m, "a merged or closed PR unblocks");
});

test("gh-frontier: a self-reference does not block its own ticket", () => {
	const { run } = fakeGh([{ number: 4, title: "Self", state: "OPEN", body: BODY("#4") }]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, run);
	assert.match(out, /^- #4 — Self$/m);
	assert.match(out, /not gating: #4 names #4/);
});

test("gh-frontier scoped to a map follows the map's sub-issue order, not the number order", () => {
	// wayfinder's contract is "first in map order wins", and the native sub-issue
	// list is where that order lives; number order is only the fallback.
	const gh = fakeGh(
		[
			{ number: 1, title: "Map", state: "OPEN", body: "", labels: ["wayfinder:map"], subIssues: 3 },
			{ number: 2, title: "Second", state: "OPEN", body: "Part of: #1" },
			{ number: 3, title: "First", state: "OPEN", body: "Part of: #1" },
			{ number: 4, title: "Third", state: "OPEN", body: "Part of: #1" },
		],
		{ subIssueOrder: { 1: [3, 2, 4] } },
	);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier", parent: "1" }, gh.run);
	assert.deepEqual(
		[...out.matchAll(/^- #(\d+)/gm)].map((m) => Number(m[1])),
		[3, 2, 4],
	);
	assert.match(out, /first in map order wins/);

	const unscoped = ghFrontierOp("/tmp", { op: "gh-frontier" }, gh.run);
	assert.match(unscoped, /first by number wins/);

	// an unreadable order is a stated fallback, not a silent reordering
	const noOrder = fakeGh([{ number: 1, title: "Map", state: "OPEN", body: "", subIssues: 1 }]);
	// a parent whose children are linked only by `Part of` has no native order:
	// claiming "map order" there would misdescribe an issue-number listing
	assert.match(ghFrontierOp("/tmp", { op: "gh-frontier", parent: "1" }, noOrder.run), /no native sub-issue order to follow/);
});

test("gh-create-spec publishes the spec as a ready-for-agent issue and names the parent number", () => {
	const gh = fakeGh([]);
	const out = ghCreateSpecOp("/tmp", { op: "gh-create-spec", title: "Rate limiting", what: "## Problem Statement\n\n..." }, gh.run);
	assert.match(out, /Spec published: .*issues\/1 — tickets reference it with parent "#1"/);
	assert.deepEqual(gh.edits[0].args.slice(-2), ["--label", "ready-for-agent"]);
	assert.throws(() => ghCreateSpecOp("/tmp", { op: "gh-create-spec", title: "x" }, gh.run), /what/);
});

test("gh-create-ticket: to-tickets template, native sub-issue + dependency edges, mirrored lines", () => {
	const gh = fakeGh([
		{ number: 1, title: "Spec", state: "OPEN", body: "spec" },
		{ number: 2, title: "Schema", state: "OPEN", body: "" },
	]);
	const out = ghCreateTicketOp(
		"/tmp",
		{
			op: "gh-create-ticket",
			title: "API",
			what: "Serve it.",
			criteria: ["returns 200", "returns 429 over limit"],
			blockedBy: ["#2"],
			parent: "1",
		},
		gh.run,
	);
	assert.match(out, /Created .*issues\/3 \[ready-for-agent\]/);
	assert.match(out, /sub-issue of #1: native edge added/);
	assert.match(out, /blocked by #2: native edge added/);
	assert.deepEqual(gh.posts, [
		"repos/{owner}/{repo}/issues/1/sub_issues sub_issue_id=1003",
		"repos/{owner}/{repo}/issues/3/dependencies/blocked_by issue_id=1002",
	]);
	const body = gh.edits.find((e) => e.args[1] === "create")!.input ?? "";
	assert.match(body, /^Part of: #1/);
	assert.match(body, /## What to build\n\nServe it\./);
	assert.match(body, /## Acceptance criteria\n\n- \[ \] returns 200\n- \[ \] returns 429 over limit/);
	assert.match(body, /\*\*Blocked by:\*\* #2/);

	assert.throws(() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "Bad", status: "not sure!" }, gh.run), /invalid label/);
	assert.throws(() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", status: "ready-for-agent" }, gh.run), /title/);
});

test("gh-create-ticket: wayfinder child gets a Question body and wayfinder:<type> label; native edges fall back to lines", () => {
	const gh = fakeGh([{ number: 1, title: "Map", state: "OPEN", body: "## Destination", labels: ["wayfinder:map"] }], {
		nativeSupport: false,
	});
	const out = ghCreateTicketOp(
		"/tmp",
		{ op: "gh-create-ticket", title: "Which parser?", what: "CSV or TSV?", type: "research", parent: "#1" },
		gh.run,
	);
	assert.match(out, /\[wayfinder:research\]/, "no triage label unless asked");
	assert.match(out, /sub-issue of #1: native edge NOT added .*body line is the fallback/);
	const body = gh.edits.find((e) => e.args[1] === "create")!.input ?? "";
	assert.match(body, /^Part of: #1\n\n## Question\n\nCSV or TSV\?/);
	assert.doesNotMatch(body, /Acceptance criteria/);
});

test("gh-claim refuses an already-claimed issue, else assigns @me", () => {
	const free = fakeGh([{ number: 2, title: "T", state: "OPEN", body: "" }]);
	assert.match(ghClaimOp("/tmp", { op: "gh-claim", ticket: "2" }, free.run), /Claimed/);
	assert.ok(free.edits.some((e) => e.args.includes("--add-assignee") && e.args.includes("@me")));

	const taken = fakeGh([{ number: 3, title: "T", state: "OPEN", body: "", assignees: ["sam"] }]);
	assert.match(ghClaimOp("/tmp", { op: "gh-claim", ticket: "3" }, taken.run), /already claimed by @sam/);
	assert.equal(taken.edits.length, 0);
});

test("gh-resolve: answer comment + close, and the gist lands in the parent map's Decisions so far", () => {
	const gh = fakeGh([
		{
			number: 1,
			title: "Map: import",
			state: "OPEN",
			body: "## Destination\n\nx\n\n## Decisions so far\n\n## Out of scope\n",
			labels: ["wayfinder:map"],
		},
		{
			number: 4,
			title: "Pick parser",
			state: "OPEN",
			body: "Part of: #1\n\n## Question\n\nCSV or TSV?",
			url: "https://example.test/issues/4",
		},
	]);
	const out = ghResolveOp("/tmp", { op: "gh-resolve", ticket: "4", answer: "CSV.", gist: "CSV beats TSV" }, gh.run);
	assert.match(out, /map #1 Decisions so far updated/);
	const close = gh.edits.find((e) => e.args[1] === "close")!;
	assert.deepEqual(close.args.slice(3, 5), ["--reason", "completed"]);
	const comment = close.args[close.args.indexOf("--comment") + 1];
	assert.match(comment, /## Answer\n\nCSV\.\n\nGist: CSV beats TSV/);
	const mapEdit = gh.edits.find((e) => e.args[1] === "edit" && e.number === 1)!;
	assert.match(
		mapEdit.input ?? "",
		/## Decisions so far\n\n- \[Pick parser\]\(https:\/\/example\.test\/issues\/4\): CSV beats TSV\n\n## Out of scope/,
	);
	assert.throws(() => ghResolveOp("/tmp", { op: "gh-resolve", ticket: "4" }, gh.run), /answer/);

	const wontfix = fakeGh([{ number: 5, title: "Dup", state: "OPEN", body: "" }]);
	ghResolveOp("/tmp", { op: "gh-resolve", ticket: "5", answer: "Already implemented in v2.", status: "wontfix" }, wontfix.run);
	const wfClose = wontfix.edits.find((e) => e.args[1] === "close")!;
	assert.deepEqual(wfClose.args.slice(3, 5), ["--reason", "not planned"]);
	assert.doesNotMatch(wfClose.args[wfClose.args.indexOf("--comment") + 1], /## Answer/);
	assert.ok(wontfix.edits.some((e) => e.args.includes("--add-label") && e.args.includes("wontfix")));
});

test("gh-out-of-scope closes as not planned and gists into the map's Out of scope, never Decisions", () => {
	const gh = fakeGh([
		{ number: 1, title: "Map", state: "OPEN", body: "## Decisions so far\n\n## Out of scope\n", labels: ["wayfinder:map"] },
		{ number: 6, title: "Support TSV", state: "OPEN", body: "Part of: #1\n\n## Question\n\nTSV too?" },
	]);
	const out = ghOutOfScopeOp(
		"/tmp",
		{ op: "gh-out-of-scope", ticket: "6", answer: "No source emits TSV.", gist: "TSV: no source emits it" },
		gh.run,
	);
	assert.match(out, /map #1 Out of scope updated/);
	const mapEdit = gh.edits.find((e) => e.args[1] === "edit" && e.number === 1)!;
	assert.match(mapEdit.input ?? "", /## Decisions so far\n\n## Out of scope\n\n- \[Support TSV\]\(.*\): TSV: no source emits it/);
	const close = gh.edits.find((e) => e.args[1] === "close")!;
	assert.deepEqual(close.args.slice(3, 5), ["--reason", "not planned"]);
});

test("gh-status swaps only within the role family: state roles, category roles, other labels untouched", () => {
	const gh = fakeGh([{ number: 5, title: "T", state: "OPEN", body: BODY("None"), labels: ["needs-triage", "bug", "wayfinder:task"] }]);
	assert.match(
		ghStatusOp("/tmp", { op: "gh-status", ticket: "5", status: "ready-for-agent" }, gh.run),
		/→ bug, wayfinder:task, ready-for-agent/,
	);
	const edit = gh.edits.at(-1)!;
	assert.deepEqual(edit.args.slice(3), ["--remove-label", "needs-triage", "--add-label", "ready-for-agent"]);

	ghStatusOp("/tmp", { op: "gh-status", ticket: "5", status: "enhancement" }, gh.run);
	assert.deepEqual(gh.edits.at(-1)!.args.slice(3), ["--remove-label", "bug", "--add-label", "enhancement"]);

	const before = gh.edits.length;
	ghStatusOp("/tmp", { op: "gh-status", ticket: "5", status: "needs-triage" }, gh.run);
	assert.equal(gh.edits.length, before, "already-present label is a no-op");
});

test("gh-status maps canonical roles through docs/agents/triage-labels.md", () => {
	const root = mkdtempSync(join(tmpdir(), "tracker-labels-"));
	try {
		mkdirSync(join(root, "docs", "agents"), { recursive: true });
		writeFileSync(
			join(root, "docs", "agents", "triage-labels.md"),
			"| Label in mattpocock/skills | Label in our tracker | Meaning |\n| --- | --- | --- |\n| `needs-triage` | `bug:triage` | x |\n| `ready-for-agent` | `agent-ready` | y |\n",
		);
		const gh = fakeGh([{ number: 1, title: "T", state: "OPEN", body: "", labels: ["bug:triage"] }]);
		ghStatusOp(root, { op: "gh-status", ticket: "1", status: "ready-for-agent" }, gh.run);
		assert.deepEqual(gh.edits.at(-1)!.args.slice(3), ["--remove-label", "bug:triage", "--add-label", "agent-ready"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gh-block mirrors the line and adds native edges; gh-tick marks exactly one box", () => {
	const gh = fakeGh([
		{ number: 2, title: "A", state: "OPEN", body: "" },
		{ number: 3, title: "B", state: "OPEN", body: "" },
		{ number: 5, title: "T", state: "OPEN", body: `${BODY("None")}` },
	]);
	const out = ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: ["#2", "#3"] }, gh.run);
	assert.match(out, /blocked by #2: native edge added/);
	assert.equal(gh.edits.find((e) => e.args[1] === "edit")!.input?.includes("**Blocked by:** #2, #3"), true);
	assert.deepEqual(gh.posts, [
		"repos/{owner}/{repo}/issues/5/dependencies/blocked_by issue_id=1002",
		"repos/{owner}/{repo}/issues/5/dependencies/blocked_by issue_id=1003",
	]);

	ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 2 }, gh.run);
	assert.equal(gh.edits.at(-1)!.input?.match(/- \[x\]/g)?.length, 1);
	assert.throws(() => ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 9 }, gh.run), /no unchecked criterion #9/);
});

test("gh-show renders every comment in full; gh-comment posts; gh-list filters by label", () => {
	const gh = fakeGh([
		{
			number: 6,
			title: "T",
			state: "OPEN",
			body: "hello",
			labels: ["needs-info"],
			comments: [
				{ author: "maint", body: "## Triage Notes\n\nneed repro" },
				{ author: "reporter", body: `here is the repro ${"x".repeat(300)}` },
			],
		},
		{ number: 7, title: "U", state: "OPEN", body: "", labels: ["needs-triage"] },
	]);
	const shown = ghShowOp("/tmp", { op: "gh-show", ticket: "6" }, gh.run);
	assert.match(shown, /## Comments \(2\)/);
	assert.match(shown, /### @maint.*\n\n## Triage Notes/);
	assert.match(shown, /x{300}/, "comments are not truncated to a snippet");
	assert.throws(() => ghShowOp("/tmp", { op: "gh-show", ticket: "abc" }, gh.run), /issue number/);
	ghCommentOp("/tmp", { op: "gh-comment", ticket: "6", what: "a note" }, gh.run);
	assert.equal(
		gh.edits.some((e) => e.args[1] === "comment"),
		true,
	);
	assert.match(ghListOp("/tmp", { op: "gh-list", status: "needs-triage" }, gh.run), /1 open, label needs-triage[\s\S]*#7 — U/);
	assert.doesNotMatch(ghListOp("/tmp", { op: "gh-list", status: "needs-triage" }, gh.run), /#6 — T/);
});

test("gh-triage buckets: never triaged, needs-triage, needs-info with a reporter reply after the last Triage Notes", () => {
	const gh = fakeGh([
		{ number: 1, title: "Untouched", state: "OPEN", body: "boom", createdAt: "2026-01-03T00:00:00Z" },
		{ number: 2, title: "Older untouched", state: "OPEN", body: "bang", labels: ["bug"], createdAt: "2026-01-01T00:00:00Z" },
		{ number: 3, title: "Queued", state: "OPEN", body: "", labels: ["needs-triage"] },
		{
			number: 4,
			title: "Waiting",
			state: "OPEN",
			body: "",
			labels: ["needs-info"],
			author: "rep",
			comments: [{ author: "maint", body: "## Triage Notes\n\nneed more" }],
		},
		{
			number: 5,
			title: "Replied",
			state: "OPEN",
			body: "",
			labels: ["needs-info"],
			author: "rep",
			comments: [
				{ author: "maint", body: "## Triage Notes\n\nneed more" },
				{ author: "rep", body: "here you go" },
			],
		},
		{ number: 6, title: "Map", state: "OPEN", body: "", labels: ["wayfinder:map"] },
		{ number: 7, title: "Ready", state: "OPEN", body: "", labels: ["ready-for-agent"] },
		// a wayfinder child carries no triage role by design (it is claimed, not
		// triaged), so it must not sit in "never triaged" forever
		{ number: 10, title: "Wayfinder child", state: "OPEN", body: "Part of: #6", labels: ["wayfinder:research"] },
		// a real spec is an index because it has native sub-issues (how the tool
		// wires a parent); the CLOSED #9 below only mentions `Part of: #8` and is
		// deliberately not enough to mark #8 an index on its own
		{ number: 8, title: "Spec", state: "OPEN", body: "the spec", createdAt: "2025-12-01T00:00:00Z", subIssues: 1 },
		{ number: 9, title: "Closed child", state: "CLOSED", body: "Part of: #8" },
	]);
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, gh.run);
	assert.match(
		out,
		/## Never triaged — no state role \(2\)\n- #2 — Older untouched.*\n- #1 — Untouched/,
		"oldest first, category-only counts as untriaged",
	);
	assert.match(out, /## needs-triage \(1\)\n- #3 — Queued/);
	assert.match(out, /## needs-info — reporter replied since the last Triage Notes \(1\)\n- #5 — Replied/);
	assert.doesNotMatch(
		out,
		/#4 — Waiting|#6 — Map|#7 — Ready|#8 — Spec|#10 — Wayfinder child/,
		"parents are indexes; wayfinder tickets are claimed, not triaged",
	);
});

test("gh-triage sees a reporter reply past the 100th comment", () => {
	// `gh issue list --json comments` returns at most the first 100 comments (gh
	// 2.87.3, verified on a 148-comment issue), so triage reads comments from the
	// paginated REST endpoint: a `## Triage Notes` at comment 110 with the reply
	// after it is invisible from the list endpoint, and the issue would sit in
	// needs-info forever or drop out wrongly.
	const comments = [
		...Array.from({ length: 110 }, (_, i) => ({ author: "maint", body: `chatter ${i}` })),
		{ author: "maint", body: "## Triage Notes\n\nneed the version" },
		...Array.from({ length: 4 }, (_, i) => ({ author: "maint", body: `more chatter ${i}` })),
		{ author: "rep", body: "1.2.3 here" },
	];
	const gh = fakeGh([{ number: 5, title: "Busy", state: "OPEN", body: "b", labels: ["needs-info"], author: "rep", comments }]);
	assert.ok(comments.length > 100, "the fixture must exceed gh's list-endpoint cap");
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, gh.run);
	assert.match(out, /## needs-info — reporter replied since the last Triage Notes \(1\)\n- #5 — Busy/);
});

test("gh-triage keeps an issue whose comments cannot be read, and says so", () => {
	// Unreadable comments mean the needs-info question cannot be answered; dropping
	// the issue would hide a waiting report, so it stays visible.
	const gh = fakeGh([{ number: 4, title: "Unreadable", state: "OPEN", body: "", labels: ["needs-info"] }]);
	const run: GhRun = (root, args, input) => {
		if (args[0] === "api" && /\/comments(?:\?|$)/.test(args.find((a) => a.startsWith("repos/")) ?? "")) {
			throw new TrackerError("gh api: HTTP 502 Bad Gateway");
		}
		return gh.run(root, args, input);
	};
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, run);
	assert.match(out, /## needs-info — reporter replied since the last Triage Notes \(1\)\n- #4 — Unreadable/);
	assert.match(out, /#4's comments could not be read/);
});

test("gh-frontier lists by number even when the REST listing is created-desc", () => {
	// GitHub's issues API defaults to `created` desc; the tracker's contract is
	// "first by number wins", so the tool must not inherit the API's order.
	const gh = fakeGh([
		{ number: 9, title: "Newest", state: "OPEN", body: "no refs" },
		{ number: 3, title: "Older", state: "OPEN", body: "no refs" },
		{ number: 7, title: "Middle", state: "OPEN", body: "no refs" },
		{ number: 1, title: "Oldest", state: "OPEN", body: "no refs" },
	]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, gh.run);
	assert.deepEqual(
		[...out.matchAll(/^- #(\d+)/gm)].map((m) => Number(m[1])),
		[1, 3, 7, 9],
	);
});

test("gh-list maps a canonical triage role through docs/agents/triage-labels.md", () => {
	const root = mkdtempSync(join(tmpdir(), "tracker-ghlist-"));
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
		const gh = fakeGh([{ number: 2, title: "T", state: "OPEN", body: "", labels: ["agent-ready"] }]);
		const out = ghListOp(root, { op: "gh-list", status: "ready-for-agent" }, gh.run);
		// passing the raw canonical role would have matched nothing here
		assert.match(out, /1 open, label agent-ready[\s\S]*#2 — T/);
		assert.equal(out.includes("No open issues"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gh-show names omitted comments and truncated bodies", () => {
	const many = Array.from({ length: 35 }, (_, i) => ({ author: `u${i}`, body: `note ${i}` }));
	const gh = fakeGh([{ number: 4, title: "T", state: "OPEN", body: "b", comments: many }]);
	const out = ghShowOp("/tmp", { op: "gh-show", ticket: "4" }, gh.run);
	assert.match(out, /## Comments \(30 of 35 — the 5 oldest were not shown\)/);
	assert.equal(/note 0\b/.test(out), false, "the 5 oldest are the omitted ones");
	assert.match(out, /note 34/);

	const long = fakeGh([{ number: 5, title: "L", state: "OPEN", body: "b", comments: [{ author: "a", body: "y".repeat(5000) }] }]);
	const shown = ghShowOp("/tmp", { op: "gh-show", ticket: "5" }, long.run);
	assert.match(shown, /## Comments \(1\)/, "no omission means no 'of N'");
	assert.match(shown, /1000 more characters truncated/);
});

test("gh-resolve status=wontfix replaces the state role instead of stacking labels", () => {
	const gh = fakeGh([{ number: 8, title: "R", state: "OPEN", body: "", labels: ["needs-info", "bug"] }]);
	ghResolveOp("/tmp", { op: "gh-resolve", ticket: "8", answer: "not a bug", status: "wontfix" }, gh.run);
	const edit = gh.edits.find((e) => e.args[1] === "edit")!;
	assert.equal(edit.args[edit.args.indexOf("--remove-label") + 1], "needs-info");
	assert.equal(edit.args.includes("bug"), false, "the category role is untouched");
	assert.equal(edit.args.includes("wontfix"), true);
});

test("gh-block deletes native edges that are no longer listed", () => {
	const gh = fakeGh([
		{ number: 5, title: "C", state: "OPEN", body: "**Blocked by:** #2, #3\n" },
		{ number: 2, title: "B2", state: "OPEN", body: "" },
		{ number: 3, title: "B3", state: "OPEN", body: "" },
	]);
	ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: ["#2"] }, gh.run);
	assert.deepEqual(gh.posts, ["repos/{owner}/{repo}/issues/5/dependencies/blocked_by issue_id=1002"]);
	assert.deepEqual(gh.deletions, [], "nothing to remove on the first write");

	// narrowing #2,#3 → #3 must drop #2's native edge, not just the body line
	ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: ["#3"] }, gh.run);
	assert.deepEqual(gh.deletions, ["repos/{owner}/{repo}/issues/5/dependencies/blocked_by/1002"]);

	// clearing entirely removes the remaining edge
	ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: [] }, gh.run);
	assert.deepEqual(gh.deletions, [
		"repos/{owner}/{repo}/issues/5/dependencies/blocked_by/1002",
		"repos/{owner}/{repo}/issues/5/dependencies/blocked_by/1003",
	]);
});

test("gh-block says so when native edges cannot be read", () => {
	const gh = fakeGh([{ number: 5, title: "C", state: "OPEN", body: "" }], { nativeSupport: false });
	const out = ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: ["#2"] }, gh.run);
	assert.match(out, /native blockers could not be read/);
	assert.match(out, /live gate may still exclude/);
});

test("gh-create-ticket rejects an invalid blocker and echoes the ones it wired", () => {
	const gh = fakeGh([{ number: 2, title: "B", state: "OPEN", body: "" }]);
	assert.throws(
		() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "T", what: "w", blockedBy: ["#2", "later"] }, gh.run),
		/invalid blocker "later"/,
	);
	assert.equal(gh.edits.length, 0, "nothing is published when a blocker is invalid");

	const out = ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "T", what: "w", blockedBy: ["#2"] }, gh.run);
	assert.match(out, /Blocked by: #2/);
	const created = gh.issues.find((i) => i.title === "T")!;
	assert.match(created.body, /\*\*Blocked by:\*\* #2/, "the body line mirrors the native edge");
});

test("ghRun returns output past spawnSync's 1 MiB default instead of blaming the CLI", () => {
	// A fake `gh` on PATH: the real CLI (and network) are not required. Before the
	// explicit maxBuffer, 2 MB of output set result.error to ENOBUFS with status
	// null, which ghRun reported as "gh CLI unavailable; install gh".
	const dir = mkdtempSync(join(tmpdir(), "ghrun-buffer-"));
	const fake = join(dir, "gh");
	writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(2_000_000));\n', { mode: 0o755 });
	const original = process.env.PATH;
	try {
		process.env.PATH = `${dir}:${original ?? ""}`;
		assert.equal(ghRun(process.cwd(), ["api", "probe"]).length, 2_000_000);
	} finally {
		process.env.PATH = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gh-status given a mapped local label still swaps the state role", () => {
	const root = mkdtempSync(join(tmpdir(), "tracker-ghstatus-local-"));
	try {
		mkdirSync(join(root, "docs", "agents"), { recursive: true });
		writeFileSync(
			join(root, "docs", "agents", "triage-labels.md"),
			[
				"| Label in mattpocock/skills | Label in our tracker | Meaning |",
				"| --- | --- | --- |",
				"| `ready-for-agent` | `agent-ready` | ok |",
				"| `needs-info` | `need-info` | ok |",
				"",
			].join("\n"),
		);
		// the caller passes this repo's LOCAL spelling, not the canonical role
		const gh = fakeGh([{ number: 3, title: "T", state: "OPEN", body: "", labels: ["need-info", "bug"] }]);
		ghStatusOp(root, { op: "gh-status", ticket: "3", status: "agent-ready" }, gh.run);
		const edit = gh.edits.find((e) => e.args[1] === "edit")!;
		assert.equal(edit.args[edit.args.indexOf("--remove-label") + 1], "need-info");
		assert.equal(edit.args.includes("bug"), false, "the category role is untouched");
		assert.equal(edit.args.includes("agent-ready"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gh-claim and gh-tick refuse a closed issue", () => {
	const gh = fakeGh([{ number: 4, title: "Done", state: "CLOSED", body: "- [ ] a\n" }]);
	assert.throws(() => ghClaimOp("/tmp", { op: "gh-claim", ticket: "4" }, gh.run), /cannot claim #4: it is closed/);
	assert.throws(() => ghTickOp("/tmp", { op: "gh-tick", ticket: "4", index: 1 }, gh.run), /cannot tick #4: it is closed/);
	assert.deepEqual(gh.edits, [], "a closed issue is never mutated");
});

test("a parent stays an index after its children close", () => {
	// This reverses an earlier rule that only counted OPEN referrers. `Part of: #N`
	// is what `gh-create-ticket parent=` writes, so it states a relationship that
	// does not expire when the child closes; keying on open referrers only made a
	// spec whose children were all done resurface as takeable agent work — observed
	// live on this repository's own spec #1 once tickets #2-#6 were closed.
	const closed = fakeGh([
		{ number: 5, title: "Spec", state: "OPEN", body: "" },
		{ number: 6, title: "Closed child", state: "CLOSED", body: "Part of: #5\n" },
	]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, closed.run);
	assert.doesNotMatch(out, /^- #5 — Spec/m, "a spec is never takeable work");
	assert.match(out, /excluded from the frontier as indexes: #5/);
	assert.match(ghTriageOp("/tmp", { op: "gh-triage" }, closed.run), /not queued as indexes: #5/);

	// the open-referrer case is unchanged
	const open = fakeGh([
		{ number: 5, title: "Parent", state: "OPEN", body: "" },
		{ number: 6, title: "Open child", state: "OPEN", body: "Part of: #5\n" },
	]);
	assert.doesNotMatch(ghFrontierOp("/tmp", { op: "gh-frontier" }, open.run), /^- #5 — Parent/m);

	// an issue nothing references is still takeable
	const lone = fakeGh([{ number: 7, title: "Ordinary ticket", state: "OPEN", body: "" }]);
	assert.match(ghFrontierOp("/tmp", { op: "gh-frontier" }, lone.run), /^- #7 — Ordinary ticket$/m);
});

test("the triage summary skips a body's H1 instead of repeating the issue title", () => {
	const gh = fakeGh([
		{ number: 1, title: "Real title", state: "OPEN", body: "# Real title\n\n> Published by to-spec.\n\n## Problem\n\nx\n" },
		{ number: 2, title: "Bare", state: "OPEN", body: "" },
	]);
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, gh.run);
	assert.match(out, /- #1 — Real title · > Published by to-spec\./);
	assert.doesNotMatch(out, /· # Real title/);
	assert.match(out, /- #2 — Bare · \(empty body\)/);
});

test("gh-edit changes the title and body prose, keeping the other sections", () => {
	const gh = fakeGh([{ number: 7, title: "Old", state: "OPEN", body: BODY("None") }]);
	const out = ghEditOp("/tmp", { op: "gh-edit", ticket: "7", title: "New", what: "fresh body" }, gh.run);
	assert.match(out, /Edited #7/);
	const edit = gh.edits.find((e) => e.args[1] === "edit")!;
	assert.equal(edit.args[edit.args.indexOf("--title") + 1], "New");
	assert.match(edit.input ?? "", /## What to build\n\nfresh body/);
	assert.match(edit.input ?? "", /## Acceptance criteria/, "the criteria section survives a body edit");
	assert.throws(() => ghEditOp("/tmp", { op: "gh-edit", ticket: "7" }, gh.run), /edit requires "title" and\/or "what"/);
});

test("gh-note appends under a named section of a map issue", () => {
	const gh = fakeGh([
		{
			number: 9,
			title: "Map: x",
			state: "OPEN",
			body: "## Destination\n\nd\n\n## Notes\n\nnotes here\n",
			labels: ["wayfinder:map"],
		},
	]);
	const out = ghMapNoteOp("/tmp", { op: "gh-note", parent: "9", what: "fog item", section: "Not yet specified" }, gh.run);
	assert.match(out, /Appended to Not yet specified on #9/);
	const edit = gh.edits.find((e) => e.args[1] === "edit")!;
	assert.match(edit.input ?? "", /## Not yet specified\n\n- fog item/, "the section is created at the end");
	assert.match(edit.input ?? "", /## Notes\n\nnotes here/, "existing sections are untouched");
	assert.throws(() => ghMapNoteOp("/tmp", { op: "gh-note", parent: "9" }, gh.run), /note requires "what"/);
});

test("labelling ops create the labels a fresh repo is missing, and say so", () => {
	// `gh issue create --label wayfinder:map` fails when the label does not exist,
	// and `wayfinder:*` is not among GitHub's default labels: without provisioning,
	// gh-create-map could not run at all on a repo that had never used wayfinder.
	//
	// Each case gets its own root: the label cache is keyed by repo root, and in a
	// long-lived session one root is one repo, so reusing a path here would test the
	// cache rather than the provisioning.
	const freshRoot = mkdtempSync(join(tmpdir(), "tracker-ghlabel-fresh-"));
	const existingRoot = mkdtempSync(join(tmpdir(), "tracker-ghlabel-existing-"));
	const childRoot = mkdtempSync(join(tmpdir(), "tracker-ghlabel-child-"));
	const mappedRoot = mkdtempSync(join(tmpdir(), "tracker-ghlabel-mapped-"));
	try {
		const fresh = fakeGh([], { labels: [] });
		const map = ghCreateMapOp(freshRoot, { op: "gh-create-map", title: "Importer" }, fresh.run);
		assert.match(map, /Map created: .*issues\/1/);
		assert.match(map, /created missing label wayfinder:map/);
		assert.deepEqual(fresh.createdLabels, ["wayfinder:map"]);

		// an existing label is never re-created (and never `--force`d, so the repo
		// keeps its own color and description)
		const existing = fakeGh([], { labels: ["wayfinder:map"] });
		const second = ghCreateMapOp(existingRoot, { op: "gh-create-map", title: "Importer" }, existing.run);
		assert.deepEqual(existing.createdLabels, []);
		assert.doesNotMatch(second, /created missing label/);

		// a wayfinder child ticket needs its type label
		const child = fakeGh([{ number: 1, title: "Map", state: "OPEN", body: "", labels: ["wayfinder:map"] }], { labels: [] });
		const childOut = ghCreateTicketOp(childRoot, { op: "gh-create-ticket", title: "Which?", type: "research", parent: "#1" }, child.run);
		assert.ok(child.createdLabels.includes("wayfinder:research"), childOut);
		assert.equal(child.edits.length, 1, "the ticket is created once the label exists");

		// a role mapped to a label nobody created yet is provisioned in the repo's own
		// spelling, not the canonical one
		mkdirSync(join(mappedRoot, "docs", "agents"), { recursive: true });
		writeFileSync(
			join(mappedRoot, "docs", "agents", "triage-labels.md"),
			"| Label in mattpocock/skills | Label in our tracker | Meaning |\n| --- | --- | --- |\n| `needs-triage` | `triage/new` | x |\n",
		);
		const mapped = fakeGh([{ number: 3, title: "T", state: "OPEN", body: "" }], { labels: [] });
		const out = ghStatusOp(mappedRoot, { op: "gh-status", ticket: "3", status: "needs-triage" }, mapped.run);
		assert.deepEqual(mapped.createdLabels, ["triage/new"]);
		assert.match(out, /created missing label triage\/new/);
	} finally {
		for (const root of [freshRoot, existingRoot, childRoot, mappedRoot]) rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable label list does not block the write, and is disclosed", () => {
	// The label listing is an optimisation, not a precondition: if it fails the op
	// still runs and gh's own "label not found" message reaches the caller.
	const root = mkdtempSync(join(tmpdir(), "tracker-ghlabel-unreadable-"));
	try {
		const gh = fakeGh([]);
		const run: GhRun = (innerRoot, args, input) => {
			if (args[0] === "label") throw new TrackerError("gh: HTTP 502 Bad Gateway");
			return gh.run(innerRoot, args, input);
		};
		const out = ghCreateMapOp(root, { op: "gh-create-map", title: "Importer" }, run);
		assert.match(out, /could not list the repo's labels/);
		assert.match(out, /Map created/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gh-block rewrites a `## Blocked by` section, not just the field line", () => {
	// to-tickets' GitHub template carries a section while gh-create-ticket writes a
	// field line, and issueRefs unions both: updating only the field line left the
	// stale section gating an issue whose body read "Blocked by: None".
	const section = fakeGh([
		{ number: 5, title: "C", state: "OPEN", body: "## What to build\n\nx\n\n## Blocked by\n\n- #2\n\n## Acceptance criteria\n" },
		{ number: 2, title: "B2", state: "OPEN", body: "" },
	]);
	ghBlockOp("/tmp", { op: "gh-block", ticket: "5", blockedBy: [] }, section.run);
	const cleared = section.edits.find((e) => e.args[1] === "edit")!.input ?? "";
	assert.deepEqual(issueRefs(cleared), [], "the stale section is rewritten, so nothing still names a blocker");
	assert.match(cleared, /## Acceptance criteria/, "the rest of the body survives");
	assert.equal(/\*\*Blocked by:\*\*/.test(cleared), false, "a section-only body does not gain a duplicate field line");

	// both shapes present: both are rewritten, or the union still gates
	const both = fakeGh([
		{ number: 6, title: "D", state: "OPEN", body: "**Blocked by:** #2\n\n## Blocked by\n\n- #2\n" },
		{ number: 2, title: "B2", state: "OPEN", body: "" },
	]);
	ghBlockOp("/tmp", { op: "gh-block", ticket: "6", blockedBy: ["#3"] }, both.run);
	assert.deepEqual(issueRefs(both.edits.find((e) => e.args[1] === "edit")!.input ?? ""), [3], "every shape names only the new blocker");

	// a field-line body keeps its field line
	const line = fakeGh([{ number: 7, title: "E", state: "OPEN", body: BODY("None") }]);
	ghBlockOp("/tmp", { op: "gh-block", ticket: "7", blockedBy: ["#3"] }, line.run);
	assert.match(line.edits.find((e) => e.args[1] === "edit")!.input ?? "", /\*\*Blocked by:\*\* #3/);
});

test("gh-show resolves blocker refs to open/closed", () => {
	const gh = fakeGh([
		{ number: 1, title: "Open blocker", state: "OPEN", body: "" },
		{ number: 2, title: "Closed blocker", state: "CLOSED", body: "" },
		{ number: 3, title: "T", state: "OPEN", body: BODY("#1, #2, #404") },
	]);
	const out = ghShowOp("/tmp", { op: "gh-show", ticket: "3" }, gh.run);
	assert.match(out, /Blocked by: #1 \(open\), #2 \(closed\), #404 \(no such issue or PR here\)/);
	assert.doesNotMatch(ghShowOp("/tmp", { op: "gh-show", ticket: "1" }, gh.run), /Blocked by:/, "no refs, no line");
});

test("gh-list reports the list endpoint's cap instead of passing it off as the total", () => {
	const many = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, title: `T${i + 1}`, state: "OPEN" as const, body: "" }));
	const out = ghListOp("/tmp", { op: "gh-list" }, fakeGh(many).run);
	assert.match(out, /stopped at the 1000-issue limit/);
	assert.doesNotMatch(ghListOp("/tmp", { op: "gh-list" }, fakeGh(many.slice(0, 3)).run), /limit/);
});

test("a merged PR is not an open issue, and no ticket op mutates a PR", () => {
	// `gh issue view` accepts a PR number and reports a merged PR as state MERGED,
	// with no `pull_request` field in its JSON shape — only the url says PR. The old
	// mapping flattened everything that was not CLOSED to OPEN, so `gh-claim` on a
	// merged PR assigned @me and reported "Claimed".
	const prUrl = (n: number) => `https://github.com/example/repo/pull/${n}`;
	const merged = fakeGh([{ number: 7, title: "A merged PR", state: "MERGED", body: "diff", url: prUrl(7) }]);
	assert.throws(() => ghClaimOp("/tmp", { op: "gh-claim", ticket: "7" }, merged.run), /it was merged/);
	assert.throws(() => ghTickOp("/tmp", { op: "gh-tick", ticket: "7", index: 1 }, merged.run), /it was merged/);
	assert.deepEqual(merged.edits, [], "a merged PR is never mutated");
	assert.match(ghShowOp("/tmp", { op: "gh-show", ticket: "7" }, merged.run), /State: merged pull request/);

	// an OPEN PR is a pull request, not an issue
	const open = fakeGh([{ number: 8, title: "An open PR", state: "OPEN", body: "diff", url: prUrl(8) }]);
	assert.throws(() => ghClaimOp("/tmp", { op: "gh-claim", ticket: "8" }, open.run), /it is a pull request/);
	assert.throws(() => ghBlockOp("/tmp", { op: "gh-block", ticket: "8", blockedBy: [] }, open.run), /it is a pull request/);
	assert.throws(() => ghStatusOp("/tmp", { op: "gh-status", ticket: "8", status: "wontfix" }, open.run), /it is a pull request/);
	assert.throws(() => ghEditOp("/tmp", { op: "gh-edit", ticket: "8", title: "x" }, open.run), /it is a pull request/);
	assert.deepEqual(open.edits, [], "no ticket op mutates a PR");
});

test("gh-frontier parent= includes natively linked children that have no Part of line", () => {
	// The canonical wayfinder link is a native sub-issue; a child linked that way
	// carries no `Part of` line, and filtering on the body line alone made the map's
	// frontier print "(nothing takeable)".
	const gh = fakeGh(
		[
			{ number: 1, title: "Map", state: "OPEN", body: "", labels: ["wayfinder:map"], subIssues: 1 },
			{ number: 2, title: "Native child", state: "OPEN", body: "## Question\n\nwhich?" },
		],
		{ subIssueOrder: { 1: [2] } },
	);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier", parent: "#1" }, gh.run);
	assert.match(out, /^- #2 — Native child$/m);
	assert.match(out, /first in map order wins/);
	assert.doesNotMatch(out, /nothing takeable/);
});

test("URL and owner/repo references are read, and a foreign ref never gates as a local number", () => {
	const local = "https://github.com/example/repo/issues/12";
	assert.deepEqual(issueRefs(`**Blocked by:** ${local}`), [12], "a URL names the same issue as #12");
	assert.deepEqual(parentRefs(`Part of: ${local}`), [12], "a URL parent link reads too");
	const gh = fakeGh([
		{ number: 12, title: "Unrelated local work", state: "OPEN", body: "" },
		{ number: 5, title: "Blocked elsewhere", state: "OPEN", body: `**Blocked by:** other/repo#12` },
		{ number: 6, title: "Blocked by a URL", state: "OPEN", body: `**Blocked by:** ${local}` },
	]);
	const out = ghFrontierOp("/tmp", { op: "gh-frontier" }, gh.run);
	// the foreign ref names another repository's #12, so it must not gate on ours
	assert.match(out, /^- #5 — Blocked elsewhere$/m);
	assert.match(out, /not gating: #5 names other\/repo#12/);
	// a URL for THIS repo is a real blocker
	assert.match(out, /#6 — Blocked by a URL.*waiting on #12/);
	assert.match(ghShowOp("/tmp", { op: "gh-show", ticket: "5" }, gh.run), /Blocked by: other\/repo#12 \(another repository\)/);
});

test("a #N in explanatory prose does not gate, and prose is not a parent link", () => {
	// Reading every `#N` made the "RFC tracked in #99" below a blocker, so an
	// unrelated open #99 wedged the ticket forever.
	assert.deepEqual(issueRefs("## Blocked by\n\n- #12 (depends on the RFC tracked in #99)"), [12]);
	assert.deepEqual(issueRefs("**Blocked by:** #12 (see #99)"), [12]);
	assert.deepEqual(issueRefs("**Blocked by:** #12, #34"), [12, 34], "a comma list still reads as two blockers");

	// and prose "Part of 2 efforts" used to mark #2 an index, hiding it everywhere
	assert.deepEqual(parentRefs("Part of 2 efforts\n"), []);
	assert.deepEqual(parentRefs("Part of #8\n"), [8]);
	assert.deepEqual(parentRefs("Part of: #7\n\n## What"), [7]);

	const gh = fakeGh([
		{ number: 2, title: "Live work", state: "OPEN", body: "Part of 2 efforts\n" },
		{ number: 5, title: "Mentions prose", state: "OPEN", body: "Part of 3 workstreams\n" },
	]);
	assert.match(ghFrontierOp("/tmp", { op: "gh-frontier" }, gh.run), /^- #2 — Live work$/m);
	assert.match(ghTriageOp("/tmp", { op: "gh-triage" }, gh.run), /#2 — Live work/);
});

test("gh-triage names the needs-info issues whose comments it did not read", () => {
	const issues = Array.from({ length: 42 }, (_, i) => ({
		number: i + 1,
		title: `W${i + 1}`,
		state: "OPEN" as const,
		body: "b",
		labels: ["needs-info"],
		author: "rep",
		createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
	}));
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, fakeGh(issues).run);
	assert.match(out, /comments were read for the 40 oldest needs-info issues only; #41, #42 were not checked for a reporter reply/);
});
