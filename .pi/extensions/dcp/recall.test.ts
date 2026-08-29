import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, test } from "bun:test";

import { isPathWithin, searchDcpRecall, activeLineageIds } from "./recall";

function withSession(
  entries: unknown[],
  run: (sessionFile: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "dcp-recall-"));
  const sessionFile = join(dir, "session.jsonl");
  try {
    writeFileSync(sessionFile, entries.map(JSON.stringify).join("\n"));
    run(sessionFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("path containment works with Windows separators and drive boundaries", () => {
  expect(isPathWithin("C:\\repo\\.pi", "C:\\repo\\.pi\\artifacts\\tasks", win32)).toBeTrue();
  expect(isPathWithin("C:\\repo\\.pi", "C:\\repo\\other", win32)).toBeFalse();
  expect(isPathWithin("C:\\repo\\.pi", "D:\\repo\\.pi\\artifacts", win32)).toBeFalse();
});

test("searches Pi native compaction summaries in the active session", () => {
  withSession(
    [
      {
        type: "compaction",
        summary:
          "Retain the recall-only extension and remove dormant compression code.",
                timestamp: "2024-12-03T14:10:00.000Z",

      },
    ],
    (sessionFile) => {
      const result = searchDcpRecall({ sessionFile, query: "dormant compression" });

      expect(result.total).toBe(1);
      expect(result.entries[0]?.role).toBe("compaction");
      expect(result.rendered).toContain("recall-only extension");
    },
  );
});

test("normalizes legacy tool-name typos in recalled text to the current name", () => {
  withSession(
    [
      {
        type: "message",
        message: { role: "user", content: "Try dep_recall and dop_recall with scope all" },
        timestamp: "2024-12-03T14:10:00.000Z",
      },
    ],
    (sessionFile) => {
      const result = searchDcpRecall({ sessionFile, query: "scope" });
      expect(result.rendered).not.toContain("dep_recall");
      expect(result.rendered).not.toContain("dop_recall");
      expect(result.rendered).toContain("recall");
    },
  );
});

test("activeLineageIds walks the leaf-parent chain and ignores dead branches", () => {
  const tree = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "x", parentId: "a" },
    { id: "c", parentId: "b" },
  ];
  expect(
    activeLineageIds({ getTree: () => tree, getLeafId: () => "c" }),
  ).toEqual(new Set(["a", "b", "c"]));
  expect(activeLineageIds({})).toBeUndefined();
  expect(
    activeLineageIds({
      getTree: () => {
        throw new Error("boom");
      },
      getLeafId: () => "a",
    }),
  ).toBeUndefined();
});

test("active scope with lineageEntryIds excludes superseded branch turns", () => {
  withSession(
    [
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: "keep me alpha" },
        timestamp: "2024-12-03T14:10:00.000Z",
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "user", content: "keep me beta" },
        timestamp: "2024-12-03T14:11:00.000Z",
      },
      {
        type: "message",
        id: "x",
        parentId: "a",
        message: { role: "user", content: "dead branch delta" },
        timestamp: "2024-12-03T14:12:00.000Z",
      },
    ],
    (sessionFile) => {
      const filtered = searchDcpRecall({
        sessionFile,
        query: "keep|dead",
        scope: "active",
        lineageEntryIds: new Set(["a", "b"]),
      });
      expect(filtered.total).toBe(2);
      expect(filtered.rendered).toContain("keep me alpha");
      expect(filtered.rendered).toContain("keep me beta");
      expect(filtered.rendered).not.toContain("dead branch delta");

      const unfiltered = searchDcpRecall({
        sessionFile,
        query: "keep|dead",
        scope: "active",
      });
      expect(unfiltered.total).toBe(3);
    },
  );
});

test("sessions walk skips symlinked directories", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-symlink-walk-"));
  const rawSessionDir = join(root, "raw-sessions");
  const outside = join(root, "outside");
  try {
    mkdirSync(rawSessionDir);
    mkdirSync(outside);
    writeFileSync(
      join(rawSessionDir, "real.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "real session needle" },
      }) + "\n",
    );
    writeFileSync(
      join(outside, "leak.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "outside leak needle" },
      }) + "\n",
    );
    symlinkSync(outside, join(rawSessionDir, "evil-link"));
    const result = searchDcpRecall({ query: "needle", scope: "all", rawSessionDir });
    expect(result.rendered).toContain("real session needle");
    expect(result.rendered).not.toContain("outside leak needle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expand rejects indices outside the available entries", () => {
  withSession(
    [
      {
        type: "message",
        message: { role: "user", content: "only entry" },
        timestamp: "2024-12-03T14:10:00.000Z",
      },
    ],
    (sessionFile) => {
      const result = searchDcpRecall({ sessionFile, expand: [1, 999] });
      expect(result.entries).toHaveLength(0);
      expect(result.rendered).toContain("Cannot expand indices");
      expect(result.rendered).toContain("999");
    },
  );
});

test("session file rewrites are re-parsed (sig-keyed cache invalidates)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-cache-"));
  const sessionFile = join(dir, "session.jsonl");
  try {
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "first content needle" },
      }) + "\n",
    );
    const first = searchDcpRecall({ sessionFile, query: "needle" });
    expect(first.rendered).toContain("first content needle");

    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "second content needle that is much longer" },
      }) + "\n",
    );
    const second = searchDcpRecall({ sessionFile, query: "needle" });
    expect(second.rendered).toContain("second content needle that is much longer");
    expect(second.rendered).not.toContain("first content needle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexes pi-task history metadata for exact provenance recall", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-task-history-"));
  const previousCwd = process.cwd();
  const taskId = "fixture-task-provenance-unique";
  const description = "Review fixture task provenance unique";
  const taskDir = join(root, ".pi", "artifacts", "tasks", "sessions", taskId);
  const rawSessionDir = join(root, "raw-sessions");
  const rawSession = join(rawSessionDir, "session.jsonl");
  const transcript = join(taskDir, "session.jsonl");
  try {
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(rawSessionDir);
    writeFileSync(rawSession, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: description }] } })}\n`);
    writeFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Mergeable with cited evidence." }] } })}\n`);
    writeFileSync(join(root, ".pi", "task-session-history.json"), JSON.stringify([
      {
        id: taskId,
        agentType: "reviewer",
        description,
        status: "done",
        reportedStatus: "success",
        startedAt: 100,
        completedAt: 200,
      },
    ]));
    process.chdir(root);

    const result = searchDcpRecall({ query: description, scope: "all", limit: 10, rawSessionDir });
    const taskEntry = result.entries[0];

    expect(taskEntry?.role).toBe("task");
    expect(taskEntry?.text).toContain(taskId);
    expect(taskEntry?.text).toContain("reported status: success");
    expect(taskEntry?.text).toContain(transcript);
    expect(result.rendered).toContain("[task:reviewer:done]");
    expect(new Set(result.entries.map((entry) => entry.index)).size).toBe(result.entries.length);

    const active = searchDcpRecall({ sessionFile: rawSession, query: description, scope: "active" });
    expect(active.entries.some((entry) => entry.role === "task")).toBeFalse();

    process.chdir(join(root, ".pi"));
    const fromPiCwd = searchDcpRecall({ query: description, scope: "all", rawSessionDir });
    expect(fromPiCwd.entries[0]?.role).toBe("task");
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not inherit task history from an ancestor project", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-nearest-project-"));
  const previousCwd = process.cwd();
  const inner = join(root, "inner");
  const rawSessionDir = join(root, "raw-sessions");
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    mkdirSync(join(inner, ".pi"), { recursive: true });
    mkdirSync(rawSessionDir);
    writeFileSync(join(root, ".pi", "task-session-history.json"), JSON.stringify([
      { id: "outer-task", agentType: "reviewer", description: "outer provenance sentinel", status: "done" },
    ]));
    process.chdir(inner);

    const result = searchDcpRecall({ query: "outer provenance sentinel", scope: "all", rawSessionDir });
    expect(result.entries.some((entry) => entry.role === "task")).toBeFalse();
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial task metadata does not outrank an exact session match", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-task-ranking-"));
  const rawSessionDir = join(root, "raw-sessions");
  const historyFile = join(root, ".pi", "task-session-history.json");
  try {
    mkdirSync(rawSessionDir, { recursive: true });
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(rawSessionDir, "session.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "needle exact target" }] } })}\n`);
    writeFileSync(historyFile, JSON.stringify([
      { id: "partial-task", agentType: "reviewer", description: "needle", status: "done" },
    ]));

    const result = searchDcpRecall({
      query: "needle exact target",
      scope: "all",
      rawSessionDir,
      taskHistoryFile: historyFile,
    });
    expect(result.entries[0]?.role).toBe("assistant");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task provenance rejects unsafe metadata and external transcript paths", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-task-safety-"));
  const previousCwd = process.cwd();
  const piDir = join(root, ".pi");
  const tasksDir = join(piDir, "artifacts", "tasks");
  const sessionsDir = join(tasksDir, "sessions");
  const rawSessionDir = join(root, "raw-sessions");
  const outside = join(root, "outside");
  const historyFile = join(piDir, "task-session-history.json");
  try {
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(rawSessionDir);
    mkdirSync(outside);
    writeFileSync(join(tasksDir, "leak.jsonl"), "{}\n");
    writeFileSync(join(outside, "outside.jsonl"), "{}\n");
    symlinkSync(outside, join(sessionsDir, "symlink-task"));
    mkdirSync(join(sessionsDir, "multiple-task"));
    writeFileSync(join(sessionsDir, "multiple-task", "a.jsonl"), "{}\n");
    writeFileSync(join(sessionsDir, "multiple-task", "b.jsonl"), "{}\n");
    writeFileSync(historyFile, JSON.stringify([
      { id: "..", agentType: "reviewer", description: "unsafe provenance traversal", status: "done" },
      { id: "symlink-task", agentType: "reviewer", description: "unsafe provenance symlink", status: "done" },
      { id: "multiple-task", agentType: "reviewer", description: "unsafe provenance multiple", status: "done" },
      { id: "forged-task", agentType: "reviewer", description: "unsafe provenance\nforged section", status: "done" },
      { id: "unicode-task", agentType: "reviewer", description: "unsafe provenance\u2028forged unicode", status: "done" },
    ]));
    process.chdir(root);

    const result = searchDcpRecall({ query: "unsafe provenance", scope: "all", limit: 20, rawSessionDir });
    expect(result.entries.some((entry) => entry.text.includes("task id: .."))).toBeFalse();
    expect(result.entries.some((entry) => entry.text.includes("forged section"))).toBeFalse();
    expect(result.entries.some((entry) => entry.text.includes("forged unicode"))).toBeFalse();
    for (const id of ["symlink-task", "multiple-task"]) {
      const entry = result.entries.find((candidate) => candidate.text.includes(`task id: ${id}`));
      expect(entry?.text).not.toContain("transcript:");
      expect(entry?.path).toBe(realpathSync.native(historyFile));
    }
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("task transcript lookup rejects symlinked ancestor directories", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-task-ancestor-symlink-"));
  const piDir = join(root, ".pi");
  const outsideArtifacts = join(root, "outside-artifacts");
  const taskId = "ancestor-symlink-task";
  const taskDir = join(outsideArtifacts, "tasks", "sessions", taskId);
  const historyFile = join(piDir, "task-session-history.json");
  const rawSessionDir = join(root, "raw-sessions");
  try {
    mkdirSync(piDir);
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(rawSessionDir);
    writeFileSync(join(taskDir, "outside.jsonl"), "{}\n");
    symlinkSync(outsideArtifacts, join(piDir, "artifacts"));
    writeFileSync(historyFile, JSON.stringify([
      { id: taskId, agentType: "reviewer", description: "ancestor symlink provenance", status: "done" },
    ]));

    const result = searchDcpRecall({
      query: "ancestor symlink provenance",
      scope: "all",
      rawSessionDir,
      taskHistoryFile: historyFile,
    });
    expect(result.entries[0]?.role).toBe("task");
    expect(result.entries[0]?.text).not.toContain("transcript:");
    expect(result.entries[0]?.path).toBe(historyFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excludes extension state and assistant thinking while retaining visible messages", () => {
  withSession(
    [
      {
        type: "custom",
        customType: "other-extension-state",
        data: { private: true },
        timestamp: 1,
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "Visible assistant answer" },
          ],
        },
        timestamp: 2,
      },
    ],
    (sessionFile) => {
      const result = searchDcpRecall({ sessionFile });

      expect(result.rendered).toContain("Visible assistant answer");
      expect(result.rendered).not.toContain("hidden reasoning");
      expect(result.rendered).not.toContain("other-extension-state");
    },
  );
});
