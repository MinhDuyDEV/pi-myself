import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * memory-nudge — closes the loop on the memory discipline at the only point
 * the harness can be deterministic: session teardown.
 *
 * pi fires `session_shutdown` before the session runtime is torn down
 * (reason: quit | reload | new | resume | fork). This extension snapshots
 * `<repo-root>/.pi/MEMORY.md` at session_start and, on a true quit,
 * reminds when the session appended nothing:
 *
 * - file created this session  → nothing to do
 * - file changed this session  → nothing to do
 * - file unchanged (or absent) → "no durable learnings appended; if something
 *   was worth remembering, append now (or run /remember next session)"
 *
 * It never writes MEMORY.md itself: judging what is durable is the agent's
 * judgment call, exercised in-turn (APPEND_SYSTEM) or on demand (/remember).
 * The nudge is addressed to the human's next session — a reminder, not a
 * gate; quitting without learnings is perfectly fine.
 */

interface Snapshot {
	existed: boolean;
	content: string;
}

function snapshot(paths: string[]): Snapshot {
	for (const path of paths) {
		try {
			return { existed: true, content: readFileSync(path, "utf8") };
		} catch {
			/* try next */
		}
	}
	return { existed: false, content: "" };
}

export type Nudge = "created" | "updated" | "unchanged" | "absent";

/** Pure for tests: decide what the quit-time message should be. */
export function quitNudge(before: Snapshot, after: Snapshot): Nudge {
	if (after.existed && !before.existed) return "created";
	if (before.existed && after.content !== before.content) return "updated";
	return after.existed ? "unchanged" : "absent";
}

export default function memoryNudgeExtension(pi: ExtensionAPI): void {
	const repoCandidate = join(process.cwd(), ".pi", "MEMORY.md");
	const candidates = [repoCandidate, join(homedir(), ".pi", "MEMORY.md")];
	let before: Snapshot = { existed: false, content: "" };

	pi.on("session_start", () => {
		before = snapshot(candidates);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if ((event as { reason?: string } | undefined)?.reason !== "quit") return;
		const verdict = quitNudge(before, snapshot(candidates));
		if (verdict === "created" || verdict === "updated") return;
		const message =
			verdict === "absent"
				? "memory: no durable learnings appended this session (.pi/MEMORY.md does not exist yet — create it when the first real one appears, or run /remember)"
				: "memory: MEMORY.md unchanged this session — if something durable was learned, append it now (/remember next session walks it)";
		// teardown may swallow the last TUI frame; stderr lands after the
		// terminal restores, so the reminder is visible on either path
		if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, "info");
		else console.error(`[memory-nudge] ${message}`);
	});
}