/**
 * Safety Module — Context Normalization
 *
 * Single point that converts raw pi tool_call events into a typed
 * ToolCallContext. Handles bash, read, write, and edit tools; other
 * URL-carrying tools are passed through with their url fields.
 */

import type { ToolCallContext } from "./types.js";

function getEventUrls(
	input: Record<string, unknown>,
): { url?: string; urls?: string[] } {
	const url = typeof input.url === "string" ? input.url.trim() : undefined;
	const urls = Array.isArray(input.urls)
		? input.urls
			.map((entry) => typeof entry === "string" ? entry.trim() : "")
			.filter(Boolean)
		: undefined;
	return { url, urls };
}

function extractFileContent(
	input: Record<string, unknown>,
	toolName: string,
): string | undefined {
	if (toolName === "write") {
		const raw = input.content;
		return typeof raw === "string" ? raw : undefined;
	}
	if (toolName !== "edit") return undefined;

	const edits = input.edits;
	if (!Array.isArray(edits)) return undefined;
	const parts: string[] = [];
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		const newText = (edit as Record<string, unknown>).newText;
		if (typeof newText === "string" && newText.length > 0) parts.push(newText);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function buildBashContext(
	input: Record<string, unknown>,
	url: string | undefined,
	urls: string[] | undefined,
	cwd: string,
	sessionId: string,
): ToolCallContext | null {
	const command = String(input.command ?? "").replace(/\s+/g, " ").trim();
	if (!command) return null;
	return { tool: "bash", command, url, urls, cwd, sessionId };
}

function buildFileContext(
	input: Record<string, unknown>,
	toolName: string,
	url: string | undefined,
	urls: string[] | undefined,
	cwd: string,
	sessionId: string,
): ToolCallContext | null {
	const path = String(input.path ?? "").trim();
	if (!path) return null;
	const content = extractFileContent(input, toolName);
	return { tool: toolName, path, content, url, urls, cwd, sessionId };
}

/**
 * Build a ToolCallContext from a raw pi tool_call event.
 * Returns null if the event is malformed or irrelevant.
 */
export function contextFromEvent(
	event: unknown,
	cwd: string,
): ToolCallContext | null {
	if (!event || typeof event !== "object") return null;

	const e = event as Record<string, unknown>;
	const toolName = String(e.toolName ?? "").trim();
	if (!toolName) return null;

	const input = (e.input ?? {}) as Record<string, unknown>;
	const sessionId = String(e.sessionId ?? "default");
	const { url, urls } = getEventUrls(input);

	if (toolName === "bash") {
		return buildBashContext(input, url, urls, cwd, sessionId);
	}

	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		return buildFileContext(input, toolName, url, urls, cwd, sessionId);
	}

	if (url || (urls && urls.length > 0)) {
		return {
			tool: toolName,
			url,
			urls,
			cwd,
			sessionId,
		};
	}

	return null;
}
