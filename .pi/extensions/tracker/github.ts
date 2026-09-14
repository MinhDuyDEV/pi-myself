import { spawnSync } from "node:child_process";

import { CATEGORY_ROLES, TrackerError, appendUnderHeading, labelValue, loadTriageLabelMap, sectionText, upsertFieldLine } from "./tracker.js";
import type { TrackerParams } from "./params.js";

/**
 * GitHub Issues backend for the tracker tool (gh CLI, run with the repo as
 * cwd). Implements docs/agents/issue-tracker.md's GitHub conventions, which
 * come from setup-matt-pocock-skills' issue-tracker-github.md:
 *
 * - Tickets are issues; the spec is an issue; a wayfinder map is an issue
 *   labelled `wayfinder:map` with `## Destination / Notes / Decisions so far /
 *   Not yet specified / Out of scope` sections.
 * - Parent link: a native sub-issue when the API allows it, always mirrored
 *   by a `Part of: #NN` line (to-tickets' `## Parent` section and wayfinder's
 *   `Part of #NN` fallback are read too).
 * - Blocking: native issue dependencies (`dependencies/blocked_by`, keyed by
 *   the blocker's database id) when the API allows it, always mirrored by a
 *   `**Blocked by:** #N` line (to-tickets' `## Blocked by` section is read
 *   too). The frontier gates on `issue_dependencies_summary.blocked_by`
 *   (open blockers) OR an open issue named in the body.
 * - Triage roles are labels mapped through docs/agents/triage-labels.md;
 *   a state role swap never touches category (`bug`/`enhancement`) or
 *   `wayfinder:*` labels.
 * - Claim = assign @me; resolve = close with the answer as a comment and the
 *   gist appended to the parent map's Decisions-so-far.
 *
 * Every op takes an injectable `run` so tests fake the CLI.
 */

export type GhRun = (root: string, args: string[], input?: string) => string;

export function ghRun(root: string, args: string[], input?: string): string {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", input });
	if (result.error) {
		throw new TrackerError(`gh CLI unavailable (${(result.error as Error).message}); install https://cli.github.com then run "gh auth login"`);
	}
	if (result.status !== 0) {
		const detail = ((result.stderr || result.stdout || "") as string).trim().split("\n")[0] ?? "gh failed";
		throw new TrackerError(`gh ${args.slice(0, 3).join(" ")}: ${detail}`);
	}
	return (result.stdout || "").trim();
}

export interface GhComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface GhIssue {
	number: number;
	/** Database id (what the dependencies / sub-issues APIs key on). */
	id?: number;
	title: string;
	state: "OPEN" | "CLOSED";
	labels: string[];
	assignees: string[];
	author: string;
	body: string;
	url: string;
	createdAt: string;
	isPullRequest: boolean;
	/** `issue_dependencies_summary.blocked_by` — open native blockers (REST only). */
	openBlockers?: number;
	/** `sub_issues_summary.total` (REST only). */
	subIssues?: number;
	comments: GhComment[];
}

/** Accepts both shapes: `gh issue view/list --json` (GraphQL-ish, `OPEN`,
 * `labels[].name`, `author.login`, `url`) and the REST `gh api` issue object
 * (`open`, `html_url`, `user.login`, `pull_request`, summaries). */
export function parseIssue(raw: unknown): GhIssue {
	if (!raw || typeof raw !== "object") throw new TrackerError("gh returned an unrecognised issue payload");
	const issue = raw as Record<string, unknown>;
	const number = Number(issue.number);
	if (!Number.isInteger(number) || number <= 0) throw new TrackerError("gh issue payload without a number");
	const name = (v: unknown) => (typeof v === "string" ? v : (v as { name?: string } | null)?.name ?? "");
	const login = (v: unknown) => (typeof v === "string" ? v : (v as { login?: string } | null)?.login ?? "");
	const deps = issue.issue_dependencies_summary as { blocked_by?: number } | undefined;
	const subs = issue.sub_issues_summary as { total?: number } | undefined;
	const comments = Array.isArray(issue.comments)
		? issue.comments
				.map((c) => c as Record<string, unknown>)
				.map((c) => ({
					author: login(c.author ?? c.user),
					body: typeof c.body === "string" ? c.body : "",
					createdAt: String(c.createdAt ?? c.created_at ?? ""),
				}))
		: [];
	return {
		number,
		id: typeof issue.id === "number" ? issue.id : undefined,
		title: String(issue.title ?? ""),
		state: String(issue.state).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
		labels: (Array.isArray(issue.labels) ? issue.labels.map(name) : []).filter(Boolean),
		assignees: (Array.isArray(issue.assignees) ? issue.assignees.map(login) : []).filter(Boolean),
		author: login(issue.author ?? issue.user),
		body: typeof issue.body === "string" ? issue.body : "",
		url: typeof issue.url === "string" ? issue.url : typeof issue.html_url === "string" ? issue.html_url : "",
		createdAt: String(issue.createdAt ?? issue.created_at ?? ""),
		isPullRequest: Boolean(issue.pull_request) || issue.__typename === "PullRequest",
		openBlockers: typeof deps?.blocked_by === "number" ? deps.blocked_by : undefined,
		subIssues: typeof subs?.total === "number" ? subs.total : undefined,
		comments,
	};
}

function parseList(jsonText: string): GhIssue[] {
	if (!jsonText.trim()) return [];
	const json = JSON.parse(jsonText) as unknown;
	// `gh api --paginate --slurp` wraps pages: [[...], [...]]
	const rows = Array.isArray(json) ? json.flatMap((page) => (Array.isArray(page) ? page : [page])) : [];
	return rows.map(parseIssue);
}

function issueLine(issue: { number: number; title: string; labels: string[]; assignees: string[] }): string {
	const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
	const assignee = issue.assignees.length ? ` → @${issue.assignees.join(", @")}` : "";
	return `#${issue.number} — ${issue.title}${labels}${assignee}`;
}

function numbersIn(text: string): number[] {
	if (!text || /^\s*(none|unblocked)\b/i.test(text)) return [];
	return [...text.matchAll(/#?(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n > 0);
}

/** Blockers named by a body: the `**Blocked by:**` field line and/or
 * to-tickets' `## Blocked by` section. */
export function issueRefs(body: string, label = "Blocked by"): number[] {
	const fromLine = numbersIn(labelValue(body, label));
	const fromSection = numbersIn(sectionText(body, label));
	return [...new Set([...fromLine, ...fromSection])];
}

/** Parent named by a body: `Part of: #N` / `Part of #N` line, or to-tickets' `## Parent` section. */
export function parentRefs(body: string): number[] {
	const line = /^\*{0,2}Part of\*{0,2}:?\s*#?(\d+)/im.exec(body);
	const fromLine = line ? [Number(line[1])] : [];
	return [...new Set([...fromLine, ...numbersIn(sectionText(body, "Parent"))])];
}

function reqNumber(token: string | undefined, op: string): string {
	const raw = (token ?? "").trim().replace(/^#*/, "");
	if (!/^\d+$/.test(raw)) throw new TrackerError(`${op} requires an issue number (got ${JSON.stringify(token ?? "")})`);
	return raw;
}

const VIEW_FIELDS = "number,title,state,body,labels,assignees,author,url,createdAt";

function issueView(root: string, number: string, run: GhRun, withComments = false): GhIssue {
	const fields = withComments ? `${VIEW_FIELDS},comments` : VIEW_FIELDS;
	const raw = run(root, ["issue", "view", number, "--json", fields]);
	if (!raw.trim()) throw new TrackerError("gh returned no issue");
	return parseIssue(JSON.parse(raw));
}

/** REST listing: the only surface that carries native dependency and
 * sub-issue summaries. Pull requests share the number space and are dropped. */
function restIssues(root: string, state: "open" | "all", run: GhRun): GhIssue[] {
	return parseList(
		run(root, ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues?state=${state}&per_page=100`]),
	).filter((issue) => !issue.isPullRequest);
}

function databaseId(root: string, number: string, run: GhRun): number {
	const id = Number(run(root, ["api", `repos/{owner}/{repo}/issues/${number}`, "--jq", ".id"]));
	if (!Number.isInteger(id) || id <= 0) throw new TrackerError(`could not resolve the database id of #${number}`);
	return id;
}

/** Native edges are canonical (they render in GitHub's UI) but not universally
 * enabled; a failure is reported, never fatal, because the body line mirrors it. */
function tryNative(action: () => void, label: string, notes: string[]): void {
	try {
		action();
		notes.push(`${label}: native edge added`);
	} catch (error) {
		notes.push(`${label}: native edge NOT added (${error instanceof Error ? error.message : String(error)}); body line is the fallback`);
	}
}

function addBlockedBy(root: string, child: string, blocker: number, run: GhRun, notes: string[]): void {
	tryNative(
		() => {
			const id = databaseId(root, String(blocker), run);
			run(root, ["api", "--method", "POST", `repos/{owner}/{repo}/issues/${child}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
		},
		`blocked by #${blocker}`,
		notes,
	);
}

function addSubIssue(root: string, parent: string, child: string, run: GhRun, notes: string[]): void {
	tryNative(
		() => {
			const id = databaseId(root, child, run);
			run(root, ["api", "--method", "POST", `repos/{owner}/{repo}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`]);
		},
		`sub-issue of #${parent}`,
		notes,
	);
}

function numberFromUrl(url: string): string {
	const m = /\/(\d+)\s*$/.exec(url.trim());
	if (!m) throw new TrackerError(`gh did not return an issue URL (got ${JSON.stringify(url)})`);
	return m[1];
}

// ── reads ────────────────────────────────────────────────────────────────────

/** gh-list: open issues, optionally filtered by label (`status`). */
export function ghListOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const label = params.status?.trim();
	const args = ["issue", "list", "--state", "open", "--limit", "300", "--json", VIEW_FIELDS];
	if (label) args.push("--label", label);
	const open = parseList(run(root, args));
	if (open.length === 0) return label ? `No open issues labelled ${label}.` : "No open issues in this GitHub repo.";
	return [`## GitHub issues (${open.length} open${label ? `, label ${label}` : ""})`, ...open.map((issue) => `- ${issueLine(issue)}`)].join("\n");
}

/** gh-frontier: open, unassigned, not a map, not a parent, no open blocker.
 * Blocked = native `issue_dependencies_summary.blocked_by > 0` OR an open
 * issue named in the body. Parents (maps, specs, anything with sub-issues or
 * named by a `Part of` / `## Parent`) are indexes, not work units: excluded
 * and reported in a footer. Optional `parent` scopes to one map's children. */
export function ghFrontierOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const all = restIssues(root, "all", run);
	const parentSet = new Set<number>();
	for (const issue of all) {
		for (const ref of parentRefs(issue.body)) parentSet.add(ref);
		if ((issue.subIssues ?? 0) > 0) parentSet.add(issue.number);
	}
	const scopeParent = params.parent ? Number(reqNumber(params.parent, "frontier")) : undefined;
	const excluded = new Set<number>();
	const open = all.filter((issue) => {
		if (issue.state !== "OPEN") return false;
		if (issue.labels.includes("wayfinder:map") || parentSet.has(issue.number)) {
			excluded.add(issue.number);
			return false;
		}
		if (scopeParent !== undefined && !parentRefs(issue.body).includes(scopeParent)) return false;
		return true;
	});
	const openBlockerOf = (issue: GhIssue): number[] => {
		const refs = issueRefs(issue.body).filter((ref) => {
			const target = all.find((other) => other.number === ref);
			return !target || target.state !== "CLOSED" || target.number === issue.number;
		});
		return refs;
	};
	const takeable = open.filter((issue) => issue.assignees.length === 0 && (issue.openBlockers ?? 0) === 0 && openBlockerOf(issue).length === 0);
	const blocked = open.filter((issue) => !takeable.includes(issue));
	return [
		`## Frontier — takeable now (first by number wins)${scopeParent ? ` · children of #${scopeParent}` : ""}`,
		...(takeable.length ? takeable.map((issue) => `- ${issueLine(issue)}`) : ["(nothing takeable)"]),
		"",
		"## Open but blocked or claimed",
		...(blocked.length
			? blocked.map((issue) => {
					const refs = openBlockerOf(issue);
					const native = issue.openBlockers ?? 0;
					const reason = refs.length ? `waiting on #${refs.join(", #")}` : native > 0 ? `waiting on ${native} native blocker(s)` : "claimed";
					return `  ${issueLine(issue)} · ${reason}`;
				})
			: ["  (none)"]),
		...(excluded.size ? ["", `_(excluded from the frontier as indexes: ${[...excluded].sort((a, b) => a - b).map((n) => `#${n}`).join(", ")} — maps and parents)_`] : []),
	].join("\n");
}

/** gh-show: one issue with its fields, body, and every comment (triage reads
 * `## Triage Notes` and reporter replies from here). */
export function ghShowOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const issue = issueView(root, reqNumber(params.ticket, "show"), run, true);
	const comments = issue.comments.slice(-30);
	return [
		issueLine(issue),
		`State: ${issue.state === "CLOSED" ? "closed" : "open"} · by @${issue.author || "ghost"} · ${issue.url || "(no url)"}`,
		"",
		issue.body.trim() || "(empty body)",
		...(comments.length
			? ["", `## Comments (${comments.length})`, ...comments.map((c) => `### @${c.author || "ghost"}${c.createdAt ? ` · ${c.createdAt}` : ""}\n\n${c.body.trim().slice(0, 4000)}`)]
			: []),
	].join("\n");
}

/** gh-triage: the triage skill's attention queue, oldest first — (1) never
 * triaged (no state role), (2) `needs-triage`, (3) `needs-info` where the
 * reporter has replied since the last `## Triage Notes` comment. */
export function ghTriageOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	void params;
	const roles = loadTriageLabelMap(root);
	const roleLabels = new Set(roles.values());
	// parents (specs, maps, anything with children) are indexes, not triage items
	const parents = new Set<number>();
	for (const issue of restIssues(root, "all", run)) {
		for (const ref of parentRefs(issue.body)) parents.add(ref);
		if ((issue.subIssues ?? 0) > 0) parents.add(issue.number);
	}
	const issues = parseList(run(root, ["issue", "list", "--state", "open", "--limit", "300", "--json", `${VIEW_FIELDS},comments`]))
		.filter((issue) => !issue.isPullRequest && !issue.labels.includes("wayfinder:map") && !parents.has(issue.number))
		.sort((a, b) => Date.parse(a.createdAt || "0") - Date.parse(b.createdAt || "0"));
	const untriaged = issues.filter((issue) => !issue.labels.some((l) => roleLabels.has(l)));
	const needsTriage = issues.filter((issue) => issue.labels.includes(roles.get("needs-triage") ?? "needs-triage"));
	const needsInfo = issues.filter((issue) => {
		if (!issue.labels.includes(roles.get("needs-info") ?? "needs-info")) return false;
		const lastNotes = issue.comments.map((c, i) => ({ c, i })).filter(({ c }) => /^##\s+Triage Notes/m.test(c.body)).pop();
		const since = lastNotes ? issue.comments.slice(lastNotes.i + 1) : issue.comments;
		return since.some((c) => c.author && c.author === issue.author);
	});
	const bucket = (title: string, list: GhIssue[]) => [
		`## ${title} (${list.length})`,
		...(list.length ? list.map((issue) => `- ${issueLine(issue)} · ${issue.body.trim().split("\n")[0]?.slice(0, 120) || "(empty body)"}`) : ["(none)"]),
		"",
	];
	return [
		...bucket("Never triaged — no state role", untriaged),
		...bucket("needs-triage", needsTriage),
		...bucket("needs-info — reporter replied since the last Triage Notes", needsInfo),
	]
		.join("\n")
		.trimEnd();
}

// ── mutations ────────────────────────────────────────────────────────────────

/** gh-create-spec: to-spec's "publish to the issue tracker" — one issue with
 * the spec body, `ready-for-agent` unless told otherwise. Tickets name it
 * with `parent`. */
export function ghCreateSpecOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = (params.title ?? "").trim();
	const body = (params.what ?? "").trim();
	if (!title || !body) throw new TrackerError('create-spec requires "title" and "what" (the spec body)');
	const label = mapRole(root, params.status?.trim() || "ready-for-agent");
	const url = run(root, ["issue", "create", "--title", title, "--body-file", "-", "--label", label], `${body}\n`);
	return `Spec published: ${url.trim()} — tickets reference it with parent "#${numberFromUrl(url)}".`;
}

function mapRole(root: string, status: string): string {
	if (!/^[a-z0-9:_ -]+$/i.test(status)) throw new TrackerError(`invalid label: ${JSON.stringify(status)}`);
	return loadTriageLabelMap(root).get(status) ?? status;
}

/** gh-create-ticket: one issue in to-tickets' tracker template (or, with
 * `type`, wayfinder's child shape: `## Question` + `wayfinder:<type>`).
 * Parent and blockers become native sub-issue / dependency edges, mirrored
 * by `Part of: #N` and `**Blocked by:** #N` lines. */
export function ghCreateTicketOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = (params.title ?? "").trim();
	if (!title) throw new TrackerError('create-ticket requires "title"');
	const type = params.type?.trim();
	const labels: string[] = [];
	if (type) labels.push(`wayfinder:${type}`);
	if (params.status?.trim() || !type) labels.push(mapRole(root, params.status?.trim() || "ready-for-agent"));
	const blockers = [...new Set((params.blockedBy ?? []).map((token) => Number(token.trim().replace(/^#*/, ""))).filter((n) => Number.isInteger(n) && n > 0))];
	const parent = params.parent ? reqNumber(params.parent, "parent") : "";
	const criteria = (params.criteria ?? []).map((c) => c.trim()).filter(Boolean);
	const blockedLine = `**Blocked by:** ${blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "None (can start immediately)"}`;
	const body = [
		...(parent ? [`Part of: #${parent}`, ""] : []),
		...(type
			? ["## Question", "", params.what?.trim() || "(the question this ticket resolves)"]
			: [
					"## What to build",
					"",
					params.what?.trim() || "(fill from the ticket's source: spec, wayfinder question, or triage note)",
					"",
					"## Acceptance criteria",
					"",
					...(criteria.length ? criteria.map((c) => `- [ ] ${c}`) : ["- [ ] (acceptance criteria — replace from the spec)"]),
				]),
		"",
		blockedLine,
		"",
	].join("\n");
	const args = ["issue", "create", "--title", title, "--body-file", "-"];
	for (const label of labels) args.push("--label", label);
	const url = run(root, args, body).trim();
	const number = numberFromUrl(url);
	const notes: string[] = [];
	if (parent) addSubIssue(root, parent, number, run, notes);
	for (const blocker of blockers) addBlockedBy(root, number, blocker, run, notes);
	return [`Created ${url} [${labels.join(", ")}]`, ...notes.map((n) => `- ${n}`)].join("\n");
}

/** gh-create-map: the wayfinder map issue (label `wayfinder:map`). */
export function ghCreateMapOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = params.title?.trim() || params.feature?.trim() || "";
	if (!title) throw new TrackerError("create-map requires a title (the effort name)");
	const body = [
		"## Destination",
		"",
		params.destination?.trim() || "(what reaching the end of this map looks like: the spec, decision, or change this effort finds its way to)",
		"",
		"## Notes",
		"",
		params.what?.trim() || "(domain; skills every session should consult; standing preferences)",
		"",
		"## Decisions so far",
		"",
		"<!-- one line per resolved child: [title](url): gist of the answer -->",
		"",
		"## Not yet specified",
		"",
		params.notes?.trim() || "(in-scope fog you cannot ticket yet)",
		"",
		"## Out of scope",
		"",
		"(work consciously ruled out of this effort)",
		"",
	].join("\n");
	const url = run(root, ["issue", "create", "--title", `Map: ${title}`, "--body-file", "-", "--label", "wayfinder:map"], body);
	return `Map created: ${url.trim()} — children reference it with parent "#${numberFromUrl(url)}".`;
}

/** gh-claim: assign @me — the session's first write (wayfinder). */
export function ghClaimOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "claim");
	const view = issueView(root, number, run);
	if (view.assignees.length > 0) {
		return `#${number} is already claimed by @${view.assignees.join(", @")} — take it only with them.`;
	}
	run(root, ["issue", "edit", number, "--add-assignee", "@me"]);
	return `Claimed ${issueLine(view)} (set this before any work).`;
}

/** Append a `- [title](url): gist` bullet under a section of the parent map's body. */
function appendToParentMap(root: string, issue: GhIssue, heading: string, gist: string, run: GhRun): string {
	const parent = parentRefs(issue.body)[0];
	if (!parent) return `no parent map named in #${issue.number}'s body; add the ${heading} line by hand`;
	const map = issueView(root, String(parent), run);
	const updated = appendUnderHeading(map.body, heading, `[${issue.title}](${issue.url || `#${issue.number}`}): ${gist.trim()}`);
	run(root, ["issue", "edit", String(parent), "--body-file", "-"], updated);
	return `map #${parent} ${heading} updated`;
}

/** gh-resolve: comment the answer, close, gist into the parent map's
 * Decisions-so-far. `status: wontfix` closes as "not planned" without an
 * `## Answer` heading (triage's rejected-bug / already-implemented paths). */
export function ghResolveOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "resolve");
	const answer = (params.answer ?? "").trim();
	if (!answer) throw new TrackerError('resolve requires "answer"');
	const wontfix = params.status?.trim() === "wontfix";
	const gist = params.gist?.trim();
	const comment = wontfix ? answer : ["## Answer", "", answer, ...(gist ? ["", `Gist: ${gist}`] : [])].join("\n");
	const issue = issueView(root, number, run);
	if (wontfix) run(root, ["issue", "edit", number, "--add-label", mapRole(root, "wontfix")]);
	run(root, ["issue", "close", number, "--reason", wontfix ? "not planned" : "completed", "--comment", comment]);
	const notes = [`Resolved #${number} (closed${wontfix ? " as not planned, labelled wontfix" : " with a resolution comment"})`];
	if (gist && !wontfix) notes.push(appendToParentMap(root, issue, "Decisions so far", gist, run));
	return notes.join(" — ");
}

/** gh-out-of-scope: wayfinder's rule-out — close the ticket and gist it into
 * the map's Out-of-scope section (never Decisions-so-far). */
export function ghOutOfScopeOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "out-of-scope");
	const reason = (params.answer ?? "").trim();
	if (!reason) throw new TrackerError('out-of-scope requires "answer" (why it is out of scope)');
	const issue = issueView(root, number, run);
	run(root, ["issue", "close", number, "--reason", "not planned", "--comment", ["## Out of scope", "", reason].join("\n")]);
	return `Closed #${number} as out of scope — ${appendToParentMap(root, issue, "Out of scope", params.gist?.trim() || reason, run)}`;
}

/** gh-comment: append a comment (agent briefs, triage notes, verification blocks). */
export function ghCommentOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "comment");
	const body = (params.what ?? "").trim();
	if (!body) throw new TrackerError('comment requires "what"');
	run(root, ["issue", "comment", number, "--body-file", "-"], `${body}\n`);
	return `Commented on #${number}.`;
}

/** gh-status: swap the state role (only other state-role labels are removed),
 * or the category role (`bug`/`enhancement`), or add any other label
 * (`wayfinder:<type>`) — triage's "one category + one state" invariant. */
export function ghStatusOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const status = (params.status ?? "").trim();
	if (!status) throw new TrackerError('status requires a label-shaped "status" value');
	const number = reqNumber(params.ticket, "status");
	const roles = loadTriageLabelMap(root);
	const label = mapRole(root, status);
	const issue = issueView(root, number, run);
	let family: Set<string>;
	if (roles.has(status)) family = new Set(roles.values());
	else if ((CATEGORY_ROLES as readonly string[]).includes(status)) family = new Set(CATEGORY_ROLES);
	else family = new Set();
	const remove = issue.labels.filter((name) => family.has(name) && name !== label);
	const args = ["issue", "edit", number];
	for (const name of remove) args.push("--remove-label", name);
	if (!issue.labels.includes(label)) args.push("--add-label", label);
	if (args.length > 3) run(root, args);
	return `Labels on #${number}: ${issue.labels.join(", ") || "(none)"} → ${[...issue.labels.filter((l) => !remove.includes(l)), ...(issue.labels.includes(label) ? [] : [label])].join(", ")}`;
}

/** gh-block: set the blockers — native dependency edges plus the mirrored
 * `**Blocked by:**` line (existing native edges are left in place). */
export function ghBlockOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "block");
	const blockers = [...new Set((params.blockedBy ?? []).map((token) => Number(token.replace(/^#*/, ""))).filter((n) => Number.isInteger(n) && n > 0))];
	const issue = issueView(root, number, run);
	const updated = upsertFieldLine(issue.body, "Blocked by", blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "None (can start immediately)");
	run(root, ["issue", "edit", number, "--body-file", "-"], updated);
	const notes: string[] = [];
	for (const blocker of blockers) addBlockedBy(root, number, blocker, run, notes);
	return [`Updated #${number} — Blocked by: ${blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "None"}`, ...notes.map((n) => `- ${n}`)].join("\n");
}

/** gh-tick: mark the Nth (1-based) unchecked `- [ ]` in the issue body. */
export function ghTickOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "tick");
	const index = params.index;
	if (typeof index !== "number" || index < 1) throw new TrackerError('tick requires a 1-based numeric "index"');
	const issue = issueView(root, number, run);
	let seen = 0;
	let hit = false;
	const updated = issue.body.replace(/- \[ \]/g, (match) => {
		seen += 1;
		if (seen === index) {
			hit = true;
			return "- [x]";
		}
		return match;
	});
	if (!hit) throw new TrackerError(`no unchecked criterion #${index} on #${number} (found ${seen})`);
	run(root, ["issue", "edit", number, "--body-file", "-"], updated);
	return `Ticked criterion ${index} of #${number}.`;
}
