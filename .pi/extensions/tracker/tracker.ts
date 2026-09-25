import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { WAYFINDER_TYPES } from "./params.js";

/**
 * Local-markdown issue tracker — the `.scratch/` convention from Matt
 * Pocock's skills (docs/agents/issue-tracker.md, local tracker), served as
 * deterministic plumbing for the `tracker` tool:
 *
 * - One feature per directory: `.scratch/<feature-slug>/`
 * - Spec: `.scratch/<feature>/spec.md`
 * - Tickets: `.scratch/<feature>/issues/NN-<slug>.md`, numbered from 01
 * - `Status:` near the top: triage roles, or wayfinder's claimed/resolved
 * - `Type:` line for wayfinder ticket types
 * - `Blocked by: 01, 02` (or "None (can start immediately)"); a ticket is
 *   unblocked when every listed ticket is resolved
 * - Frontier: open, unblocked, unclaimed; first by number wins
 * - Resolve: `## Answer` + `Status: resolved` (done and wontfix also close)
 *
 * The wayfinder / to-tickets / triage skills own the prose discipline; this
 * module only reads and edits those files.
 */

export const CLOSED_STATUSES = new Set(["resolved", "done", "wontfix", "out-of-scope"]);
export const TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;
/** triage's category roles: exactly one per triaged item, beside exactly one state role. */
export const CATEGORY_ROLES = ["bug", "enhancement"] as const;

/** Canonical triage role → this repo's label string, from the table in
 * docs/agents/triage-labels.md (setup-matt-pocock-skills writes it; the
 * right-hand column is the repo's vocabulary). Identity when the file or a
 * row is missing. */
export function loadTriageLabelMap(repoRoot: string): Map<string, string> {
	const map = new Map<string, string>(TRIAGE_ROLES.map((role) => [role, role]));
	let text = "";
	try {
		text = readFileSync(join(repoRoot, "docs", "agents", "triage-labels.md"), "utf8");
	} catch {
		return map;
	}
	for (const line of text.split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
		const canonical = cells[1];
		const local = cells[2];
		if (canonical !== undefined && local !== undefined && map.has(canonical) && local && !/^-+$/.test(local)) {
			map.set(canonical, local);
		}
	}
	return map;
}

/** Resolve a status the caller passed — a canonical triage role, or the local
 * label string `triage-labels.md` maps it to — back to the canonical role, so
 * either spelling filters and writes correctly. `.scratch/` files keep the
 * canonical role: closure and frontier semantics key on those values. */
export function canonicalRole(repoRoot: string, value: string): string {
	const wanted = value.trim().toLowerCase();
	const roles = loadTriageLabelMap(repoRoot);
	if (roles.has(wanted)) return wanted;
	for (const [role, local] of roles.entries()) {
		if (local.toLowerCase() === wanted) return role;
	}
	return wanted;
}

/** Escape a literal for a `RegExp` source. Headings are literal text, so a
 * caller-supplied section name (`note`'s `section`) must never be treated as a
 * pattern — an unbalanced `(` used to throw a raw SyntaxError. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Validate a map section heading: non-empty, one line, no `#`, so both the
 * regex builder and the written `## ` line stay well-formed. */
export function assertSection(section: string): void {
	if (!section.trim() || /[\n\r#]/.test(section)) throw new TrackerError(`invalid map section ${JSON.stringify(section)}`);
}

/** Text of a `## Heading` section (up to the next `## `), or "" when absent. */
export function sectionText(text: string, heading: string): string {
	const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "im");
	const match = re.exec(text);
	if (!match) return "";
	const start = match.index + match[0].length;
	const next = text.slice(start).search(/^##\s/m);
	return (next === -1 ? text.slice(start) : text.slice(start, start + next)).trim();
}

/** Insert a bullet at the end of a `## Heading` section (created at the end when absent). */
export function appendUnderHeading(text: string, heading: string, line: string): string {
	const { at, rest, found } = sectionInsert(text, heading);
	if (!found) return `${text.trimEnd()}\n\n## ${heading}\n\n- ${line.trim()}\n`;
	return `${text.slice(0, at).trimEnd()}\n\n- ${line.trim()}\n${rest ? `\n${rest}` : ""}`;
}

/** Insert a free-form block at the end of a `## Heading` section (created at the
 * end when absent). Unlike a bullet this keeps the block's own lines, so
 * repeated comments extend the one section instead of each call starting a new
 * `## Comments` heading. */
export function appendBlockUnderHeading(text: string, heading: string, block: string): string {
	const { at, rest, found } = sectionInsert(text, heading);
	const body = block.trim();
	if (!found) return `${text.trimEnd()}\n\n## ${heading}\n\n${body}\n`;
	return `${text.slice(0, at).trimEnd()}\n\n${body}\n${rest ? `\n${rest}` : ""}`;
}

/** Where a new block belongs inside a `## Heading` section: after its existing
 * body, or at the end of the document when the heading is absent. */
function sectionInsert(text: string, heading: string): { at: number; rest: string; found: boolean } {
	const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "im");
	const match = re.exec(text);
	if (!match) return { at: text.length, rest: "", found: false };
	const afterHead = match.index + match[0].length;
	const next = text.slice(afterHead).search(/^##\s/m);
	const at = next === -1 ? text.length : afterHead + next;
	return { at, rest: text.slice(at).replace(/^\n+/, ""), found: true };
}

const NUM_FILE_RE = /^(\d+)-(.+)\.md$/;

/** `**Label:** value` (or `Label: value`) line value, with bold markers stripped.
 * Shared with the GitHub backend: issue bodies carry the same field lines. */
export function labelValue(text: string, label: string): string {
	const line = new RegExp(`^\\*{0,2}${label}\\*{0,2}:[^\\n]*$`, "im").exec(text)?.[0];
	if (!line) return "";
	return line
		.slice(line.indexOf(":") + 1)
		.replace(/^[ \t]*\*+/, "")
		.replace(/\*+$/, "")
		.trim();
}

export class TrackerError extends Error {}

export function isFeatureSlug(feature: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(feature) && !feature.includes("..");
}

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		// the slice can land on a separator: `-fix` would read as a negative lookahead
		.replace(/-+$/, "");
	return slug || "unslugged";
}

export function scratchRoot(repoRoot: string): string {
	return join(repoRoot, ".scratch");
}

export function featureDir(repoRoot: string, feature: string): string {
	return join(scratchRoot(repoRoot), feature);
}

export function issuesDir(repoRoot: string, feature: string): string {
	return join(featureDir(repoRoot, feature), "issues");
}

function statDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// ── parsing ──────────────────────────────────────────────────────────────────

export interface Ticket {
	id: string;
	slug: string;
	title: string;
	file: string;
	assignee: string;
	status: string;
	/** triage's category role (`bug`/`enhancement`), on its own `Category:` line. */
	category: string;
	ticketType: string;
	blockedBy: string[];
	totalChecklist: number;
	doneChecklist: number;
	raw: string;
}

/** Blocker tokens from a `Blocked by:` value: comma-separated ids or slugs.
 * `and` is NOT a separator here — a blocker written as a title may legitimately
 * contain it, and `frontierOf` retries the conjunction only when the whole
 * token fails to resolve. */
function parseBlockerTokens(raw: string): string[] {
	const value = raw.trim();
	if (!value || /^none\b/i.test(value)) return [];
	return value
		.split(",")
		.map((part) => part.trim().replace(/^#*/, ""))
		.filter(Boolean);
}

export function parseTicket(file: string): Ticket {
	const raw = readFileSync(file, "utf8");
	const name = basename(file);
	const numbered = NUM_FILE_RE.exec(name);
	const id = numbered?.[1] ?? name.replace(/\.md$/, "");
	const slug = numbered?.[2] ?? name.replace(/\.md$/, "");
	const h1 = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
	return {
		id,
		slug,
		title: h1.replace(/^\d+:\s*/, "") || id,
		file,
		assignee: labelValue(raw, "Assign(?:ee|ed to)"),
		status: (labelValue(raw, "Status").match(/[a-z-]+/i)?.[0] ?? "").toLowerCase(),
		category: (labelValue(raw, "Category").match(/[a-z-]+/i)?.[0] ?? "").toLowerCase(),
		ticketType: labelValue(raw, "Type").toLowerCase(),
		blockedBy: parseBlockerTokens(labelValue(raw, "Blocked by")),
		totalChecklist: (raw.match(/- \[[xX ]\]/g) ?? []).length,
		doneChecklist: (raw.match(/- \[[xX]\]/g) ?? []).length,
		raw,
	};
}

export function isClosed(ticket: Ticket): boolean {
	return CLOSED_STATUSES.has(ticket.status.toLowerCase());
}

export interface FeatureSummary {
	feature: string;
	tickets: number;
	open: number;
	hasMap: boolean;
	hasSpec: boolean;
}

export function listFeatures(repoRoot: string): FeatureSummary[] {
	const dir = join(repoRoot, ".scratch");
	if (!existsSync(dir) || !statDir(dir)) return [];
	return readdirSync(dir)
		.sort()
		.filter((entry) => statDir(join(dir, entry)))
		.map((feature) => {
			const tickets = listTickets(repoRoot, feature);
			return {
				feature,
				tickets: tickets.length,
				open: tickets.filter((t) => !isClosed(t)).length,
				hasMap: existsSync(join(featureDir(repoRoot, feature), "map.md")),
				hasSpec: existsSync(join(featureDir(repoRoot, feature), "spec.md")),
			};
		});
}

export function listTickets(repoRoot: string, feature: string): Ticket[] {
	const dir = issuesDir(repoRoot, feature);
	if (!statDir(dir)) return [];
	return readdirSync(dir)
		.map((file) => ({ file, number: ticketNumberOf(file) }))
		.filter((entry): entry is { file: string; number: number } => entry.number !== undefined)
		.sort((a, b) => a.number - b.number)
		.map((entry) => parseTicket(join(dir, entry.file)));
}

/** Ticket number from an `NN-<slug>.md` file name, or undefined when the name
 * does not match the convention. One parse, no assertion operator. */
function ticketNumberOf(file: string): number | undefined {
	const match = NUM_FILE_RE.exec(file);
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function byIdOrTitle(tickets: Ticket[], token: string): Ticket | undefined {
	const raw = token.trim().replace(/^#*/, "");
	if (!raw) return undefined;
	if (/^\d+$/.test(raw)) {
		const wanted = Number(raw);
		const numeric = tickets.find((t) => /^\d+$/.test(t.id) && Number(t.id) === wanted);
		if (numeric) return numeric;
	}
	return tickets.find((t) => t.slug === raw.toLowerCase()) ?? tickets.find((t) => t.title.toLowerCase() === raw.toLowerCase());
}

/** Resolve one blocker token against every ticket: a RESOLVED blocker unblocks. */
function resolveBlocker(tickets: Ticket[], token: string): Ticket | undefined {
	return byIdOrTitle(tickets, token) ?? byIdOrTitle(tickets, token.replace(/^\d+-/, ""));
}

/** True when every blocker this ticket names is closed. A token that resolves to
 * nothing is conservative (stays blocked); one that does not resolve but splits
 * on `and` is retried part by part, so a blocker written as a title containing
 * `and` still unblocks instead of blocking the ticket forever. */
function allBlockersClosed(tickets: Ticket[], blockedBy: string[]): boolean {
	for (const token of blockedBy) {
		const target = resolveBlocker(tickets, token);
		if (target !== undefined) {
			if (!isClosed(target)) return false;
			continue;
		}
		const parts = token
			.split(/\band\b/i)
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length < 2) return false;
		for (const part of parts) {
			const partTarget = resolveBlocker(tickets, part);
			if (partTarget === undefined || !isClosed(partTarget)) return false;
		}
	}
	return true;
}

/** Open, unblocked, unclaimed — the wayfinder frontier (first by number wins, list order preserves that). */
export function frontierOf(tickets: Ticket[]): { takeable: Ticket[]; blocked: Ticket[] } {
	const open = tickets.filter((t) => !isClosed(t));
	const takeable = open.filter(
		(ticket) => ticket.status.toLowerCase() !== "claimed" && !ticket.assignee && allBlockersClosed(tickets, ticket.blockedBy),
	);
	return { takeable: takeable, blocked: open.filter((t) => !takeable.includes(t)) };
}

// ── mutations ────────────────────────────────────────────────────────────────

// `.scratch/` is a shared filesystem tracker: wayfinder explicitly expects
// parallel sessions working the same map (wayfinder/SKILL.md), so the writes
// below take a lock and replace files atomically instead of racing.

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 25;
/** Bounded retry for the read-number-then-create-ticket race. */
const TICKET_ALLOCATION_ATTEMPTS = 50;

/** Synchronous sleep; `Atomics.wait` is available on Node's main thread. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `action` while holding `<file>.lock`, so parallel sessions cannot
 * interleave a read-modify-write and silently drop one of the two updates.
 * A lock older than LOCK_STALE_MS is treated as abandoned by a crashed writer. */
export function withFileLock<T>(file: string, action: () => T): T {
	const lock = `${file}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A missing parent directory is a caller error, not lock contention:
			// say so instead of leaking a bare ENOENT.
			if (code === "ENOENT") throw new TrackerError(`cannot lock a path whose directory is missing: ${lock}`);
			if (code !== "EEXIST") throw error;
			let abandoned: boolean;
			try {
				abandoned = statSync(lock).mtimeMs < Date.now() - LOCK_STALE_MS;
			} catch {
				continue; // the holder released it between openSync and statSync
			}
			if (abandoned) {
				rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new TrackerError(`timed out waiting for the tracker lock: ${lock}`);
			sleepSync(LOCK_POLL_MS);
		}
	}
	try {
		return action();
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Replace a file by renaming a sibling temp file over it, so a concurrent
 * reader sees either the old or the new content, never a truncated file. */
function writeFileAtomic(file: string, content: string): void {
	const temp = `${file}.tmp`;
	writeFileSync(temp, content);
	renameSync(temp, file);
}

/** Read-modify-write a ticket under its own lock and return the reparsed result.
 * Reading inside the lock is what makes two parallel writers safe. */
function mutateTicket(repoRoot: string, feature: string, token: string, mutate: (ticket: Ticket) => string): Ticket {
	const target = findTicket(repoRoot, feature, token);
	return withFileLock(target.file, () => {
		writeFileAtomic(target.file, mutate(parseTicket(target.file)));
		return parseTicket(target.file);
	});
}

/** Escape a replacement string for String.replace's `$` patterns. */
function replacementSafe(text: string): string {
	return text.replace(/\$/g, "$$$$");
}

/** Insert `**Label:** value` after the H1, or rewrite the existing line. */
export function upsertFieldLine(text: string, label: string, value: string): string {
	const line = `**${label}:** ${value}`;
	const existing = new RegExp(`^\\*{0,2}${label}\\*{0,2}:[^\\n]*$`, "im");
	if (existing.test(text)) return text.replace(existing, replacementSafe(line));
	const h1 = /^#[^\n]*\n/.exec(text);
	if (h1) {
		const rest = text.slice(h1[0].length);
		return `${h1[0]}\n${line}\n${rest.replace(/^\n+/, "\n")}`;
	}
	return `${line}\n\n${text}`;
}

function assertFreshFeature(repoRoot: string, feature: string): void {
	if (!isFeatureSlug(feature)) throw new TrackerError(`invalid feature slug: ${feature}`);
	if (existsSync(featureDir(repoRoot, feature))) throw new TrackerError(`feature already exists: .scratch/${feature}`);
}

/** Validate the slug; required before any ticket/map write into a feature. */
function assertFeature(feature: string): void {
	if (!isFeatureSlug(feature)) throw new TrackerError(`invalid feature slug: ${feature}`);
}

/** Validate a wayfinder ticket type at the write, so a typo cannot publish a
 * `Type:` line (or `wayfinder:<typo>` label) nothing recognises. */
export function assertTicketType(ticketType: string | undefined): void {
	if (ticketType === undefined || ticketType === "") return;
	if (!(WAYFINDER_TYPES as readonly string[]).includes(ticketType)) {
		throw new TrackerError(`invalid ticket type ${JSON.stringify(ticketType)}: expected one of ${WAYFINDER_TYPES.join(", ")}`);
	}
}

/** Create a file only when it does not exist yet (`wx`), so two sessions racing
 * the same creation cannot clobber one file. */
function writeNewFile(file: string, content: string, label: string): void {
	try {
		writeFileSync(file, content, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TrackerError(`${label} already exists: ${file}`);
		throw error;
	}
}

/** Create `.scratch/<feature>/` (+ `issues/`, + `spec.md` when a spec body is given). */
export function createFeature(repoRoot: string, feature: string, spec?: string): string {
	assertFreshFeature(repoRoot, feature);
	mkdirSync(issuesDir(repoRoot, feature), { recursive: true });
	if (spec?.trim()) writeNewFile(join(featureDir(repoRoot, feature), "spec.md"), `${spec.trimEnd()}\n`, "spec");
	return featureDir(repoRoot, feature);
}

/** to-spec's "publish to the issue tracker": `.scratch/<feature>/spec.md`
 * (the feature directory is created when new; an existing spec is not
 * overwritten). */
export function createSpec(repoRoot: string, feature: string, title: string, body: string): string {
	assertFeature(feature);
	mkdirSync(issuesDir(repoRoot, feature), { recursive: true });
	const file = join(featureDir(repoRoot, feature), "spec.md");
	const text = /^#\s/.test(body.trim()) ? body.trim() : `# ${title}\n\n${body.trim()}`;
	writeNewFile(file, `${text}\n`, "spec");
	return file;
}

function nextTicketNumber(dir: string): number {
	let max = 0;
	if (statDir(dir)) {
		for (const file of readdirSync(dir)) {
			const number = ticketNumberOf(file);
			if (number !== undefined) max = Math.max(max, number);
		}
	}
	return max + 1;
}

/** Create a ticket file per the to-tickets local template (or, with a
 * wayfinder `ticketType`, the wayfinder child shape: a `Type:` line and the
 * question as the body). */
export function createTicket(
	repoRoot: string,
	feature: string,
	title: string,
	what: string,
	blockedBy: string[],
	status: string,
	ticketType?: string,
	criteria: string[] = [],
): Ticket {
	assertFeature(feature);
	assertTicketType(ticketType);
	const dir = issuesDir(repoRoot, feature);
	mkdirSync(dir, { recursive: true });
	// Number and file are allocated together: `wx` fails on a collision, and the
	// retry re-reads the directory instead of overwriting a parallel session's
	// ticket (two sessions previously both computed `01` and one won silently).
	for (let attempt = 0; attempt < TICKET_ALLOCATION_ATTEMPTS; attempt++) {
		const number = nextTicketNumber(dir);
		const file = join(dir, `${String(number).padStart(2, "0")}-${slugify(title)}.md`);
		try {
			writeFileSync(file, ticketBody(number, title, what, blockedBy, status, ticketType, criteria), { flag: "wx" });
			return parseTicket(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new TrackerError(`could not allocate a ticket number in ${dir} after ${TICKET_ALLOCATION_ATTEMPTS} attempts`);
}

/** Body of a new ticket at `number` (the number is part of the H1). */
function ticketBody(
	number: number,
	title: string,
	what: string,
	blockedBy: string[],
	status: string,
	ticketType?: string,
	criteria: string[] = [],
): string {
	const blocked = `**Blocked by:** ${blockedBy.length ? blockedBy.join(", ") : "None (can start immediately)"}`;
	return (
		ticketType
			? [
					`# ${number}: ${title}`,
					"",
					`**Type:** ${ticketType}`,
					"",
					blocked,
					"",
					`**Status:** ${status}`,
					"",
					"## Question",
					"",
					what || "(the question this ticket resolves)",
					"",
				]
			: [
					`# ${number}: ${title}`,
					"",
					`**What to build:** ${what || "(fill from the ticket's source: spec, wayfinder question, or triage note)"}`,
					"",
					blocked,
					"",
					`**Status:** ${status}`,
					"",
					...(criteria.length ? criteria.map((c) => `- [ ] ${c.trim()}`) : ["- [ ] (acceptance criteria — replace from the spec)"]),
					"",
				]
	).join("\n");
}

/** Create `.scratch/<effort>/map.md` — the wayfinder map skeleton. */
export function createMap(repoRoot: string, feature: string, destination: string, notes: string, fog: string, outOfScope: string): string {
	createFeature(repoRoot, feature);
	const file = join(featureDir(repoRoot, feature), "map.md");
	writeNewFile(
		file,
		[
			`# Map: ${feature}`,
			"",
			"Label: wayfinder:map",
			"",
			"## Destination",
			"",
			destination || "(what reaching the end of this map looks like: the spec, decision, or change this effort finds its way to)",
			"",
			"## Notes",
			"",
			notes || "(domain; skills every session should consult; standing preferences)",
			"",
			"## Decisions so far",
			"",
			"<!-- one line per resolved ticket: [title](issues/NN-slug.md): gist of the answer -->",
			"",
			"## Not yet specified",
			"",
			fog || "(in-scope fog you cannot ticket yet)",
			"",
			"## Out of scope",
			"",
			outOfScope || "(work consciously ruled out of this effort)",
			"",
		].join("\n"),
		"map",
	);
	return file;
}

export function findTicket(repoRoot: string, feature: string, token: string): Ticket {
	// Every read and every write-by-token funnels through here, so this is the
	// choke point: an unvalidated slug would `join` straight out of `.scratch/`.
	assertFeature(feature);
	const tickets = listTickets(repoRoot, feature);
	const found = byIdOrTitle(tickets, token);
	if (!found) throw new TrackerError(`no ticket matching ${JSON.stringify(token)} in .scratch/${feature}/issues/`);
	return found;
}

/** Create or replace a `**Label:** value` line in a ticket (Status / Blocked by / Type). */
export function setTicketField(repoRoot: string, feature: string, token: string, label: string, value: string): Ticket {
	return mutateTicket(repoRoot, feature, token, (ticket) => upsertFieldLine(ticket.raw, label, value));
}

/** Rewrite the H1, keeping a leading `NN: ` number so the title stays bound to
 * its file. */
function upsertTitle(text: string, title: string): string {
	const h1 = /^#\s+[^\n]*$/m.exec(text);
	if (!h1) return `# ${title}\n\n${text}`;
	const number = /^#\s+(\d+):/.exec(h1[0])?.[1];
	// replacementSafe: a title containing `$&`/`$1` would otherwise be read as a
	// replacement pattern by String.replace
	return text.replace(h1[0], replacementSafe(number === undefined ? `# ${title}` : `# ${number}: ${title}`));
}

/** Replace a `## Heading` section's prose (up to the next `## ` heading), or the
 * text unchanged when the section is absent. */
export function replaceSection(text: string, heading: string, content: string): string {
	const found = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(text);
	if (!found) return text;
	const start = found.index + found[0].length;
	const next = text.slice(start).search(/^##\s/m);
	const end = next === -1 ? text.length : start + next;
	const tail = text.slice(end).replace(/^\n+/, "");
	return `${text.slice(0, start).trimEnd()}\n\n${content}\n${tail ? `\n${tail}` : ""}`;
}

/** Replace a ticket's body prose in either backend's shape: the `## Question`
 * section (wayfinder), a `## What to build` section (GitHub), or this backend's
 * `**What to build:**` field line. Appends a section when none is present. */
export function replaceTicketBody(text: string, what: string): string {
	if (/^##\s+Question\s*$/m.test(text)) return replaceSection(text, "Question", what);
	if (/^##\s+What to build\s*$/m.test(text)) return replaceSection(text, "What to build", what);
	if (/^\*{0,2}What to build\*{0,2}:/m.test(text)) return upsertFieldLine(text, "What to build", what);
	return `${text.trimEnd()}\n\n## What to build\n\n${what}\n`;
}

/** Edit a ticket's title and/or body in place, leaving its field lines alone. */
export function updateTicket(repoRoot: string, feature: string, token: string, title?: string, what?: string): Ticket {
	return mutateTicket(repoRoot, feature, token, (ticket) => {
		let text = ticket.raw;
		if (title?.trim()) text = upsertTitle(text, title.trim());
		if (what?.trim()) text = replaceTicketBody(text, what.trim());
		return text;
	});
}

/** Append the answer under `## Answer` and set `Status: resolved`. */
export function resolveTicket(repoRoot: string, feature: string, token: string, answer: string, gist?: string): Ticket {
	const updated = mutateTicket(repoRoot, feature, token, (ticket) =>
		upsertFieldLine(`${ticket.raw.trimEnd()}\n\n## Answer\n\n${answer.trim()}\n`, "Status", "resolved"),
	);
	if (gist?.trim() && existsSync(join(featureDir(repoRoot, feature), "map.md"))) {
		appendMapDecision(repoRoot, feature, `[${updated.title}](issues/${basename(updated.file)}): ${gist.trim()}`);
	}
	return updated;
}

/** Mark the Nth (1-based) unchecked acceptance criterion as done. */
export function tickCriterion(repoRoot: string, feature: string, token: string, index: number): Ticket {
	return mutateTicket(repoRoot, feature, token, (ticket) => {
		let seen = 0;
		let hit = false;
		const text = ticket.raw.replace(/- \[ \]/g, (match) => {
			seen += 1;
			if (seen === index) {
				hit = true;
				return "- [x]";
			}
			return match;
		});
		if (!hit) throw new TrackerError(`no unchecked criterion #${index} in ${ticket.file} (found ${seen})`);
		return text;
	});
}

/** Append a section (`## Comments` and friends) at the end of a ticket's body,
 * extending the existing section when one is already there. */
export function appendTicketSection(repoRoot: string, feature: string, token: string, heading: string, content: string): Ticket {
	return mutateTicket(repoRoot, feature, token, (ticket) => appendBlockUnderHeading(ticket.raw, heading, content));
}

/** Append a bullet to a section of the map (`Decisions so far`, `Out of scope`,
 * `Not yet specified`), creating the section when it is absent. Held under the
 * map's lock because parallel wayfinder sessions append to one file. */
export function appendMapLine(repoRoot: string, feature: string, heading: string, line: string): void {
	assertFeature(feature);
	const file = join(featureDir(repoRoot, feature), "map.md");
	// fast path so a missing map is a clear error, plus the in-lock recheck for
	// the race where another session removes it between the two
	if (!existsSync(file)) throw new TrackerError(`map file missing: ${file}`);
	withFileLock(file, () => {
		if (!existsSync(file)) throw new TrackerError(`map file missing: ${file}`);
		writeFileAtomic(file, appendUnderHeading(readFileSync(file, "utf8"), heading, line));
	});
}

/** Append a decision-context pointer to the map's Decisions-so-far list. */
export function appendMapDecision(repoRoot: string, feature: string, line: string): void {
	appendMapLine(repoRoot, feature, "Decisions so far", line);
}

/** wayfinder: rule a ticket out of scope — close it (`Status: out-of-scope`,
 * the reason under `## Out of scope`) and gist it into the map's Out-of-scope
 * section, never into Decisions-so-far. */
export function outOfScopeTicket(repoRoot: string, feature: string, token: string, reason: string, gist?: string): Ticket {
	const updated = mutateTicket(repoRoot, feature, token, (ticket) =>
		upsertFieldLine(`${ticket.raw.trimEnd()}\n\n## Out of scope\n\n${reason.trim()}\n`, "Status", "out-of-scope"),
	);
	if (existsSync(join(featureDir(repoRoot, feature), "map.md"))) {
		appendMapLine(repoRoot, feature, "Out of scope", `[${updated.title}](issues/${basename(updated.file)}): ${(gist ?? reason).trim()}`);
	}
	return updated;
}
