import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Current-state docs must not carry stale counts. Every "N roles" / "N promoted
// skills" / "N beta skills" / "N local skills" / "N extensions" phrase in the
// docs a reader trusts for the present is compared with the tree. PLAN.md is a
// decision record with history ("10 roles → 7") and is deliberately not scanned.

const ROOT = resolve(import.meta.dirname, "..");
const CURRENT_STATE_DOCS = ["README.md", "AGENTS.md", "PROJECT.md", "CONTEXT.md", ".pi/APPEND_SYSTEM.md", ".pi/agents/README.md"];

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const toNumber = (token: string): number => (/^\d+$/.test(token) ? Number(token) : WORDS[token.toLowerCase()]);

function actualCounts() {
	const agents = readdirSync(join(ROOT, ".pi", "agents")).filter((f) => f.endsWith(".md") && /^---\n/.test(readFileSync(join(ROOT, ".pi", "agents", f), "utf8")));
	const localSkills = readdirSync(join(ROOT, ".pi", "skills")).filter((d) => existsSync(join(ROOT, ".pi", "skills", d, "SKILL.md")));
	const lock = JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8")) as { skillCount: number; skills: Record<string, { bucket: string }> };
	const buckets = Object.values(lock.skills).map((s) => s.bucket);
	const extDir = join(ROOT, ".pi", "extensions");
	const extensions = readdirSync(extDir).filter((name) => {
		const path = join(extDir, name);
		if (name.endsWith(".ts") && !name.endsWith(".test.ts")) return true;
		return !name.startsWith(".") && existsSync(join(path, "index.ts"));
	});
	return {
		roles: agents.length,
		"local skills": localSkills.length,
		"promoted skills": buckets.filter((b) => b === "promoted").length,
		"beta skills": buckets.filter((b) => b === "beta").length,
		"registered skills": lock.skillCount,
		extensions: extensions.length,
	};
}

test("current-state docs carry no stale roster, skill, or extension counts", () => {
	const actual = actualCounts();
	const phrase = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:harness\s+|task\s+)?(roles?|promoted skills?|beta skills?|registered skills?|local skills?|extensions?)\b/gi;
	const offenders: string[] = [];
	for (const doc of CURRENT_STATE_DOCS) {
		const text = readFileSync(join(ROOT, doc), "utf8");
		for (const m of text.matchAll(phrase)) {
			const n = toNumber(m[1]);
			const noun = m[2].toLowerCase().replace(/s?$/, "s") as keyof typeof actual;
			const expected = actual[noun];
			if (expected === undefined) continue;
			if (n !== expected) offenders.push(`${doc}: "${m[0]}" but the tree has ${expected}`);
		}
	}
	assert.deepEqual(offenders, []);
});
