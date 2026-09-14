import { Optional, Type } from "typebox";

export const TRACKER_OPS = [
	// local `.scratch/` tracker
	"list",
	"frontier",
	"show",
	"create-spec",
	"create-ticket",
	"create-map",
	"claim",
	"resolve",
	"out-of-scope",
	"tick",
	"status",
	"block",
	"comment",
	// GitHub Issues backend (gh CLI)
	"gh-list",
	"gh-frontier",
	"gh-triage",
	"gh-show",
	"gh-create-spec",
	"gh-create-ticket",
	"gh-create-map",
	"gh-claim",
	"gh-resolve",
	"gh-out-of-scope",
	"gh-comment",
	"gh-status",
	"gh-block",
	"gh-tick",
] as const;

export type TrackerOp = (typeof TRACKER_OPS)[number];

export interface TrackerParams {
	op: TrackerOp;
	feature?: string;
	ticket?: string;
	title?: string;
	what?: string;
	answer?: string;
	gist?: string;
	blockedBy?: string[];
	parent?: string;
	status?: string;
	type?: string;
	criteria?: string[];
	index?: number;
	destination?: string;
	notes?: string;
}

/** Wayfinder ticket types (issue-tracker-local.md / -github.md: `Type:` line or `wayfinder:<type>` label). */
export const WAYFINDER_TYPES = ["research", "prototype", "grilling", "task"] as const;

export const trackerSchema = Type.Object({
	op: Type.Union(
		TRACKER_OPS.map((op) => Type.Literal(op)),
		{ description: "Tracker operation." },
	),
	feature: Optional(Type.String({ description: "Feature/effort slug under .scratch/ (local ops)." })),
	ticket: Optional(Type.String({ description: "Ticket id (1 or 01), file slug, or exact title; GitHub: the issue number." })),
	title: Optional(Type.String({ description: "Title (create-spec, create-ticket, create-map)." })),
	what: Optional(
		Type.String({
			description:
				"Body text: spec body (create-spec), what-to-build or the wayfinder question (create-ticket), map Notes (create-map), comment body (comment).",
		}),
	),
	answer: Optional(Type.String({ description: "Resolution answer (resolve) or the reason (out-of-scope)." })),
	gist: Optional(
		Type.String({ description: "One-line gist appended to the map's Decisions-so-far (resolve) or Out-of-scope (out-of-scope)." }),
	),
	blockedBy: Optional(Type.Array(Type.String(), { description: "Blocker ids or titles (create-ticket, block); GitHub: issue numbers." })),
	parent: Optional(
		Type.String({
			description:
				"GitHub parent issue number: the spec issue for to-tickets, the map issue for wayfinder children (gh-create-ticket → sub-issue + Part of line; gh-frontier → scope to that parent's children).",
		}),
	),
	criteria: Optional(Type.Array(Type.String(), { description: "Acceptance criteria, one per entry (create-ticket → `- [ ]` list)." })),
	status: Optional(
		Type.String({
			description:
				"Status value: triage role (needs-triage…wontfix) or wayfinder's claimed/resolved. On list/gh-list: filter by this status/label.",
		}),
	),
	type: Optional(
		Type.Union(
			WAYFINDER_TYPES.map((t) => Type.Literal(t)),
			{ description: "Wayfinder ticket type (create-ticket): local `Type:` line / GitHub `wayfinder:<type>` label." },
		),
	),
	index: Optional(Type.Number({ description: "1-based acceptance-criterion index (tick)." })),
	destination: Optional(Type.String({ description: "Map destination (create-map)." })),
	notes: Optional(Type.String({ description: "Map 'Not yet specified' fog at charting time (create-map)." })),
});