import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { defaultSessionDirName } from "../lib/agent-dir.js";
import { expect } from "../tests/expect.js";
import { isPathWithin, searchDcpRecall, activeLineageIds } from "./recall.js";

/** A v3 session header, as pi writes the first line of every session file. */
const sessionHeader = (cwd: string, id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd });
const userLine = (text: string, id?: string, timestamp = "2026-09-01T00:00:01.000Z") =>
  JSON.stringify({ type: "message", ...(id ? { id } : {}), timestamp, message: { role: "user", content: text } });

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

test("scope:'project' searches this repository's earlier sessions, scope:'all' every project's", () => {
  const root = mkdtempSync(join(tmpdir(), "dcp-scope-"));
  const sessions = join(root, "sessions");
  const thisProject = join(sessions, "--repo-a--");
  const otherProject = join(sessions, "--repo-b--");
  try {
    mkdirSync(thisProject, { recursive: true });
    mkdirSync(otherProject, { recursive: true });
    const line = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;
    writeFileSync(join(thisProject, "old.jsonl"), line("earlier session needle in repo a"));
    writeFileSync(join(thisProject, "live.jsonl"), line("live session needle in repo a"));
    writeFileSync(join(otherProject, "far.jsonl"), line("needle from repo b"));

    const active = searchDcpRecall({ sessionFile: join(thisProject, "live.jsonl"), query: "needle", scope: "active" });
    expect(active.total).toBe(1);
    expect(active.rendered).toContain("live session needle");

    const project = searchDcpRecall({
      sessionFile: join(thisProject, "live.jsonl"),
      projectSessionDir: thisProject,
      rawSessionDir: sessions,
      query: "needle",
      scope: "project",
    });
    expect(project.total).toBe(2);
    expect(project.rendered).toContain("earlier session needle");
    expect(project.rendered).not.toContain("repo b");

    const all = searchDcpRecall({ projectSessionDir: thisProject, rawSessionDir: sessions, query: "needle", scope: "all" });
    expect(all.total).toBe(3);
    expect(all.rendered).toContain("repo b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("scope:'project' reads subdirectory launches and drops a same-prefix sibling repository", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-project-dirs-")));
  const sessions = join(root, "sessions");
  const repo = join(root, "work", "repo");
  const dirFor = (cwd: string) => join(sessions, defaultSessionDirName(cwd));
  try {
    for (const cwd of [repo, join(repo, "sub"), `${repo}-other`]) mkdirSync(dirFor(cwd), { recursive: true });
    writeFileSync(join(dirFor(repo), "a.jsonl"), [sessionHeader(repo, "s1"), userLine("root launch needle")].join("\n"));
    writeFileSync(join(dirFor(join(repo, "sub")), "b.jsonl"), [sessionHeader(join(repo, "sub"), "s2"), userLine("subdirectory launch needle")].join("\n"));
    writeFileSync(join(dirFor(`${repo}-other`), "c.jsonl"), [sessionHeader(`${repo}-other`, "s3"), userLine("other repository needle")].join("\n"));

    const result = searchDcpRecall({
      scope: "project",
      query: "needle",
      projectSessionDir: dirFor(repo),
      projectRoots: [repo],
      rawSessionDir: sessions,
      taskHistoryFile: join(root, "no-history.json"),
    });
    expect(result.total).toBe(2);
    expect(result.rendered).toContain("root launch needle");
    expect(result.rendered).toContain("subdirectory launch needle");
    expect(result.rendered).not.toContain("other repository needle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shared custom session dir: project keeps this repository's files, all includes the dir", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-custom-dir-")));
  const flat = join(root, "custom-sessions");
  const repo = join(root, "work", "repo");
  const noHistory = join(root, "no-history.json");
  try {
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "mine.jsonl"), [sessionHeader(join(repo, "packages", "a"), "s1"), userLine("mine needle")].join("\n"));
    writeFileSync(join(flat, "theirs.jsonl"), [sessionHeader(join(root, "work", "elsewhere"), "s2"), userLine("theirs needle")].join("\n"));
    writeFileSync(join(flat, "legacy.jsonl"), userLine("headerless legacy needle"));

    const project = searchDcpRecall({ scope: "project", query: "needle", projectSessionDir: flat, projectRoots: [repo], taskHistoryFile: noHistory });
    expect(project.rendered).toContain("mine needle");
    expect(project.rendered).toContain("headerless legacy needle");
    expect(project.rendered).not.toContain("theirs needle");

    const all = searchDcpRecall({ scope: "all", query: "theirs", projectSessionDir: flat, rawSessionDir: join(root, "sessions"), taskHistoryFile: noHistory });
    expect(all.rendered).toContain("theirs needle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entries a fork copied into a new session file count once", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-fork-")));
  const repo = join(root, "repo");
  const dir = join(root, "sessions", defaultSessionDirName(repo));
  try {
    mkdirSync(dir, { recursive: true });
    const copied = userLine("copied turn needle", "e1");
    writeFileSync(join(dir, "original.jsonl"), [sessionHeader(repo, "s1"), copied].join("\n"));
    writeFileSync(join(dir, "fork.jsonl"), [sessionHeader(repo, "s2"), copied, userLine("fork-only needle", "e2", "2026-09-01T00:05:00.000Z")].join("\n"));

    const result = searchDcpRecall({ scope: "project", query: "needle", projectSessionDir: dir, projectRoots: [repo], taskHistoryFile: join(root, "none.json") });
    expect(result.total).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file-cap cut is reported, and a miss says it is not evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-cap-"));
  try {
    for (const name of ["one", "two", "three"]) writeFileSync(join(dir, `${name}.jsonl`), userLine(`capped ${name} needle`));
    const capped = searchDcpRecall({ scope: "project", query: "needle", projectSessionDir: dir, fileCap: 2, taskHistoryFile: join(dir, "none.json") });
    expect(capped.scannedFiles).toBe(2);
    expect(capped.totalFiles).toBe(3);
    expect(capped.rendered).toContain("Scanned the newest 2 of 3 session files");

    const miss = searchDcpRecall({ scope: "project", query: "zzz-absent-token", projectSessionDir: dir, taskHistoryFile: join(dir, "none.json") });
    expect(miss.rendered).toContain("A miss is not evidence it never happened");
    expect(miss.rendered).toContain("scope:'all'");
    expect(miss.rendered).not.toContain("Scanned the newest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-call paths and commands, user shell runs, and branch summaries are searchable", () => {
  withSession(
    [
      {
        type: "message",
        id: "t1",
        timestamp: 1,
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/billing/invoice.ts", oldText: "private edit body" } }] },
      },
      {
        type: "message",
        id: "t2",
        timestamp: 2,
        message: { role: "bashExecution", command: "npm run sync:check", output: "lock drift", exitCode: 1, cancelled: false, truncated: false, timestamp: 2 },
      },
      { type: "branch_summary", id: "t3", fromId: "t1", timestamp: 3, summary: "Abandoned branch tried a wrapper layer" },
    ],
    (sessionFile) => {
      const byPath = searchDcpRecall({ sessionFile, query: "invoice" });
      expect(byPath.rendered).toContain('tool call: edit path="src/billing/invoice.ts"');
      expect(byPath.rendered).not.toContain("private edit body");

      const shell = searchDcpRecall({ sessionFile, query: "sync" });
      expect(shell.rendered).toContain("$ npm run sync:check");
      expect(shell.rendered).toContain("exit code: 1");

      const browse = searchDcpRecall({ sessionFile });
      expect(browse.rendered).toContain("Abandoned branch tried a wrapper layer");
    },
  );
});

test("projectRootSpellings: empty outside a git checkout, the repository root inside one", async () => {
  const { projectRootSpellings } = await import("./recall.js");
  const outside = mkdtempSync(join(tmpdir(), "dcp-no-git-"));
  try {
    expect(projectRootSpellings(outside)).toEqual([]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const repoRoot = realpathSync.native(join(import.meta.dirname, "..", "..", ".."));
  expect(projectRootSpellings(import.meta.dirname)).toContain(repoRoot);
});

test("a session whose cwd was deleted still matches through the symlinked spelling of the root", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-link-")));
  const realRepo = join(root, "real", "repo");
  const linkRepo = join(root, "link", "repo");
  try {
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const active = join(root, "sessions", defaultSessionDirName(linkRepo));
    const gone = join(root, "sessions", defaultSessionDirName(join(linkRepo, "gone")));
    mkdirSync(active, { recursive: true });
    mkdirSync(gone, { recursive: true });
    writeFileSync(join(gone, "old.jsonl"), [sessionHeader(join(linkRepo, "gone"), "s1"), userLine("deleted subdirectory needle")].join("\n"));

    const result = searchDcpRecall({ scope: "project", query: "needle", projectSessionDir: active, projectRoots: [linkRepo, realRepo], taskHistoryFile: join(root, "none.json") });
    expect(result.rendered).toContain("deleted subdirectory needle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user runs excluded from context (!!cmd) stay out of recall", () => {
  withSession(
    [
      {
        type: "message",
        id: "b1",
        timestamp: 1,
        message: { role: "bashExecution", command: "cat private-notes.txt", output: "hidden output marker", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 },
      },
    ],
    (sessionFile) => {
      expect(searchDcpRecall({ sessionFile, query: "private-notes" }).total).toBe(0);
      expect(searchDcpRecall({ sessionFile, query: "hidden output marker" }).total).toBe(0);
    },
  );
});

test("entries without a timestamp are never merged by id", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-no-timestamp-"));
  try {
    const line = (text: string) => JSON.stringify({ type: "message", id: "same", message: { role: "user", content: text } });
    writeFileSync(join(dir, "a.jsonl"), line("first foreign needle"));
    writeFileSync(join(dir, "b.jsonl"), line("second foreign needle"));
    const result = searchDcpRecall({ scope: "project", query: "needle", projectSessionDir: dir, taskHistoryFile: join(dir, "none.json") });
    expect(result.total).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
