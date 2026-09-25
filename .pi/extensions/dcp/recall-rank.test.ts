import { test } from "node:test";

import { expect } from "../tests/expect.js";
import type { RecallEntry } from "./recall.js";
import { rankAndFilter } from "./recall-rank.js";

/** One searchable entry; `user` is the role the ranker boosts most. */
const entry = (text: string, role = "user"): RecallEntry => ({
	index: 1,
	source: "jsonl",
	role,
	title: "[jsonl:user]",
	text,
});

// rankAndFilter only applies role/length/echo scoring once the match score is
// positive, so `length === 0` below means "the pattern did not match at all" —
// which is exactly the discriminator these tests need.

test("a safe regex that matches still scores (baseline)", () => {
	// "a+b" matches "aaab" as a regex and appears nowhere literally, so only the
	// regex bonus can keep the entry.
	expect(rankAndFilter([entry("aaab")], "a+b").length).toBe(1);
});

test("a nested-quantifier pattern degrades to term scoring instead of backtracking", () => {
	// Compiled, "(a+)+b" also matches "aaab" and would score. Skipped, only
	// literal term scoring remains. The pattern is the classic exponential shape
	// and, once running, a single test() cannot be interrupted.
	expect(rankAndFilter([entry("aaab")], "(a+)+b").length).toBe(0);
	expect(rankAndFilter([entry("aaab")], "(?:a+)*b").length).toBe(0);
	// a plain alternation is not a nested quantifier and must keep working
	expect(rankAndFilter([entry("aaab")], "(?:a|b)+b").length).toBe(1);
});

test("an over-long query is never compiled as a regex", () => {
	const text = `${"a".repeat(200)}b`;
	const pattern = `(?:a){200}b|${"z".repeat(220)}`;
	expect(pattern.length > 200).toBeTrue();
	// the first alternative matches `text`, so only the length guard can stop it
	expect(rankAndFilter([entry(text)], pattern).length).toBe(0);
});

test("an invalid regex falls back to term scoring without throwing", () => {
	// "(" is not a valid pattern and does not occur literally in the text.
	expect(rankAndFilter([entry("a dangling paren")], "(").length).toBe(0);
	expect(rankAndFilter([entry("a dangling paren")], "dangling").length).toBe(1);
});

test("a matched entry buried by role and echo penalties is returned last, not dropped", () => {
	// toolResult carries -25 and a recall echo another -55; the literal "needle"
	// match is real, so the penalties may only demote it, never erase it behind
	// "No results".
	const echo = entry('DCP recall for "needle": 1 result (page 1)', "toolResult");
	const result = rankAndFilter([entry("needle ordinary hit"), echo], "needle");
	expect(result).toHaveLength(2);
	expect(result[0]?.text).toBe("needle ordinary hit");
	expect(result[1]?.role).toBe("toolResult");
});
