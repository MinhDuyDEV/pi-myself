import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Type, Optional } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { agentDir, defaultSessionDirName } from "../lib/agent-dir.js";
import { gitTopLevel } from "../lib/repo-root.js";
import { hasSymlinkComponent, isPathWithin } from "./recall-path.js";
import { isBrowseDiagnostic, isLowSignalAcknowledgement, rankAndFilter } from "./recall-rank.js";
import {
  jsonlRole,
  jsonlText,
  jsonlTimestamp,
  jsonlId,
  renderExpanded,
  renderSearch,
  shouldIncludeJsonlEntry,
} from "./recall-render.js";
export { isPathWithin };

export interface RecallEntry {
  index: number;
  source: "jsonl" | "task";
  sessionKey?: string;
  role?: string;
  title: string;
  text: string;
  timestamp?: number;
  path?: string;
  taskDescription?: string;
}

interface RecallOptions {
  sessionFile?: string;
  query?: string;
  expand?: number[];
  page?: number;
  scope?: RecallScope;
  limit?: number;
  /** Every project's sessions (scope:"all"); defaults to `<agentDir>/sessions`,
   * where `PI_CODING_AGENT_DIR` moves the agent dir. */
  rawSessionDir?: string;
  /** The active session's directory (scope:"project"). pi's default layout
   * keys it by launch cwd; a custom session dir (--session-dir,
   * PI_CODING_AGENT_SESSION_DIR, settings sessionDir) is flat and shared. */
  projectSessionDir?: string;
  /** This repository's root, in every spelling a launch cwd may have used
   * (symlinked and real). With it, scope:"project" also reads sessions
   * launched from a subdirectory and keeps only files whose header cwd lies
   * inside the repository. */
  projectRoots?: string[];
  taskHistoryFile?: string;
  /** Active-lineage entry ids from the session manager; entries outside
   * the set are excluded when provided (dead branches stay searchable
   * via scope:"all"). */
  lineageEntryIds?: Set<string>;
  /** Override the newest-first session file cap of the scope. */
  fileCap?: number;
}

export interface RecallResult {
  entries: RecallEntry[];
  rendered: string;
  total: number;
  /** Session files read vs. files in scope: fewer means older sessions were cut by the cap. */
  scannedFiles: number;
  totalFiles: number;
}

export type RecallScope = "active" | "project" | "all";

const PAGE_SIZE = 5;
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
        promptSnippet:
          "Search exact Pi session history when compacted context may have omitted details.",

    promptGuidelines: [
      "Use recall before guessing about old compacted context.",
      "Search first, then call expand with result indices when you need exact full content.",
      "Widen scope in order: 'active' → 'project' (earlier sessions of this repo) → 'all' (other projects); each step is slower and noisier.",
    ],
    parameters: Type.Object({
      query: Optional(
        Type.String({
          description:
            "Search query. Regex is supported; multi-word queries are OR-ranked.",
        }),
      ),
      expand: Optional(
        Type.Array(Type.Number(), {
          description: "Recall indices to expand with full content.",
        }),
      ),
      page: Optional(
        Type.Number({ description: "1-based page number for search results." }),
      ),
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
    renderCall: (_args, theme) =>
      new Text(theme.fg("toolTitle", theme.bold("⚙ recall")), 0, 0),
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
          const manager = ctx.sessionManager as unknown as LineageSessionManagerLike;
          const result = searchDcpRecall({
            sessionFile,
            projectSessionDir: manager.getSessionDir?.() ?? (sessionFile ? dirname(sessionFile) : undefined),
            projectRoots: scope === "project" ? projectRootSpellings(ctx.cwd) : undefined,
            lineageEntryIds: scope === "active" ? activeLineageIds(manager) : undefined,
            ...params,
          });

      return {
        content: [{ type: "text", text: result.rendered }],
        details: { total: result.total, entries: result.entries },
      };
    },
  });
}

interface LineageSessionManagerLike {
  getTree?: () => Array<{ id: string; parentId: string | null }>;
  getLeafId?: () => string | undefined;
  getSessionDir?: () => string;
}

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
    spellings.add(resolve(cwd, relative(realpathSync.native(cwd), root)));
  } catch {
    /* cwd vanished: the git spelling alone */
  }
  return [...spellings];
}

/** Active-lineage entry ids: walk the leaf-parent chain through the
 * session tree. Dead branches (retried/edited turns) stay excluded for
 * scope:"active"; returns undefined when the API is unavailable. */
export function activeLineageIds(
  sessionManager: LineageSessionManagerLike,
): Set<string> | undefined {
  try {
    const tree = sessionManager.getTree?.() ?? [];
    const leafId = sessionManager.getLeafId?.();
    if (!leafId) return undefined;
    const byId = new Map(tree.map((entry) => [entry.id, entry]));
    const ids = new Set<string>();
    let current = byId.get(leafId);
    while (current) {
      ids.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return ids;
  } catch {
    return undefined;
  }
}

export function searchDcpRecall(options: RecallOptions): RecallResult {
  const scope = options.scope ?? "active";
  const sessionFiles = listRawSessionFiles(scope, options);
  const coverage = { scanned: sessionFiles.files.length, total: sessionFiles.total, scope };
  const entries = buildRecallEntries(sessionFiles.files, options.lineageEntryIds);
  if (scope !== "active") {
    // pi-task provenance belongs to this project: it joins every scope wider than the live session
    const taskHistoryFile = options.taskHistoryFile ?? findTaskHistoryFile(process.cwd());
    entries.push(...buildTaskHistoryEntries(taskHistoryFile, entries.length + 1));
  }
  const fileCounts = { scannedFiles: coverage.scanned, totalFiles: coverage.total };

  const expanded = options.expand?.length
    ? entries.filter((entry) => options.expand?.includes(entry.index))
    : undefined;
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
    : entries
        .filter(isBrowseEntry)
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const limited = queried.slice(0, options.limit ?? 200);
  const page = Math.max(1, options.page ?? 1);
  const start = (page - 1) * PAGE_SIZE;
  const pageEntries = limited.slice(start, start + PAGE_SIZE);
  return {
    entries: pageEntries,
    total: queried.length,
    rendered: renderSearch(pageEntries, queried.length, page, options.query, coverage),
    ...fileCounts,
  };
}

function buildRecallEntries(
  sessionFiles: string[],
  lineageEntryIds?: Set<string>,
): RecallEntry[] {
  const entries: RecallEntry[] = [];
  // pi's fork and branch-to-new-session copy every entry, id and timestamp
  // included, into the new file: count each entry once across files. Only
  // entries carrying both an id and a timestamp (as pi's always do) are merged.
  const seen = new Set<string>();
  let index = 1;

  for (const path of sessionFiles) {
    const stat = safeStat(path);
    const sessionKey = rawSessionKey(path);
    for (const raw of readJsonlLines(path)) {
      if (!shouldIncludeJsonlEntry(raw)) continue;
      const text = jsonlText(raw);
      if (!text.trim()) continue;
      const entryId = jsonlId(raw);
      if (lineageEntryIds && entryId && !lineageEntryIds.has(entryId)) continue;
      if (entryId && jsonlTimestamp(raw) !== undefined) {
        const copyKey = `${entryId}\u0000${jsonlTimestamp(raw) ?? ""}`;
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
  }
  return entries;
}

function listRawSessionFiles(
  scope: RecallScope,
  options: RecallOptions,
): { files: string[]; total: number } {
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
  const files = [...new Set(candidates)].sort(
    (a, b) =>
      Number(safeStat(b)?.mtimeMs ?? 0) - Number(safeStat(a)?.mtimeMs ?? 0),
  );
  return { files: files.slice(0, options.fileCap ?? FILE_CAP[scope]), total: files.length };
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
      if (stat.isFile() && /\.jsonl?$/.test(name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

/** The `cwd` of a v3 session header (the file's first line), read without
 * loading the whole file. */
function sessionHeaderCwd(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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

function boundedMetadata(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return undefined;
  return text;
}

function buildTaskHistoryEntries(
  historyFile: string | undefined,
  firstIndex: number,
): RecallEntry[] {
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
    const reportedStatus = candidateReportedStatus && REPORTED_STATUSES.has(candidateReportedStatus)
      ? candidateReportedStatus
      : undefined;
    const transcript = findTaskTranscript(dirname(historyFile), taskSessionsDir, id);
    const text = [
      `task id: ${id}`,
      `agent: ${agentType}`,
      `description: ${description}`,
      `status: ${status}`,
      reportedStatus ? `reported status: ${reportedStatus}` : undefined,
      transcript ? `transcript: ${transcript}` : undefined,
    ].filter(Boolean).join("\n");
    entries.push({
      index: firstIndex + entries.length,
      source: "task",
      sessionKey: id,
      role: "task",
      title: `[task:${agentType}:${status}]`,
      text,
      timestamp: typeof row.startedAt === "number" && Number.isFinite(row.startedAt)
        ? row.startedAt
        : undefined,
      path: transcript ?? historyFile,
      taskDescription: description,
    });
  }
  return entries;
}

function findTaskTranscript(
  piDir: string,
  taskSessionsDir: string,
  id: string,
): string | undefined {
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
  try {
    const names = readdirSync(taskDir).filter((entry) => entry.endsWith(".jsonl")).sort();
    if (names.length !== 1) return undefined;
    const transcript = join(taskDir, names[0]);
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

interface CachedLines {
  sig: string;
  bytes: number;
  lines: unknown[];
}

const lineCache = new Map<string, CachedLines>();
let lineCacheBytes = 0;

function readJsonlLines(path: string): unknown[] {
  const stat = safeStat(path);
  const size = stat ? Number(stat.size) : 0;
  const sig = stat ? `${stat.mtimeMs}:${size}` : "";
  const cached = lineCache.get(path);
  if (cached && cached.sig === sig) return cached.lines;
  let lines: unknown[];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      });
  } catch {
    return [];
  }
  if (stat) {
    if (lineCache.size >= LINE_CACHE_MAX_FILES || lineCacheBytes + size > LINE_CACHE_MAX_BYTES) {
      lineCache.clear();
      lineCacheBytes = 0;
    }
    lineCache.set(path, { sig, bytes: size, lines });
    lineCacheBytes += size;
  }
  return lines;
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
      ?.replace(/\.jsonl?$/, "") ?? path
  );
}
