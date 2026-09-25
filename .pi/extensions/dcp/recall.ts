import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Optional, Type } from "typebox";
import { agentDir, defaultSessionDirName } from "../lib/agent-dir.js";
import { gitTopLevel } from "../lib/repo-root.js";
import { hasSymlinkComponent, isPathWithin } from "./recall-path.js";
import { isBrowseDiagnostic, isLowSignalAcknowledgement, rankAndFilter } from "./recall-rank.js";
import { jsonlId, jsonlRole, jsonlText, jsonlTimestamp, renderExpanded, renderSearch, shouldIncludeJsonlEntry } from "./recall-render.js";

export { isPathWithin };

export interface RecallEntry {
	index: number;
	source: "jsonl" | "task";
	sessionKey?: string | undefined;
	role?: string | undefined;
	title: string;
	text: string;
	timestamp?: number | undefined;
	path?: string | undefined;
	taskDescription?: string | undefined;
}

interface RecallOptions {
	sessionFile?: string | undefined;
	query?: string | undefined;
	expand?: number[] | undefined;
	page?: number | undefined;
	scope?: RecallScope | undefined;
	limit?: number | undefined;
	/** Every project's sessions (scope:"all"); defaults to `<agentDir>/sessions`,
	 * where `PI_CODING_AGENT_DIR` moves the agent dir. */
	rawSessionDir?: string | undefined;
	/** The active session's directory (scope:"project"). pi's default layout
	 * keys it by launch cwd; a custom session dir (--session-dir,
	 * PI_CODING_AGENT_SESSION_DIR, settings sessionDir) is flat and shared. */
	projectSessionDir?: string | undefined;
	/** This repository's root, in every spelling a launch cwd may have used
	 * (symlinked and real). With it, scope:"project" also reads sessions
	 * launched from a subdirectory and keeps only files whose header cwd lies
	 * inside the repository. */
	projectRoots?: string[] | undefined;
	taskHistoryFile?: string | undefined;
	/** The launcher's cwd, as `ctx.cwd` reports it: task-history discovery must
	 * search from the same directory the scope/roots are derived from, not from
	 * `process.cwd()` (which an extension does not own). */
	cwd?: string | undefined;
	/** Override the per-file byte cap above which a session file is not read at
	 * all (see `LINE_READ_MAX_BYTES`); injectable so tests never build one. */
	readCapBytes?: number | undefined;
	/** Active-lineage entry ids from the session manager; entries outside
	 * the set are excluded when provided (dead branches stay searchable
	 * via scope:"all"). */
	lineageEntryIds?: Set<string> | undefined;
	/** Override the newest-first session file cap of the scope. */
	fileCap?: number | undefined;
	/** Consulted before each chunk read and before each file, so an interrupted
	 * call stops instead of finishing a scan nobody is waiting for. The tool
	 * passes the call's `AbortSignal` flag; injectable so a test can stop at a
	 * deterministic point. */
	shouldStop?: (() => boolean) | undefined;
}

export interface RecallResult {
	entries: RecallEntry[];
	rendered: string;
	total: number;
	/** Session files actually read vs. files in scope. Fewer can mean older
	 * sessions were cut by the newest-first cap, or that a file was too large to
	 * read (which the rendered result names separately). */
	scannedFiles: number;
	totalFiles: number;
}

export type RecallScope = "active" | "project" | "all";

const PAGE_SIZE = 5;
/** Matches addressable per search call before `limit` kicks in. */
const DEFAULT_ENTRY_LIMIT = 200;
/** Newest-first file caps per scope: this repo's history is small and
 * relevant; the whole session root (every project, hundreds of MB) is a last
 * resort. A cut is always reported in the rendered result. */
const FILE_CAP: Record<RecallScope, number> = { active: 1, project: 60, all: 200 };

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search persisted Pi session JSONL history (including native compaction summaries) and this project's pi-task provenance. Regex queries, pagination, expand. scope: 'active' (this session's live lineage, default), 'project' (every session of this repository), 'all' (every project on this machine).",
		promptSnippet: "Search exact Pi session history when compacted context may have omitted details.",

		promptGuidelines: [
			"Use recall before guessing about old compacted context.",
			"Search first, then call expand with result indices when you need exact full content.",
			"Widen scope in order: 'active' → 'project' (earlier sessions of this repo) → 'all' (other projects); each step is slower and noisier.",
		],
		parameters: Type.Object({
			query: Optional(
				Type.String({
					description: "Search query. Regex is supported; multi-word queries are OR-ranked.",
				}),
			),
			expand: Optional(
				Type.Array(Type.Number(), {
					description: "Recall indices to expand with full content.",
				}),
			),
			page: Optional(Type.Number({ description: "1-based page number for search results." })),
			scope: Optional(
				Type.Union([Type.Literal("active"), Type.Literal("project"), Type.Literal("all")], {
					description:
						"active: this session's live lineage (superseded branches excluded). project: every persisted session of this repository, newest first. all: every project's sessions on this machine.",
				}),
			),
			limit: Optional(
				Type.Number({
					description: "Maximum entries to return before pagination.",
				}),
			),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("⚙ recall")), 0, 0),
		async execute(
			_toolCallId: string,
			params: {
				query?: string;
				expand?: number[];
				page?: number;
				scope?: RecallScope;
				limit?: number;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const scope = params.scope ?? "active";
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const manager = ctx.sessionManager;
			const result = searchDcpRecall({
				sessionFile,
				cwd: ctx.cwd,
				projectSessionDir: manager.getSessionDir?.() ?? (sessionFile ? dirname(sessionFile) : undefined),
				projectRoots: scope === "project" ? projectRootSpellings(ctx.cwd) : undefined,
				lineageEntryIds: scope === "active" ? activeLineageIds(manager) : undefined,
				// scope:"all" on a busy machine walks hundreds of session files
				// synchronously; honouring the call's signal means an interrupt (or a
				// superseded cell) stops the scan instead of running it to the end.
				shouldStop: _signal ? () => _signal.aborted : undefined,
				...params,
			});

			return {
				content: [{ type: "text", text: result.rendered }],
				details: { total: result.total, entries: result.entries },
			};
		},
	});
}

/** The slice of pi's session manager that lineage walking needs, derived from
 * pi's own `ExtensionContext` so a shape change is a type error here rather
 * than a silently empty result at runtime. `getTree()` returns pi's
 * `SessionTreeNode[]` — `{ entry: { id, parentId }, children }` — NOT a flat
 * `{ id, parentId }` array; that mismatch is why this type is derived and not
 * hand-written. Test doubles may omit either method. */
export type LineageSessionManager = Partial<Pick<ExtensionContext["sessionManager"], "getTree" | "getLeafId">>;

/** The repository root as git reports it (real path) and as the launch cwd
 * spells it (possibly through a symlink such as /tmp → /private/tmp): pi
 * names session directories after the launch spelling. Empty outside a git
 * checkout: there is no repository to widen to, and launching from $HOME
 * would otherwise adopt every project under it as a subdirectory. */
export function projectRootSpellings(cwd: string): string[] {
	const root = gitTopLevel(cwd);
	if (!root) return [];
	const spellings = new Set([root]);
	try {
		// Re-spell the root through the launch cwd's symlinks: realpath(cwd) sits
		// somewhere inside the real root, so applying that same relative offset to
		// the spelled cwd reconstructs how a session launched through a symlinked
		// path recorded its cwd (e.g. /tmp → /private/tmp). A cwd that symlinks
		// *into* a subdirectory from an unrelated place rewrites to a broad
		// ancestor (e.g. /home/me/proj → /repo/src yields /home/me), which would
		// adopt unrelated sessions: keep the spelling only when it still names the
		// repository directory.
		const spelledRoot = resolve(cwd, relative(realpathSync.native(cwd), root));
		const rootName = basename(root);
		if (spelledRoot === root || (rootName !== "" && spelledRoot.split(/[\\/]/).includes(rootName))) spellings.add(spelledRoot);
	} catch {
		/* cwd vanished: the git spelling alone */
	}
	return [...spellings];
}

/** Active-lineage entry ids: walk the leaf-parent chain through the
 * session tree. Dead branches (retried/edited turns) stay excluded for
 * scope:"active"; returns undefined when the API is unavailable.
 *
 * Returns `undefined` — never an empty Set — when no lineage could be walked:
 * downstream, `lineageEntryIds` excludes every entry it does not contain, so an
 * empty Set means "match nothing". "No lineage" must mean "no filter". */
export function activeLineageIds(sessionManager: LineageSessionManager): Set<string> | undefined {
	try {
		const tree = sessionManager.getTree?.() ?? [];
		const leafId = sessionManager.getLeafId?.();
		if (!leafId) return undefined;
		// pi's getTree() returns a nested forest: roots at the top level with
		// `children` nested below. Walk it iteratively (pi does too) so a deep
		// session cannot overflow the stack, and index every entry so the
		// parentId chain below can be followed from the leaf back to its root.
		const byId = new Map<string, SessionTreeNode["entry"]>();
		const stack: SessionTreeNode[] = [...tree];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			byId.set(node.entry.id, node.entry);
			stack.push(...node.children);
		}
		const ids = new Set<string>();
		let current = byId.get(leafId);
		while (current) {
			ids.add(current.id);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return ids.size > 0 ? ids : undefined;
	} catch {
		return undefined;
	}
}

export function searchDcpRecall(options: RecallOptions): RecallResult {
	const scope = options.scope ?? "active";
	const sessionFiles = listRawSessionFiles(scope, options);
	const built = buildRecallEntries(sessionFiles.files, options.lineageEntryIds, options.readCapBytes, options.shouldStop);
	const entries = built.entries;
	// Skipped (oversized) files were not read, so they must not count as
	// `scanned`; `coverage.skipped` names them in the rendered output instead.
	const coverage = {
		scanned: built.scanned,
		total: sessionFiles.total,
		scope,
		skipped: built.skipped,
		aborted: built.aborted,
	};
	if (scope !== "active") {
		// pi-task provenance belongs to this project: it joins every scope wider than the live session
		const taskHistoryFile = options.taskHistoryFile ?? findTaskHistoryFile(options.cwd ?? process.cwd());
		entries.push(...buildTaskHistoryEntries(taskHistoryFile, entries.length + 1));
	}
	const fileCounts = { scannedFiles: coverage.scanned, totalFiles: coverage.total };

	const expanded = options.expand?.length ? entries.filter((entry) => options.expand?.includes(entry.index)) : undefined;
	if (expanded) {
		const available = new Set(entries.map((entry) => entry.index));
		const invalid = (options.expand ?? []).filter((index) => !available.has(index));
		if (invalid.length > 0) {
			return {
				entries: [],
				total: 0,
				rendered: `Cannot expand indices outside the available entries: ${invalid.join(", ")}.`,
				...fileCounts,
			};
		}
		return {
			entries: expanded,
			total: expanded.length,
			rendered: renderExpanded(expanded),
			...fileCounts,
		};
	}

	const hasQuery = Boolean(options.query?.trim());
	const queried = hasQuery
		? rankAndFilter(entries, options.query?.trim() ?? "")
		: entries.filter(isBrowseEntry).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
	// `limit` caps how many matches are addressable this call; `total` stays the
	// true match count so a capped search never reads as "that is all there is".
	const limited = queried.slice(0, countOption(options.limit, DEFAULT_ENTRY_LIMIT, 0));
	const page = countOption(options.page, 1, 1);
	const start = (page - 1) * PAGE_SIZE;
	const pageEntries = limited.slice(start, start + PAGE_SIZE);
	return {
		entries: pageEntries,
		total: queried.length,
		rendered: renderSearch(pageEntries, queried.length, page, options.query, coverage, {
			shown: limited.length,
			matched: queried.length,
		}),
		...fileCounts,
	};
}

/** A finite integer option at or above `min`, else the fallback. Guards the
 * `limit`/`page`/`fileCap` arithmetic against NaN and negatives, which would
 * otherwise `slice` to nothing (or drop the tail) with no explanation. */
function countOption(value: number | undefined, fallback: number, min: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function buildRecallEntries(
	sessionFiles: string[],
	lineageEntryIds: Set<string> | undefined,
	readCapBytes: number | undefined,
	shouldStop?: (() => boolean) | undefined,
): { entries: RecallEntry[]; skipped: number; scanned: number; aborted: boolean } {
	const entries: RecallEntry[] = [];
	// pi's fork and branch-to-new-session copy every entry, id and timestamp
	// included, into the new file: count each entry once across files. pi ids
	// are 8-char random ids unique only within one session, so across projects
	// two unrelated entries can share id and millisecond; the text hash keeps
	// fork copies (byte-identical) merged while strangers stay separate.
	const seen = new Set<string>();
	const cap = countOption(readCapBytes, LINE_READ_MAX_BYTES, 1);
	let index = 1;
	let skipped = 0;
	// Files actually read, counted as they are read rather than derived from the
	// list length minus skips: an interrupted scan reads fewer than the list, and
	// the coverage line must not claim otherwise.
	let scanned = 0;
	let aborted = false;

	for (const path of sessionFiles) {
		if (shouldStop?.()) {
			aborted = true;
			break;
		}
		const stat = safeStat(path);
		const sessionKey = rawSessionKey(path);
		const read = readJsonlLines(path, cap, shouldStop);
		if (read.skipped) {
			skipped++;
			continue;
		}
		scanned++;
		if (read.aborted) aborted = true;
		for (const raw of read.lines) {
			if (!shouldIncludeJsonlEntry(raw)) continue;
			const text = jsonlText(raw);
			if (!text.trim()) continue;
			const entryId = jsonlId(raw);
			if (lineageEntryIds && entryId && !lineageEntryIds.has(entryId)) continue;
			if (entryId && jsonlTimestamp(raw) !== undefined) {
				const copyKey = `${entryId}\u0000${jsonlTimestamp(raw) ?? ""}\u0000${textHash(text)}`;
				if (seen.has(copyKey)) continue;
				seen.add(copyKey);
			}
			const role = jsonlRole(raw);
			entries.push({
				index: index++,
				source: "jsonl",
				sessionKey,
				role,
				title: `[jsonl:${role || "entry"}]`,
				text,
				path,
				timestamp: jsonlTimestamp(raw) ?? Number(stat?.mtimeMs ?? 0),
			});
		}
		if (aborted) break;
	}
	return { entries, skipped, scanned, aborted };
}

/** Short content hash for the fork-copy dedupe key: fork copies are
 * byte-identical, colliding stranger ids are not. */
function textHash(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function listRawSessionFiles(scope: RecallScope, options: RecallOptions): { files: string[]; total: number } {
	if (scope === "active") {
		const files = options.sessionFile && existsSync(options.sessionFile) ? [options.sessionFile] : [];
		return { files, total: files.length };
	}
	const sessionsRoot = options.rawSessionDir ?? join(agentDir(), "sessions");
	let candidates: string[];
	if (scope === "all") {
		const roots = [sessionsRoot];
		const projectDir = options.projectSessionDir;
		// a custom session dir lives outside the default root: every scope wider than the project includes it
		if (projectDir && !isPathWithin(canonicalPath(sessionsRoot), canonicalPath(projectDir))) roots.push(projectDir);
		candidates = roots.flatMap(walkSessionFiles);
	} else {
		candidates = projectSessionFiles(options.projectSessionDir, options.projectRoots);
	}
	const files = [...new Set(candidates)].sort((a, b) => Number(safeStat(b)?.mtimeMs ?? 0) - Number(safeStat(a)?.mtimeMs ?? 0));
	return { files: files.slice(0, countOption(options.fileCap, FILE_CAP[scope], 0)), total: files.length };
}

/** This repository's session files. The active session's directory, plus —
 * in pi's default per-launch-cwd layout — the sibling directories of
 * launches from inside the repository (`--Users-me-repo-sub--`). The sibling
 * name prefix also matches `--Users-me-repo-other--`, and a custom session
 * dir is shared by every project, so with known roots each file must carry a
 * header cwd inside the repository; a headerless file is trusted only in the
 * active session's own directory. */
function projectSessionFiles(base: string | undefined, projectRoots: string[] | undefined): string[] {
	if (!base) return [];
	const roots = projectRoots ?? [];
	const dirs = [base];
	const parent = dirname(base);
	if (roots.length > 0 && /^--.*--$/.test(basename(base))) {
		const names = roots.map((root) => defaultSessionDirName(resolve(root)));
		const baseKey = canonicalPath(base);
		for (const name of safeReaddir(parent)) {
			if (!names.some((own) => name === own || name.startsWith(`${own.slice(0, -2)}-`))) continue;
			const path = join(parent, name);
			const stat = safeLstat(path);
			if (stat?.isDirectory() && !stat.isSymbolicLink() && canonicalPath(path) !== baseKey) dirs.push(path);
		}
	}
	const files = dirs.flatMap(walkSessionFiles);
	if (roots.length === 0) return files;
	// Raw and real spellings on both sides: a session cwd that no longer exists
	// (a deleted subdirectory, a removed worktree) cannot be realpath'd.
	const rootSpellings = roots.flatMap((root) => [resolve(root), canonicalPath(root)]);
	const baseKey = canonicalPath(base);
	return files.filter((file) => {
		const cwd = sessionHeaderCwd(file);
		if (cwd === undefined) return canonicalPath(dirname(file)) === baseKey;
		const cwdSpellings = [resolve(cwd), canonicalPath(cwd)];
		return rootSpellings.some((root) => cwdSpellings.some((spelling) => isPathWithin(root, spelling)));
	});
}

function walkSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of safeReaddir(dir)) {
			const path = join(dir, name);
			const stat = safeLstat(path);
			if (!stat || stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) walk(path);
			// `.jsonl` only: a pretty-printed `.json` here would be split per line and
			// every fragment indexed as a searchable "entry".
			if (stat.isFile() && /\.jsonl$/.test(name)) files.push(path);
		}
	};
	walk(root);
	return files;
}

/** pi's own header discovery bound (`MAX_SESSION_HEADER_SCAN_BYTES` in
 * core/session-manager.js). A header line longer than this is not discoverable
 * from a bounded scan; unlike pi, recall has no full-load fallback, so 1 MB is
 * the honest limit rather than a 16 KB truncation that reads as "no cwd". */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
const SESSION_HEADER_CHUNK_BYTES = 4096;

/** The `cwd` of a v3 session header (the file's first line), read without
 * loading the whole file: a bounded chunk loop stops at the first newline or at
 * pi's 1 MB scan limit. Splitting on the raw `\n` byte is UTF-8 safe, and a
 * leading BOM (which old files carry and JSON.parse rejects) is stripped. */
function sessionHeaderCwd(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const chunks: Buffer[] = [];
		let scannedBytes = 0;
		let lineBytes: Buffer | undefined;
		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(SESSION_HEADER_CHUNK_BYTES, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const buffer = Buffer.allocUnsafe(readLength);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) break;
			scannedBytes += bytesRead;
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf(0x0a);
			chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
			if (newline !== -1) {
				lineBytes = Buffer.concat(chunks);
				break;
			}
		}
		if (lineBytes === undefined) {
			if (chunks.length === 0) return undefined;
			lineBytes = Buffer.concat(chunks);
		}
		const firstLine = stripBom(lineBytes.toString("utf8"));
		const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
		return header.type === "session" && typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function findTaskHistoryFile(cwd: string): string | undefined {
	const piDir = findNearestPiDir(cwd);
	if (!piDir) return undefined;
	const historyFile = join(piDir, "task-session-history.json");
	const stat = safeLstat(historyFile);
	return stat?.isFile() && !stat.isSymbolicLink() ? historyFile : undefined;
}

function findNearestPiDir(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		if (basename(current) === ".pi") return current;
		const candidate = join(current, ".pi");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

const TASK_STATUSES = new Set(["running", "done", "cancelled", "aborted", "failed", "timeout"]);
const REPORTED_STATUSES = new Set(["success", "failure", "blocked", "partial"]);

/** One bounded line of task metadata. Every whitespace run (newlines, tabs, and
 * Unicode line/paragraph separators included) collapses to a single space so a
 * legitimate multi-line description is indexed as one line; non-whitespace
 * control characters (NUL, ESC, ...) still reject, because they could forge a
 * second provenance line.
 *
 * An over-long value is truncated with an ellipsis rather than dropped. Dropping
 * it made a task with a 300-character description unfindable by its own words —
 * the one thing recall exists to prevent. Truncation is also self-protecting for
 * the validated fields: the `…` cannot satisfy the id charset or a status set,
 * so a truncated id or status is rejected downstream exactly as before. */
function boundedMetadata(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return undefined;
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildTaskHistoryEntries(historyFile: string | undefined, firstIndex: number): RecallEntry[] {
	const historyStat = historyFile ? safeLstat(historyFile) : undefined;
	if (!historyFile || !historyStat?.isFile() || historyStat.isSymbolicLink()) return [];
	let rows: unknown;
	try {
		rows = JSON.parse(readFileSync(historyFile, "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(rows)) return [];

	const taskSessionsDir = join(dirname(historyFile), "artifacts", "tasks", "sessions");
	const entries: RecallEntry[] = [];
	for (const value of rows) {
		if (!value || typeof value !== "object") continue;
		const row = value as Record<string, unknown>;
		const id = boundedMetadata(row.id, 80);
		const description = boundedMetadata(row.description, 240);
		if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !description) continue;
		const candidateAgent = boundedMetadata(row.agentType, 40);
		const agentType = candidateAgent && /^[A-Za-z0-9_-]+$/.test(candidateAgent) ? candidateAgent : "task";
		const candidateStatus = boundedMetadata(row.status, 20);
		const status = candidateStatus && TASK_STATUSES.has(candidateStatus) ? candidateStatus : "unknown";
		const candidateReportedStatus = boundedMetadata(row.reportedStatus, 20);
		const reportedStatus = candidateReportedStatus && REPORTED_STATUSES.has(candidateReportedStatus) ? candidateReportedStatus : undefined;
		const transcript = findTaskTranscript(dirname(historyFile), taskSessionsDir, id);
		const text = [
			`task id: ${id}`,
			`agent: ${agentType}`,
			`description: ${description}`,
			`status: ${status}`,
			reportedStatus ? `reported status: ${reportedStatus}` : undefined,
			transcript ? `transcript: ${transcript}` : undefined,
		]
			.filter(Boolean)
			.join("\n");
		entries.push({
			index: firstIndex + entries.length,
			source: "task",
			sessionKey: id,
			role: "task",
			title: `[task:${agentType}:${status}]`,
			text,
			timestamp: typeof row.startedAt === "number" && Number.isFinite(row.startedAt) ? row.startedAt : undefined,
			path: transcript ?? historyFile,
			taskDescription: description,
		});
	}
	return entries;
}

function findTaskTranscript(piDir: string, taskSessionsDir: string, id: string): string | undefined {
	// Every probe is inside one try: the directory can be deleted by a
	// concurrent task between the lstat and the realpath, and a racing delete
	// must mean "no transcript", never an error thrown out of recall.
	try {
		const piStat = safeLstat(piDir);
		const sessionsStat = safeLstat(taskSessionsDir);
		if (!piStat?.isDirectory() || !sessionsStat?.isDirectory()) return undefined;
		if (hasSymlinkComponent(piDir, taskSessionsDir)) return undefined;
		const piRoot = realpathSync.native(piDir);
		const sessionsRoot = realpathSync.native(taskSessionsDir);
		if (!isPathWithin(piRoot, sessionsRoot)) return undefined;

		const taskDir = join(taskSessionsDir, id);
		const taskStat = safeLstat(taskDir);
		if (!taskStat?.isDirectory() || taskStat.isSymbolicLink()) return undefined;
		const resolvedTaskDir = realpathSync.native(taskDir);
		if (!isPathWithin(sessionsRoot, resolvedTaskDir)) return undefined;
		const names = readdirSync(taskDir)
			.filter((entry) => entry.endsWith(".jsonl"))
			.sort();
		if (names.length !== 1) return undefined;
		const name = names[0];
		if (name === undefined) return undefined;
		const transcript = join(taskDir, name);
		const transcriptStat = safeLstat(transcript);
		if (!transcriptStat?.isFile() || transcriptStat.isSymbolicLink()) return undefined;
		const resolvedTranscript = realpathSync.native(transcript);
		return isPathWithin(sessionsRoot, resolvedTranscript) ? resolvedTranscript : undefined;
	} catch {
		return undefined;
	}
}

// ─── Sig-keyed JSONL line cache ─────────────────────────────────────────────
// scope:"project"/"all" read up to 60/200 session files synchronously; expand
// follow-ups would re-parse everything on every call. Cache parsed lines
// per file keyed by (mtimeMs, size) — the same signature pattern pi-task
// uses for transcript re-parsing — with a hard bound on entries and bytes.

const LINE_CACHE_MAX_FILES = 100;
const LINE_CACHE_MAX_BYTES = 40 * 1024 * 1024;
/** Hard per-file read cap. A file above this is not read at all and is reported
 * as skipped: its byte count is the only thing known about it, and parsing a
 * multi-hundred-MB session would blow the same budget the cache exists to
 * respect. */
export const LINE_READ_MAX_BYTES = 40 * 1024 * 1024;
/** Chunk size of the streaming line reader. Big enough that the per-chunk
 * `readSync` overhead is irrelevant against the JSON parse it feeds, small
 * enough that peak memory is bounded by this plus one line, not by the file. */
const LINE_STREAM_CHUNK_BYTES = 1024 * 1024;

interface CachedLines {
	sig: string;
	bytes: number;
	lines: unknown[];
}

interface JsonlReadResult {
	lines: unknown[];
	/** The file was larger than the read cap and was not read. */
	skipped: boolean;
	/** Reading stopped early because the caller asked it to; `lines` is a prefix. */
	aborted: boolean;
}

const lineCache = new Map<string, CachedLines>();

/** Retained bytes of the cache. Derived rather than tracked in a mutable
 * counter, which had to be reset on every eviction and silently drifted from
 * the map it described. `n` is bounded by LINE_CACHE_MAX_FILES. */
function lineCacheBytes(): number {
	let total = 0;
	for (const entry of lineCache.values()) total += entry.bytes;
	return total;
}

/** Insert (or refresh) an entry, then evict least-recently-used entries until
 * both bounds hold. Clearing the whole cache (what this used to do) threw away
 * every file the caller had just read whenever one new scope pushed it over the
 * bound, turning the next `expand` into a full re-parse.
 *
 * The byte bound counts *source* bytes, so it is a proxy for retained memory
 * rather than a measurement: parsed line objects cost a multiple of their
 * source text, and a file is bounded to the whole budget so one session cannot
 * monopolise it. */
function cacheLines(path: string, sig: string, bytes: number, lines: unknown[]): void {
	if (bytes > LINE_CACHE_MAX_BYTES) return;
	lineCache.delete(path);
	lineCache.set(path, { sig, bytes, lines });
	let total = lineCacheBytes();
	while ((total > LINE_CACHE_MAX_BYTES || lineCache.size > LINE_CACHE_MAX_FILES) && lineCache.size > 1) {
		const oldest = lineCache.keys().next();
		if (oldest.done) break;
		const evicted = lineCache.get(oldest.value)?.bytes ?? 0;
		lineCache.delete(oldest.value);
		total -= evicted;
	}
}

/** Parse one JSONL line: JSON when it parses, the raw text otherwise (a
 * truncated or hand-edited line stays searchable instead of vanishing). */
function pushJsonlLine(lines: unknown[], bytes: Buffer): void {
	const line = bytes.toString("utf8").trim();
	if (!line) return;
	try {
		lines.push(JSON.parse(line));
	} catch {
		lines.push(line);
	}
}

function readJsonlLines(path: string, maxBytes: number, shouldStop?: (() => boolean) | undefined): JsonlReadResult {
	const stat = safeStat(path);
	const size = stat ? Number(stat.size) : 0;
	if (stat && size > maxBytes) return { lines: [], skipped: true, aborted: false };
	const sig = stat ? `${stat.mtimeMs}:${size}` : "";
	const cached = lineCache.get(path);
	if (cached && cached.sig === sig) {
		// a hit is a use: move it to the most-recently-used end of the eviction order
		lineCache.delete(path);
		lineCache.set(path, cached);
		return { lines: cached.lines, skipped: false, aborted: false };
	}
	const lines: unknown[] = [];
	let fd: number | undefined;
	let aborted = false;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(LINE_STREAM_CHUNK_BYTES);
		/** Buffers of one line that does not fit in a single chunk. Collected as
		 * copies and concatenated once, at the newline: growing one `carry` buffer
		 * with `Buffer.concat` per chunk would copy the whole partial line on every
		 * iteration (quadratic in the length of the longest line). */
		let parts: Buffer[] = [];
		for (;;) {
			// Checked before every chunk, so an interrupt stops mid-file rather than
			// after the whole file has been read and parsed.
			if (shouldStop?.()) {
				aborted = true;
				break;
			}
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			// Splitting on the raw 0x0a byte is UTF-8 safe: a multi-byte sequence never
			// contains it. A line spanning chunks is carried in `parts`.
			const chunk = buffer.subarray(0, bytesRead);
			let start = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, start);
				if (newline === -1) break;
				if (parts.length === 0) {
					pushJsonlLine(lines, chunk.subarray(start, newline));
				} else {
					parts.push(Buffer.from(chunk.subarray(start, newline)));
					pushJsonlLine(lines, Buffer.concat(parts));
					parts = [];
				}
				start = newline + 1;
			}
			// copy the tail: `buffer` is reused by the next readSync
			if (start < bytesRead) parts.push(Buffer.from(chunk.subarray(start)));
		}
		// a trailing line with no newline is still an entry (pi always terminates,
		// but a killed writer can leave one)
		if (!aborted && parts.length > 0) pushJsonlLine(lines, Buffer.concat(parts));
	} catch {
		// A read that fails partway still yields the lines already parsed: losing
		// them would make one bad chunk look like an empty file.
		return { lines, skipped: false, aborted };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	// Never cache a prefix: the signature does not change when a scan is aborted,
	// so a later full scan would be served the truncated line list.
	if (!aborted) cacheLines(path, sig, size, lines);
	return { lines, skipped: false, aborted };
}

function isBrowseEntry(entry: RecallEntry): boolean {
	if (isBrowseDiagnostic(entry.text)) return false;
	if (isLowSignalAcknowledgement(entry.text)) return false;
	const role = entry.role?.toLowerCase() ?? "";
	if (role === "user") return true;
	if (role === "assistant") return !/^tool call:/i.test(entry.text.trim());
	return role === "compaction" || role === "branch_summary" || role === "task";
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function rawSessionKey(path: string): string {
	return (
		path
			.split(/[\\/]/)
			.pop()
			?.replace(/\.jsonl$/, "") ?? path
	);
}
