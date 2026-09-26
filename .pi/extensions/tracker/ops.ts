import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
	ghBlockOp,
	ghClaimOp,
	ghCommentOp,
	ghCreateMapOp,
	ghCreateSpecOp,
	ghCreateTicketOp,
	ghEditOp,
	ghFrontierOp,
	ghListOp,
	ghMapNoteOp,
	ghOutOfScopeOp,
	ghResolveOp,
	ghShowOp,
	ghStatusOp,
	ghTickOp,
	ghTriageOp,
} from "./github.js";
import { TRACKER_OPS, type TrackerParams } from "./params.js";
import { renderFeatures, renderFrontier, renderTicket, renderTicketList } from "./render.js";
import {
	appendMapLine,
	appendTicketSection,
	assertBlockersExist,
	assertSection,
	CATEGORY_ROLES,
	canonicalRole,
	claimTicket,
	createMap,
	createSpec,
	createTicket,
	featureDir,
	findTicket,
	isClosed,
	isFeatureSlug,
	listFeatures,
	listTickets,
	outOfScopeTicket,
	resolveTicket,
	setTicketField,
	TrackerError,
	tickCriterion,
	updateTicket,
} from "./tracker.js";

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
	// `list`/`frontier` reach the directory without going through findTicket.
	if (!isFeatureSlug(feature)) throw new TrackerError(`invalid feature slug: ${feature}`);
	return feature;
}

function rel(root: string, path: string): string {
	return relative(root, path).split("\\").join("/");
}

function ticket(params: TrackerParams, root: string) {
	return findTicket(root, reqFeature(params), req(params, "ticket"));
}

const BACKEND_DOC = "docs/agents/issue-tracker.md";

/** The backend `docs/agents/issue-tracker.md` names in its H1 (`# Issue
 * tracker: GitHub` / `Local Markdown` / `GitLab`, as setup-matt-pocock-skills
 * writes it), or undefined when the file is absent (no restriction). */
function configuredBackend(root: string): { kind: "github" | "local" | "other"; name: string } | undefined {
	let text: string;
	try {
		text = readFileSync(join(root, ...BACKEND_DOC.split("/")), "utf8");
	} catch {
		return undefined;
	}
	const h1 = /^#[ \t]+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
	const name = h1.replace(/^issue tracker\s*:\s*/i, "").trim();
	if (/^github\b/i.test(name)) return { kind: "github", name };
	if (/^local\b/i.test(name)) return { kind: "local", name };
	return { kind: "other", name: name || "no backend in its H1" };
}

/** Refuse the op family the repo is not configured for: local ops in a GitHub
 * repo wrote `.scratch/` tickets that never reached GitHub, and `gh-*` ops in a
 * local repo wrote issues nobody reads. A backend this tool does not implement
 * (GitLab, anything else) refuses both. The message names the op to use. */
function assertConfiguredBackend(root: string, op: string): void {
	if (!(TRACKER_OPS as readonly string[]).includes(op)) return;
	const backend = configuredBackend(root);
	if (backend === undefined) return;
	const github = op.startsWith("gh-");
	if (backend.kind === "github" && !github) {
		throw new TrackerError(
			`${BACKEND_DOC} configures ${backend.name}, so the local .scratch/ op "${op}" is refused (its tickets would never reach GitHub): use "gh-${op}" instead`,
		);
	}
	if (backend.kind === "local" && github) {
		const twin = op.slice(3);
		const instead = (TRACKER_OPS as readonly string[]).includes(twin)
			? `use "${twin}" instead`
			: `the local backend has no "${twin}" op — use "list" with a "status" filter (for example needs-triage)`;
		throw new TrackerError(`${BACKEND_DOC} configures ${backend.name}, so the GitHub op "${op}" is refused: ${instead}`);
	}
	if (backend.kind === "other") {
		throw new TrackerError(
			`${BACKEND_DOC} configures ${backend.name}, which the tracker tool does not implement: "${op}" is refused — follow that doc's CLI recipes instead`,
		);
	}
}

/** Dispatch one `tracker` tool call; returns markdown for the model. */
export function runOp(root: string, params: TrackerParams): string {
	assertConfiguredBackend(root, params.op);
	switch (params.op) {
		case "list": {
			// no feature: the feature table; with one: every ticket of it (closed
			// included), filtered by any of the triage fields the ticket carries —
			// state role (status), category role (category), or wayfinder type.
			if (!params.feature?.trim()) return renderFeatures(listFeatures(root));
			const feature = reqFeature(params);
			const filter = params.status?.trim() ? canonicalRole(root, params.status) : undefined;
			const tickets = listTickets(root, feature).filter(
				(t) => !filter || t.status === filter || t.category === filter || t.ticketType === filter,
			);
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
			const feature = reqFeature(params);
			const title = req(params, "title");
			const blockedBy = params.blockedBy ?? [];
			assertBlockersExist(root, feature, blockedBy);
			// A wayfinder child carries no triage role unless asked (as on GitHub,
			// where a typed ticket gets no triage label): `ready-for-agent` made a
			// HITL grilling/prototype ticket look agent-ready.
			const status = params.status?.trim() ? canonicalRole(root, params.status) : params.type ? "" : "ready-for-agent";
			const ticket = createTicket(root, feature, title, params.what ?? "", blockedBy, status, params.type, params.criteria ?? []);
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
			// A closed or already-claimed ticket is refused under the ticket's lock
			// (claimTicket), so a parallel resolve or claim cannot slip in between.
			const updated = claimTicket(root, reqFeature(params), req(params, "ticket"));
			return `Claimed (set this before any work):\n\n${renderTicket(updated)}`;
		}

		case "resolve": {
			const feature = reqFeature(params);
			const hasMap = existsSync(join(featureDir(root, feature), "map.md"));
			const updated = resolveTicket(root, feature, req(params, "ticket"), req(params, "answer"), params.gist);
			// Say what happened to the map: a missing gist used to skip the
			// Decisions-so-far pointer silently. No map, no gist expected.
			const mapNote = !hasMap
				? ""
				: params.gist?.trim()
					? " (map Decisions-so-far updated)"
					: ` — map.md was NOT updated: no "gist" was given (add "[${updated.title}](issues/${basename(updated.file)}): <gist>" with op "note", section "Decisions so far")`;
			return `Resolved ${rel(root, updated.file)}${mapNote}:\n\n${renderTicket(updated)}`;
		}

		case "tick": {
			const index = params.index;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
				throw new TrackerError('"tick" requires a 1-based numeric "index"');
			}
			const target = ticket(params, root);
			if (isClosed(target)) throw new TrackerError(`cannot tick ${target.id}: it is ${target.status}`);
			const updated = tickCriterion(root, reqFeature(params), req(params, "ticket"), index);
			return `Ticked criterion ${index}:\n\n${renderTicket(updated)}`;
		}

		case "status": {
			// triage's category roles live on their own line so a state change never
			// clobbers them; either the canonical role or this repo's mapped label
			// spelling is accepted, and the file keeps the canonical role.
			const role = canonicalRole(root, req(params, "status"));
			const label = (CATEGORY_ROLES as readonly string[]).includes(role) ? "Category" : "Status";
			const updated = setTicketField(root, reqFeature(params), req(params, "ticket"), label, role);
			return `Updated ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		case "block": {
			const blockers = params.blockedBy ?? [];
			const feature = reqFeature(params);
			assertBlockersExist(root, feature, blockers);
			const updated = setTicketField(root, feature, req(params, "ticket"), "Blocked by", blockers.length ? blockers.join(", ") : UNBLOCKED);
			return `Updated ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		case "comment": {
			const updated = appendTicketSection(root, reqFeature(params), req(params, "ticket"), "Comments", req(params, "what"));
			return `Commented on ${rel(root, updated.file)}:\n\n${renderTicket(updated)}`;
		}

		case "edit": {
			if (!params.title?.trim() && !params.what?.trim()) {
				throw new TrackerError('"edit" requires "title" and/or "what"');
			}
			const { ticket: updated, bodyAppended } = updateTicket(root, reqFeature(params), req(params, "ticket"), params.title, params.what);
			const appended = bodyAppended
				? ' — it had no Question or What-to-build section, so the text was appended as a new "## What to build" section and the old prose kept'
				: "";
			return `Edited ${rel(root, updated.file)}${appended}:\n\n${renderTicket(updated)}`;
		}

		case "note": {
			const feature = reqFeature(params);
			const section = params.section?.trim() || "Notes";
			assertSection(section);
			appendMapLine(root, feature, section, req(params, "what"));
			return `Appended to ${section} in .scratch/${feature}/map.md.`;
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

		case "gh-edit":
			return ghEditOp(root, params);

		case "gh-note":
			return ghMapNoteOp(root, params);

		default:
			throw new TrackerError(`unsupported op ${JSON.stringify((params as { op?: string }).op)}`);
	}
}

/** The wayfinder frontier of every feature at once — used by the /frontier
 * command. A repo configured for another backend gets a pointer instead of a
 * misleading "No features tracked". */
export function runAllFrontiers(root: string): string {
	const backend = configuredBackend(root);
	if (backend?.kind === "github") {
		return `${BACKEND_DOC} configures ${backend.name}, so tickets are GitHub issues, not .scratch/ files: run the tracker tool's "gh-frontier" op (with "parent" to scope it to one map) for the frontier.`;
	}
	if (backend?.kind === "other") {
		return `${BACKEND_DOC} configures ${backend.name}, which the tracker tool does not implement: follow that doc's CLI recipes for the frontier.`;
	}
	const summaries = listFeatures(root);
	if (summaries.length === 0) return "No features tracked (.scratch/ is empty or missing).";
	return summaries.map((summary) => `## .scratch/${summary.feature}\n\n${renderFrontier(listTickets(root, summary.feature))}`).join("\n\n");
}
