import type { RecallEntry, RecallScope } from "./recall.js";

/** How much of the session history a search actually read. */
export interface RecallCoverage {
	scanned: number;
	total: number;
	scope: RecallScope;
	/** Files in scope that were too large to read at all; they are excluded from
	 * `scanned` and named separately so the coverage line stays honest. */
	skipped?: number;
	/** The scan stopped early (the call was interrupted), so `entries` is a
	 * prefix of what the scope holds. */
	aborted?: boolean;
}

const WIDER_SCOPE: Record<RecallScope, string> = {
	active: " or scope:'project'",
	project: " or scope:'all'",
	all: "",
};

/** How many matches this call made addressable vs. how many matched at all. */
export interface RecallEntryCap {
	shown: number;
	matched: number;
}

export function renderSearch(
	entries: RecallEntry[],
	total: number,
	page: number,
	query?: string,
	coverage?: RecallCoverage,
	cap?: RecallEntryCap,
): string {
	const normalizedQuery = query?.trim();
	const lines = [
		`DCP recall${normalizedQuery ? ` for "${normalizedQuery}"` : " browse"}: ${total} result${total === 1 ? "" : "s"} (page ${page})`,
	];
	const skipped = coverage?.skipped ?? 0;
	if (coverage?.aborted) {
		// A partial scan must never read as a complete miss: say which it was.
		lines.push(
			`The scan was interrupted after ${coverage.scanned} of ${coverage.total} session file${coverage.total === 1 ? "" : "s"}; these results are partial.`,
		);
	}
	if (skipped > 0) {
		lines.push(
			`${skipped} session file${skipped === 1 ? "" : "s"} exceeded the read cap and ${skipped === 1 ? "was" : "were"} not searched.`,
		);
	}
	// `scanned + skipped` is what the newest-first file cap actually kept, so this
	// line is about the cap, not about oversized files (named above). An aborted
	// scan already stated its coverage, so it does not also claim a cap cut.
	if (coverage && !coverage.aborted && coverage.scanned + skipped < coverage.total) {
		lines.push(`Scanned the newest ${coverage.scanned} of ${coverage.total} session files; older sessions were not searched.`);
	}
	if (cap && cap.shown < cap.matched) {
		lines.push(`Showing the first ${cap.shown} of ${cap.matched} matches (limit); raise limit or narrow the query for the rest.`);
	}
	if (entries.length === 0) {
		lines.push(
			total > 0
				? `No results on page ${page}.`
				: `No results. A miss is not evidence it never happened: try a broader query${coverage ? WIDER_SCOPE[coverage.scope] : " or a wider scope"}.`,
		);
		return lines.join("\n");
	}
	for (const entry of entries) {
		const snippet = oneLine(entry.text, normalizedQuery ? 300 : 180);
		if (normalizedQuery) {
			lines.push("", `#${entry.index} ${entry.title}`, snippet);
		} else {
			lines.push(`#${entry.index} ${entry.title} — ${snippet}`);
		}
	}
	lines.push("", "Expand with recall using expand:<index>.");
	return lines.join("\n");
}

export function renderExpanded(entries: RecallEntry[]): string {
	if (entries.length === 0) return "No matching recall indices.";
	return entries.map((entry) => [`#${entry.index} ${entry.title}`, entry.text].join("\n")).join("\n\n---\n\n");
}

export function shouldIncludeJsonlEntry(value: unknown): boolean {
	if (typeof value === "string") return true;
	if (!value || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	const customType = typeof obj.customType === "string" ? obj.customType : "";
	if (obj.type === "custom") return false;
	if (customType) return false;
	// a `!!cmd` run is excluded from the LLM context by the user's choice: recall must not bring it back
	const message =
		obj.type === "message" && obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : undefined;
	if (message?.excludeFromContext === true) return false;
	return true;
}

function jsonlPayload(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	if (obj.type === "message" && obj.message && typeof obj.message === "object") return obj.message;
	return value;
}

export function jsonlText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return String(value ?? "");
	const payload = jsonlPayload(value);
	if (!payload || typeof payload !== "object") return contentToText(payload);
	const obj = payload as Record<string, unknown>;
	if (obj.role === "bashExecution") return bashExecutionText(obj);
	return contentToText(obj.summary ?? obj.content ?? obj.message ?? obj.text ?? obj.output ?? obj.result ?? payload);
}

/** A user `!cmd` run: the command and its exit status are what a later
 * session searches for, not only the output. */
function bashExecutionText(obj: Record<string, unknown>): string {
	const status = typeof obj.exitCode === "number" ? `exit code: ${obj.exitCode}` : obj.cancelled === true ? "cancelled" : "";
	return [typeof obj.command === "string" ? `$ ${obj.command}` : "", contentToText(obj.output), status].filter(Boolean).join("\n");
}

export function jsonlRole(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const payload = jsonlPayload(value);
	if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		if (typeof obj.role === "string") return obj.role;
	}
	const obj = value as Record<string, unknown>;
	return String(obj.type ?? "");
}

export function jsonlId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	return typeof obj.id === "string" ? obj.id : undefined;
}

export function jsonlTimestamp(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	const raw = obj.timestamp ?? obj.createdAt ?? obj.created_at;
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content == null) return "";
	if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
	if (typeof content === "object") {
		const obj = content as Record<string, unknown>;
		if (obj.type === "thinking" || typeof obj.thinking === "string") return "";
		if (obj.type === "toolCall") return `tool call: ${String(obj.name ?? obj.toolName ?? "unknown")}${toolArgumentSummary(obj.arguments)}`;
		if (typeof obj.text === "string") return obj.text;
		if (typeof obj.content === "string" || Array.isArray(obj.content)) return contentToText(obj.content);
		if (obj.message) return contentToText(obj.message);
		if (obj.output) return contentToText(obj.output);
		if (obj.result) return contentToText(obj.result);
		if (obj.data) return contentToText(obj.data);
		return "";
	}
	return String(content);
}

/** The tool arguments that answer "which file, which command": indexed so a
 * later session can find them; edit bodies and file contents stay out. */
const TOOL_ARGUMENT_KEYS = ["path", "file_path", "filePath", "command", "pattern"];

function toolArgumentSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const parts: string[] = [];
	for (const key of TOOL_ARGUMENT_KEYS) {
		const value = (args as Record<string, unknown>)[key];
		if (typeof value === "string" && value.trim()) parts.push(`${key}=${JSON.stringify(oneLine(value, 200))}`);
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}
