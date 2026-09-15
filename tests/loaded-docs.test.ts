import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

// Guidance an agent trusts for the present: AGENTS.md and PROJECT.md, the
// workflow rules and role bodies (both also copied into every consuming repo),
// the prompts, and our skills. Three drift guards over what git knows — never
// what happens to sit in this working tree, so a fresh clone (CI) and a
// developer checkout with runtime state decide the same way:
//   1. every relative link and backticked repo path names a tracked file or
//      directory, or runtime state that .gitignore declares;
//   2. no paragraph or bullet is stated twice across files (PLAN.md §6: a
//      section survives only if no other loaded text already says it);
//   3. the two files that ride along in every turn stay inside a byte budget.

const ROOT = resolve(import.meta.dirname, "..");
// a tracked file deleted but not yet `git rm`-ed is gone, not a crash
const TRACKED = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
	.split("\n")
	.filter((file) => file && existsSync(join(ROOT, file)));
const TRACKED_FILES = new Set(TRACKED);
const TRACKED_DIRS = new Set(
	TRACKED.flatMap((file) => {
		const parts = file.split("/");
		return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
	}),
);
const GUIDANCE = TRACKED.filter(
	(file) =>
		file === "AGENTS.md" ||
		file === "PROJECT.md" ||
		file === ".pi/APPEND_SYSTEM.md" ||
		/^\.pi\/(agents|prompts)\/[^/]+\.md$/.test(file) ||
		/^\.pi\/skills\/.+\.md$/.test(file),
);

/** `dir/file.ext`-shaped code spans; machine paths (~, /) are host facts, not repo paths. */
const PATH_TOKEN = /`([A-Za-z0-9_.@-][A-Za-z0-9_.@\/-]*\/[A-Za-z0-9_.@-]+\.(?:md|ts|mjs|json|py|sh))`/g;

/** Bytes of always-in-context text; raising a budget is a decision, not a fix. */
const BYTE_BUDGET: Record<string, number> = { "AGENTS.md": 6_000, ".pi/APPEND_SYSTEM.md": 12_000 };

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const repoPath = (absolute: string) => relative(ROOT, absolute).split(sep).join("/");

test("the guidance set is what the gates think it is", () => {
	for (const required of ["AGENTS.md", ".pi/APPEND_SYSTEM.md", ".pi/agents/reviewer.md", ".pi/prompts/verify.md", ".pi/skills/memory/SKILL.md"]) {
		assert.ok(GUIDANCE.includes(required), `${required} is not tracked or no longer matches the guidance filter`);
	}
});

test("links and backticked repo paths in guidance name tracked files or declared runtime state", () => {
	const pending: Array<{ label: string; candidates: string[] }> = [];
	const consider = (label: string, candidates: string[], suffix?: string) => {
		const inRepo = candidates.map(repoPath).filter((path) => path && !path.startsWith(".."));
		if (inRepo.some((path) => TRACKED_FILES.has(path) || TRACKED_DIRS.has(path.replace(/\/+$/, "")))) return;
		// skill-relative mentions such as `ask-matt/PHASE-BOUNDARIES.md`
		if (suffix && TRACKED.some((file) => file.endsWith(`/${suffix}`))) return;
		pending.push({ label, candidates: inRepo });
	};
	for (const file of GUIDANCE) {
		const text = read(file);
		for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1].split("#")[0];
			if (!target || /^(https?:|mailto:)/.test(target)) continue;
			consider(`${file}: link ${m[1]}`, [resolve(ROOT, dirname(file), target)]);
		}
		for (const m of text.matchAll(PATH_TOKEN)) {
			consider(`${file}: path \`${m[1]}\``, [resolve(ROOT, m[1]), resolve(ROOT, dirname(file), m[1])], m[1]);
		}
	}
	const ignored = new Set(
		spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
			cwd: ROOT,
			input: pending.flatMap((item) => item.candidates).join("\n"),
			encoding: "utf8",
		})
			.stdout.split("\n")
			.filter(Boolean),
	);
	const offenders = pending.filter((item) => !item.candidates.some((path) => ignored.has(path))).map((item) => item.label);
	assert.deepEqual(offenders, []);
});

test("no paragraph or bullet is repeated across guidance files", () => {
	const normalize = (unit: string) =>
		unit.replace(/^\s*([-*+]|\d+\.)\s+/, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
	const firstSeen = new Map<string, string>();
	const offenders: string[] = [];
	for (const file of GUIDANCE) {
		const body = read(file).replace(/^---\n[\s\S]*?\n---\n/, "").replace(/```[\s\S]*?```/g, "");
		const units = new Set<string>();
		for (const block of body.split(/\n\s*\n/)) {
			const prose = block.split("\n").filter((line) => !/^\s*(\||#)/.test(line));
			units.add(normalize(prose.join(" ")));
			for (const line of prose) if (/^\s*([-*+]|\d+\.)\s+/.test(line)) units.add(normalize(line));
		}
		for (const unit of units) {
			if (unit.length < 40 || unit.split(" ").length < 6) continue;
			const owner = firstSeen.get(unit);
			if (owner === undefined) firstSeen.set(unit, file);
			else if (owner !== file) offenders.push(`${owner} and ${file}: "${unit.slice(0, 80)}"`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("always-in-context files stay inside their byte budget", () => {
	for (const [file, budget] of Object.entries(BYTE_BUDGET)) {
		const bytes = statSync(join(ROOT, file)).size;
		assert.ok(bytes <= budget, `${file} is ${bytes} bytes (budget ${budget}): move detail into a skill or reference, or raise the budget deliberately`);
	}
});
