import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * smart-zone meter — turns ask-matt's PHASE-BOUNDARIES.md vocabulary into a
 * runtime signal. The smart zone (~150k tokens on state-of-the-art models) is
 * the window within which the model still reasons sharply; past it, phase
 * boundaries get decided in order (continue → /clear → /handoff → subagent →
 * /compact). This extension measures the last agent turn's usage and nudges
 * at the thresholds — it never compacts or clears on its own.
 */

export const SMART_ZONE_LIMIT = 150_000;
const WATCH_RATIO = 0.6;
const BOUNDARY_RATIO = 0.85;

export type SmartZoneLevel = "ok" | "watch" | "boundary" | "over";

export interface SmartZoneReading {
	used: number;
	pct: number;
	level: SmartZoneLevel;
	note: string;
}

export function smartZone(used: number, limit: number = SMART_ZONE_LIMIT): SmartZoneReading {
	const pct = Math.round((used / limit) * 1000) / 10;
	const level: SmartZoneLevel =
		used >= limit ? "over" : used >= limit * BOUNDARY_RATIO ? "boundary" : used >= limit * WATCH_RATIO ? "watch" : "ok";
	return { used, pct, level, note: zoneNote(level, used, limit) };
}

function k(tokens: number): string {
	return `${Math.round(tokens / 1000).toLocaleString("en-US")}k`;
}

function zoneNote(level: SmartZoneLevel, used: number, limit: number): string {
	switch (level) {
		case "ok":
			return "room left; work on, decide at the next phase boundary";
		case "watch":
			return `past ${Math.round(WATCH_RATIO * 100)}% of the smart zone — fine to continue, but pick the boundary deliberately`;
		case "boundary":
			return "phase-boundary decision due: continue only if this context is a primary source for the next phase; else /clear > /handoff > subagent > /compact (ask-matt/PHASE-BOUNDARIES.md)";
		case "over":
			return "past the smart zone — reasoning degrades from here; compact at a phase boundary now (pass an instruction so the summary keeps what the next phase needs)";
	}
}

/** Context size for the next turn ≈ the last assistant message's full usage. */
export function lastTurnTokens(messages: readonly unknown[]): number | undefined {
	let last: AssistantMessage["usage"] | undefined;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		const usage = (message as AssistantMessage).usage;
		if (usage) last = usage;
	}
	if (!last) return undefined;
	return (last.input ?? 0) + (last.output ?? 0) + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0);
}

const METER = "smart-zone";

export default function smartZoneExtension(pi: ExtensionAPI): void {
	let reading: SmartZoneReading | undefined;

	pi.on("agent_end", (event, ctx) => {
		const used = lastTurnTokens(event.messages);
		if (used === undefined) return;
		const next = smartZone(used);
		reading = next;
		if (next.level === "ok") return;
		if (!ctx.hasUI) return;
		ctx.ui.notify(`${METER} ${next.pct}% (~${k(next.used)}/${k(SMART_ZONE_LIMIT)}) — ${next.note}`, next.level === "over" ? "warning" : "info");
	});

	pi.registerCommand("smartzone", {
		description: "Show the smart-zone reading and phase-boundary guidance",
		async handler(_args, ctx) {
			if (!reading) {
				ctx.ui?.notify?.(`${METER}: no reading yet (measured after each agent turn). Limit ${k(SMART_ZONE_LIMIT)} tokens.`, "info");
				return;
			}
			ctx.ui?.notify?.(
				[
					`${METER}: ${reading.pct}% (~${k(reading.used)}/${k(SMART_ZONE_LIMIT)}) — ${reading.level}`,
					"",
					reading.note,
				].join("\n"),
				reading.level === "over" ? "warning" : "info",
			);
		},
	});
}