import { relative } from "node:path";
import {
	CATEGORY_ROLES,
	TrackerError,
	appendTicketSection,
	createMap,
	createSpec,
	createTicket,
	findTicket,
	listFeatures,
	listTickets,
	outOfScopeTicket,
	resolveTicket,
	setTicketField,
	tickCriterion,
} from "./tracker.js";
import {
	ghBlockOp,
	ghClaimOp,
	ghCommentOp,
	ghCreateMapOp,
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
} from "./github.js";
import { renderFeatures, renderFrontier, renderTicket, renderTicketList } from "./render.js";
import type { TrackerParams } from "./params.js";

const UNBLOCKED = "None (can start immediately)";

type TextField = "title" | "ticket" | "answer" | "status" | "what" | "gist";

function req(params: TrackerParams, field: TextField): string {
	const value = params[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new TrackerError(`"${params.op}" requires ${JSON.stringify(field)}`);
	}
	return value.trim();
}

function reqFeature(params: TrackerParams): string {
	const feature = params.feature?.trim();
	if (!feature) throw new TrackerError(`"${params.op}" requires "feature"`);
	return feature;
}

function rel(root: string, path: string): string {
	return relative(root, path).split("\\").join("/");
}

function ticket(params: TrackerParams, root: string) {
	return findTicket(root, reqFeature(params), req(params, "ticket"));
}

function withId(ticket: { id: string; file: string }, root: string): string {
	return `${rel(root, ticket.file)}`;
}

/** Dispatch one `tracker` tool call; returns markdown for the model. */
export function runOp(root: string, params: TrackerParams): string {
	switch (params.op) {
		case "list": {
			// no feature: the feature table; with one: every ticket of it (closed included), optionally filtered by status
			if (!params.feature?.trim()) return renderFeatures(listFeatures(root));
			const feature = reqFeature(params);
			const tickets = listTickets(root, feature).filter((t) => !params.status || t.status === params.status.trim().toLowerCase());
			return renderTicketList(feature, tickets);
		}

		case "frontier":
			return renderFrontier(listTickets(root, reqFeature(params)));

		case "show":
			return renderTicket(ticket(params, root));

		case "create-spec": {
			const file = createSpec(root, reqFeature(params), req(params, "title"), req(params, "what"));
			return `Spec published: ${rel(root, file)} — tickets go beside it under issues/.`;
		}

		case "create-ticket": {
			const ticket = createTicket(
				root,
				reqFeature(params),
				req(params, "title"),
				params.what ?? "",
				params.blockedBy ?? [],
				params.status ?? "ready-for-agent",
				params.type,
				params.criteria ?? [],
			);
			return `Created ${rel(root, ticket.file)}\n\n${renderTicket(ticket)}`;
		}

		case "create-map": {
			const file = createMap(root, reqFeature(params), params.destination ?? "", params.what ?? "", params.notes ?? "", "");
			return `Map written: ${rel(root, file)}`;
		}

		case "out-of-scope": {
			const updated = outOfScopeTicket(root, reqFeature(params), req(params, "ticket"), req(params, "answer"), params.gist);
			return `Ruled out of scope ${rel(root, updated.file)} (map Out-of-scope updated when a map exists):\n\n${renderTicket(updated)}`;
		}

		case "claim": {
			const updated = setTicketField(root, reqFeature(params), req(params, "ticket"), "Status", "claimed");
			return `Claimed (set this before any work):\n\n${renderTicket(updated)}`;
		}

		case "resolve": {
			const updated = resolveTicket(
				root,
				reqFeature(params),
				req(params, "ticket"),
				req(params, "answer"),
				params.gist,
			);
			return `Resolved ${rel(root, updated.file)}${params.gist ? " (map Decisions-so-far updated)" : ""}:\n\n${renderTicket(updated)}`;
		}

		case "tick": {
			const index = params.index;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
				throw new TrackerError('"tick" requires a 1-based numeric "index"');
			}
			const updated = tickCriterion(root, reqFeature(params), req(params, "ticket"), index);
			return `Ticked criterion ${index}:\n\n${renderTicket(updated)}`;
		}

		case "status": {
			// triage's category roles live on their own line so a state change never clobbers them
			const value = req(params, "status");
			const label = (CATEGORY_ROLES as readonly string[]).includes(value.toLowerCase()) ? "Category" : "Status";
			const updated = setTicketField(root, reqFeature(params), req(params, "ticket"), label, value);
			return `Updated ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		case "block": {
			const blockers = params.blockedBy ?? [];
			const updated = setTicketField(
				root,
				reqFeature(params),
				req(params, "ticket"),
				"Blocked by",
				blockers.length ? blockers.join(", ") : UNBLOCKED,
			);
			return `Updated ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		case "comment": {
			const updated = appendTicketSection(
				root,
				reqFeature(params),
				req(params, "ticket"),
				"Comments",
				req(params, "what"),
			);
			return `Commented on ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		// ── GitHub backend (gh CLI; tickets are issues, docs/agents/issue-tracker.md configures which backend is in play)

		case "gh-list":
			return ghListOp(root, params);

		case "gh-frontier":
			return ghFrontierOp(root, params);

		case "gh-triage":
			return ghTriageOp(root, params);

		case "gh-show":
			return ghShowOp(root, params);

		case "gh-create-spec":
			return ghCreateSpecOp(root, params);

		case "gh-create-ticket":
			return ghCreateTicketOp(root, params);

		case "gh-create-map":
			return ghCreateMapOp(root, params);

		case "gh-claim":
			return ghClaimOp(root, params);

		case "gh-resolve":
			return ghResolveOp(root, params);

		case "gh-out-of-scope":
			return ghOutOfScopeOp(root, params);

		case "gh-comment":
			return ghCommentOp(root, params);

		case "gh-status":
			return ghStatusOp(root, params);

		case "gh-block":
			return ghBlockOp(root, params);

		case "gh-tick":
			return ghTickOp(root, params);

		default:
			throw new TrackerError(`unsupported op ${JSON.stringify((params as { op?: string }).op)}`);
	}
}

/** The wayfinder frontier of every feature at once — used by the /frontier command. */
export function runAllFrontiers(root: string): string {
	const summaries = listFeatures(root);
	if (summaries.length === 0) return "No features tracked (.scratch/ is empty or missing).";
	return summaries
		.map((summary) => `## .scratch/${summary.feature}\n\n${renderFrontier(listTickets(root, summary.feature))}`)
		.join("\n\n");
}