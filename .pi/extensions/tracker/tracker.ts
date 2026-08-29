import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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

export const CLOSED_STATUSES = new Set(["resolved", "done", "wontfix"]);
export const TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;

const NUM_FILE_RE = /^(\d+)-(.+)\.md$/;

/** `**Label:** value` (or `Label: value`) line value, with bold markers stripped.
 * Shared with the GitHub backend: issue bodies carry the same field lines. */
export function labelValue(text: string, label: string): string {
	const line = new RegExp("^\\*{0,2}" + label + "\\*{0,2}:[^\\n]*$", "im").exec(text)?.[0];
	if (!line) return "";
	return line.slice(line.indexOf(":") + 1).replace(/^[ \t]*\*+/, "").replace(/\*+$/, "").trim();
}

export class TrackerError extends Error {}

export function isFeatureSlug(feature: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(feature) && !feature.includes("..");
}

export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "unslugged"
	);
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
	ticketType: string;
	blockedBy: string[];
	totalChecklist: number;
	doneChecklist: number;
	raw: string;
}

export function parseTicket(file: string): Ticket {
	const raw = readFileSync(file, "utf8");
	const name = basename(file);
	const numbered = NUM_FILE_RE.exec(name);
	const id = numbered ? numbered[1] : name.replace(/\.md$/, "");
	const slug = numbered ? numbered[2] : name.replace(/\.md$/, "");
	const h1 = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
	const blockedRaw = labelValue(raw, "Blocked by");
	return {
		id,
		slug,
		title: h1.replace(/^\d+:\s*/, "") || id,
		file,
		assignee: labelValue(raw, "Assign(?:ee|ed to)"),
		status: (labelValue(raw, "Status").match(/[a-z-]+/i)?.[0] ?? "").toLowerCase(),
		ticketType: labelValue(raw, "Type").toLowerCase(),
		blockedBy: !blockedRaw || /^none\b/i.test(blockedRaw.trim())
			? []
			: blockedRaw
					.split(/,|\band\b/i)
					.map((part) => part.trim().replace(/^#*/, ""))
					.filter(Boolean),
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
		.filter((file) => NUM_FILE_RE.test(file))
		.sort((a, b) => Number(NUM_FILE_RE.exec(a)![1]) - Number(NUM_FILE_RE.exec(b)![1]))
		.map((file) => parseTicket(join(dir, file)));
}

export function byIdOrTitle(tickets: Ticket[], token: string): Ticket | undefined {
	const raw = token.trim().replace(/^#*/, "");
	if (!raw) return undefined;
	if (/^\d+$/.test(raw)) {
		const wanted = Number(raw);
		const numeric = tickets.find((t) => /^\d+$/.test(t.id) && Number(t.id) === wanted);
		if (numeric) return numeric;
	}
	const slug = raw.toLowerCase();
	return (
		tickets.find((t) => t.slug === raw.toLowerCase()) ??
		tickets.find((t) => t.title.toLowerCase() === raw.toLowerCase())
	);
}

/** Open, unblocked, unclaimed — the wayfinder frontier (first by number wins, list order preserves that). */
export function frontierOf(tickets: Ticket[]): { takeable: Ticket[]; blocked: Ticket[] } {
	const open = tickets.filter((t) => !isClosed(t));
	const takeable = open.filter((ticket) => {
		if (ticket.status.toLowerCase() === "claimed" || ticket.assignee) return false;
		for (const token of ticket.blockedBy) {
			// blockers resolve against every ticket: a RESOLVED blocker unblocks
			const target = byIdOrTitle(tickets, token) ?? byIdOrTitle(tickets, token.replace(/^\d+-/, ""));
			if (!target) return false; // unknown or self-referential blocker: conservative
			if (!isClosed(target)) return false;
			if (target.id === ticket.id) return false; // self-blocked
			if (target === ticket) return false; // self-blocked
		}
		return true;
	});
	return { takeable: takeable, blocked: open.filter((t) => !takeable.includes(t)) };
}

// ── mutations ────────────────────────────────────────────────────────────────

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
function assertFeature(repoRoot: string, feature: string): void {
	if (!isFeatureSlug(feature)) throw new TrackerError(`invalid feature slug: ${feature}`);
}

/** Create `.scratch/<feature>/` (+ `issues/`, + `spec.md` when a spec body is given). */
export function createFeature(repoRoot: string, feature: string, spec?: string): string {
	assertFreshFeature(repoRoot, feature);
	mkdirSync(issuesDir(repoRoot, feature), { recursive: true });
	if (spec !== undefined && spec.trim()) writeFileSync(join(featureDir(repoRoot, feature), "spec.md"), `${spec.trimEnd()}\n`);
	return featureDir(repoRoot, feature);
}

function nextTicketNumber(repoRoot: string, feature: string): number {
	const dir = issuesDir(repoRoot, feature);
	let max = 0;
	if (statDir(dir)) {
		for (const file of readdirSync(dir)) {
			const m = NUM_FILE_RE.exec(file);
			if (m) max = Math.max(max, Number(m[1]));
		}
	}
	return max + 1;
}

/** Create a ticket file per the to-tickets local template. */
export function createTicket(
	repoRoot: string,
	feature: string,
	title: string,
	what: string,
	blockedBy: string[],
	status: string,
	ticketType?: string,
): Ticket {
	assertFeature(repoRoot, feature);
	const dir = issuesDir(repoRoot, feature);
	mkdirSync(dir, { recursive: true });
	const number = nextTicketNumber(repoRoot, feature);
	const file = join(dir, `${String(number).padStart(2, "0")}-${slugify(title)}.md`);
	if (existsSync(file)) throw new TrackerError(`ticket file already exists: ${file}`);
	const body = [
		`# ${number}: ${title}`,
		"",
		`**What to build:** ${what || "(fill from the ticket's source: spec, wayfinder question, or triage note)"}`,
		"",
		`**Blocked by:** ${blockedBy.length ? blockedBy.join(", ") : "None (can start immediately)"}`,
		"",
		`**Status:** ${status}`,
		...(ticketType ? ["", `Type: ${ticketType}`, ""] : [""]),
		"- [ ] (acceptance criteria — replace from the spec)",
		"",
	].join("\n");
	writeFileSync(file, body);
	return parseTicket(file);
}

/** Create `.scratch/<effort>/map.md` — the wayfinder map skeleton. */
export function createMap(
	repoRoot: string,
	feature: string,
	destination: string,
	notes: string,
	fog: string,
	outOfScope: string,
): string {
	createFeature(repoRoot, feature);
	const file = join(featureDir(repoRoot, feature), "map.md");
	if (existsSync(file)) throw new TrackerError(`map already exists: ${file}`);
	writeFileSync(
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
	);
	return file;
}

export function findTicket(repoRoot: string, feature: string, token: string): Ticket {
	const tickets = listTickets(repoRoot, feature);
	const found = byIdOrTitle(tickets, token);
	if (!found) throw new TrackerError(`no ticket matching ${JSON.stringify(token)} in .scratch/${feature}/issues/`);
	return found;
}

function saveTicket(ticket: Ticket, text: string): Ticket {
	writeFileSync(ticket.file, text);
	return parseTicket(ticket.file);
}

/** Create or replace a `**Label:** value` line in a ticket (Status / Blocked by / Type). */
export function setTicketField(
	repoRoot: string,
	feature: string,
	token: string,
	label: string,
	value: string,
): Ticket {
	const ticket = findTicket(repoRoot, feature, token);
	return saveTicket(ticket, upsertFieldLine(ticket.raw, label, value));
}

/** Append the answer under `## Answer` and set `Status: resolved`. */
export function resolveTicket(
	repoRoot: string,
	feature: string,
	token: string,
	answer: string,
	gist?: string,
): Ticket {
	const ticket = findTicket(repoRoot, feature, token);
	const text = `${ticket.raw.trimEnd()}\n\n## Answer\n\n${answer.trim()}\n`;
	saveTicket(ticket, upsertFieldLine(text, "Status", "resolved"));
	if (gist?.trim() && existsSync(join(featureDir(repoRoot, feature), "map.md"))) {
		appendMapDecision(repoRoot, feature, `[${ticket.title}](issues/${basename(ticket.file)}): ${gist.trim()}`);
	}
	return parseTicket(ticket.file);
}

/** Mark the Nth (1-based) unchecked acceptance criterion as done. */
export function tickCriterion(repoRoot: string, feature: string, token: string, index: number): Ticket {
	const ticket = findTicket(repoRoot, feature, token);
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
	return saveTicket(ticket, text);
}

/** Append a section (`## Comments` and friends) at the end of a ticket. */
export function appendTicketSection(
	repoRoot: string,
	feature: string,
	token: string,
	heading: string,
	content: string,
): Ticket {
	const ticket = findTicket(repoRoot, feature, token);
	const text = `${ticket.raw.trimEnd()}\n\n## ${heading}\n\n${content.trim()}\n`;
	return saveTicket(ticket, text);
}

/** Append a decision-context pointer to the map's Decisions-so-far list. */
export function appendMapDecision(repoRoot: string, feature: string, line: string): void {
	const file = join(featureDir(repoRoot, feature), "map.md");
	if (!existsSync(file)) throw new TrackerError(`map file missing: ${file}`);
	const text = readFileSync(file, "utf8");
	const heading = "## Decisions so far";
	const start = text.indexOf(heading);
	if (start === -1) throw new TrackerError(`map file has no ${heading} section: ${file}`);
	const afterHead = start + heading.length;
	const nextHeading = text.indexOf("\n## ", afterHead);
	const insertAt = nextHeading === -1 ? text.length : nextHeading;
	writeFileSync(file, `${text.slice(0, insertAt).trimEnd()}\n\n- ${line.trim()}\n${text.slice(insertAt).replace(/^\n+/, "\n")}`);
}