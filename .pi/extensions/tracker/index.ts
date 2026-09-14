/**
/**
 * tracker — deterministic ops over Matt Pocock's issue tracker conventions
 * (`docs/agents/issue-tracker.md`). Two backends, one tool:
 *
 * - Local markdown (`.scratch/<feature>/issues/NN-<slug>.md` + `map.md`):
 *   the default tracker; ops `list/frontier/show/create-ticket/create-map/
 *   claim/resolve/tick/status/block/comment`.
 * - GitHub Issues (ops prefixed `gh-`): tickets/wayfinder maps are issues via
 *   the `gh` CLI with the repo as cwd; triage roles and wayfinder types are
 *   labels; `Blocked by:`/`Part of:` lines in issue bodies carry the edges.
 *   Check docs/agents/issue-tracker.md first and use the backend it names.
 *
 * The skills own the prose discipline (what an answer says, how a map is
 * indexed); this tool owns the mechanics so claims, resolves, blocking, and
 * frontier queries stop being re-interpreted from prose on every run.
 * Also registers `/frontier` (whole-tracker readout).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveRepoRoot } from "../lib/repo-root.js";
import { runAllFrontiers, runOp } from "./ops.js";
import { trackerSchema, type TrackerParams } from "./params.js";
import { TrackerError } from "./tracker.js";

/** The consuming repository's root (git top-level, else cwd): `.scratch/`
 * lives there and `gh` runs there, wherever pi was launched inside the repo. */
const findRepoRoot = resolveRepoRoot;

export default function trackerExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tracker",
		label: "Tracker",
		description:
			"Read or update the repo's issue tracker the way Matt Pocock's skills expect (to-spec, to-tickets, wayfinder, triage). Local markdown (.scratch/) ops: list/frontier/show/create-spec/create-ticket/create-map/claim/resolve/out-of-scope/tick/status/block/comment. GitHub Issues ops (gh-* prefix, need the gh CLI + auth): gh-list (label filter via status), gh-frontier (optionally scoped to a parent), gh-triage (attention queue), gh-show (full comments), gh-create-spec, gh-create-ticket (native sub-issue + dependency edges mirrored by Part of / Blocked by lines; wayfinder type → wayfinder:<type> label), gh-create-map, gh-claim (assign @me), gh-resolve (answer comment + close + gist into the map), gh-out-of-scope, gh-comment, gh-status (swaps only the state-role or category-role family), gh-block, gh-tick.",
		promptSnippet: "Read or update tracker tickets deterministically (local .scratch/ markdown, or GitHub Issues via the gh- ops).",
		promptGuidelines: [
			"Claim a ticket with op 'claim' (local) or 'gh-claim' (GitHub, assigns @me) before working it — wayfinder's rule; it is the session's first write.",
			"Publish blockers first (create-ticket with blockedBy naming real ids); resolve with 'resolve'/'gh-resolve' plus the answer and a gist so the map's Decisions-so-far stays indexed.",
			"Use the backend docs/agents/issue-tracker.md configures; these ops own the fields (status, blockers, parent, criteria boxes) and never rewrite the prose around them.",
		],
		parameters: trackerSchema,
		renderCall: (args, theme) => {
			const p = (args ?? {}) as { op?: string; feature?: string };
			return new Text(theme.fg("toolTitle", theme.bold(`⚙ tracker ${p.op ?? ""}${p.feature ? ` ${p.feature}` : ""}`.trimEnd())), 0, 0);
		},
		async execute(
			_toolCallId: string,
			params: TrackerParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
		) {
			const root = findRepoRoot(process.cwd());
			try {
				return { content: [{ type: "text", text: runOp(root, params) }], details: { tracker: params.op } };
			} catch (error) {
				const message = error instanceof TrackerError ? error.message : error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `tracker: ${message}` }], details: { tracker: "error" } };
			}
		},
	});

	pi.registerCommand("frontier", {
		description: "Print the wayfinder frontier of every feature in .scratch/",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			ctx.ui?.notify?.(runAllFrontiers(findRepoRoot(process.cwd())), "info");
		},
	});
}