import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Best-effort deferral between `session_compact` firing and the follow-up send.
 *
 * `session_compact` is documented as firing *after* context compaction, so in
 * principle the runtime is ready and no deferral is needed. The one-tick delay
 * (0ms) is kept as cheap insurance so a manual `/compact` can finish any
 * post-compaction runtime reconnection before a new prompt begins. It is a
 * best-effort heuristic, not a contract: delivery is additionally race-safe
 * because we pick `deliverAs: "followUp"` whenever the agent is not idle.
 */
export const CONTINUATION_DELAY_MS = 0;

/** The subset of `SessionCompactEvent` our resume decision depends on. */
export interface CompactionSignal {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
}

/**
 * Decide whether this compaction should trigger an automatic continuation.
 *
 * Guards against the two failure modes the naive version had:
 *
 * 1. Overflow recovery: when `willRetry` is true, Pi itself retries the aborted
 *    turn. Injecting our own continuation would spawn a competing turn, so we
 *    stay out of its way.
 * 2. Runaway loop: automatic (`threshold`) compaction chained off a continuation
 *    we already injected is skipped (`inflight === true`), breaking the
 *    "continuation -> huge output -> threshold compaction -> continuation" cycle.
 *    Manual and non-retried overflow compactions always resume: they are fresh,
 *    deliberate checkpoints where Pi will not continue on its own.
 */
export function shouldResume(signal: CompactionSignal, inflight: boolean): boolean {
  if (signal.willRetry) return false;
  if (signal.reason === "manual") return true;
  if (signal.reason === "overflow") return true;
  return !inflight;
}

export const buildContinuationPrompt = (
  sessionFile: string | undefined,
  compactionEntryId: string,
): string => {
  const sessionSource =
    sessionFile === undefined
      ? "This session is ephemeral, so no persisted session file is available."
      : [
          `The persisted session JSONL is ${JSON.stringify(sessionFile)}.`,
          "Inspect it directly with the read and bash tools.",
          "Do not launch a nested Pi process or open the session with `pi --session`.",
        ].join(" ");

  return `Compaction has just completed. Resume the existing task rather than waiting for another user prompt.

${sessionSource}
The new compaction entry ID is ${JSON.stringify(compactionEntryId)}.

Before continuing:

1. Review the active session branch leading to the compaction entry. Focus first on messages and tool calls immediately before compaction, searching earlier history only as needed. Remember that JSONL append order can include abandoned branches, so follow parentId links rather than blindly treating every entry as active.
2. Reconstruct the original goal, user constraints, decisions made, files changed, commands and tests run, unresolved issues, and intended next action.
3. Reconcile the recovered history with the compaction summary and current repository state. Treat the current worktree as authoritative for file state and the original session history as authoritative for user intent.
4. Briefly state the context you recovered.
5. Immediately perform the next unfinished step. Do not stop after the recap and do not ask the user to repeat prior context unless the session data is genuinely unavailable or ambiguous.`;
};

/**
 * Automatically resumes work after successful Pi compactions.
 *
 * Behaviour:
 * - Never interferes with Pi's own overflow recovery (`willRetry`).
 * - Breaks chained automatic compaction: a `threshold` compaction that follows a
 *   continuation we injected does not start another one.
 * - Coalesces: a newer compaction cancels an older pending continuation so only
 *   one continuation is ever queued at a time.
 * - Never resumes from a failed compaction (`session_compact_failed`): there is
 *   no compaction entry to anchor recovery to, and a persistent failure (e.g.
 *   provider outage) would make failure-triggered resumes an unbounded loop.
 *   Hard automatic-compaction failures (threshold/overflow) are surfaced via a
 *   warning so the silence of the auto-continuation is explained; manual
 *   failures (Pi rethrows /compact errors itself), user-aborted and Pi-retried
 *   failures stay silent.
 * - `inflight` is cleared when the agent fully settles (`agent_settled`), i.e.
 *   after the continuation turn ends with no pending retry, compaction, or
 *   queued continuation.
 */
export default function continueAfterCompaction(pi: ExtensionAPI): void {
  /** True while a continuation we injected is pending or its turn is running. */
  let inflight = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelPending = () => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };

  pi.on("session_compact", (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const signal: CompactionSignal = {
      reason: event.reason,
      willRetry: event.willRetry,
    };

    if (!shouldResume(signal, inflight)) {
      // Either Pi is already retrying this turn, or we are breaking a chain of
      // automatic compactions. Leave `inflight` untouched so the chain stays
      // broken until the agent settles.
      return;
    }

    // Coalesce: only one continuation may be queued at a time.
    cancelPending();

    const prompt = buildContinuationPrompt(sessionFile, event.compactionEntry.id);
    inflight = true;

    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      // Follow Pi's own guidance for sending user messages from extensions:
      // plain send when idle (always triggers a turn), followUp when streaming
      // so the continuation waits for the current turn instead of interrupting it.
      if (ctx.isIdle()) {
        void pi.sendUserMessage(prompt);
      } else {
        void pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    }, CONTINUATION_DELAY_MS);
  });

  pi.on("session_compact_failed", (event, ctx) => {
    // Failures never trigger a continuation:
    // 1. A failed compaction produces no compaction entry, so there is nothing
    //    to anchor a recovery prompt to.
    // 2. Resuming only on success keeps every chain bounded by construction;
    //    failure-triggered resumes could loop forever on persistent errors.
    //
    // Pending continuations and `inflight` are deliberately left untouched:
    // a queued continuation anchors to an earlier successful compaction and
    // remains valid regardless of this failure.
    if (!event.aborted && !event.willRetry && event.reason !== "manual") {
      // User-aborted compactions need no explanation; willRetry means Pi's own
      // overflow recovery continues without us; manual /compact failures are
      // already reported to the caller by Pi itself.
      const detail = event.errorMessage ? `: ${event.errorMessage}` : "";
      ctx.ui.notify(
        `Automatic continuation skipped: compaction failed (${event.reason})${detail}`,
        "warning",
      );
    }
  });

  pi.on("agent_settled", () => {
    // The agent run has fully settled with no pending retry, compaction, or
    // queued continuation — a future automatic compaction may resume again.
    inflight = false;
  });

  pi.on("session_shutdown", () => {
    cancelPending();
    inflight = false;
  });
}
