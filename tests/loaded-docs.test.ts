import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

// Guidance an agent trusts for the present: AGENTS.md and PROJECT.md, the
// workflow policy and child contract (.pi/policy/), the role bodies (copied
// into every consuming repo), the prompts, and our skills. Three drift guards over what git knows — never
// what happens to sit in this working tree, so a fresh clone (CI) and a
// developer checkout with runtime state decide the same way:
//   1. every relative link and backticked repo path names a tracked file or
//      directory, or runtime state that .gitignore declares;
//   2. no paragraph or bullet is stated twice across files (PLAN.md §6: a
//      section survives only if no other loaded text already says it);
//   3. the files that ride along in every turn stay inside a byte budget.
// PLAN.md gets a size cap of its own, apart from those budgets (see below).

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
		/^\.pi\/(agents|prompts|policy)\/[^/]+\.md$/.test(file) ||
		/^\.pi\/skills\/.+\.md$/.test(file),
);

/**
 * The child contract `npm run agents:sync` splices into every role body: one
 * source (`.pi/policy/CHILD-CONTRACT.md`) and seven generated copies, which
 * tests/agents.test.ts holds identical. Only the source counts as a statement.
 */
const GENERATED_CONTRACT = /<!-- child-contract:begin[^\n]*-->\n[\s\S]*?\n<!-- child-contract:end -->\n?/g;

/** `dir/file.ext`-shaped code spans; machine paths (~, /) are host facts, not repo paths. */
const PATH_TOKEN = /`([A-Za-z0-9_.@-][A-Za-z0-9_.@/-]*\/[A-Za-z0-9_.@-]+\.(?:md|ts|mjs|json|py|sh))`/g;

/**
 * Bytes of always-in-context text; raising a budget is a decision, not a fix.
 * The workflow policy (injected into every parent turn) went 12,000 → 12,500
 * (2026-09-26) for the child contract's `bash` timeout rule, when the contract
 * still lived there: a hung gate costs a blocked child, which is worth more
 * than the ~40 tokens a turn the extra line adds. The child contract rides in
 * every child's role body, so it gets a budget of its own.
 */
const BYTE_BUDGET: Record<string, number> = {
	"AGENTS.md": 6_000,
	".pi/policy/WORKFLOW.md": 12_500,
	".pi/policy/CHILD-CONTRACT.md": 2_500,
};

/**
 * PLAN.md is not always-in-context text; it is the current-state contract, and
 * it stays one because the dated history lives in docs/history.md and the
 * decisions with their reasons in docs/adr/ (split 2026-09-26, when the file
 * had reached 80 KB and its sections had drifted from the tree). A contract
 * small enough to check against the tree in one read is the point, so raising
 * the cap is a decision, and history goes to docs/history.md instead.
 */
const PLAN_MAX_BYTES = 10_000;

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const repoPath = (absolute: string) => relative(ROOT, absolute).split(sep).join("/");

test("the guidance set is what the gates think it is", () => {
	for (const required of [
		"AGENTS.md",
		".pi/policy/WORKFLOW.md",
		".pi/agents/reviewer.md",
		".pi/policy/CHILD-CONTRACT.md",
		".pi/prompts/verify.md",
		".pi/skills/memory/SKILL.md",
	]) {
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
			const link = m[1];
			if (link === undefined) continue;
			const target = link.split("#")[0] ?? "";
			if (!target || /^(https?:|mailto:)/.test(target)) continue;
			consider(`${file}: link ${link}`, [resolve(ROOT, dirname(file), target)]);
		}
		for (const m of text.matchAll(PATH_TOKEN)) {
			const token = m[1];
			if (token === undefined) continue;
			consider(`${file}: path \`${token}\``, [resolve(ROOT, token), resolve(ROOT, dirname(file), token)], token);
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
		unit
			.replace(/^\s*([-*+]|\d+\.)\s+/, "")
			.replace(/[`*_]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	const firstSeen = new Map<string, string>();
	const offenders: string[] = [];
	for (const file of GUIDANCE) {
		const body = read(file)
			.replace(/^---\n[\s\S]*?\n---\n/, "")
			.replace(GENERATED_CONTRACT, "")
			.replace(/```[\s\S]*?```/g, "");
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
		// Name the headroom or the overflow: at these budgets the number is the whole
		// decision ("43 bytes left" is room for one clause, "2.000 over" is not).
		const room = bytes <= budget ? `${budget - bytes} left` : `${bytes - budget} over`;
		assert.ok(
			bytes <= budget,
			`${file} is ${bytes} bytes against a budget of ${budget} (${room}): move detail into a skill or reference, or raise the budget deliberately`,
		);
	}
});

test("PLAN.md stays a current-state contract inside its size cap", () => {
	const bytes = statSync(join(ROOT, "PLAN.md")).size;
	assert.ok(
		bytes <= PLAN_MAX_BYTES,
		`PLAN.md is ${bytes} bytes against a cap of ${PLAN_MAX_BYTES} (${bytes - PLAN_MAX_BYTES} over): move dated entries to docs/history.md and reasons to an ADR in docs/adr/, or raise the cap deliberately`,
	);
});
