import type { RecallEntry } from "./recall.js";

export function renderSearch(
  entries: RecallEntry[],
  total: number,
  page: number,
  query?: string,
): string {
  const normalizedQuery = query?.trim();
  const lines = [
    `DCP recall${normalizedQuery ? ` for "${normalizedQuery}"` : " browse"}: ${total} result${total === 1 ? "" : "s"} (page ${page})`,
  ];
  if (entries.length === 0) {
    lines.push("No results. Try a broader query or scope:'all'.");
    return lines.join("\n");
  }
  for (const entry of entries) {
    const displayText = normalizeRecallDisplayText(entry.text);
    const snippet = oneLine(displayText, normalizedQuery ? 300 : 180);
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
  return entries
    .map((entry) =>
      [
        `#${entry.index} ${entry.title}`,
        normalizeRecallDisplayText(entry.text),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function normalizeRecallDisplayText(text: string): string {
  return text
    .replace(/\b(?:dcp|de[pp]|dop)_recall\b/gi, "recall")
    .replace(/\bde[pp]-recall\b/gi, "dcp-recall")
    .replace(/\bdop-recall\b/gi, "dcp-recall")
    .replace(/\/de[pp]-recall\b/gi, "/dcp-recall")
    .replace(/\/dop-recall\b/gi, "/dcp-recall")
    .replace(/\bde[pp]\/(index\.ts|[\w.-]+\.ts)\b/gi, "dcp/$1")
    .replace(/\bdop\/(index\.ts|[\w.-]+\.ts)\b/gi, "dcp/$1")
    .replace(/\bde[pp]\/([\w./-]*dcp[\w./-]*)/gi, "dcp/$1")
    .replace(/\bdop\/([\w./-]*dcp[\w./-]*)/gi, "dcp/$1");
}

export function shouldIncludeJsonlEntry(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const customType = typeof obj.customType === "string" ? obj.customType : "";
  if (obj.type === "custom") return false;
  if (customType) return false;
  return true;
}

function jsonlPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "message" && obj.message && typeof obj.message === "object")
    return obj.message;
  return value;
}

export function jsonlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  const payload = jsonlPayload(value);
  if (!payload || typeof payload !== "object") return contentToText(payload);
  const obj = payload as Record<string, unknown>;
  return contentToText(
    obj.summary ??
      obj.content ??
      obj.message ??
      obj.text ??
      obj.output ??
      obj.result ??
      payload,
  );
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
  if (Array.isArray(content))
    return content.map(contentToText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (obj.type === "thinking" || typeof obj.thinking === "string") return "";
    if (obj.type === "toolCall")
      return `tool call: ${String(obj.name ?? obj.toolName ?? "unknown")}`;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string" || Array.isArray(obj.content))
      return contentToText(obj.content);
    if (obj.message) return contentToText(obj.message);
    if (obj.output) return contentToText(obj.output);
    if (obj.result) return contentToText(obj.result);
    if (obj.data) return contentToText(obj.data);
    return "";
  }
  return String(content);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}
