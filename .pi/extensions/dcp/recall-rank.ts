import type { RecallEntry } from "./recall.js";

export function rankAndFilter(entries: RecallEntry[], query: string): RecallEntry[] {
  const regex = safeRegex(query);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .map((entry) => {
      const haystack = `${entry.title}\n${entry.text}`;
      const lower = haystack.toLowerCase();
      let matchScore = 0;
      if (regex?.test(haystack)) matchScore += 12;
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
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.entry.timestamp ?? 0) - (a.entry.timestamp ?? 0),
    )
    .map((item) => item.entry);
}

function recallRoleBoost(entry: RecallEntry): number {
  const role = entry.role?.toLowerCase() ?? "";
  if (role === "user") return 45;
  if (role === "assistant")
    return /^tool call:/i.test(entry.text.trim()) ? -30 : 35;
  if (role === "compaction") return 50;
  if (role === "task") return 5;
  if (role === "toolresult" || role === "tool_result" || role === "tool")
    return -25;
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

export function isBrowseDiagnostic(text: string): boolean {
  return isRecallEcho(text) || isBenchmarkDiagnostic(text);
}

function isRecallEcho(text: string): boolean {
  const markers = [
    /DCP recall (?:for|browse):/i,
    /\/d[ceo]p-recall/i,
    /output\s+["']?\/d[ceo]p-recall/i,
    /new output .*\/d[ceo]p-recall/i,
    /#\d+\s+\[jsonl:/i,
    /Expand with \/d[ceo]p-recall/i,
    /expand with recall\b/i,
    /Brutal review:.*(?:recall|browse-mode|query mode)/is,
    /This is \*\*clean\*\*.*too sparse/is,
    /Browse mode no longer shows:/i,
    /Browse mode .*?(?:tool spam|raw JSON|recall-debug loop|low-signal|too sparse)/is,
  ];
  return markers.some((marker) => marker.test(text));
}

function isBenchmarkDiagnostic(text: string): boolean {
  const markers = [
    /DCP deterministic compaction benchmark:/i,
    /DCP compaction diagnostic benchmark:/i,
    /\/dcp-ben(?:ch)?mark/i,
    /Use this output beside pi-vcc metrics/i,
    /Diagnostic only\. Normal workflow: \/compact and \/dcp-recall/i,
    /benchmark formatting is fixed/i,
    /That benchmark is .*?(?:excellent|very good)/is,
    /Before:\s*[\d,]+.*After:\s*[\d,]+.*Reduction:/is,
  ];
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

function safeRegex(query: string): RegExp | undefined {
  try {
    return new RegExp(query, "i");
  } catch {
    return undefined;
  }
}

