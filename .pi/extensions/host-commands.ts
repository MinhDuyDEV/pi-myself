import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * host-commands — bridges two host gaps the vendored mattpocock/skills hit.
 *
 * - Bare skill commands: the vendored skills tell the human to type
 *   `/to-spec`, `/wayfinder`, `/grill-with-docs`…, but pi exposes a skill only
 *   as `/skill:<name>`. An `input` handler rewrites `/<name>` (followed by the
 *   end or whitespace) to `/skill:<name>` plus the rest, when `<name>` is a
 *   registered skill and no extension command or prompt template owns
 *   `/<name>`. pi runs extension commands before `input` handlers and expands
 *   `/skill:` after them, so the rewritten text expands like a typed one.
 * - `/clear`: the vendored skills (ask-matt/PHASE-BOUNDARIES.md and others)
 *   say `/clear`; pi 0.87 has no such command, only `/new`. `/clear` starts a
 *   new session through `ctx.newSession()`, as `/new` does; the old session
 *   stays resumable.
 */

const BARE_COMMAND = /^\/([^\s/:]+)(?=\s|$)/;

export default function hostCommands(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Start a new session (same as /new; the vendored skills call it /clear)",
		handler: async (_args, ctx) => {
			await ctx.newSession({ withSession: async (next) => next.ui.notify("New session started", "info") });
		},
	});

	pi.on("input", (event) => {
		const match = BARE_COMMAND.exec(event.text);
		const name = match?.[1];
		if (name === undefined) return { action: "continue" };
		let isSkill = false;
		for (const command of pi.getCommands()) {
			// Skills are listed as `skill:<name>`; extension commands and prompt templates by their bare invocation name.
			if (command.source === "skill" && command.name === `skill:${name}`) isSkill = true;
			else if (command.source !== "skill" && command.name === name) return { action: "continue" };
		}
		if (!isSkill) return { action: "continue" };
		return { action: "transform", text: `/skill:${name}${event.text.slice(name.length + 1)}` };
	});
}
