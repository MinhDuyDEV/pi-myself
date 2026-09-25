import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Best-effort deferral between `session_compact` firing and the follow-up send.
 *
 * `session_compact` fires after compaction has rebuilt the agent state, so the
 * runtime is ready. The one-tick delay (0ms) is cheap insurance so `/compact`
 * can finish any post-compaction work before a new prompt begins; delivery is
 * additionally race-safe because we pick `deliverAs: "followUp"` whenever the
 * agent is not idle.
 */
export const CONTINUATION_DELAY_MS = 0;

/** The subset of `SessionCompactEvent` our resume decision depends on. */
export interface CompactionSignal {
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

/** How the most recent agent run ended, as far as resuming is concerned. */
export type RunEnd = "finished" | "interrupted";

/**
 * Classify a run from its `agent_end` messages. A run is interrupted when its
 * last assistant message did not complete. `/compact` calls `abort()` before it
 * compacts, and the abort surfaces as `aborted` or — when it lands while a tool
 * runs and the provider stream throws — as `error` ("This operation was
 * aborted", observed with openai-completions on pi 0.85.1). A run that failed
 * on its own is unfinished too, so `/compact` after it resumes as well.
 */
export function classifyRunEnd(messages: ReadonlyArray<unknown>): RunEnd {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		return message.stopReason === "aborted" || message.stopReason === "error" ? "interrupted" : "finished";
	}
	return "finished";
}

/**
 * Decide whether this compaction should trigger an automatic continuation.
 *
 * Only a manual compaction that cut a run short resumes:
 *
 * - `threshold` and `overflow`: Pi either compacts inside the run and resumes
 *   it itself, or compacts after the run finished; a continuation here lands as
 *   an unsolicited extra turn (observed after a post-run threshold compaction).
 * - `willRetry`: Pi retries the aborted turn itself.
 * - `manual` after a finished run: the user compacted between tasks and is
 *   about to say what comes next.
 *
 * Esc followed by `/compact` also counts as interrupted — the run ended aborted
 * and nothing started since — so it resumes too.
 */
export function shouldResume(signal: CompactionSignal, lastRun: RunEnd | undefined): boolean {
	return signal.reason === "manual" && !signal.willRetry && lastRun === "interrupted";
}

export const buildContinuationPrompt = (sessionFile: string | undefined, compactionEntryId: string): string => {
	const sessionSource =
		sessionFile === undefined
			? "This session is ephemeral, so no persisted session file is available."
			: [
					`The persisted session JSONL is ${JSON.stringify(sessionFile)}.`,
					"Inspect it directly with the read and bash tools.",
					"Do not launch a nested Pi process or open the session with `pi --session`.",
				].join(" ");

	return `A manual compaction interrupted the running task and has just completed. Resume the existing task rather than waiting for another user prompt.

${sessionSource}
The new compaction entry ID is ${JSON.stringify(compactionEntryId)}.

Before continuing:

1. Recover context before guessing: use the recall tool first (it searches exactly this history, including compaction summaries), and inspect the session file directly with read/bash for anything it leaves out. Focus first on messages and tool calls immediately before compaction, searching earlier history only as needed. Remember that JSONL append order can include abandoned branches, so follow parentId links rather than blindly treating every entry as active.
2. If a memory_search tool is available, run it once with the task's keywords: durable project records written in earlier sessions may already answer what the summary flattened.
3. Reconstruct the original goal, user constraints, decisions made, files changed, commands and tests run, unresolved issues, and intended next action.
4. Reconcile the recovered history with the compaction summary and current repository state. Treat the current worktree as authoritative for file state and the original session history as authoritative for user intent.
5. Briefly state the context you recovered.
6. Immediately perform the next unfinished step. Do not stop after the recap and do not ask the user to repeat prior context unless the session data is genuinely unavailable or ambiguous.`;
};

/**
 * Resumes a task that a manual `/compact` interrupted.
 *
 * Behaviour:
 * - `agent_end` records whether the latest run was interrupted; `agent_start`
 *   clears it, so only the run immediately before the compaction counts.
 * - A successful manual compaction after an interrupted run queues one
 *   continuation and consumes the record.
 * - Automatic compactions and failed compactions never resume: Pi owns both
 *   (it resumes in-run threshold compaction, retries overflow, and reports
 *   compaction errors itself).
 * - Coalesces: a newer compaction cancels an older pending continuation.
 */
export default function continueAfterCompaction(pi: ExtensionAPI): void {
	let lastRun: RunEnd | undefined;
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;

	const cancelPending = () => {
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			pendingTimer = undefined;
		}
	};

	pi.on("agent_start", () => {
		lastRun = undefined;
	});

	pi.on("agent_end", (event) => {
		lastRun = classifyRunEnd(event.messages);
	});

	pi.on("session_compact", (event, ctx) => {
		const signal: CompactionSignal = { reason: event.reason, willRetry: event.willRetry };
		if (!shouldResume(signal, lastRun)) return;

		lastRun = undefined;
		cancelPending();

		const prompt = buildContinuationPrompt(ctx.sessionManager.getSessionFile(), event.compactionEntry.id);

		pendingTimer = setTimeout(() => {
			pendingTimer = undefined;
			// Plain send when idle (always triggers a turn); followUp otherwise so the
			// continuation waits for the current turn instead of interrupting it.
			if (ctx.isIdle()) {
				void pi.sendUserMessage(prompt);
			} else {
				void pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
		}, CONTINUATION_DELAY_MS);
	});

	pi.on("session_shutdown", () => {
		cancelPending();
		lastRun = undefined;
	});
}
