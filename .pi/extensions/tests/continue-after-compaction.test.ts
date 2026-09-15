import test from "node:test";
import assert from "node:assert/strict";
import continueAfterCompaction, {
  shouldResume,
  classifyRunEnd,
  buildContinuationPrompt,
  type CompactionSignal,
} from "../continue-after-compaction.js";

/** Minimal fake of the pi ExtensionAPI surface this extension touches. */
function createFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const sent: Array<{ prompt: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];

  const pi: any = {
    on(event: string, handler: (event: any, ctx: any) => void) {
      handlers.set(event, handler);
    },
    sendUserMessage(prompt: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sent.push({ prompt, options });
      return Promise.resolve();
    },
  };

  const fire = (event: string, payload: any, ctx: any = ctxWith(true)) => handlers.get(event)!(payload, ctx);
  return { pi, handlers, sent, fire };
}

function ctxWith(isIdle: boolean, sessionFile?: string) {
  return {
    isIdle: () => isIdle,
    sessionManager: { getSessionFile: () => sessionFile },
  };
}

const assistant = (stopReason: string) => ({ role: "assistant", stopReason, content: [] });
const toolResult = () => ({ role: "toolResult", content: [] });

function compactEvent(partial: Partial<CompactionSignal> & { id?: string } = {}) {
  return {
    type: "session_compact",
    compactionEntry: { id: partial.id ?? "entry-1" },
    fromExtension: false,
    reason: partial.reason ?? "manual",
    willRetry: partial.willRetry ?? false,
  };
}

/** A run that ends with `stopReason` on its last assistant message. */
function runEndingWith(fire: ReturnType<typeof createFakePi>["fire"], stopReason: string) {
  fire("agent_start", { type: "agent_start" });
  fire("agent_end", { type: "agent_end", messages: [assistant("toolUse"), toolResult(), assistant(stopReason)] });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("classifyRunEnd reads the last assistant message", () => {
  assert.equal(classifyRunEnd([assistant("stop")]), "finished");
  assert.equal(classifyRunEnd([assistant("toolUse"), toolResult(), assistant("aborted")]), "interrupted");
  assert.equal(classifyRunEnd([assistant("aborted"), toolResult()]), "interrupted", "trailing tool results are skipped");
  assert.equal(classifyRunEnd([assistant("error")]), "interrupted", "an abort during a tool surfaces as error");
  assert.equal(classifyRunEnd([assistant("length")]), "finished");
  assert.equal(classifyRunEnd([]), "finished");
});

test("resumes when /compact aborts a running tool (the run ends on an error response)", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  // Shape observed live on pi 0.85.1: aborted bash result, then an empty error response.
  fire("agent_start", { type: "agent_start" });
  fire("agent_end", {
    type: "agent_end",
    messages: [
      { role: "user", content: "run sleep" },
      assistant("toolUse"),
      { role: "toolResult", isError: true, content: [{ type: "text", text: "Command aborted" }] },
      { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] },
    ],
  });
  fire("session_compact", compactEvent());
  await flush();

  assert.equal(sent.length, 1);
});

test("shouldResume only after a manual compaction that interrupted a run", () => {
  assert.equal(shouldResume({ reason: "manual", willRetry: false }, "interrupted"), true);
  assert.equal(shouldResume({ reason: "manual", willRetry: false }, "finished"), false);
  assert.equal(shouldResume({ reason: "manual", willRetry: false }, undefined), false);
  assert.equal(shouldResume({ reason: "manual", willRetry: true }, "interrupted"), false);
});

test("shouldResume never fires on automatic compaction (Pi resumes or the run had finished)", () => {
  for (const reason of ["threshold", "overflow"] as const) {
    for (const willRetry of [false, true]) {
      for (const lastRun of ["interrupted", "finished", undefined] as const) {
        assert.equal(shouldResume({ reason, willRetry }, lastRun), false, `${reason}/${willRetry}/${lastRun}`);
      }
    }
  }
});

test("buildContinuationPrompt includes session file guidance when persisted", () => {
  const prompt = buildContinuationPrompt("/a/b/session.jsonl", "entry-9");
  assert.match(prompt, /\/a\/b\/session\.jsonl/);
  assert.match(prompt, /entry-9/);
  assert.match(prompt, /parentId/);
  assert.match(prompt, /memory_search/, "post-compaction recovery consults durable memory records");
  assert.doesNotMatch(prompt, /ephemeral/);
});

test("buildContinuationPrompt falls back to ephemeral note without a session file", () => {
  const prompt = buildContinuationPrompt(undefined, "entry-1");
  assert.match(prompt, /ephemeral/);
  assert.doesNotMatch(prompt, /Inspect it directly/);
});

test("resumes when /compact interrupted a run, sending plainly when idle", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent(), ctxWith(true, "/s.jsonl"));
  await flush();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.prompt, /Resume the existing task/);
  assert.equal(sent[0]!.options, undefined);
});

test("queues as a follow-up when the agent is not idle", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent(), ctxWith(false, "/s.jsonl"));
  await flush();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.options, { deliverAs: "followUp" });
});

test("stays silent when /compact follows a finished run (user compacts between tasks)", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "stop");
  fire("session_compact", compactEvent());
  await flush();

  assert.equal(sent.length, 0);
});

test("stays silent on /compact before any run", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  fire("session_compact", compactEvent());
  await flush();

  assert.equal(sent.length, 0);
});

test("stays silent on in-run threshold compaction, which Pi resumes itself", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  // Threshold compaction fires between agent_start and agent_end.
  fire("agent_start", { type: "agent_start" });
  fire("session_compact", compactEvent({ reason: "threshold" }), ctxWith(false));
  fire("agent_end", { type: "agent_end", messages: [assistant("stop")] });
  await flush();

  assert.equal(sent.length, 0);
});

test("stays silent on automatic compaction even right after an interrupted run", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent({ reason: "threshold" }));
  fire("session_compact", compactEvent({ reason: "overflow", willRetry: true }));
  await flush();

  assert.equal(sent.length, 0);
});

test("a new run clears the interrupted record", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("agent_start", { type: "agent_start" });
  fire("session_compact", compactEvent());
  await flush();

  assert.equal(sent.length, 0);
});

test("resumes once per interruption: a second /compact does not resume again", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent({ id: "a" }));
  await flush();
  fire("session_compact", compactEvent({ id: "b" }));
  await flush();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.prompt, /"a"/);
});

test("coalesces: a newer resuming compaction cancels a pending continuation", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent({ id: "a" }));
  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent({ id: "b" }));
  await flush();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.prompt, /"b"/);
});

test("session shutdown cancels any pending continuation", async () => {
  const { pi, sent, fire } = createFakePi();
  continueAfterCompaction(pi);

  runEndingWith(fire, "aborted");
  fire("session_compact", compactEvent());
  fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  await flush();

  assert.equal(sent.length, 0);
});

test("registers no compaction-failure handler (Pi reports those itself)", () => {
  const { pi, handlers } = createFakePi();
  continueAfterCompaction(pi);

  assert.deepEqual([...handlers.keys()].sort(), ["agent_end", "agent_start", "session_compact", "session_shutdown"]);
});
