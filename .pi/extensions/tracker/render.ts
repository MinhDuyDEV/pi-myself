import { frontierOf, type FeatureSummary, type Ticket } from "./tracker.js";

export function renderTicket(t: Ticket): string {
	const meta = [
		`Status: ${t.status || "(none)"}`,
		t.ticketType ? `Type: ${t.ticketType}` : undefined,
		t.assignee ? `assignee: ${t.assignee}` : undefined,
		`Blocked by: ${t.blockedBy.length ? t.blockedBy.join(", ") : "none"}`,
		`Criteria: ${t.doneChecklist}/${t.totalChecklist} done`,
	]
		.filter((line) => line !== undefined)
		.join(" · ");
	return [`**${t.id}** — ${t.title}`, meta, "", t.raw.trim()].join("\n");
}

export function renderFeatures(summaries: FeatureSummary[]): string {
	if (summaries.length === 0) return "No features tracked (.scratch/ is empty or missing).";
	const lines = ["## Features", "", "feature | tickets (open) | spec | map", "--- | --- | --- | ---"];
	for (const s of summaries) {
		lines.push(`.scratch/${s.feature} | ${s.tickets} (${s.open}) | ${s.hasSpec ? "spec.md" : "-"} | ${s.hasMap ? "map.md" : "-"}`);
	}
	return lines.join("\n");
}

export function renderFrontier(tickets: Ticket[]): string {
	const { takeable, blocked } = frontierOf(tickets);
	if (tickets.length === 0) return "No tickets.";
	const takeableLines = takeable.length
		? takeable.map((t) => `- ${t.id} — ${t.title}${t.ticketType ? ` [${t.ticketType}]` : ""} · ${t.doneChecklist}/${t.totalChecklist} criteria done`)
		: ["(nothing takeable — blocked or claimed below)"];
	const blockedLines = blocked.length
		? blocked.map((t) =>
				t.blockedBy.length
					? `  ${t.id} — ${t.title} (waiting on ${t.blockedBy.join(", ")})`
					: `  ${t.id} — ${t.title} [${t.status || "claimed"}]`,
			)
		: ["  (none)"];
	return [
		"## Frontier — takeable now (first by number wins)",
		...takeableLines,
		"",
		"## Open but blocked or claimed",
		...blockedLines,
	].join("\n");
}