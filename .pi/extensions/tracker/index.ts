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

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runAllFrontiers, runOp } from "./ops.js";
import { trackerSchema, type TrackerParams } from "./params.js";
import { TrackerError } from "./tracker.js";

function findRepoRoot(start: string): string {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, "vendor", "mattpocock-skills", ".claude-plugin", "plugin.json"))) return current;
		const parent = join(current, "..");
		if (parent === current) return resolve(start);
		current = parent;
	}
}

export default function trackerExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tracker",
		label: "Tracker",
		description:
			"Read or update the repo's issue tracker. Local markdown (.scratch/') ops: list/frontier/show/create-ticket/create-map/claim/resolve/tick/status/block/comment. GitHub Issues ops (gh-* prefix) need the gh CLI + auth and follow docs/agents/issue-tracker.md's conventions: issues carry Blocked by/Part of field lines, triage roles and wayfinder:* types are labels, claim = assign @me, resolve = close with an ## Answer comment.",
		promptSnippet: "Read or update tracker tickets deterministically (local .scratch/ markdown, or GitHub Issues via the gh- ops).",
		promptGuidelines: [
			"Claim a ticket with op 'claim' (local) or 'gh-claim' (GitHub, assigns @me) before working it — wayfinder's rule.",
			"Resolve with 'resolve'/'gh-resolve' plus the answer; pass a gist so the wayfinder map's Decisions-so-far stays indexed.",
			"Use the backend docs/agents/issue-tracker.md configures; these ops never hand-edit .scratch/ prose around the fields they own.",
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