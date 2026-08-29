import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Type, Optional } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
  scope?: "active" | "all";
  limit?: number;
  rawSessionDir?: string;
  taskHistoryFile?: string;
  /** Active-lineage entry ids from the session manager; entries outside
   * the set are excluded when provided (dead branches stay searchable
   * via scope:"all"). */
  lineageEntryIds?: Set<string>;
}

export interface RecallResult {
  entries: RecallEntry[];
  rendered: string;
  total: number;
}

const PAGE_SIZE = 5;
const RAW_SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

export function registerRecallTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "recall",
    label: "Recall",
        description:
          "Search persisted Pi session JSONL history and current-project pi-task provenance metadata, including native compaction summaries. Supports regex queries, pagination, expand, and scope:'all'.",
        promptSnippet:
          "Search exact Pi session history when compacted context may have omitted details.",

    promptGuidelines: [
      "Use recall before guessing about old compacted context.",
      "Search first, then call expand with result indices when you need exact full content.",
      "Use scope:'all' only when current-lineage results are insufficient.",
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
        Type.Union([Type.Literal("active"), Type.Literal("all")], {
              description:
                "active searches the current session's active lineage (superseded branches excluded); all searches all persisted session logs.",

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
        scope?: "active" | "all";
        limit?: number;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
          const scope = params.scope ?? "active";
          const result = searchDcpRecall({
            sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
            lineageEntryIds:
              scope === "all"
                ? undefined
                : activeLineageIds(ctx.sessionManager as unknown as LineageSessionManagerLike),
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
  const entries = buildRecallEntries(
    scope,
    options.sessionFile,
    options.rawSessionDir,
    options.lineageEntryIds,
  );
  if (scope === "all") {
    const taskHistoryFile = options.taskHistoryFile ?? findTaskHistoryFile(process.cwd());
    entries.push(...buildTaskHistoryEntries(taskHistoryFile, entries.length + 1));
  }

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
      };
    }
    return {
      entries: expanded,
      total: expanded.length,
      rendered: renderExpanded(expanded),
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
    rendered: renderSearch(pageEntries, queried.length, page, options.query),
  };
}

function buildRecallEntries(
  scope: "active" | "all",
  sessionFile?: string,
  rawSessionDir?: string,
  lineageEntryIds?: Set<string>,
): RecallEntry[] {
  const entries: RecallEntry[] = [];
  let index = 1;

  for (const path of listRawSessionFiles(scope, sessionFile, rawSessionDir)) {
    const stat = safeStat(path);
    const sessionKey = rawSessionKey(path);
    if (scope === "active" && sessionFile && path !== sessionFile) continue;
    for (const raw of readJsonlLines(path)) {
      if (!shouldIncludeJsonlEntry(raw)) continue;
      const text = jsonlText(raw);
      if (!text.trim()) continue;
      const entryId = jsonlId(raw);
      if (lineageEntryIds && entryId && !lineageEntryIds.has(entryId)) continue;
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
  scope: "active" | "all",
  sessionFile?: string,
  rawSessionDir = RAW_SESSION_DIR,
): string[] {
  if (scope === "active" && sessionFile && existsSync(sessionFile))
    return [sessionFile];
  if (scope === "active") return [];
  if (!existsSync(rawSessionDir)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = safeLstat(path);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      if (stat.isFile() && /\.jsonl?$/.test(name)) files.push(path);
    }
  };
  walk(rawSessionDir);
  files.sort(
    (a, b) =>
      Number(safeStat(b)?.mtimeMs ?? 0) - Number(safeStat(a)?.mtimeMs ?? 0),
  );
  return scope === "all" ? files.slice(0, 200) : files.slice(0, 20);
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
// scope:"all" reads up to 200 session files synchronously; expand
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
  return role === "compaction" || role === "task";
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

