import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { defaultSessionDirName } from "../lib/agent-dir.js";
import { expect } from "../tests/expect.js";
import { activeLineageIds, isPathWithin, projectRootSpellings, registerRecallTool, searchDcpRecall } from "./recall.js";

/** A v3 session header, as pi writes the first line of every session file. */
const sessionHeader = (cwd: string, id: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd });
const userLine = (text: string, id?: string, timestamp = "2026-09-01T00:00:01.000Z") =>
	JSON.stringify({ type: "message", ...(id ? { id } : {}), timestamp, message: { role: "user", content: text } });

/** A `SessionTreeNode` as pi's `getTree()` returns it: `{ entry, children }`. */
const treeNode = (id: string, parentId: string | null, children: unknown[] = []) => ({
	entry: { type: "message", id, parentId, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: id } },
	children,
});

function withSession(entries: unknown[], run: (sessionFile: string) => void): void {
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
				summary: "Retain the recall-only extension and remove dormant compression code.",
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

test("activeLineageIds walks pi's nested SessionTreeNode chain and ignores dead branches", () => {
	// pi's getTree() returns SessionTreeNode = { entry: { id, parentId }, children },
	// a nested forest — NOT a flat {id,parentId}[]. A flat fixture here is what let
	// the shape mismatch ship: it walked nothing and returned an empty Set.
	const tree = [
		treeNode("a", null, [
			treeNode("b", "a", [treeNode("c", "b")]),
			treeNode("x", "a"), // superseded branch
		]),
	];
	expect(activeLineageIds({ getTree: () => tree, getLeafId: () => "c" })).toEqual(new Set(["a", "b", "c"]));
	expect(activeLineageIds({})).toBeUndefined();
	expect(
		activeLineageIds({
			getTree: () => {
				throw new Error("boom");
			},
			getLeafId: () => "a",
		}),
	).toBeUndefined();
	// "no lineage walked" must mean "no filter": an empty Set would exclude every
	// entry downstream and render the search as a miss.
	expect(activeLineageIds({ getTree: () => tree, getLeafId: () => "absent" })).toBeUndefined();
	expect(activeLineageIds({ getTree: () => [], getLeafId: () => "c" })).toBeUndefined();
	// an orphaned entry is a root: its own chain still resolves
	expect(activeLineageIds({ getTree: () => [treeNode("orphan", "gone")], getLeafId: () => "orphan" })).toEqual(new Set(["orphan"]));
});

test("the registered recall tool resolves the active lineage end to end", async () => {
	// The tool's `execute` was never exercised by any test; the wiring it owns
	// (ctx.sessionManager -> activeLineageIds -> lineageEntryIds) is where the
	// default scope silently returned nothing.
	const entries = [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: "2026-09-01T00:00:01.000Z",
			message: { role: "user", content: "needle kept branch" },
		},
		{ type: "message", id: "b", parentId: "a", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "assistant", content: "ack" } },
		{
			type: "message",
			id: "x",
			parentId: "a",
			timestamp: "2026-09-01T00:00:03.000Z",
			message: { role: "user", content: "needle abandoned branch" },
		},
		{
			type: "message",
			id: "c",
			parentId: "b",
			timestamp: "2026-09-01T00:00:04.000Z",
			message: { role: "user", content: "needle at the leaf" },
		},
	];
	const dir = mkdtempSync(join(tmpdir(), "dcp-exec-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));

		const tree = [
			{
				entry: entries[0],
				children: [
					{ entry: entries[1], children: [{ entry: entries[3], children: [] }] },
					{ entry: entries[2], children: [] },
				],
			},
		];

		const registered: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
		registerRecallTool({
			registerTool: (tool: unknown) => registered.push(tool as (typeof registered)[number]),
			on() {},
			appendEntry() {},
		} as never);

		const result = await registered[0]!.execute("call-1", { query: "needle" }, undefined, undefined, {
			cwd: dir,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionDir: () => dir,
				getTree: () => tree,
				getLeafId: () => "c",
			},
		});
		const rendered = result.content[0]!.text;
		expect(rendered).toContain("needle at the leaf");
		expect(rendered).toContain("needle kept branch");
		// the superseded branch is not in the live lineage
		expect(rendered.includes("needle abandoned branch")).toBeFalse();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: "real session needle" },
			})}\n`,
		);
		writeFileSync(
			join(outside, "leak.jsonl"),
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: "outside leak needle" },
			})}\n`,
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
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: "first content needle" },
			})}\n`,
		);
		const first = searchDcpRecall({ sessionFile, query: "needle" });
		expect(first.rendered).toContain("first content needle");

		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: "second content needle that is much longer" },
			})}\n`,
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
		writeFileSync(
			rawSession,
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: description }] } })}\n`,
		);
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Mergeable with cited evidence." }] } })}\n`,
		);
		writeFileSync(
			join(root, ".pi", "task-session-history.json"),
			JSON.stringify([
				{
					id: taskId,
					agentType: "reviewer",
					description,
					status: "done",
					reportedStatus: "success",
					startedAt: 100,
					completedAt: 200,
				},
			]),
		);
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
		writeFileSync(
			join(root, ".pi", "task-session-history.json"),
			JSON.stringify([{ id: "outer-task", agentType: "reviewer", description: "outer provenance sentinel", status: "done" }]),
		);
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
		writeFileSync(
			join(rawSessionDir, "session.jsonl"),
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "needle exact target" }] } })}\n`,
		);
		writeFileSync(historyFile, JSON.stringify([{ id: "partial-task", agentType: "reviewer", description: "needle", status: "done" }]));

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
		writeFileSync(
			historyFile,
			JSON.stringify([
				{ id: "..", agentType: "reviewer", description: "unsafe provenance traversal", status: "done" },
				{ id: "symlink-task", agentType: "reviewer", description: "unsafe provenance symlink", status: "done" },
				{ id: "multiple-task", agentType: "reviewer", description: "unsafe provenance multiple", status: "done" },
				{ id: "forged-task", agentType: "reviewer", description: "unsafe provenance\nforged section", status: "done" },
				{ id: "unicode-task", agentType: "reviewer", description: "unsafe provenance\u2028forged unicode", status: "done" },
				{ id: "control-task", agentType: "reviewer", description: "unsafe provenance\u0000forged control", status: "done" },
			]),
		);
		process.chdir(root);

		const result = searchDcpRecall({ query: "unsafe provenance", scope: "all", limit: 20, rawSessionDir });
		expect(result.entries.some((entry) => entry.text.includes("task id: .."))).toBeFalse();
		// Newlines and Unicode line separators are whitespace: the row is indexed
		// with the description flattened onto one line (no forged second line)
		// instead of the whole row being dropped.
		const forged = result.entries.find((entry) => entry.text.includes("task id: forged-task"));
		expect(forged?.text).toContain("description: unsafe provenance forged section");
		expect(forged?.text.includes("\nforged section")).toBeFalse();
		const unicode = result.entries.find((entry) => entry.text.includes("task id: unicode-task"));
		expect(unicode?.text).toContain("description: unsafe provenance forged unicode");
		// A non-whitespace control character is still rejected outright.
		expect(result.entries.some((entry) => entry.text.includes("task id: control-task"))).toBeFalse();
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
		writeFileSync(
			historyFile,
			JSON.stringify([{ id: taskId, agentType: "reviewer", description: "ancestor symlink provenance", status: "done" }]),
		);

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
		writeFileSync(
			join(dirFor(join(repo, "sub")), "b.jsonl"),
			[sessionHeader(join(repo, "sub"), "s2"), userLine("subdirectory launch needle")].join("\n"),
		);
		writeFileSync(
			join(dirFor(`${repo}-other`), "c.jsonl"),
			[sessionHeader(`${repo}-other`, "s3"), userLine("other repository needle")].join("\n"),
		);

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

		const project = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: flat,
			projectRoots: [repo],
			taskHistoryFile: noHistory,
		});
		expect(project.rendered).toContain("mine needle");
		expect(project.rendered).toContain("headerless legacy needle");
		expect(project.rendered).not.toContain("theirs needle");

		const all = searchDcpRecall({
			scope: "all",
			query: "theirs",
			projectSessionDir: flat,
			rawSessionDir: join(root, "sessions"),
			taskHistoryFile: noHistory,
		});
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
		writeFileSync(
			join(dir, "fork.jsonl"),
			[sessionHeader(repo, "s2"), copied, userLine("fork-only needle", "e2", "2026-09-01T00:05:00.000Z")].join("\n"),
		);

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: dir,
			projectRoots: [repo],
			taskHistoryFile: join(root, "none.json"),
		});
		expect(result.total).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a file-cap cut is reported, and a miss says it is not evidence", () => {
	const dir = mkdtempSync(join(tmpdir(), "dcp-cap-"));
	try {
		for (const name of ["one", "two", "three"]) writeFileSync(join(dir, `${name}.jsonl`), userLine(`capped ${name} needle`));
		const capped = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: dir,
			fileCap: 2,
			taskHistoryFile: join(dir, "none.json"),
		});
		expect(capped.scannedFiles).toBe(2);
		expect(capped.totalFiles).toBe(3);
		expect(capped.rendered).toContain("Scanned the newest 2 of 3 session files");

		const miss = searchDcpRecall({
			scope: "project",
			query: "zzz-absent-token",
			projectSessionDir: dir,
			taskHistoryFile: join(dir, "none.json"),
		});
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
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/billing/invoice.ts", oldText: "private edit body" } },
					],
				},
			},
			{
				type: "message",
				id: "t2",
				timestamp: 2,
				message: {
					role: "bashExecution",
					command: "npm run sync:check",
					output: "lock drift",
					exitCode: 1,
					cancelled: false,
					truncated: false,
					timestamp: 2,
				},
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
		writeFileSync(
			join(gone, "old.jsonl"),
			[sessionHeader(join(linkRepo, "gone"), "s1"), userLine("deleted subdirectory needle")].join("\n"),
		);

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: active,
			projectRoots: [linkRepo, realRepo],
			taskHistoryFile: join(root, "none.json"),
		});
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
				message: {
					role: "bashExecution",
					command: "cat private-notes.txt",
					output: "hidden output marker",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: 1,
				},
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

test("a limit cut is disclosed and total still reports every match", () => {
	const entries = [1, 2, 3].map((n) => ({
		type: "message",
		id: `m${n}`,
		parentId: n === 1 ? null : `m${n - 1}`,
		timestamp: `2026-09-01T00:00:0${n}.000Z`,
		message: { role: "user", content: `needle number ${n}` },
	}));
	withSession(entries, (sessionFile) => {
		const all = searchDcpRecall({ sessionFile, query: "needle", scope: "active" });
		expect(all.total).toBe(3);

		// limit is now visible: the header keeps the true match count and the cut
		// is named, so a truncated page cannot read as "that is all there is".
		const capped = searchDcpRecall({ sessionFile, query: "needle", scope: "active", limit: 2 });
		expect(capped.total).toBe(3);
		expect(capped.rendered).toContain("Showing the first 2 of 3 matches (limit)");
		expect(capped.entries).toHaveLength(2);

		expect(searchDcpRecall({ sessionFile, query: "needle", scope: "active", limit: 0 }).rendered).toContain(
			"Showing the first 0 of 3 matches (limit)",
		);

		// a negative limit used to slice(0, -n) and silently drop the tail
		const negative = searchDcpRecall({ sessionFile, query: "needle", scope: "active", limit: -5 });
		expect(negative.total).toBe(3);
		expect(negative.rendered.includes("Showing the first")).toBeFalse();

		// NaN page used to slice(NaN, NaN) and render an empty "page NaN"
		const nanPage = searchDcpRecall({ sessionFile, query: "needle", scope: "active", page: Number.NaN });
		expect(nanPage.rendered).toContain("(page 1)");
		expect(nanPage.entries).toHaveLength(3);
	});
});

test("only .jsonl session files are scanned; a stray .json is not", () => {
	const root = mkdtempSync(join(tmpdir(), "dcp-jsonl-only-"));
	const sessions = join(root, "sessions");
	try {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "real.jsonl"), `${userLine("needle from a jsonl session")}\n`);
		// pretty-printed JSON: line-splitting it would index each fragment as an entry
		writeFileSync(join(sessions, "stray.json"), JSON.stringify({ note: "needle from a stray json" }, null, 2));
		const result = searchDcpRecall({ rawSessionDir: sessions, query: "needle", scope: "all" });
		expect(result.total).toBe(1);
		expect(result.rendered).toContain("needle from a jsonl session");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session header longer than 16 KB still yields its cwd for scope:'project'", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-large-header-")));
	const repo = join(root, "repo");
	const sub = join(repo, "sub");
	const base = join(root, "sessions", defaultSessionDirName(repo));
	const sibling = join(root, "sessions", defaultSessionDirName(sub));
	try {
		mkdirSync(base, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		// A 20 KB header line. The sibling directory is only kept because the
		// header cwd is read; a 16 KB truncation makes JSON.parse fail, yields
		// "no cwd", and the subdirectory session is dropped.
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "big",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: sub,
			padding: "x".repeat(20 * 1024),
		});
		writeFileSync(join(sibling, "big.jsonl"), [header, userLine("long header needle")].join("\n"));

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: base,
			projectRoots: [repo],
			taskHistoryFile: join(root, "none.json"),
		});
		expect(result.rendered).toContain("long header needle");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a BOM-prefixed session header still yields its cwd", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-bom-header-")));
	const repo = join(root, "repo");
	const sub = join(repo, "sub");
	const base = join(root, "sessions", defaultSessionDirName(repo));
	const sibling = join(root, "sessions", defaultSessionDirName(sub));
	try {
		mkdirSync(base, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		// JSON.parse rejects a leading BOM; without stripping it the header cwd is
		// lost and the subdirectory session is dropped.
		writeFileSync(join(sibling, "bom.jsonl"), [`\uFEFF${sessionHeader(sub, "bom")}`, userLine("bom header needle")].join("\n"));

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: base,
			projectRoots: [repo],
			taskHistoryFile: join(root, "none.json"),
		});
		expect(result.rendered).toContain("bom header needle");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session file above the read cap is skipped and never claimed as searched", () => {
	const root = mkdtempSync(join(tmpdir(), "dcp-read-cap-"));
	try {
		writeFileSync(join(root, "small.jsonl"), userLine("small session needle"));
		writeFileSync(join(root, "huge.jsonl"), userLine(`huge session needle ${"x".repeat(400)}`));

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: root,
			readCapBytes: 200,
			taskHistoryFile: join(root, "none.json"),
		});
		expect(result.rendered).toContain("small session needle");
		expect(result.rendered).not.toContain("huge session needle");
		expect(result.rendered).toContain("1 session file exceeded the read cap and was not searched.");
		// Honest coverage: the skipped file is not counted as scanned.
		expect(result.scannedFiles).toBe(1);
		expect(result.totalFiles).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a cwd symlinked into a repository subdirectory does not widen the project root", () => {
	const base = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-link-into-")));
	const realRepo = join(base, "real", "repo");
	const sub = join(realRepo, "src");
	const link = join(base, "proj");
	try {
		mkdirSync(sub, { recursive: true });
		const init = spawnSync("git", ["init", "-q"], { cwd: realRepo, encoding: "utf8" });
		expect(init.status).toBe(0);
		symlinkSync(sub, link);

		const spellings = projectRootSpellings(link);
		expect(spellings).toContain(realRepo);
		// The rewrite of root through the symlink lands on `base`, an ancestor of
		// every unrelated project: adopting it would accept their sessions.
		expect(spellings.includes(base)).toBeFalse();
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("unrelated entries sharing an id and timestamp but not text are not merged", () => {
	const dir = mkdtempSync(join(tmpdir(), "dcp-id-collision-"));
	try {
		const shared = { type: "message", id: "abcd1234", timestamp: "2026-09-01T00:00:01.000Z" };
		writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ ...shared, message: { role: "user", content: "foreign alpha needle" } }));
		writeFileSync(join(dir, "b.jsonl"), JSON.stringify({ ...shared, message: { role: "user", content: "foreign beta needle" } }));

		const result = searchDcpRecall({
			scope: "project",
			query: "needle",
			projectSessionDir: dir,
			taskHistoryFile: join(dir, "none.json"),
		});
		expect(result.total).toBe(2);
		expect(result.rendered).toContain("foreign alpha needle");
		expect(result.rendered).toContain("foreign beta needle");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a multi-line task description is normalized and indexed instead of dropped", () => {
	const root = mkdtempSync(join(tmpdir(), "dcp-multiline-task-"));
	const rawSessionDir = join(root, "raw-sessions");
	const historyFile = join(root, ".pi", "task-session-history.json");
	try {
		mkdirSync(rawSessionDir, { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(
			historyFile,
			JSON.stringify([
				{
					id: "multiline-task",
					agentType: "reviewer",
					description: "first line needle\nsecond line detail\tthird",
					status: "done",
				},
			]),
		);

		const result = searchDcpRecall({ query: "second line detail", scope: "all", rawSessionDir, taskHistoryFile: historyFile });
		const entry = result.entries.find((candidate) => candidate.role === "task");
		expect(entry).toBeDefined();
		expect(entry?.text).toContain("description: first line needle second line detail third");
		expect(entry?.taskDescription).toBe("first line needle second line detail third");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the registered recall tool resolves task provenance from ctx.cwd, not process.cwd()", async () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-exec-cwd-")));
	const neutral = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-exec-neutral-")));
	const previousCwd = process.cwd();
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "task-session-history.json"),
			JSON.stringify([{ id: "ctx-cwd-task", agentType: "reviewer", description: "ctx cwd provenance needle", status: "done" }]),
		);
		const registered: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
		registerRecallTool({
			registerTool: (tool: unknown) => registered.push(tool as (typeof registered)[number]),
			on() {},
			appendEntry() {},
		} as never);

		// process.cwd() has no task history; only ctx.cwd does.
		process.chdir(neutral);
		const result = await registered[0]!.execute("call-1", { query: "provenance needle", scope: "project" }, undefined, undefined, {
			cwd: root,
			sessionManager: { getSessionFile: () => undefined, getSessionDir: () => join(root, "sessions") },
		});
		expect(result.content[0]!.text).toContain("ctx cwd provenance needle");
	} finally {
		process.chdir(previousCwd);
		rmSync(root, { recursive: true, force: true });
		rmSync(neutral, { recursive: true, force: true });
	}
});

test("a task transcript lookup survives a racing delete between lstat and realpath", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcp-race-")));
	const piDir = join(root, ".pi");
	const taskId = "race-task";
	const historyFile = join(piDir, "task-session-history.json");
	const rawSessionDir = join(root, "raw-sessions");
	const originalNative = realpathSync.native;
	try {
		mkdirSync(join(piDir, "artifacts", "tasks", "sessions", taskId), { recursive: true });
		mkdirSync(rawSessionDir);
		writeFileSync(join(piDir, "artifacts", "tasks", "sessions", taskId, "session.jsonl"), "{}\n");
		writeFileSync(
			historyFile,
			JSON.stringify([{ id: taskId, agentType: "reviewer", description: "race transcript provenance needle", status: "done" }]),
		);

		// Simulate the race: lstat succeeds, then realpath hits ENOENT because the
		// task directory was removed in between.
		realpathSync.native = ((path: string) => {
			if (String(path).includes("artifacts")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return originalNative(path);
		}) as typeof realpathSync.native;

		const result = searchDcpRecall({ query: "race transcript provenance", scope: "all", rawSessionDir, taskHistoryFile: historyFile });
		const entry = result.entries.find((candidate) => candidate.role === "task");
		expect(entry).toBeDefined();
		expect(entry?.text).not.toContain("transcript:");
	} finally {
		realpathSync.native = originalNative;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session file larger than the stream chunk is read whole, boundary line included", () => {
	const dir = mkdtempSync(join(tmpdir(), "dcp-recall-chunk-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		// The reader streams in 1 MiB chunks. A line spanning the boundary is what a
		// naive reader loses or corrupts (the chunk buffer is reused by the next
		// read), and the padding is multi-byte on purpose: the split is on the raw
		// newline byte, so a UTF-8 sequence may straddle the boundary.
		const filler = Array.from({ length: 4_000 }, (_, i) =>
			JSON.stringify({ type: "message", message: { role: "user", content: `filler ${i} ${"é".repeat(120)}` } }),
		);
		const straddling = JSON.stringify({
			type: "message",
			message: { role: "user", content: `straddling needle ${"é".repeat(500_000)} end of the straddling line` },
		});
		writeFileSync(sessionFile, [...filler, straddling, userLine("final needle", "final-entry")].join("\n"));
		expect(statSync(sessionFile).size > 1024 * 1024).toBeTrue();

		const result = searchDcpRecall({ sessionFile, query: "needle" });
		expect(result.total).toBe(2);
		// the tail of a line that spans chunks is present, so nothing was dropped at
		// the boundary and the buffer was not reused under it
		expect(result.entries.some((entry) => entry.text.includes("end of the straddling line"))).toBeTrue();
		expect(result.entries.some((entry) => entry.text.includes("final needle"))).toBeTrue();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an interrupted scan stops early and reports its results as partial", () => {
	// Two roots, because the line cache is keyed by path: a baseline run that warmed
	// the cache would leave nothing for the abort to interrupt, and the test would
	// measure the cache instead of the streaming read.
	const baseline = mkdtempSync(join(tmpdir(), "dcp-recall-abort-base-"));
	const interrupted = mkdtempSync(join(tmpdir(), "dcp-recall-abort-"));
	const seed = (root: string) => {
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(root, `s${i}.jsonl`), `${sessionHeader(root, `s${i}`)}\n${userLine(`needle in file ${i}`, `e${i}`)}\n`);
		}
	};
	const options = (root: string, shouldStop?: () => boolean) => ({
		scope: "project" as const,
		query: "needle",
		projectSessionDir: root,
		rawSessionDir: root,
		taskHistoryFile: join(root, "none.json"),
		...(shouldStop ? { shouldStop } : {}),
	});
	try {
		seed(baseline);
		seed(interrupted);
		expect(searchDcpRecall(options(baseline)).total).toBe(4);

		// the predicate is consulted before every chunk read, so the scan stops
		// partway instead of finishing work nobody is waiting for
		let calls = 0;
		const aborted = searchDcpRecall(options(interrupted, () => calls++ >= 3));
		expect(aborted.rendered).toContain("The scan was interrupted after");
		expect(aborted.rendered).toContain("of 4 session files; these results are partial");
		expect(aborted.total < 4).toBeTrue();
		expect(aborted.scannedFiles < 4).toBeTrue();
		expect(aborted.total > 0).toBeTrue();
	} finally {
		rmSync(baseline, { recursive: true, force: true });
		rmSync(interrupted, { recursive: true, force: true });
	}
});

test("an interrupted read is not cached as if it were the whole file", () => {
	// The cache signature is (mtime, size), which does not change when a scan is
	// interrupted. Caching the prefix would serve every later search a truncated
	// file and silently lose the rest of the session — the exact failure recall
	// exists to prevent.
	const dir = mkdtempSync(join(tmpdir(), "dcp-recall-abort-cache-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const lines = [sessionHeader(dir, "big")];
		for (let i = 0; i < 20_000; i++) lines.push(userLine(`needle ${i}`, `e${i}`, new Date(1_700_000_000_000 + i).toISOString()));
		writeFileSync(sessionFile, lines.join("\n"));
		expect(statSync(sessionFile).size > 2 * 1024 * 1024).toBeTrue();

		let calls = 0;
		const partial = searchDcpRecall({ sessionFile, query: "needle", shouldStop: () => calls++ >= 1 });
		expect(partial.rendered).toContain("The scan was interrupted");
		expect(partial.total < 20_000).toBeTrue();

		// the whole file, from a cold-ish cache: the aborted prefix must not be it
		expect(searchDcpRecall({ sessionFile, query: "needle" }).total).toBe(20_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an over-long task description is indexed, and an over-long id is still rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "dcp-recall-long-meta-"));
	const piDir = join(root, ".pi");
	const historyFile = join(piDir, "task-session-history.json");
	const rawSessionDir = join(root, "raw-sessions");
	try {
		mkdirSync(piDir, { recursive: true });
		mkdirSync(rawSessionDir, { recursive: true });
		writeFileSync(
			historyFile,
			JSON.stringify([{ id: "t1", agentType: "reviewer", status: "done", description: `reconciliation ${"detail ".repeat(60)}tail` }]),
		);
		// A 300+ character description used to be dropped whole, leaving the task
		// unfindable by its own words; it is now truncated and searchable.
		const result = searchDcpRecall({ query: "reconciliation", scope: "all", rawSessionDir, taskHistoryFile: historyFile, cwd: root });
		expect(result.total).toBe(1);
		expect(result.entries[0]?.role).toBe("task");
		expect(result.entries[0]?.text).toContain("reconciliation");
		expect(result.entries[0]?.text).toContain("…");

		// Truncation must not invent an identifier: the ellipsis fails the id charset,
		// so a nonsense id is still rejected rather than indexed under a wrong one.
		writeFileSync(historyFile, JSON.stringify([{ id: "x".repeat(90), description: "short task", status: "done" }]));
		expect(searchDcpRecall({ query: "short task", scope: "all", rawSessionDir, taskHistoryFile: historyFile, cwd: root }).total).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
