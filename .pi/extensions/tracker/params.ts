import { Optional, Type } from "typebox";

export const TRACKER_OPS = [
	// local `.scratch/` tracker
	"list",
	"frontier",
	"show",
	"create-ticket",
	"create-map",
	"claim",
	"resolve",
	"tick",
	"status",
	"block",
	"comment",
	// GitHub Issues backend (gh CLI)
	"gh-list",
	"gh-frontier",
	"gh-show",
	"gh-create-ticket",
	"gh-create-map",
	"gh-claim",
	"gh-resolve",
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
	index?: number;
	destination?: string;
	notes?: string;
}

export const trackerSchema = Type.Object({
	op: Type.Union(
		TRACKER_OPS.map((op) => Type.Literal(op)),
		{ description: "Tracker operation." },
	),
	feature: Optional(Type.String({ description: "Feature/effort slug under .scratch/." })),
	ticket: Optional(Type.String({ description: "Ticket id (1 or 01), file slug, or exact title." })),
	title: Optional(Type.String({ description: "New ticket title (create-ticket)." })),
	what: Optional(
		Type.String({ description: "What-to-build body (create-ticket), map notes (create-map), or comment body (comment)." }),
	),
	answer: Optional(Type.String({ description: "Resolution answer written under ## Answer (resolve)." })),
	gist: Optional(
		Type.String({ description: "One-line gist appended to the map's Decisions-so-far on resolve." }),
	),
	blockedBy: Optional(Type.Array(Type.String(), { description: "Blocker ids or titles (create-ticket, block)." })),
	parent: Optional(
		Type.String({ description: "Parent issue number/URL when a feature has a tracked parent (gh-create-ticket, wayfinder children → the map issue)." }),
	),
	status: Optional(
		Type.String({ description: "Status value: triage role (needs-triage…wontfix) or wayfinder's claimed/resolved." }),
	),
	index: Optional(Type.Number({ description: "1-based acceptance-criterion index (tick)." })),
	destination: Optional(Type.String({ description: "Map destination (create-map)." })),
});