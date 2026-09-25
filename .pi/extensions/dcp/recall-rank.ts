import type { RecallEntry } from "./recall.js";

/** Floor for a genuinely matched entry whose role/length/echo penalties would
 * otherwise drive the score to zero or below and filter it out. */
const MIN_MATCHED_SCORE = 1;

export function rankAndFilter(entries: RecallEntry[], query: string): RecallEntry[] {
	const regex = safeRegex(query);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return entries
		.map((entry) => {
			const haystack = `${entry.title}\n${entry.text}`;
			const lower = haystack.toLowerCase();
			let matchScore = 0;
			if (regex?.test(haystack.slice(0, MAX_REGEX_HAYSTACK))) matchScore += 12;
			for (const term of terms) {
				const count = lower.split(term).length - 1;
				matchScore += Math.min(count, 3) * Math.max(1, 8 - term.length / 4);
			}
			if (matchScore <= 0) return { entry, score: 0 };
			const score =
				matchScore +
				recallRoleBoost(entry) +
				taskExactDescriptionBoost(entry, query) -
				recallLengthPenalty(entry.text) -
				recallEchoPenalty(entry.text);
			// The query really matched (`matchScore > 0`), so the penalties are
			// ranking signals, not evidence of a miss: a net-negative score clamps
			// here and sorts last instead of vanishing behind "No results".
			return { entry, score: Math.max(score, MIN_MATCHED_SCORE) };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || (b.entry.timestamp ?? 0) - (a.entry.timestamp ?? 0))
		.map((item) => item.entry);
}

function recallRoleBoost(entry: RecallEntry): number {
	const role = entry.role?.toLowerCase() ?? "";
	if (role === "user") return 45;
	// A tool call carries its path/command arguments: findable when they match,
	// ranked below prose that says the same thing.
	if (role === "assistant") return /^tool call:/i.test(entry.text.trim()) ? -10 : 35;
	if (role === "compaction") return 50;
	if (role === "task") return 5;
	if (role === "toolresult" || role === "tool_result" || role === "tool") return -25;
	return 0;
}

function taskExactDescriptionBoost(entry: RecallEntry, query: string): number {
	if (!entry.taskDescription) return 0;
	const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
	return normalize(entry.taskDescription) === normalize(query) ? 90 : 0;
}

function recallLengthPenalty(text: string): number {
	return Math.min(20, Math.floor(text.length / 2_000));
}

function recallEchoPenalty(text: string): number {
	return isRecallEcho(text) ? 55 : 0;
}

/** Recall's own rendered output, echoed back into a session as a tool result
 * or quoted by the assistant, is not history worth recalling. The markers are
 * the shapes renderSearch / renderExpanded emit. */
export function isBrowseDiagnostic(text: string): boolean {
	return isRecallEcho(text);
}

function isRecallEcho(text: string): boolean {
	const markers = [/DCP recall (?:for|browse):/i, /#\d+\s+\[jsonl:/i, /Expand with recall using expand:/i];
	return markers.some((marker) => marker.test(text));
}

export function isLowSignalAcknowledgement(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[.!?"'`*_~()[\]{}:;,]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return true;
	if (normalized.length > 80) return false;
	const patterns = [
		/^(ok|okay|sure|yes|yep|yeah|fine|good|great|sounds good|nice|thanks|thank you)$/,
		/^(ok|okay) (sure|sounds good|thanks|thank you)$/,
		/^(ok|okay|sure|yes|yep|yeah|fine|sounds good) (go ahead|continue|please continue|do it|proceed)$/,
		/^(ok|okay|sure|yes|yep|yeah|fine) (go ahead )?continue( next work)?$/,
		/^please continue$/,
		/^go ahead$/,
	];
	return patterns.some((pattern) => pattern.test(normalized));
}

/** Longest query compiled as a regex. */
const MAX_REGEX_QUERY_LENGTH = 200;
/** Longest prefix of an entry the regex runs against — a throughput bound for
 * large messages, not a backtracking guard. Term scoring below still covers the
 * full text. */
const MAX_REGEX_HAYSTACK = 8_192;
/** The classic exponential-backtracking shape: a quantifier applied to a group
 * that itself already ends in one (`(a+)+`, `(?:\d+)*`). The query is
 * model-authored rather than adversarial input, but a single `test()` cannot be
 * interrupted once it starts, so this shape degrades to term scoring — the regex
 * is only a ranking bonus here — instead of risking an uninterruptible hang.
 * Residual: an algebraically overlapping alternation such as `(a|aa)+` is not
 * detected; it requires deliberately constructing the pattern. */
const NESTED_QUANTIFIER = /\([^()]*[+*]\)[+*]/;

function safeRegex(query: string): RegExp | undefined {
	if (query.length > MAX_REGEX_QUERY_LENGTH || NESTED_QUANTIFIER.test(query)) return undefined;
	try {
		return new RegExp(query, "i");
	} catch {
		return undefined;
	}
}
