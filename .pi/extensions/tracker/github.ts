import { spawnSync } from "node:child_process";

import { labelValue, TrackerError, upsertFieldLine } from "./tracker.js";
import type { TrackerParams } from "./params.js";

/**
 * GitHub Issues backend for the tracker tool (gh CLI, run with the repo as
 * cwd). Op surface mirrors the local tracker with GitHub-native semantics:
 *
 * - Tickets are issues; a wayfinder "map" is an issue labelled `wayfinder:map`
 *   whose children reference it via a `Part of: #NN` body line.
 * - Blocking: a `**Blocked by:** #12, #13` line in the issue body (the field
 *   convention the skills write). GitHub has no gh blocking query, so the
 *   frontier resolves those refs against issue state.
 * - Triage roles are labels (per docs/agents/triage-labels.md); wayfinder
 *   children carry `wayfinder:<type>`.
 * - Claim = assign @me; resolve = close with the answer as a comment.
 *
 * Every op takes an injectable `run` so tests can fake the CLI later.
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

export interface GhIssue {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	labels: string[];
	assignees: string[];
	body: string;
	url: string;
}

function parseIssue(raw: unknown): GhIssue {
	if (!raw || typeof raw !== "object") throw new TrackerError("gh returned an unrecognised issue payload");
	const issue = raw as Record<string, unknown>;
	const number = Number(issue.number);
	if (!Number.isInteger(number) || number <= 0) throw new TrackerError("gh issue payload without a number");
	const toLabel = (label: unknown) => (typeof label === "string" ? label : (label as { name?: string } | null)?.name ?? "");
	const toLogin = (user: unknown) => (typeof user === "string" ? user : (user as { login?: string } | null)?.login ?? "");
	const labels = (Array.isArray(issue.labels) ? issue.labels.map(toLabel) : []).filter(Boolean);
	const assignees = (Array.isArray(issue.assignees) ? issue.assignees.map(toLogin) : []).filter(Boolean);
	return {
		number,
		title: String(issue.title ?? ""),
		state: issue.state === "CLOSED" ? "CLOSED" : "OPEN",
		labels,
		assignees,
		body: typeof issue.body === "string" ? issue.body : "",
		url: typeof issue.url === "string" ? issue.url : "",
	};
}

function parseOne(jsonText: string): GhIssue {
	if (!jsonText.trim()) throw new TrackerError("gh returned no issue");
	return parseIssue(JSON.parse(jsonText));
}

function parseList(jsonText: string): GhIssue[] {
	if (!jsonText.trim()) return [];
	const json = JSON.parse(jsonText);
	return Array.isArray(json) ? json.map(parseIssue) : [];
}

function issueLine(issue: { number: number; title: string; labels: string[]; assignees: string[] }): string {
	const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
	const assignee = issue.assignees.length ? ` → @${issue.assignees.join(", @")}` : "";
	return `#${issue.number} — ${issue.title}${labels}${assignee}`;
}

/** Issue numbers referenced by a body's `**Blocked by:**` line. */
export function issueRefs(body: string): number[] {
	const raw = labelValue(body, "Blocked by");
	if (!raw || /^(none|unblocked)\b/i.test(raw)) return [];
	return raw
		.split(/,|\band\b/i)
		.map((part) => part.trim().replace(/^#*/, ""))
		.filter((part) => /^\d+$/.test(part))
		.map(Number);
}

function reqNumber(token: string | undefined, op: string): string {
	const raw = (token ?? "").trim().replace(/^#*/, "");
	if (!/^\d+$/.test(raw)) throw new TrackerError(`${op} requires an issue number (got ${JSON.stringify(token ?? "")})`);
	return raw;
}

const LIST_FIELDS = "number,title,state,body,labels,assignees,url";

export function ghListOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	void params;
	const open = parseList(run(root, ["issue", "list", "--state", "open", "--limit", "300", "--json", LIST_FIELDS]));
	if (open.length === 0) return "No open issues in this GitHub repo.";
	return [`## GitHub issues (${open.length} open)`, ...open.map((issue) => `- ${issueLine(issue)}`)].join("\n");
}

/** gh-frontier: open, unassigned, not a map, every `Blocked by` ref closed. */
export function ghFrontierOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	void params;
	const all = parseList(run(root, ["issue", "list", "--state", "all", "--limit", "300", "--json", LIST_FIELDS]));
	const open = all.filter((issue) => issue.state === "OPEN" && !issue.labels.includes("wayfinder:map"));
	const takeable = open.filter((issue) => {
		if (issue.assignees.length > 0) return false;
		for (const ref of issueRefs(issue.body)) {
			const target = all.find((other) => other.number === ref);
			if (!target || target.state !== "CLOSED" || target.number === issue.number) return false;
		}
		return true;
	});
	const blocked = open.filter((issue) => !takeable.includes(issue));
	return [
		"## Frontier — takeable now (first by number wins)",
		...(takeable.length ? takeable.map((issue) => `- ${issueLine(issue)}`) : ["(nothing takeable)"]),
		"",
		"## Open but blocked or claimed",
		...(blocked.length
			? blocked.map((issue) => {
					const refs = issueRefs(issue.body);
					const reason = refs.length ? `waiting on #${refs.join(", #")}` : "claimed";
					return `  ${issueLine(issue)} · ${reason}`;
				})
			: ["  (none)"]),
	].join("\n");
}

/** gh-show: one issue, fields + body + last comments. */
export function ghShowOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "show");
	const raw = run(root, ["issue", "view", String(number), "--json", "number,title,state,body,labels,assignees,url,comments"]);
	const payload = JSON.parse(raw) as Record<string, unknown> & {
		comments?: Array<{ author?: { login?: string } | null; body?: string | null }>;
	};
	const issue = parseIssue(payload);
	const comments = Array.isArray(payload.comments) ? payload.comments.slice(-3) : [];
	return [
		issueLine(issue),
		`State: ${issue.state === "CLOSED" ? "closed" : "open"} · ${issue.url || "(no url)"}`,
		"",
		issue.body.trim() || "(empty body)",
		...(comments.length ? ["", "## Recent comments", ...comments.map((c) => `- **@${c.author?.login ?? "ghost"}**: ${(c.body ?? "").trim().split("\n").slice(0, 4).join(" ").slice(0, 240)}`)] : []),
	].join("\n");
}

// ── mutations ────────────────────────────────────────────────────────────────


function labelArg(label: string): string[] {
	return ["--label", label];
}

/** gh-create-ticket: one issue with the ticket template body + triage/wayfinder label. */
export function ghCreateTicketOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = (params.title ?? "").trim();
	if (!title) throw new TrackerError('create-ticket requires "title"');
	const label = (params.status ?? "ready-for-agent").trim() || "ready-for-agent";
	if (!/^[a-z0-9:_-]+$/i.test(label)) throw new TrackerError(`invalid label: ${JSON.stringify(label)}`);
	const blockedRefs = (params.blockedBy ?? []).map((token) => `#${Number(token.trim().replace(/^#*/, ""))}`).filter((ref) => ref !== "#NaN");
	const parent = params.parent ? reqNumber(params.parent, "parent") : "";
	const body = [
		...(parent ? [`Part of: #${parent}`, ""] : []),
		`**What to build:** ${params.what?.trim() || "(fill from the ticket's source: spec, wayfinder question, or triage note)"}`,
		"",
		`**Blocked by:** ${blockedRefs.length ? blockedRefs.join(", ") : "None (can start immediately)"}`,
		"",
		`**Status:** ${label}`,
		"",
	].join("\n");
	const url = run(root, ["issue", "create", "--title", title, "--body-file", "-", "--label", label], body);
	return `Created ${url.trim()}`;
}

/** gh-create-map: the wayfinder map issue (label `wayfinder:map`). */
export function ghCreateMapOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = params.title?.trim() || params.feature?.trim() || "";
	if (!title) throw new TrackerError("create-map requires a title (the effort name)");
	const body = [
		`# Map: ${title}`,
		"",
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
		"(in-scope fog you cannot ticket yet)",
		"",
		"## Out of scope",
		"",
		"(work consciously ruled out of this effort)",
		"",
	].join("\n");
	const url = run(root, ["issue", "create", "--title", `Map: ${title}`, "--body-file", "-", "--label", "wayfinder:map"], body);
	return `Map created: ${url.trim()} — children reference it with "Part of: #NN".`;
}

/** gh-claim: assign @me (the claim, per wayfinder — before any work). */
export function ghClaimOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "claim");
	const payload = JSON.parse(run(root, ["issue", "view", String(number), "--json", "number,title,state,assignees,url"])) as Record<string, unknown>;
	const view = parseIssue(payload);
	if (view.assignees.length > 0) {
		return `#${number} is already claimed by @${view.assignees.join(", @")} — take it only with them.`;
	}
	run(root, ["issue", "edit", String(number), "--add-assignee", "@me"]);
	return `Claimed ${issueLine(view)} (set this before any work).`;
}

/** gh-resolve: close with the answer as a resolution comment (gist appended). */
export function ghResolveOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "resolve");
	const answer = (params.answer ?? "").trim();
	if (!answer) throw new TrackerError('resolve requires "answer"');
	const comment = ["## Answer", "", answer, ...(params.gist?.trim() ? ["", `Gist: ${params.gist.trim()}`] : [])].join("\n");
	run(root, ["issue", "close", String(number), "--comment", comment]);
	return `Resolved #${number} (closed with a resolution comment)${params.gist?.trim() ? ` — gist: ${params.gist.trim()}` : ""}.`;
}

/** gh-comment: append a comment. */
export function ghCommentOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "comment");
	const body = (params.what ?? "").trim();
	if (!body) throw new TrackerError('comment requires "what"');
	run(root, ["issue", "comment", String(number), "--body-file", "-"], `${body}\n`);
	return `Commented on #${number}.`;
}

/** gh-status: apply the triage role or wayfinder label (per docs/agents/triage-labels.md). */
export function ghStatusOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const label = (params.status ?? "").trim();
	if (!/^[a-z0-9:_-]+$/i.test(label)) throw new TrackerError('status requires a label-shaped "status" value');
	const number = reqNumber(params.ticket, "status");
	const issue = parseIssue(JSON.parse(run(root, ["issue", "view", String(number), "--json", "number,title,labels"])));
	const existing = issue.labels.filter((name) => name !== label);
	const args = ["issue", "edit", String(number)];
	for (const name of existing) args.push("--remove-label", name);
	args.push("--add-label", label);
	run(root, args);
	return `Status on #${number}: ${issue.labels.join(", ") || "(none)"} → ${label}`;
}

/** gh-block: rewrite the body's `**Blocked by:**` line with the given refs. */
export function ghBlockOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "block");
	const blockers = (params.blockedBy ?? []).map((token) => `#${Number(token.replace(/^#*/, ""))}`);
	const issue = parseIssue(JSON.parse(run(root, ["issue", "view", String(number), "--json", "number,title,body"])));
	const updated = upsertFieldLine(issue.body, "Blocked by", blockers.length ? blockers.join(", ") : "None (can start immediately)");
	run(root, ["issue", "edit", String(number), "--body-file", "-"], updated);
	return `Updated #${number} — Blocked by: ${blockers.length ? blockers.join(", ") : "None"}`;
}

/** gh-tick: mark the Nth (1-based) unchecked `- [ ]` in the issue body. */
export function ghTickOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "tick");
	const index = params.index;
	if (typeof index !== "number" || index < 1) throw new TrackerError('tick requires a 1-based numeric "index"');
	const issue = parseIssue(JSON.parse(run(root, ["issue", "view", String(number), "--json", "number,title,body"])));
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
	run(root, ["issue", "edit", String(number), "--body-file", "-"], updated);
	return `Ticked criterion ${index} of #${number}.`;
}