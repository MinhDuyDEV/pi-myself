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
	ghCreateSpecOp,
	ghCreateTicketOp,
	ghFrontierOp,
	ghListOp,
	ghOutOfScopeOp,
	ghResolveOp,
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
	state: "OPEN" | "CLOSED";
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
 * edit/close/comment` in gh's `--json` shapes, and `gh api` for the REST
 * listing (with dependency / sub-issue summaries), database ids, and the
 * native-edge POSTs. Mutations are recorded in `edits`. */
function fakeGh(issues: FakeIssue[], options: { nativeSupport?: boolean } = {}) {
	const edits: Array<{ number: number; args: string[]; input?: string }> = [];
	const posts: string[] = [];
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
		comments: (i.comments ?? []).map((c) => ({ author: { login: c.author }, body: c.body, createdAt: c.createdAt ?? "2026-01-02T00:00:00Z" })),
	});
	const restShape = (i: FakeIssue) => ({
		number: i.number,
		id: 1000 + i.number,
		title: i.title,
		state: i.state.toLowerCase(),
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
		if (args[0] === "api") {
			const path = args.find((a) => a.startsWith("repos/")) ?? "";
			if (args.includes("POST")) {
				if (options.nativeSupport === false) throw new TrackerError("gh api: HTTP 404 Not Found");
				posts.push(`${path} ${args[args.length - 1]}`);
				return "{}";
			}
			if (/issues\?state=/.test(path)) {
				const state = /state=all/.test(path) ? "all" : "open";
				return JSON.stringify([issues.filter((i) => (state === "all" ? true : i.state === "OPEN")).map(restShape)]);
			}
			const m = /issues\/(\d+)$/.exec(path);
			const issue = issues.find((i) => i.number === Number(m?.[1]));
			if (!issue) throw new TrackerError(`no issue ${path}`);
			return String(1000 + issue.number);
		}
		if (args[0] !== "issue") throw new TrackerError(`unexpected gh call: ${args.join(" ")}`);
		const [, sub, numberOrFlag] = args;
		if (sub === "list") {
			const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : undefined;
			return JSON.stringify(issues.filter((i) => i.state === "OPEN" && (!label || (i.labels ?? []).includes(label))).map(graphqlShape));
		}
		if (sub === "view") {
			const issue = issues.find((i) => i.number === Number(numberOrFlag));
			if (!issue) throw new TrackerError(`no issue #${numberOrFlag}`);
			return JSON.stringify(graphqlShape(issue));
		}
		if (sub === "create") {
			const number = nextNumber++;
			edits.push({ number, args, input });
			issues.push({ number, title: args[args.indexOf("--title") + 1], state: "OPEN", body: input ?? "", labels: args.filter((_, i) => args[i - 1] === "--label") });
			return `https://example.test/issues/${number}`;
		}
		if (sub === "edit" || sub === "close" || sub === "comment") {
			edits.push({ number: Number(numberOrFlag), args, input });
			return "";
		}
		throw new TrackerError(`unexpected gh sub: ${sub}`);
	};
	return { run, edits, posts, issues };
}

const BODY = (refs: string, what = "Do the thing.") =>
	`## What to build\n\n${what}\n\n## Acceptance criteria\n\n- [ ] a\n- [ ] b\n\n**Blocked by:** ${refs}\n`;

test("issueRefs / parentRefs read every spelling the skills write", () => {
	assert.deepEqual(issueRefs(BODY("#1, #3 and #04")), [1, 3, 4]);
	assert.deepEqual(issueRefs(BODY("None (can start immediately)")), []);
	assert.deepEqual(issueRefs("## Blocked by\n\n- #7\n- #9\n\n## Other\n#5"), [7, 9], "to-tickets section form");
	assert.deepEqual(issueRefs("no field at all"), []);
	assert.deepEqual(parentRefs("Part of: #7\n\n## What"), [7], "this repo's line form");
	assert.deepEqual(parentRefs("Part of #8\n"), [8], "wayfinder fallback (no colon)");
	assert.deepEqual(parentRefs("## Parent\n\n#9\n\n## What to build"), [9], "to-tickets section form");
	assert.deepEqual(parentRefs(BODY("#1")), []);
});

test("gh-frontier: native blocked_by count, body refs, maps, parents (sub-issues or Part of), PRs, claim", () => {
	const gh = fakeGh([
		{ number: 1, title: "Spec", state: "OPEN", body: "the spec", labels: ["ready-for-agent"], subIssues: 2 },
		{ number: 2, title: "Child A", state: "OPEN", body: "Part of: #1\n\n" + BODY("None"), labels: ["ready-for-agent"] },
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

test("gh-frontier: unknown blocker is conservative (blocks)", () => {
	const { run } = fakeGh([{ number: 9, title: "Dangling", state: "OPEN", body: BODY("#999") }]);
	assert.doesNotMatch(ghFrontierOp("/tmp", { op: "gh-frontier" }, run), /^- #9 — Dangling$/m);
});

test("gh-create-spec publishes the spec as a ready-for-agent issue and names the parent number", () => {
	const gh = fakeGh([]);
	const out = ghCreateSpecOp("/tmp", { op: "gh-create-spec", title: "Rate limiting", what: "## Problem Statement\n\n..." }, gh.run);
	assert.match(out, /Spec published: .*issues\/1 — tickets reference it with parent "#1"/);
	assert.deepEqual(gh.edits[0].args.slice(-2), ["--label", "ready-for-agent"]);
	assert.throws(() => ghCreateSpecOp("/tmp", { op: "gh-create-spec", title: "x" }, gh.run), /what/);
});

test("gh-create-ticket: to-tickets template, native sub-issue + dependency edges, mirrored lines", () => {
	const gh = fakeGh([{ number: 1, title: "Spec", state: "OPEN", body: "spec" }, { number: 2, title: "Schema", state: "OPEN", body: "" }]);
	const out = ghCreateTicketOp(
		"/tmp",
		{ op: "gh-create-ticket", title: "API", what: "Serve it.", criteria: ["returns 200", "returns 429 over limit"], blockedBy: ["#2"], parent: "1" },
		gh.run,
	);
	assert.match(out, /Created .*issues\/3 \[ready-for-agent\]/);
	assert.match(out, /sub-issue of #1: native edge added/);
	assert.match(out, /blocked by #2: native edge added/);
	assert.deepEqual(gh.posts, ["repos/{owner}/{repo}/issues/1/sub_issues sub_issue_id=1003", "repos/{owner}/{repo}/issues/3/dependencies/blocked_by issue_id=1002"]);
	const body = gh.edits.find((e) => e.args[1] === "create")!.input ?? "";
	assert.match(body, /^Part of: #1/);
	assert.match(body, /## What to build\n\nServe it\./);
	assert.match(body, /## Acceptance criteria\n\n- \[ \] returns 200\n- \[ \] returns 429 over limit/);
	assert.match(body, /\*\*Blocked by:\*\* #2/);

	assert.throws(() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "Bad", status: "not sure!" }, gh.run), /invalid label/);
	assert.throws(() => ghCreateTicketOp("/tmp", { op: "gh-create-ticket", status: "ready-for-agent" }, gh.run), /title/);
});

test("gh-create-ticket: wayfinder child gets a Question body and wayfinder:<type> label; native edges fall back to lines", () => {
	const gh = fakeGh([{ number: 1, title: "Map", state: "OPEN", body: "## Destination", labels: ["wayfinder:map"] }], { nativeSupport: false });
	const out = ghCreateTicketOp("/tmp", { op: "gh-create-ticket", title: "Which parser?", what: "CSV or TSV?", type: "research", parent: "#1" }, gh.run);
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
		{ number: 1, title: "Map: import", state: "OPEN", body: "## Destination\n\nx\n\n## Decisions so far\n\n## Out of scope\n", labels: ["wayfinder:map"] },
		{ number: 4, title: "Pick parser", state: "OPEN", body: "Part of: #1\n\n## Question\n\nCSV or TSV?", url: "https://example.test/issues/4" },
	]);
	const out = ghResolveOp("/tmp", { op: "gh-resolve", ticket: "4", answer: "CSV.", gist: "CSV beats TSV" }, gh.run);
	assert.match(out, /map #1 Decisions so far updated/);
	const close = gh.edits.find((e) => e.args[1] === "close")!;
	assert.deepEqual(close.args.slice(3, 5), ["--reason", "completed"]);
	const comment = close.args[close.args.indexOf("--comment") + 1];
	assert.match(comment, /## Answer\n\nCSV\.\n\nGist: CSV beats TSV/);
	const mapEdit = gh.edits.find((e) => e.args[1] === "edit" && e.number === 1)!;
	assert.match(mapEdit.input ?? "", /## Decisions so far\n\n- \[Pick parser\]\(https:\/\/example\.test\/issues\/4\): CSV beats TSV\n\n## Out of scope/);
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
	const out = ghOutOfScopeOp("/tmp", { op: "gh-out-of-scope", ticket: "6", answer: "No source emits TSV.", gist: "TSV: no source emits it" }, gh.run);
	assert.match(out, /map #1 Out of scope updated/);
	const mapEdit = gh.edits.find((e) => e.args[1] === "edit" && e.number === 1)!;
	assert.match(mapEdit.input ?? "", /## Decisions so far\n\n## Out of scope\n\n- \[Support TSV\]\(.*\): TSV: no source emits it/);
	const close = gh.edits.find((e) => e.args[1] === "close")!;
	assert.deepEqual(close.args.slice(3, 5), ["--reason", "not planned"]);
});

test("gh-status swaps only within the role family: state roles, category roles, other labels untouched", () => {
	const gh = fakeGh([{ number: 5, title: "T", state: "OPEN", body: BODY("None"), labels: ["needs-triage", "bug", "wayfinder:task"] }]);
	assert.match(ghStatusOp("/tmp", { op: "gh-status", ticket: "5", status: "ready-for-agent" }, gh.run), /→ bug, wayfinder:task, ready-for-agent/);
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
	assert.deepEqual(gh.posts, ["repos/{owner}/{repo}/issues/5/dependencies/blocked_by issue_id=1002", "repos/{owner}/{repo}/issues/5/dependencies/blocked_by issue_id=1003"]);

	ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 2 }, gh.run);
	assert.equal(gh.edits.at(-1)!.input?.match(/- \[x\]/g)?.length, 1);
	assert.throws(() => ghTickOp("/tmp", { op: "gh-tick", ticket: "5", index: 9 }, gh.run), /no unchecked criterion #9/);
});

test("gh-show renders every comment in full; gh-comment posts; gh-list filters by label", () => {
	const gh = fakeGh([
		{ number: 6, title: "T", state: "OPEN", body: "hello", labels: ["needs-info"], comments: [{ author: "maint", body: "## Triage Notes\n\nneed repro" }, { author: "reporter", body: "here is the repro " + "x".repeat(300) }] },
		{ number: 7, title: "U", state: "OPEN", body: "", labels: ["needs-triage"] },
	]);
	const shown = ghShowOp("/tmp", { op: "gh-show", ticket: "6" }, gh.run);
	assert.match(shown, /## Comments \(2\)/);
	assert.match(shown, /### @maint.*\n\n## Triage Notes/);
	assert.match(shown, /x{300}/, "comments are not truncated to a snippet");
	assert.throws(() => ghShowOp("/tmp", { op: "gh-show", ticket: "abc" }, gh.run), /issue number/);
	ghCommentOp("/tmp", { op: "gh-comment", ticket: "6", what: "a note" }, gh.run);
	assert.equal(gh.edits.some((e) => e.args[1] === "comment"), true);
	assert.match(ghListOp("/tmp", { op: "gh-list", status: "needs-triage" }, gh.run), /1 open, label needs-triage[\s\S]*#7 — U/);
	assert.doesNotMatch(ghListOp("/tmp", { op: "gh-list", status: "needs-triage" }, gh.run), /#6 — T/);
});

test("gh-triage buckets: never triaged, needs-triage, needs-info with a reporter reply after the last Triage Notes", () => {
	const gh = fakeGh([
		{ number: 1, title: "Untouched", state: "OPEN", body: "boom", createdAt: "2026-01-03T00:00:00Z" },
		{ number: 2, title: "Older untouched", state: "OPEN", body: "bang", labels: ["bug"], createdAt: "2026-01-01T00:00:00Z" },
		{ number: 3, title: "Queued", state: "OPEN", body: "", labels: ["needs-triage"] },
		{ number: 4, title: "Waiting", state: "OPEN", body: "", labels: ["needs-info"], author: "rep", comments: [{ author: "maint", body: "## Triage Notes\n\nneed more" }] },
		{ number: 5, title: "Replied", state: "OPEN", body: "", labels: ["needs-info"], author: "rep", comments: [{ author: "maint", body: "## Triage Notes\n\nneed more" }, { author: "rep", body: "here you go" }] },
		{ number: 6, title: "Map", state: "OPEN", body: "", labels: ["wayfinder:map"] },
		{ number: 7, title: "Ready", state: "OPEN", body: "", labels: ["ready-for-agent"] },
		{ number: 8, title: "Spec", state: "OPEN", body: "the spec", createdAt: "2025-12-01T00:00:00Z" },
		{ number: 9, title: "Closed child", state: "CLOSED", body: "Part of: #8" },
	]);
	const out = ghTriageOp("/tmp", { op: "gh-triage" }, gh.run);
	assert.match(out, /## Never triaged — no state role \(2\)\n- #2 — Older untouched.*\n- #1 — Untouched/, "oldest first, category-only counts as untriaged");
	assert.match(out, /## needs-triage \(1\)\n- #3 — Queued/);
	assert.match(out, /## needs-info — reporter replied since the last Triage Notes \(1\)\n- #5 — Replied/);
	assert.doesNotMatch(out, /#4 — Waiting|#6 — Map|#7 — Ready|#8 — Spec/, "parents (even with only closed children) are indexes, not triage items");
});
