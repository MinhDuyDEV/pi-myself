import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * smart-zone meter — turns ask-matt's PHASE-BOUNDARIES.md vocabulary into a
 * runtime signal. The smart zone (~150k tokens on state-of-the-art models) is
 * the window within which the model still reasons sharply; past it, phase
 * boundaries get decided in order (continue → /new → /skill:handoff →
 * subagent → /compact). This extension measures the last agent turn's usage,
 * shows the reading in the footer status past 60%, and toasts the decision
 * order once when the level crosses into boundary/over — it never compacts or
 * clears on its own. The limit is the smart zone or the model's context window,
 * whichever is smaller; pi's compaction reserve (a setting) is not exposed to
 * extensions, so it is not subtracted.
 */

export const SMART_ZONE_LIMIT = 150_000;
const WATCH_RATIO = 0.6;
const BOUNDARY_RATIO = 0.85;

/** PI_SMART_ZONE_LIMIT overrides the limit (min 1k) — for small-context
 * models and for exercising the thresholds in short test sessions. */
export function smartZoneLimit(): number {
	const env = Number(process.env.PI_SMART_ZONE_LIMIT);
	return Number.isFinite(env) && env >= 1000 ? env : SMART_ZONE_LIMIT;
}

export type SmartZoneLevel = "ok" | "watch" | "boundary" | "over";

export interface SmartZoneReading {
	used: number;
	limit: number;
	pct: number;
	level: SmartZoneLevel;
	note: string;
}

export function smartZone(used: number, limit: number = SMART_ZONE_LIMIT): SmartZoneReading {
	const pct = Math.round((used / limit) * 1000) / 10;
	const level: SmartZoneLevel =
		used >= limit ? "over" : used >= limit * BOUNDARY_RATIO ? "boundary" : used >= limit * WATCH_RATIO ? "watch" : "ok";
	return { used, limit, pct, level, note: zoneNote(level) };
}

/** The effective limit: the smart zone, capped by the model's context window
 * when it is known. A 128k model auto-compacts before a 150k meter leaves
 * "watch", so the boundary advice would never fire. */
export function effectiveLimit(contextWindow: number | undefined): number {
	const limit = smartZoneLimit();
	return typeof contextWindow === "number" && contextWindow > 0 ? Math.min(limit, contextWindow) : limit;
}

function k(tokens: number): string {
	return `${Math.round(tokens / 1000).toLocaleString("en-US")}k`;
}

function zoneNote(level: SmartZoneLevel): string {
	switch (level) {
		case "ok":
			return "room left; work on, decide at the next phase boundary";
		case "watch":
			return `past ${Math.round(WATCH_RATIO * 100)}% of the smart zone — fine to continue, but pick the boundary deliberately`;
		case "boundary":
			return "phase-boundary decision due: continue only if this context is a primary source for the next phase; else /new > /skill:handoff > subagent > /compact (ask-matt/PHASE-BOUNDARIES.md)";
		case "over":
			return "past the smart zone — reasoning degrades from here; compact at a phase boundary now (pass an instruction so the summary keeps what the next phase needs)";
	}
}

/** Context size for the next turn ≈ the last assistant message's full usage.
 * Like pi's own counter (`getAssistantUsage` in core/compaction), aborted and
 * errored messages and all-zero usage are skipped: pi records a failed run with
 * an empty usage, which is not a reading. Undefined when no message counts. */
export function lastTurnTokens(messages: readonly unknown[]): number | undefined {
	let last: number | undefined;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const assistant = message as Partial<AssistantMessage>;
		if (assistant.role !== "assistant") continue;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		const usage = assistant.usage;
		if (!usage) continue;
		const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (total > 0) last = total;
	}
	return last;
}

const METER = "smart-zone";

/** What the UI should do after a turn: the footer text (undefined clears it)
 * and whether the phase-boundary advice toasts. The reading itself lives in
 * the footer (persistent, quiet); the toast fires only when the level crosses
 * into boundary/over, so the advice interrupts once per crossing instead of
 * after every turn. */
export function zoneTransition(
	previous: SmartZoneReading | undefined,
	next: SmartZoneReading,
): { status: string | undefined; toast: boolean } {
	const status = next.level === "ok" ? undefined : `${METER} ${next.pct}% (${next.level})`;
	const crossed = previous?.level !== next.level;
	const toast = crossed && (next.level === "boundary" || next.level === "over");
	return { status, toast };
}

export default function smartZoneExtension(pi: ExtensionAPI): void {
	let reading: SmartZoneReading | undefined;

	pi.on("agent_end", (event, ctx) => {
		const used = lastTurnTokens(event.messages);
		// a failed or aborted run keeps the previous reading
		if (used === undefined) return;
		const next = smartZone(used, effectiveLimit(ctx.model?.contextWindow));
		const { status, toast } = zoneTransition(reading, next);
		reading = next;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(METER, status);
		if (toast) {
			ctx.ui.notify(`${METER} ${next.pct}% (~${k(next.used)}/${k(next.limit)}) — ${next.note}`, next.level === "over" ? "warning" : "info");
		}
	});

	pi.registerCommand("smartzone", {
		description: "Show the smart-zone reading and phase-boundary guidance",
		async handler(_args, ctx) {
			if (!reading) {
				ctx.ui?.notify?.(
					`${METER}: no reading yet (measured after each agent turn). Limit ${k(effectiveLimit(ctx.model?.contextWindow))} tokens.`,
					"info",
				);
				return;
			}
			ctx.ui?.notify?.(
				[`${METER}: ${reading.pct}% (~${k(reading.used)}/${k(reading.limit)}) — ${reading.level}`, "", reading.note].join("\n"),
				reading.level === "over" ? "warning" : "info",
			);
		},
	});
}
