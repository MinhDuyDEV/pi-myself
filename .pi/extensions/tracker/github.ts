import { spawnSync } from "node:child_process";
import type { TrackerParams } from "./params.js";
import {
	appendUnderHeading,
	assertSection,
	assertTicketType,
	CATEGORY_ROLES,
	labelValue,
	loadTriageLabelMap,
	replaceSection,
	replaceTicketBody,
	sectionText,
	TrackerError,
	upsertFieldLine,
} from "./tracker.js";

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

/** `spawnSync`'s 1 MiB default is well under what `gh api --paginate --slurp`
 * returns for a repo with a few hundred issues, and an overflow surfaces as
 * `result.error` with no exit status — which used to be reported as "gh CLI
 * unavailable".
 *
 * The ceiling is real, not decorative: the frontier and triage list every issue
 * with its body, and a REST issue object runs about 6.5 KB, so a repo with
 * ~40,000 issues or PRs would exceed 256 MiB. It is set high enough that the
 * failure is a clear message rather than a silent truncation, and the message
 * names the op so the cause is obvious. A repo that size needs server-side
 * filtering (`gh issue list --label`, `--search`) rather than a bigger buffer. */
const GH_MAX_BUFFER = 256 * 1024 * 1024;

export function ghRun(root: string, args: string[], input?: string): string {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", input, maxBuffer: GH_MAX_BUFFER });
	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
			throw new TrackerError(
				`gh output exceeded ${Math.round(GH_MAX_BUFFER / 1024 / 1024)} MB (gh ${args.slice(0, 3).join(" ")}): this repository has more issues than a full listing can carry — narrow the query with a label or search`,
			);
		}
		throw new TrackerError(
			`gh CLI unavailable (${(result.error as Error).message}); install https://cli.github.com then run "gh auth login"`,
		);
	}
	if (result.status !== 0) {
		const detail = ((result.stderr || result.stdout || "") as string).trim().split("\n")[0] ?? "gh failed";
		throw new TrackerError(`gh ${args.slice(0, 3).join(" ")}: ${detail}`);
	}
	return (result.stdout || "").trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Colors and descriptions for labels an op may have to add to a repo that has
 * never seen this workflow. `gh issue create --label X` fails outright when X
 * does not exist, so the wayfinder ops could not run at all on a fresh repo
 * (a `wayfinder:*` label is not among GitHub's defaults). Values mirror the
 * triage labels' upstream colors and setup-matt-pocock-skills' intent; a label
 * the repo already has is never touched, so the repo's own colors/descriptions
 * always win. */
const LABEL_DEFAULTS: Record<string, { color: string; description: string }> = {
	"wayfinder:map": { color: "1d76db", description: "Wayfinder map: the index issue for one effort" },
	"wayfinder:research": { color: "5319e7", description: "Wayfinder ticket: research a question" },
	"wayfinder:prototype": { color: "5319e7", description: "Wayfinder ticket: build a throwaway prototype" },
	"wayfinder:grilling": { color: "5319e7", description: "Wayfinder ticket: interrogate a decision" },
	"wayfinder:task": { color: "5319e7", description: "Wayfinder ticket: concrete implementation task" },
	bug: { color: "d73a4a", description: "Something isn't working" },
	enhancement: { color: "a2eeef", description: "New feature or request" },
	"needs-triage": { color: "d4c5f9", description: "Maintainer needs to evaluate this issue" },
	"needs-info": { color: "e99695", description: "Waiting on reporter for more information" },
	"ready-for-agent": { color: "0e8a16", description: "Fully specified, ready for an AFK agent" },
	"ready-for-human": { color: "fef2c0", description: "Requires human implementation" },
	wontfix: { color: "ffffff", description: "Will not be actioned" },
};

/** The repo's label names, read once per process. A session runs many tracker
 * ops against one repo; re-listing the labels on every op would add an API call
 * to each write for a set that changes only when a human edits it. */
const labelCache = new Map<string, Set<string>>();

/** Create any of `names` the repo does not have yet, so a label-adding op cannot
 * fail on a fresh repo. Never `--force`: an existing label keeps its own color
 * and description. Every outcome is appended to `notes`, so the caller's report
 * says which labels the op created. */
function ensureLabels(root: string, names: string[], run: GhRun, notes: string[]): void {
	const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	if (wanted.length === 0) return;
	let known = labelCache.get(root);
	if (!known) {
		try {
			const raw = run(root, ["label", "list", "--limit", "500", "--json", "name"]);
			const rows = JSON.parse(raw || "[]") as Array<{ name?: unknown }>;
			known = new Set(rows.map((row) => String(row.name ?? "")).filter(Boolean));
			labelCache.set(root, known);
		} catch (error) {
			// Not fatal: report it and let the label-adding call fail with gh's own
			// message, which names the missing label.
			notes.push(`could not list the repo's labels (${errorMessage(error)}), so missing labels were not created`);
			return;
		}
	}
	for (const name of wanted) {
		if (known.has(name)) continue;
		const spec = LABEL_DEFAULTS[name] ?? { color: "ededed", description: "Created by the pi-myself tracker tool" };
		try {
			run(root, ["label", "create", name, "--color", spec.color, "--description", spec.description]);
			known.add(name);
			notes.push(`created missing label ${name}`);
		} catch (error) {
			notes.push(`could not create label ${name} (${errorMessage(error)})`);
		}
	}
}

/** The triage-label vocabulary this repo actually uses, so role labels are
 * created in the repo's own spelling rather than the canonical one. */
function roleLabel(root: string, status: string): string {
	return loadTriageLabelMap(root).get(status) ?? status;
}

export interface GhComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface GhIssue {
	number: number;
	/** Database id (what the dependencies / sub-issues APIs key on). */
	id?: number | undefined;
	title: string;
	/** `MERGED` only ever comes from a PR payload; it is not `OPEN`. */
	state: "OPEN" | "CLOSED" | "MERGED";
	labels: string[];
	assignees: string[];
	author: string;
	body: string;
	url: string;
	createdAt: string;
	isPullRequest: boolean;
	/** `issue_dependencies_summary.blocked_by` — open native blockers (REST only). */
	openBlockers?: number | undefined;
	/** `sub_issues_summary.total` (REST only). */
	subIssues?: number | undefined;
	comments: GhComment[];
}

/** Accepts both shapes: `gh issue view/list --json` (GraphQL-ish, `OPEN`,
 * `labels[].name`, `author.login`, `url`) and the REST `gh api` issue object
/** gh's `issue view --json state` reports a merged PR as `MERGED`. Flattening
 * everything that is not `CLOSED` to `OPEN` made a merged PR read as an open
 * issue, so it passed the "cannot claim a closed issue" guard and the tracker
 * assigned itself to a merged pull request. */
function normalizeState(value: unknown): GhIssue["state"] {
	const raw = String(value ?? "").toUpperCase();
	if (raw === "OPEN") return "OPEN";
	if (raw === "MERGED") return "MERGED";
	return "CLOSED";
}

/** `true` when the payload describes a PR. The `gh issue view --json` shape
 * carries neither `pull_request` nor `__typename`, but it does carry the html
 * url — and issues and PRs share one number space, so `gh issue view 42` happily
 * returns PR #42. */
function looksLikePullRequest(raw: Record<string, unknown>, url: string): boolean {
	return Boolean(raw.pull_request) || raw.__typename === "PullRequest" || /\/pull\/\d+\s*$/.test(url);
}

/** Accepts both shapes: `gh issue view/list --json` (GraphQL-ish, `OPEN`,
 * `labels[].name`, `author.login`, `url`) and the REST `gh api` issue object
 * (`open`, `html_url`, `user.login`, `pull_request`, summaries). */
export function parseIssue(raw: unknown): GhIssue {
	if (!raw || typeof raw !== "object") throw new TrackerError("gh returned an unrecognised issue payload");
	const issue = raw as Record<string, unknown>;
	const number = Number(issue.number);
	if (!Number.isInteger(number) || number <= 0) throw new TrackerError("gh issue payload without a number");
	const name = (v: unknown) => (typeof v === "string" ? v : ((v as { name?: string } | null)?.name ?? ""));
	const login = (v: unknown) => (typeof v === "string" ? v : ((v as { login?: string } | null)?.login ?? ""));
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
	const url = typeof issue.url === "string" ? issue.url : typeof issue.html_url === "string" ? issue.html_url : "";
	return {
		number,
		id: typeof issue.id === "number" ? issue.id : undefined,
		title: String(issue.title ?? ""),
		state: normalizeState(issue.state),
		labels: (Array.isArray(issue.labels) ? issue.labels.map(name) : []).filter(Boolean),
		assignees: (Array.isArray(issue.assignees) ? issue.assignees.map(login) : []).filter(Boolean),
		author: login(issue.author ?? issue.user),
		body: typeof issue.body === "string" ? issue.body : "",
		url,
		createdAt: String(issue.createdAt ?? issue.created_at ?? ""),
		isPullRequest: looksLikePullRequest(issue, url),
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

/** Explicit "this names no blocker" spellings: the tracker's own
 * "None (can start immediately)" line, wayfinder's `-` placeholder, and the
 * `n/a` a human writes. */
const NO_BLOCKER_VALUE = /^(?:[-*]\s*)?(?:none\b|unblocked\b|n\/a\b|nil\b|[-—]\s*$)/i;

/** One reference to an issue or PR. `repo` is set only when the text named a
 * repository (`owner/repo#12`, or a github.com URL); a bare `#12` leaves it
 * undefined, which means "this repository". */
export interface IssueRef {
	number: number;
	repo?: string;
}

/** `#12`, `owner/repo#12`, and github.com issue/pull URLs. Built per call: a
 * module-level `g` regex carries `lastIndex` state between calls. */
const refToken = () =>
	/(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?#(\d+)\b|github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)/g;

/** References named by a blocker/parent value.
 *
 * Only text up to the first `(` counts. `#N` in explanatory prose is not a
 * reference: `- #12 (depends on the RFC tracked in #99)` names one blocker, but
 * reading every `#N` made #99 — possibly an unrelated open issue — gate the
 * ticket forever. Refs after the parenthesis are dropped, not guessed at.
 *
 * Bare digits are accepted only when the value is nothing but a list of numbers:
 * scanning every digit run read the "4567" in "also needs PR 4567" and the "3"
 * in "3 days" as issue numbers, and an unresolvable number wedged the issue out
 * of the frontier. */
function refsIn(text: string): IssueRef[] {
	const trimmed = text.trim();
	if (!trimmed || NO_BLOCKER_VALUE.test(trimmed)) return [];
	const refs: IssueRef[] = [];
	for (const part of trimmed.split(",")) {
		const scoped = part.replace(/^[ \t]*[-*][ \t]*/gm, "").split("(")[0] ?? "";
		for (const match of scoped.matchAll(refToken())) {
			const number = Number(match[2] ?? match[5]);
			if (!Number.isInteger(number) || number <= 0) continue;
			const repo = match[1] ?? (match[3] && match[4] ? `${match[3]}/${match[4]}` : undefined);
			refs.push(repo ? { number, repo } : { number });
		}
	}
	if (refs.length > 0) return refs;
	// bare ids: nothing but a list of numbers
	const bare = trimmed
		.replace(/^[ \t]*[-*][ \t]*/gm, "")
		.replace(/[\s,]+/g, " ")
		.trim();
	if (!/^\d+(?: \d+)*$/.test(bare)) return [];
	return bare
		.split(" ")
		.map(Number)
		.filter((number) => Number.isInteger(number) && number > 0)
		.map((number) => ({ number }));
}

/** De-duplicate refs by (repo, number), preserving order. */
function uniqueRefs(refs: IssueRef[]): IssueRef[] {
	const seen = new Set<string>();
	const out: IssueRef[] = [];
	for (const ref of refs) {
		const key = `${ref.repo ?? ""}#${ref.number}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

function uniquePositive(values: number[]): number[] {
	return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

/** Refs named by a body: the `**Blocked by:**` field line and/or to-tickets'
 * `## Blocked by` section. */
export function issueRefList(body: string, label = "Blocked by"): IssueRef[] {
	return uniqueRefs([...refsIn(labelValue(body, label)), ...refsIn(sectionText(body, label))]);
}

/** Just the numbers, for callers that do not care which repository a ref named.
 * Kept because it is the shape the tracker's prose is written in. */
export function issueRefs(body: string, label = "Blocked by"): number[] {
	return uniquePositive(issueRefList(body, label).map((ref) => ref.number));
}

/** Parent refs named by a body: a `Part of: #N` / `Part of #N` line, or
 * to-tickets' `## Parent` section.
 *
 * The `#` is required. Accepting a bare number matched the prose "Part of 2
 * efforts", which marked issue #2 as an index and then hid it from the frontier
 * and the triage queue with no footer and no error. */
export function parentRefList(body: string): IssueRef[] {
	// The value, not a bare `#N`: a `Part of:` line may carry a URL or an
	// `owner/repo#N` reference too, and `refsIn` already rejects prose.
	const line = /^\*{0,2}Part of\*{0,2}:?\s*(.+)$/im.exec(body)?.[1];
	const fromLine: IssueRef[] = line ? refsIn(line) : [];
	return uniqueRefs([...fromLine, ...refsIn(sectionText(body, "Parent"))]);
}

export function parentRefs(body: string): number[] {
	return uniquePositive(parentRefList(body).map((ref) => ref.number));
}

/** This repository's `owner/repo`, read at most once per process. Fetched only
 * when a ref actually named a repository, so a body of bare `#12` refs never
 * pays for it. A failed read is not cached: the next op may succeed. */
const repoSlugCache = new Map<string, string>();

function localRepoSlug(root: string, run: GhRun): string | undefined {
	const cached = repoSlugCache.get(root);
	if (cached !== undefined) return cached;
	try {
		const value = run(root, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return undefined;
		repoSlugCache.set(root, value);
		return value;
	} catch {
		return undefined;
	}
}

/** Split refs into this repository's issue numbers and refs that name another
 * repository. `owner/repo#12` must never be read as local #12: that would gate
 * the ticket on an unrelated issue, or look like a real blocker when it is not. */
function splitLocalRefs(refs: IssueRef[], root: string, run: GhRun): { local: number[]; foreign: string[] } {
	const local: number[] = [];
	const foreign: string[] = [];
	const slug = refs.some((ref) => ref.repo) ? localRepoSlug(root, run)?.toLowerCase() : undefined;
	for (const ref of refs) {
		if (ref.repo === undefined || (slug !== undefined && ref.repo.toLowerCase() === slug)) {
			local.push(ref.number);
			continue;
		}
		foreign.push(`${ref.repo}#${ref.number}`);
	}
	return { local: uniquePositive(local), foreign };
}

function reqNumber(token: string | undefined, op: string): string {
	const raw = (token ?? "").trim().replace(/^#*/, "");
	if (!/^\d+$/.test(raw)) throw new TrackerError(`${op} requires an issue number (got ${JSON.stringify(token ?? "")})`);
	return raw;
}

/** Refuse to mutate a PR. Issues and PRs share one number space, so a PR number
 * that reaches a ticket op would edit a pull request through the issue tracker
 * (`gh issue view 42` returns PR #42 without complaint). */
function assertNotPullRequest(view: GhIssue, number: string, op: string): void {
	if (view.isPullRequest) throw new TrackerError(`cannot ${op} #${number}: it is a pull request, not an issue`);
}

/** Refuse to work a ticket that is not open. `MERGED` is reported separately
 * because gh says "merged", not "closed", for a merged PR. */
function assertOpenTicket(view: GhIssue, number: string, verb: string): void {
	if (view.state === "MERGED") throw new TrackerError(`cannot ${verb} #${number}: it was merged (a pull request)`);
	if (view.state === "CLOSED") throw new TrackerError(`cannot ${verb} #${number}: it is closed`);
	assertNotPullRequest(view, number, verb);
}

const VIEW_FIELDS = "number,title,state,body,labels,assignees,author,url,createdAt";

function issueView(root: string, number: string, run: GhRun, withComments = false): GhIssue {
	const fields = withComments ? `${VIEW_FIELDS},comments` : VIEW_FIELDS;
	const raw = run(root, ["issue", "view", number, "--json", fields]);
	if (!raw.trim()) throw new TrackerError("gh returned no issue");
	return parseIssue(JSON.parse(raw));
}

/** REST listing: the only surface that carries native dependency and
 * sub-issue summaries. The REST default order is `created` desc, which is not
 * the tracker's contract ("first by number wins"), so the result is sorted by
 * number here.
 *
 * `keepPullRequests` keeps PRs. The frontier needs them: issues and PRs share
 * one number space, so a `Blocked by: #12` may name a PR — and dropping PRs here
 * made such a reference look unresolvable, which counted as an open blocker
 * forever. */
function restIssues(root: string, state: "open" | "all", run: GhRun, keepPullRequests = false): GhIssue[] {
	return parseList(run(root, ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues?state=${state}&per_page=100`]))
		.filter((issue) => keepPullRequests || !issue.isPullRequest)
		.sort((a, b) => a.number - b.number);
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
	const number = /\/(\d+)\s*$/.exec(url.trim())?.[1];
	if (number === undefined) throw new TrackerError(`gh did not return an issue URL (got ${JSON.stringify(url)})`);
	return number;
}

// ── reads ────────────────────────────────────────────────────────────────────

/** `gh issue list` pages internally but stops at `--limit` without saying so. */
const LIST_LIMIT = 1000;

/** gh-list: open issues, optionally filtered by label (`status`). */
export function ghListOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	// the canonical triage role is mapped to this repo's label vocabulary, the
	// same way gh-status maps it; passing the raw role silently returns nothing
	// on a repo whose labels differ from the canonical names.
	const requested = params.status?.trim();
	const label = requested ? mapRole(root, requested) : undefined;
	const args = ["issue", "list", "--state", "open", "--limit", String(LIST_LIMIT), "--json", VIEW_FIELDS];
	if (label) args.push("--label", label);
	const open = parseList(run(root, args));
	if (open.length === 0) return label ? `No open issues labelled ${label}.` : "No open issues in this GitHub repo.";
	return [
		`## GitHub issues (${open.length} open${label ? `, label ${label}` : ""})`,
		...open.map((issue) => `- ${issueLine(issue)}`),
		// the endpoint caps silently: report a floor as a floor, not as a total
		...(open.length >= LIST_LIMIT ? ["", `_(stopped at the ${LIST_LIMIT}-issue limit; filter with status)_`] : []),
	].join("\n");
}

/** Blocker numbers a ticket names, split into the refs that resolve to an open
 * issue or PR in this repo and the refs that resolve to nothing. Only the first
 * kind gates: a reference that names no issue used to be read as an open blocker
 * forever, hiding the ticket from the frontier with no way to say why. */
interface BlockerRefs {
	open: number[];
	/** Display strings for refs that gate nothing: refs naming no issue or PR in
	 * this repository, refs naming another repository, and self-references. */
	unresolved: string[];
}

function blockerRefsOf(issue: GhIssue, stateByNumber: Map<number, string>, root: string, run: GhRun): BlockerRefs {
	const open: number[] = [];
	const { local, foreign } = splitLocalRefs(issueRefList(issue.body), root, run);
	const unresolved: string[] = [...foreign];
	for (const ref of local) {
		// A self-reference blocks nothing; report it rather than gate on it.
		if (ref === issue.number) {
			unresolved.push(`#${ref}`);
			continue;
		}
		const state = stateByNumber.get(ref);
		if (state === undefined) unresolved.push(`#${ref}`);
		else if (state !== "CLOSED") open.push(ref);
	}
	return { open, unresolved };
}

/** A parent's native children, in the order GitHub records them (the order they
 * were linked) — wayfinder's "map order". `undefined` means the list could not be
 * read; `[]` means it was read and is empty, which is a different answer. */
function nativeSubIssues(root: string, parent: number, run: GhRun): number[] | undefined {
	try {
		const raw = run(root, ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${parent}/sub_issues?per_page=100`]);
		if (!raw.trim()) return [];
		const json = JSON.parse(raw) as unknown;
		const rows = Array.isArray(json) ? json.flatMap((page) => (Array.isArray(page) ? page : [page])) : [];
		return rows.map((row) => Number((row as { number?: unknown }).number)).filter((number) => Number.isInteger(number) && number > 0);
	} catch {
		return undefined;
	}
}

/** gh-frontier: open, unassigned, not a map, not a parent, no open blocker.
 * Blocked = native `issue_dependencies_summary.blocked_by > 0` OR a ref in the
 * body that names an open issue/PR. Parents (maps, specs, anything with
 * sub-issues or named by a `Part of` / `## Parent`) are indexes, not work units:
 * excluded and reported in a footer. Optional `parent` scopes to one map's
 * children, in map order. */
export function ghFrontierOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	// PRs are kept in the index: issues and PRs share one number space, so a
	// `Blocked by: #12` may name a PR, and its state decides whether the edge
	// still gates. PRs are still never frontier candidates (filtered below).
	const all = restIssues(root, "all", run, true);
	const stateByNumber = new Map(all.map((issue) => [issue.number, issue.state]));
	const parentSet = new Set<number>();
	for (const issue of all) {
		// Every state counts, closed referrers included. `Part of: #N` is written by
		// `gh-create-ticket parent=`, so it means "#N is this ticket's parent" — a
		// relationship that does not expire when the child closes. Keying on open
		// referrers only made a spec whose children were all done resurface as
		// takeable agent work (observed on this repository's own spec #1). Native
		// sub-issue edges are counted the same way: `sub_issues_summary.total` covers
		// every child, not just the open ones.
		if (issue.isPullRequest) continue;
		for (const ref of splitLocalRefs(parentRefList(issue.body), root, run).local) parentSet.add(ref);
		if ((issue.subIssues ?? 0) > 0) parentSet.add(issue.number);
	}
	const scopeParent = params.parent ? Number(reqNumber(params.parent, "frontier")) : undefined;
	// A child linked natively (the GitHub UI, or `gh api .../sub_issues`) is a
	// child even when its body carries no `Part of` line — that native link is the
	// canonical form the contract asks for when sub-issues are available. Filtering
	// on the body line alone made such a map's frontier print "(nothing takeable)".
	const nativeChildren = scopeParent === undefined ? undefined : nativeSubIssues(root, scopeParent, run);
	const children = new Set<number>(nativeChildren ?? []);
	if (scopeParent !== undefined) {
		for (const issue of all) {
			if (issue.isPullRequest || issue.state !== "OPEN") continue;
			if (splitLocalRefs(parentRefList(issue.body), root, run).local.includes(scopeParent)) children.add(issue.number);
		}
	}
	const excluded = new Set<number>();
	const open = all.filter((issue) => {
		if (issue.isPullRequest || issue.state !== "OPEN") return false;
		if (issue.labels.includes("wayfinder:map") || parentSet.has(issue.number)) {
			excluded.add(issue.number);
			return false;
		}
		if (scopeParent !== undefined && !children.has(issue.number)) return false;
		return true;
	});
	const refsOf = (issue: GhIssue): BlockerRefs => blockerRefsOf(issue, stateByNumber, root, run);
	// Map order when scoped to a map: wayfinder's first-in-map-order wins, and the
	// native sub-issue list is the only place that order is recorded. An unreadable
	// or empty list means number order — and the heading says which one the list is
	// actually in, rather than claiming an order it does not have.
	const mapOrder = nativeChildren !== undefined && nativeChildren.length > 0 ? nativeChildren : undefined;
	const orderOf = (issue: GhIssue): number => {
		const at = mapOrder?.indexOf(issue.number) ?? -1;
		return at === -1 ? Number.MAX_SAFE_INTEGER : at;
	};
	const byMapOrder = (a: GhIssue, b: GhIssue): number => orderOf(a) - orderOf(b) || a.number - b.number;
	const takeable = open
		.filter((issue) => issue.assignees.length === 0 && (issue.openBlockers ?? 0) === 0 && refsOf(issue).open.length === 0)
		.sort(byMapOrder);
	const blocked = open.filter((issue) => !takeable.includes(issue)).sort(byMapOrder);
	const misdirected = takeable.map((issue) => ({ issue, refs: refsOf(issue).unresolved })).filter((entry) => entry.refs.length > 0);
	const order = mapOrder === undefined ? "first by number wins" : "first in map order wins";
	return [
		`## Frontier — takeable now (${order})${scopeParent ? ` · children of #${scopeParent}` : ""}`,
		...(takeable.length ? takeable.map((issue) => `- ${issueLine(issue)}`) : ["(nothing takeable)"]),
		"",
		"## Open but blocked or claimed",
		...(blocked.length
			? blocked.map((issue) => {
					const refs = refsOf(issue);
					const native = issue.openBlockers ?? 0;
					const reason = refs.open.length
						? `waiting on #${refs.open.join(", #")}`
						: native > 0
							? `waiting on ${native} native blocker(s)`
							: "claimed";
					const unread = refs.unresolved.length ? ` · also names ${refs.unresolved.join(", ")}, not gating` : "";
					return `  ${issueLine(issue)} · ${reason}${unread}`;
				})
			: ["  (none)"]),
		...(scopeParent !== undefined && mapOrder === undefined
			? [
					"",
					nativeChildren === undefined
						? `_(#${scopeParent}'s native sub-issue list could not be read; children found only by a "Part of" line are listed, in issue-number order)_`
						: `_(#${scopeParent} has no native sub-issue order to follow; these are in issue-number order)_`,
				]
			: []),
		...(misdirected.length
			? [
					"",
					`_(not gating: ${misdirected
						.map((entry) => `#${entry.issue.number} names ${entry.refs.join(", ")}`)
						.join("; ")} — no such issue or PR in this repo, or another repository)_`,
				]
			: []),
		// the scoped heading already names the parent, so it is not repeated here
		...(() => {
			const others = [...excluded].filter((number) => number !== scopeParent).sort((a, b) => a - b);
			return others.length
				? ["", `_(excluded from the frontier as indexes: ${others.map((n) => `#${n}`).join(", ")} — maps and parents)_`]
				: [];
		})(),
	].join("\n");
}

/** Most recent comments gh-show renders. Anything dropped is named in the
 * heading — triage reads prior `## Triage Notes` from here, so a silent cut
 * would make it re-ask a resolved question. */
const MAX_SHOWN_COMMENTS = 30;
/** Per-comment character cap. A longer body is truncated with the remainder named. */
const MAX_COMMENT_CHARS = 4_000;
/** Blocker refs gh-show resolves to a state. One API call per ref. */
const MAX_SHOWN_BLOCKER_REFS = 10;

/** `Blocked by:` refs with their current state — the "can I start?" question
 * gh-show is asked, which the raw field line cannot answer (it does not say
 * whether the blocker is still open). One API call per ref, and none at all for
 * an issue that names no blocker. */
function resolveBlockerRefs(root: string, body: string, run: GhRun): string | undefined {
	const { local, foreign } = splitLocalRefs(issueRefList(body), root, run);
	if (local.length === 0 && foreign.length === 0) return undefined;
	const shown = local.slice(0, MAX_SHOWN_BLOCKER_REFS);
	const parts = shown.map((ref) => {
		try {
			const state = run(root, ["api", `repos/{owner}/{repo}/issues/${ref}`, "--jq", ".state"])
				.trim()
				.toUpperCase();
			return `#${ref} (${state === "CLOSED" ? "closed" : state === "MERGED" ? "merged" : "open"})`;
		} catch {
			// 404 (a typo, a deleted issue) or an unreadable API: say so rather than guess
			return `#${ref} (no such issue or PR here)`;
		}
	});
	const omitted = local.length - shown.length;
	const rest = [
		...(omitted > 0 ? [`… ${omitted} further local ref(s) not resolved`] : []),
		...foreign.map((ref) => `${ref} (another repository)`),
	];
	return `Blocked by: ${[...parts, ...rest].join(", ")}`;
}

/** How gh-show names the state. A PR is called a pull request: issues and PRs
 * share one number space, so `gh-show 42` can land on a PR, and reporting it as
 * plain "open" hid that from every reader. `MERGED` is gh's own word for a merged
 * PR and is not "closed". */
function stateLabel(issue: GhIssue): string {
	const kind = issue.isPullRequest ? " pull request" : "";
	if (issue.state === "MERGED") return `merged${kind}`;
	return issue.state === "CLOSED" ? `closed${kind}` : `open${kind}`;
}

/** gh-show: one issue with its fields, blocker states, body, and its comments
 * (triage reads `## Triage Notes` and reporter replies from here). Omissions and
 * truncation are always stated. */
export function ghShowOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const issue = issueView(root, reqNumber(params.ticket, "show"), run, true);
	const total = issue.comments.length;
	const comments = total > MAX_SHOWN_COMMENTS ? issue.comments.slice(-MAX_SHOWN_COMMENTS) : issue.comments;
	const omitted = total - comments.length;
	const blockers = resolveBlockerRefs(root, issue.body, run);
	return [
		issueLine(issue),
		`State: ${stateLabel(issue)} · by @${issue.author || "ghost"} · ${issue.url || "(no url)"}`,
		...(blockers ? [blockers] : []),
		"",
		issue.body.trim() || "(empty body)",
		...(comments.length
			? [
					"",
					`## Comments (${comments.length}${omitted > 0 ? ` of ${total} — the ${omitted} oldest were not shown` : ""})`,
					...comments.map(renderComment),
				]
			: []),
	].join("\n");
}

/** One comment; a body over the cap is truncated with the omitted length named. */
function renderComment(comment: GhComment): string {
	const body = comment.body.trim();
	const shown =
		body.length > MAX_COMMENT_CHARS
			? `${body.slice(0, MAX_COMMENT_CHARS)}\n\n… (${body.length - MAX_COMMENT_CHARS} more characters truncated)`
			: body;
	return `### @${comment.author || "ghost"}${comment.createdAt ? ` · ${comment.createdAt}` : ""}\n\n${shown}`;
}

/** Wayfinder's label family (`wayfinder:map`, `wayfinder:<type>`). Those tickets
 * are claimed and worked, never triaged, so the triage queue must not treat a
 * missing triage role on one as "never triaged". */
const WAYFINDER_LABEL_PREFIX = /^wayfinder:/;

/** Comments are read per issue, and only for the `needs-info` bucket, from the
 * paginated REST endpoint. `gh issue list --json comments` silently returns at
 * most the first 100 comments, which made "did the reporter reply since the last
 * `## Triage Notes`?" read a stale window on a busy issue. */
const MAX_TRIAGE_COMMENT_LOOKUPS = 40;

/** All comments of one issue, oldest first; `undefined` when they could not be
 * read (so the caller can keep the issue visible instead of dropping it). */
function issueComments(root: string, number: number, run: GhRun): GhComment[] | undefined {
	try {
		const raw = run(root, ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${number}/comments?per_page=100`]);
		if (!raw.trim()) return [];
		const json = JSON.parse(raw) as unknown;
		// `--slurp` wraps pages: [[...], [...]]
		const rows = Array.isArray(json) ? json.flatMap((page) => (Array.isArray(page) ? page : [page])) : [];
		return rows.map((row) => {
			const comment = row as Record<string, unknown>;
			return {
				author: String((comment.user as { login?: unknown } | undefined)?.login ?? ""),
				body: typeof comment.body === "string" ? comment.body : "",
				createdAt: String(comment.created_at ?? ""),
			};
		});
	} catch {
		return undefined;
	}
}

/** gh-triage: the triage skill's attention queue, oldest first — (1) never
 * triaged (no state role), (2) `needs-triage`, (3) `needs-info` where the
 * reporter has replied since the last `## Triage Notes` comment. */
export function ghTriageOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	void params;
	const roles = loadTriageLabelMap(root);
	const roleLabels = new Set(roles.values());
	// REST listing rather than `gh issue list --limit N`: the list endpoint caps
	// silently, and in a triage queue a cap means quietly dropping reports.
	// every state, so a parent is still recognised once its children are closed
	// (see gh-frontier); only OPEN issues are queue candidates
	const all = restIssues(root, "all", run);
	// parents (specs, maps, anything with children) are indexes, not triage items
	const parents = new Set<number>();
	for (const issue of all) {
		if (issue.isPullRequest) continue;
		for (const ref of splitLocalRefs(parentRefList(issue.body), root, run).local) parents.add(ref);
		if ((issue.subIssues ?? 0) > 0) parents.add(issue.number);
	}
	const excluded = new Set<number>();
	const issues = all
		.filter((issue) => {
			if (issue.isPullRequest || issue.state !== "OPEN") return false;
			if (issue.labels.some((label) => WAYFINDER_LABEL_PREFIX.test(label)) || parents.has(issue.number)) {
				if (parents.has(issue.number)) excluded.add(issue.number);
				return false;
			}
			return true;
		})
		.sort((a, b) => Date.parse(a.createdAt || "0") - Date.parse(b.createdAt || "0"));
	const untriaged = issues.filter((issue) => !issue.labels.some((label) => roleLabels.has(label)));
	const needsTriage = issues.filter((issue) => issue.labels.includes(roleLabel(root, "needs-triage")));
	const candidates = issues.filter((issue) => issue.labels.includes(roleLabel(root, "needs-info")));
	const notes: string[] = [];
	const looked = candidates.slice(0, MAX_TRIAGE_COMMENT_LOOKUPS);
	if (candidates.length > looked.length) {
		// Name them: they stay in the queue, but only a reader can go and ask the
		// question, so the omission has to be actionable rather than a bare count.
		const unchecked = candidates.slice(MAX_TRIAGE_COMMENT_LOOKUPS).map((issue) => `#${issue.number}`);
		notes.push(
			`comments were read for the ${MAX_TRIAGE_COMMENT_LOOKUPS} oldest needs-info issues only; ${unchecked.join(", ")} were not checked for a reporter reply`,
		);
	}
	const needsInfo = looked.filter((issue) => {
		const comments = issueComments(root, issue.number, run);
		if (comments === undefined) {
			// Unreadable comments mean the question cannot be answered; keeping the
			// issue in the queue is the safe direction (a human looks at it).
			notes.push(`#${issue.number}'s comments could not be read, so whether the reporter replied is unknown`);
			return true;
		}
		const lastNotes = comments
			.map((comment, index) => ({ comment, index }))
			.filter(({ comment }) => /^##\s+Triage Notes/m.test(comment.body))
			.pop();
		const since = lastNotes ? comments.slice(lastNotes.index + 1) : comments;
		return since.some((comment) => comment.author && comment.author === issue.author);
	});
	/** First body line worth showing. The bodies this tool writes start with
	 * `# <title>`, which only repeats the issue title in the queue. */
	const summaryLine = (body: string): string => {
		for (const line of body.trim().split("\n")) {
			const text = line.trim();
			if (!text || /^#{1,6}\s/.test(text) || text.startsWith("<!--")) continue;
			return text.slice(0, 120);
		}
		return "(empty body)";
	};
	const bucket = (title: string, list: GhIssue[]) => [
		`## ${title} (${list.length})`,
		...(list.length ? list.map((issue) => `- ${issueLine(issue)} · ${summaryLine(issue.body)}`) : ["(none)"]),
		"",
	];
	return [
		...bucket("Never triaged — no state role", untriaged),
		...bucket("needs-triage", needsTriage),
		...bucket("needs-info — reporter replied since the last Triage Notes", needsInfo),
		...(excluded.size
			? [
					`_(not queued as indexes: ${[...excluded]
						.sort((a, b) => a - b)
						.map((number) => `#${number}`)
						.join(", ")} — specs, maps and parents)_`,
				]
			: []),
		...(notes.length ? [`_(${notes.join("; ")})_`] : []),
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
	const notes: string[] = [];
	ensureLabels(root, [label], run, notes);
	const url = run(root, ["issue", "create", "--title", title, "--body-file", "-", "--label", label], `${body}\n`);
	return [`Spec published: ${url.trim()} — tickets reference it with parent "#${numberFromUrl(url)}".`, ...notes.map((n) => `- ${n}`)].join(
		"\n",
	);
}

function mapRole(root: string, status: string): string {
	if (!/^[a-z0-9:_ -]+$/i.test(status)) throw new TrackerError(`invalid label: ${JSON.stringify(status)}`);
	return loadTriageLabelMap(root).get(status) ?? status;
}

/** Explicit "no blockers" spellings, so clearing a blocked ticket stays possible. */
const NO_BLOCKER_TOKEN = /^(none|unblocked|n\/a|-)$/i;

/** Blocker numbers from `#12` / `12` tokens. A token that is neither a positive
 * integer nor an explicit "none" is rejected rather than dropped: silently
 * discarding it publishes a ticket whose edge looks wired but is not. */
function parseBlockers(tokens: string[]): number[] {
	const values = tokens
		.map((token) => token.trim())
		.filter((token) => token && !NO_BLOCKER_TOKEN.test(token))
		.map((token) => {
			const raw = token.replace(/^#*/, "");
			const value = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value <= 0) {
				throw new TrackerError(`invalid blocker ${JSON.stringify(token)}: expected an issue number like "#12"`);
			}
			return value;
		});
	return [...new Set(values)];
}

/** gh-create-ticket: one issue in to-tickets' tracker template (or, with
 * `type`, wayfinder's child shape: `## Question` + `wayfinder:<type>`).
 * Parent and blockers become native sub-issue / dependency edges, mirrored
 * by `Part of: #N` and `**Blocked by:** #N` lines. */
export function ghCreateTicketOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = (params.title ?? "").trim();
	if (!title) throw new TrackerError('create-ticket requires "title"');
	const type = params.type?.trim();
	assertTicketType(type);
	const labels: string[] = [];
	if (type) labels.push(`wayfinder:${type}`);
	if (params.status?.trim() || !type) labels.push(mapRole(root, params.status?.trim() || "ready-for-agent"));
	const blockers = parseBlockers(params.blockedBy ?? []);
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
	const notes: string[] = [];
	// `gh issue create --label X` fails when X does not exist, and a repo that has
	// never run this workflow has no `wayfinder:*` label at all: provision first,
	// and report what was created.
	ensureLabels(root, labels, run, notes);
	const url = run(root, args, body).trim();
	const number = numberFromUrl(url);
	if (parent) addSubIssue(root, parent, number, run, notes);
	for (const blocker of blockers) addBlockedBy(root, number, blocker, run, notes);
	return [
		`Created ${url} [${labels.join(", ")}]`,
		// echo the blockers: the caller must be able to see the edge it asked for
		`Blocked by: ${blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "none"}`,
		...notes.map((n) => `- ${n}`),
	].join("\n");
}

/** gh-create-map: the wayfinder map issue (label `wayfinder:map`). */
export function ghCreateMapOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const title = params.title?.trim() || params.feature?.trim() || "";
	if (!title) throw new TrackerError("create-map requires a title (the effort name)");
	const body = [
		"## Destination",
		"",
		params.destination?.trim() ||
			"(what reaching the end of this map looks like: the spec, decision, or change this effort finds its way to)",
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
	const notes: string[] = [];
	ensureLabels(root, ["wayfinder:map"], run, notes);
	const url = run(root, ["issue", "create", "--title", `Map: ${title}`, "--body-file", "-", "--label", "wayfinder:map"], body);
	return [`Map created: ${url.trim()} — children reference it with parent "#${numberFromUrl(url)}".`, ...notes.map((n) => `- ${n}`)].join(
		"\n",
	);
}

/** gh-claim: assign @me — the session's first write (wayfinder). */
export function ghClaimOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "claim");
	const view = issueView(root, number, run);
	assertOpenTicket(view, number, "claim");
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
	assertNotPullRequest(issue, number, "resolve");
	const notes: string[] = [];
	// wontfix is a state role: applying it the same way gh-status does keeps
	// exactly one state role, instead of leaving e.g. needs-info behind.
	if (wontfix) applyRole(root, number, "wontfix", issue, run, notes);
	run(root, ["issue", "close", number, "--reason", wontfix ? "not planned" : "completed", "--comment", comment]);
	notes.unshift(`Resolved #${number} (closed${wontfix ? " as not planned with the wontfix state role" : " with a resolution comment"})`);
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
	assertNotPullRequest(issue, number, "rule out of scope");
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

/** gh-edit: change an issue's title and/or body prose in place — the one
 * field-level edit the vendored skills ask for (wayfinder rewords a ticket
 * after research) that had no op. */
export function ghEditOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "edit");
	const title = params.title?.trim();
	const what = params.what?.trim();
	if (!title && !what) throw new TrackerError('edit requires "title" and/or "what"');
	const issue = issueView(root, number, run);
	assertNotPullRequest(issue, number, "edit");
	const args = ["issue", "edit", number];
	if (title) args.push("--title", title);
	if (what) args.push("--body-file", "-");
	run(root, args, what ? replaceTicketBody(issue.body, what) : undefined);
	return `Edited #${number}${title ? ` — title: ${JSON.stringify(title)}` : ""}${what ? " — body replaced" : ""}.`;
}

/** gh-note: append a line under a section of a map issue's body (the Notes /
 * Not-yet-specified fog edits wayfinder does by hand). */
export function ghMapNoteOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.parent, "note");
	const line = (params.what ?? "").trim();
	if (!line) throw new TrackerError('note requires "what" (the line to append)');
	const section = params.section?.trim() || "Notes";
	assertSection(section);
	const issue = issueView(root, number, run);
	assertNotPullRequest(issue, number, "append a note to");
	run(root, ["issue", "edit", number, "--body-file", "-"], appendUnderHeading(issue.body, section, line));
	return `Appended to ${section} on #${number}.`;
}

/** Apply `status` as a role label, dropping the rest of its family first so
 * triage's "exactly one category role + one state role" invariant holds.
 * Non-role labels (`wayfinder:*`) are never touched. Returns the label applied
 * and the labels removed, for the caller's report. */
function applyRole(
	root: string,
	number: string,
	status: string,
	issue: GhIssue,
	run: GhRun,
	notes: string[],
): { label: string; remove: string[] } {
	const roles = loadTriageLabelMap(root);
	const label = mapRole(root, status);
	// `gh issue edit --add-label X` fails when X does not exist (a repo may map a
	// role to a label string nobody created yet).
	ensureLabels(root, [label], run, notes);
	// The family is keyed by canonical role, and a caller may pass either the
	// canonical role or this repo's mapped label string; resolve both to the
	// canonical key first, or a mapped local label leaves the previous state role
	// in place.
	const canonical = roles.has(status) ? status : [...roles.entries()].find(([, local]) => local === status)?.[0];
	let family: Set<string>;
	// Both spellings: this repo may carry the canonical label while the map is
	// non-identity, or the mapped one.
	if (canonical !== undefined) family = new Set([...roles.keys(), ...roles.values()]);
	else if ((CATEGORY_ROLES as readonly string[]).includes(status)) family = new Set<string>(CATEGORY_ROLES);
	else family = new Set<string>();
	const remove = issue.labels.filter((name) => family.has(name) && name !== label);
	const args = ["issue", "edit", number];
	for (const name of remove) args.push("--remove-label", name);
	if (!issue.labels.includes(label)) args.push("--add-label", label);
	if (args.length > 3) run(root, args);
	return { label, remove };
}

/** gh-status: swap the state role (only other state-role labels are removed),
 * or the category role (`bug`/`enhancement`), or add any other label
 * (`wayfinder:<type>`) — triage's "one category + one state" invariant. */
export function ghStatusOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const status = (params.status ?? "").trim();
	if (!status) throw new TrackerError('status requires a label-shaped "status" value');
	const number = reqNumber(params.ticket, "status");
	const issue = issueView(root, number, run);
	assertNotPullRequest(issue, number, "relabel");
	const notes: string[] = [];
	const { label, remove } = applyRole(root, number, status, issue, run, notes);
	const kept = issue.labels.filter((name) => !remove.includes(name));
	return [
		`Labels on #${number}: ${issue.labels.join(", ") || "(none)"} → ${[...kept, ...(issue.labels.includes(label) ? [] : [label])].join(", ")}`,
		...notes.map((note) => `- ${note}`),
	].join("\n");
}

/** Existing native blockers of `child`, or `undefined` when the listing could
 * not be read (so the caller can say the cleanup did not happen). */
function nativeBlockers(root: string, child: string, run: GhRun): Array<{ id: number; number: number }> | undefined {
	try {
		const raw = run(root, ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${child}/dependencies/blocked_by`]);
		if (!raw.trim()) return [];
		const json = JSON.parse(raw) as unknown;
		// `--slurp` wraps pages: [[...], [...]]
		const rows = Array.isArray(json) ? json.flatMap((page) => (Array.isArray(page) ? page : [page])) : [];
		return rows
			.map((row) => row as { id?: unknown; number?: unknown })
			.filter((row) => typeof row.id === "number" && typeof row.number === "number")
			.map((row) => ({ id: row.id as number, number: row.number as number }));
	} catch {
		return undefined;
	}
}

/** Native dependency edges are the live gate for `gh-frontier`, so a blocker
 * removed from the body must lose its edge too — otherwise the ticket reads
 * "Blocked by: None" while a closed-over edge still excludes it. */
function removeBlockedBy(root: string, child: string, blockerId: number, run: GhRun, notes: string[]): void {
	tryNative(
		() => {
			run(root, ["api", "--method", "DELETE", `repos/{owner}/{repo}/issues/${child}/dependencies/blocked_by/${blockerId}`]);
		},
		`native edge issue_id=${blockerId} removed`,
		notes,
	);
}

/** Write the blocker list into whichever shape the body already uses.
 *
 * to-tickets' GitHub template carries a `## Blocked by` **section**, while this
 * tool's `gh-create-ticket` writes a `**Blocked by:**` **field line**, and
 * `issueRefs` unions both. Updating only the field line left a stale section
 * gating an issue whose body read "Blocked by: None", so every shape that is
 * present is rewritten; a body with neither gains the field line. */
function upsertBlockedBy(body: string, value: string): string {
	const hadSection = /^##\s+Blocked by\s*$/m.test(body);
	const hadLine = /^\*{0,2}Blocked by\*{0,2}:/im.test(body);
	let text = body;
	if (hadSection) text = replaceSection(text, "Blocked by", value);
	// With a section and no field line, adding one would only duplicate the value
	// in every later read; the section is the body's own shape, so keep it.
	if (hadLine || !hadSection) text = upsertFieldLine(text, "Blocked by", value);
	return text;
}

/** gh-block: set the blockers — native dependency edges plus the mirrored
 * `Blocked by` field line (or section). Blocker numbers no longer listed have
 * their native edge deleted, so the body and the live gate agree. */
export function ghBlockOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "block");
	const blockers = parseBlockers(params.blockedBy ?? []);
	const issue = issueView(root, number, run);
	assertNotPullRequest(issue, number, "block");
	const value = blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "None (can start immediately)";
	run(root, ["issue", "edit", number, "--body-file", "-"], upsertBlockedBy(issue.body, value));
	const notes: string[] = [];
	for (const blocker of blockers) addBlockedBy(root, number, blocker, run, notes);
	const existing = nativeBlockers(root, number, run);
	if (existing === undefined) {
		notes.push(
			"native blockers could not be read, so stale native edges (if any) were NOT removed — the body line is accurate but the live gate may still exclude this issue",
		);
	} else {
		for (const edge of existing) {
			if (!blockers.includes(edge.number)) removeBlockedBy(root, number, edge.id, run, notes);
		}
	}
	return [
		`Updated #${number} — Blocked by: ${blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "None"}`,
		...notes.map((n) => `- ${n}`),
	].join("\n");
}

/** gh-tick: mark the Nth (1-based) unchecked `- [ ]` in the issue body. */
export function ghTickOp(root: string, params: TrackerParams, run: GhRun = ghRun): string {
	const number = reqNumber(params.ticket, "tick");
	const index = params.index;
	if (typeof index !== "number" || index < 1) throw new TrackerError('tick requires a 1-based numeric "index"');
	const issue = issueView(root, number, run);
	assertOpenTicket(issue, number, "tick");
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
