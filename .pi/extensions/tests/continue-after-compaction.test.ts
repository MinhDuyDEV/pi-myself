import test from "node:test";
import assert from "node:assert/strict";
import continueAfterCompaction, {
  shouldResume,
  buildContinuationPrompt,
  type CompactionSignal,
} from "../continue-after-compaction.js";

/** Minimal fake of the pi ExtensionAPI surface this extension touches. */
function createFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const sent: Array<{ prompt: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];

  const pi: any = {
    handlers,
    sent,
    on(event: string, handler: (event: any, ctx: any) => void) {
      handlers.set(event, handler);
    },
    sendUserMessage(prompt: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sent.push({ prompt, options });
      return Promise.resolve();
    },
  };

  return { pi, handlers: () => handlers, sent: () => sent };
}

function ctxWith(isIdle: boolean, sessionFile?: string): { isIdle: () => boolean } & any {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  return {
    isIdle: () => isIdle,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    notifications,
  };
}

function compactEvent(partial: Partial<Record<"reason" | "willRetry", unknown>> & { id?: string }) {
  return {
    type: "session_compact",
    compactionEntry: { id: partial.id ?? "entry-1" },
    fromExtension: false,
    reason: (partial.reason as CompactionSignal["reason"]) ?? "manual",
    willRetry: partial.willRetry ?? false,
  };
}

test("shouldResume stays out of the way of Pi's own overflow retry", () => {
  // willRetry wins regardless of reason
  assert.equal(shouldResume({ reason: "overflow", willRetry: true }, false), false);
  assert.equal(shouldResume({ reason: "threshold", willRetry: true }, true), false);
  assert.equal(shouldResume({ reason: "manual", willRetry: true }, false), false);
});

test("shouldResume always resumes after deliberate checkpoints (manual / non-retried overflow)", () => {
  assert.equal(shouldResume({ reason: "manual", willRetry: false }, false), true);
  assert.equal(shouldResume({ reason: "manual", willRetry: false }, true), true);
  assert.equal(shouldResume({ reason: "overflow", willRetry: false }, false), true);
  assert.equal(shouldResume({ reason: "overflow", willRetry: false }, true), true);
});

test("shouldResume breaks the chain on automatic threshold compaction while a continuation is inflight", () => {
  assert.equal(shouldResume({ reason: "threshold", willRetry: false }, false), true);
  assert.equal(shouldResume({ reason: "threshold", willRetry: false }, true), false);
});

test("buildContinuationPrompt includes session file guidance when persisted", () => {
  const prompt = buildContinuationPrompt("/a/b/session.jsonl", "entry-9");
  assert.match(prompt, /\/a\/b\/session\.jsonl/);
  assert.match(prompt, /entry-9/);
  assert.match(prompt, /parentId/);
  assert.doesNotMatch(prompt, /ephemeral/);
});

test("buildContinuationPrompt falls back to ephemeral note without a session file", () => {
  const prompt = buildContinuationPrompt(undefined, "entry-1");
  assert.match(prompt, /ephemeral/);
  assert.doesNotMatch(prompt, /Inspect it directly/);
});

test("injects a continuation after a manual compaction and sends plainly when idle", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  handlers().get("session_compact")!(compactEvent({ reason: "manual" }), ctxWith(true, "/s.jsonl"));

  // CONTINUATION_DELAY_MS = 0 -> deferral is one event-loop turn
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sent().length, 1);
  assert.match(sent()[0]!.prompt, /Resume the existing task/);
  assert.equal(sent()[0]!.options, undefined); // idle -> plain send, no deliverAs
});

test("queues as a follow-up when the agent is not idle", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  handlers().get("session_compact")!(compactEvent({ reason: "manual" }), ctxWith(false, "/s.jsonl"));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sent().length, 1);
  assert.deepEqual(sent()[0]!.options, { deliverAs: "followUp" });
});

test("does not inject on overflow recovery (willRetry) that Pi will retry", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  handlers().get("session_compact")!(
    compactEvent({ reason: "overflow", willRetry: true }),
    ctxWith(true, "/s.jsonl"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sent().length, 0);
});

test("breaks chained automatic compaction and can resume again after the agent settles", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  // 1. Manual checkpoint -> continuation scheduled (inflight becomes true)
  handlers().get("session_compact")!(compactEvent({ reason: "manual" }), ctxWith(true, "/s.jsonl"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent().length, 1);

  // 2. While our continuation turn is running, automatic threshold compaction fires -> skip
  handlers().get("session_compact")!(
    compactEvent({ reason: "threshold", willRetry: false }),
    ctxWith(true, "/s.jsonl"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent().length, 1, "chain must be broken: no second continuation");

  // 3. Agent settles -> inflight cleared
  handlers().get("agent_settled")!({ type: "agent_settled" }, ctxWith(true, "/s.jsonl"));

  // 4. A later unrelated threshold compaction may resume again
  handlers().get("session_compact")!(
    compactEvent({ reason: "threshold", willRetry: false, id: "entry-2" }),
    ctxWith(true, "/s.jsonl"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent().length, 2);
});

test("coalesces: a newer compaction cancels a pending continuation before it fires", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  // Two compactions back-to-back before the (0ms) timer fires.
  handlers().get("session_compact")!(compactEvent({ reason: "manual", id: "a" }), ctxWith(true));
  handlers().get("session_compact")!(compactEvent({ reason: "manual", id: "b" }), ctxWith(true));

  // setTimeout(0) can already have run between the two synchronous calls above on some
  // runtimes; to make the ordering deterministic, run both notifications first and only
  // then flush the timer queue.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent().length, 1, "only the latest compaction should produce a continuation");
});

function compactFailedEvent(partial: Partial<{ reason: CompactionSignal["reason"]; aborted: boolean; willRetry: boolean; errorMessage?: string }> = {}) {
  return {
    type: "session_compact_failed" as const,
    reason: partial.reason ?? "manual",
    errorMessage: partial.errorMessage,
    aborted: partial.aborted ?? false,
    willRetry: partial.willRetry ?? false,
    fromExtension: false,
  };
}

test("registers a session_compact_failed handler", () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  assert.ok(handlers().has("session_compact_failed"), "failure events must be observed");
});

test("failed compactions never inject a continuation", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  // Every failure shape: hard error vs abort, with and without Pi-side retry.
  for (const event of [
    compactFailedEvent({ reason: "manual", aborted: false, willRetry: false }),
    compactFailedEvent({ reason: "threshold", aborted: false, willRetry: false }),
    compactFailedEvent({ reason: "overflow", aborted: false, willRetry: false }),
    compactFailedEvent({ reason: "overflow", aborted: false, willRetry: true }),
    compactFailedEvent({ reason: "threshold", aborted: true, willRetry: false }),
    compactFailedEvent({ reason: "manual", aborted: true, willRetry: true }),
  ]) {
    handlers().get("session_compact_failed")!(event, ctxWith(true, "/s.jsonl"));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sent().length, 0);
});

test("a later failed compaction does not cancel a pending continuation", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  // Success queues a continuation anchored to its own compaction entry...
  handlers().get("session_compact")!(compactEvent({ reason: "manual", id: "ok-1" }), ctxWith(true));
  // ...then an unrelated failure arrives before the timer fires.
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "threshold", aborted: false, willRetry: false }),
    ctxWith(true),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sent().length, 1, "pending continuation anchors to the earlier success and still fires");
});

test("notifies on hard non-retried failures so silence is explained", async () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  const ctx = ctxWith(true, "/s.jsonl");
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "threshold", aborted: false, willRetry: false, errorMessage: "provider 503" }),
    ctx,
  );

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0]!.type, "warning");
  assert.match(ctx.notifications[0]!.message, /compaction failed/i);
  assert.match(ctx.notifications[0]!.message, /provider 503/);
});

test("stays silent on failed manual compactions (Pi already reports /compact errors)", () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  const ctx = ctxWith(true, "/s.jsonl");
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "manual", aborted: false, willRetry: false, errorMessage: "provider 503" }),
    ctx,
  );

  assert.equal(ctx.notifications.length, 0, "the /compact caller already saw the error rethrow");
});

test("notify message omits detail separator when errorMessage is absent", () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  const ctx = ctxWith(true, "/s.jsonl");
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "overflow", aborted: false, willRetry: false }),
    ctx,
  );

  assert.equal(ctx.notifications.length, 1);
  assert.doesNotMatch(ctx.notifications[0]!.message, /undefined/);
  assert.doesNotMatch(ctx.notifications[0]!.message, /: $/);
});

test("stays silent for user-aborted and Pi-retried failures", () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  const abortedCtx = ctxWith(true, "/s.jsonl");
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "manual", aborted: true, willRetry: false, errorMessage: "cancelled" }),
    abortedCtx,
  );
  const retriedCtx = ctxWith(true, "/s.jsonl");
  handlers().get("session_compact_failed")!(
    compactFailedEvent({ reason: "overflow", aborted: false, willRetry: true, errorMessage: "context overflow" }),
    retriedCtx,
  );

  assert.equal(abortedCtx.notifications.length, 0, "user cancelled it themselves");
  assert.equal(retriedCtx.notifications.length, 0, "Pi owns overflow recovery");
});

test("session shutdown cancels any pending continuation", async () => {
  const { pi, handlers, sent } = createFakePi();
  continueAfterCompaction(pi);

  // Schedule a continuation then shut down before the deferral fires.
  handlers().get("session_compact")!(compactEvent({ reason: "manual" }), ctxWith(true));
  handlers().get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctxWith(true));

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent().length, 0);
});
