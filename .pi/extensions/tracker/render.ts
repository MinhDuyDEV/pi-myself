import { blockerStateOf, type FeatureSummary, frontierOf, type Ticket } from "./tracker.js";

export function renderTicket(t: Ticket): string {
	const meta = [
		`Status: ${t.status || "(none)"}`,
		t.category ? `Category: ${t.category}` : undefined,
		t.ticketType ? `Type: ${t.ticketType}` : undefined,
		t.assignee ? `assignee: ${t.assignee}` : undefined,
		`Blocked by: ${t.blockedBy.length ? t.blockedBy.join(", ") : "none"}`,
		`Criteria: ${t.doneChecklist}/${t.totalChecklist} done`,
	]
		.filter((line) => line !== undefined)
		.join(" · ");
	return [`**${t.id}** — ${t.title}`, meta, "", t.raw.trim()].join("\n");
}

/** Every ticket of a feature, closed ones included — the read behind "what happened to X?". */
export function renderTicketList(feature: string, tickets: Ticket[]): string {
	if (tickets.length === 0) return `No tickets in .scratch/${feature}/issues/.`;
	const lines = [
		`## .scratch/${feature} — ${tickets.length} tickets`,
		"",
		"id | title | status | category | type | blocked by | criteria",
		"--- | --- | --- | --- | --- | --- | ---",
	];
	for (const t of tickets) {
		lines.push(
			`${t.id} | ${t.title} | ${t.status || "-"} | ${t.category || "-"} | ${t.ticketType || "-"} | ${t.blockedBy.join(", ") || "-"} | ${t.doneChecklist}/${t.totalChecklist}`,
		);
	}
	return lines.join("\n");
}

export function renderFeatures(summaries: FeatureSummary[]): string {
	if (summaries.length === 0) return "No features tracked (.scratch/ is empty or missing).";
	const lines = ["## Features", "", "feature | tickets (open) | spec | map", "--- | --- | --- | ---"];
	for (const s of summaries) {
		lines.push(`.scratch/${s.feature} | ${s.tickets} (${s.open}) | ${s.hasSpec ? "spec.md" : "-"} | ${s.hasMap ? "map.md" : "-"}`);
	}
	return lines.join("\n");
}

/** The frontier readout. A blocked line names only the blockers still open; a
 * ticket held by a claim (or a not-ready role) shows that instead. Blocker
 * tokens that name no ticket gate nothing and are disclosed, the way
 * gh-frontier discloses an unresolvable ref. */
export function renderFrontier(tickets: Ticket[]): string {
	const { takeable, blocked } = frontierOf(tickets);
	if (tickets.length === 0) return "No tickets.";
	const unreadOf = (t: Ticket): string[] => blockerStateOf(tickets, t).unresolved;
	const takeableLines = takeable.length
		? takeable.map(
				(t) => `- ${t.id} — ${t.title}${t.ticketType ? ` [${t.ticketType}]` : ""} · ${t.doneChecklist}/${t.totalChecklist} criteria done`,
			)
		: ["(nothing takeable — blocked or claimed below)"];
	const blockedLines = blocked.length
		? blocked.map((t) => {
				const open = blockerStateOf(tickets, t).open;
				const unread = unreadOf(t);
				const hold = t.assignee ? `assignee: ${t.assignee}` : t.status || "claimed";
				const reason = open.length ? `(waiting on ${open.join(", ")})` : `[${hold}]`;
				return `  ${t.id} — ${t.title} ${reason}${unread.length ? ` · also names ${unread.join(", ")}, not gating` : ""}`;
			})
		: ["  (none)"];
	const misdirected = takeable.filter((t) => unreadOf(t).length > 0);
	return [
		"## Frontier — takeable now (first by number wins)",
		...takeableLines,
		"",
		"## Open but blocked or claimed",
		...blockedLines,
		...(misdirected.length
			? [
					"",
					`_(not gating: ${misdirected.map((t) => `${t.id} names ${unreadOf(t).join(", ")}`).join("; ")} — no ticket of this feature matches, so fix the Blocked by line with "block")_`,
				]
			: []),
	].join("\n");
}
