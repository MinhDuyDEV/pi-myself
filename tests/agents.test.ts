import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Roster hygiene: seven roles in three model tiers, bodies written for the
// child (no routing sections, no result-envelope boilerplate — pi-task parses
// none), pipeline roles kept out of the proactive catalog, and every skill a
// role declares must exist (pi-task fails the launch otherwise).

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS = join(ROOT, ".pi", "agents");
const VENDOR = join(ROOT, "vendor", "mattpocock-skills", "skills");

const ROSTER = ["explore", "scout", "general", "reviewer", "designer", "ultra-scout", "ultra-verifier"];
const READ_TIER = new Set(["explore", "scout"]);
const REVIEW_TIER = new Set(["reviewer", "ultra-scout"]);
const PIPELINE = new Set(["ultra-scout", "ultra-verifier"]);
/** One model per tier: change it here and in the role files together. */
const TIER_MODEL = {
	read: "opencode-go/deepseek-v4-flash",
	reason: "opencode-go/deepseek-v4-flash",
	review: "opencode-go/kimi-k3",
};

/** `provider/deepseek-v4-flash` → `deepseek`: the vendor family, the unit of shared blind spots. */
function modelFamily(model: string): string {
	return (
		model
			.split("/")
			.pop()!
			.match(/^[a-z]+/)?.[0] ?? model
	);
}

function tierOf(name: string): keyof typeof TIER_MODEL {
	return READ_TIER.has(name) ? "read" : REVIEW_TIER.has(name) ? "review" : "reason";
}

function frontmatter(raw: string): Record<string, string> {
	const block = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const match = /^([a-z_-]+):\s*(.*)$/.exec(line);
		const key = match?.[1];
		if (key !== undefined) out[key] = (match?.[2] ?? "").trim();
	}
	return out;
}

function skillExists(name: string): boolean {
	const local = join(ROOT, ".pi", "skills", name, "SKILL.md");
	const buckets = ["engineering", "productivity", "in-progress"].map((b) => join(VENDOR, b, name, "SKILL.md"));
	return [local, ...buckets].some((p) => {
		try {
			readFileSync(p);
			return true;
		} catch {
			return false;
		}
	});
}

const roles = readdirSync(AGENTS)
	.filter((f) => f.endsWith(".md") && f !== "README.md")
	.map((f) => ({ name: f.replace(/\.md$/, ""), raw: readFileSync(join(AGENTS, f), "utf8") }));

test("the roster is exactly the seven roles", () => {
	assert.deepEqual(roles.map((r) => r.name).sort(), [...ROSTER].sort());
});

test("every role sits in a tier with that tier's model and a one-line description", () => {
	for (const role of roles) {
		const fm = frontmatter(role.raw);
		const tier = tierOf(role.name);
		assert.equal(fm.model, TIER_MODEL[tier], `${role.name}: tier ${tier} model`);
		assert.ok(fm.description && fm.description.length <= 400, `${role.name}: description present and one line`);
		assert.match(role.raw, new RegExp(`Tier: \\*\\*${tier}\\*\\*`), `${role.name}: body names its tier`);
		assert.notEqual(fm.readonly, "false", `${role.name}: readonly: false is the default, drop it`);
	}
});

test("the review tier judges on a different model family than the reason tier writes", () => {
	// Author and reviewer on one vendor share blind spots; the independent review
	// APPEND_SYSTEM requires is only independent if the family differs.
	assert.notEqual(
		modelFamily(TIER_MODEL.review),
		modelFamily(TIER_MODEL.reason),
		"review tier must not share the reason tier's model family",
	);
	for (const role of roles) {
		if (REVIEW_TIER.has(role.name)) assert.equal(frontmatter(role.raw).readonly, "true", `${role.name}: the review tier never writes`);
	}
});

test("read-tier roles never write except scout's single report; pipeline roles are not proactive", () => {
	for (const role of roles) {
		const fm = frontmatter(role.raw);
		if (READ_TIER.has(role.name) && role.name !== "scout") assert.equal(fm.readonly, "true", `${role.name} must be readonly`);
		if (PIPELINE.has(role.name)) assert.equal(fm.proactive, "false", `${role.name} is launched only by its skill`);
		else assert.equal(fm.proactive, "true", `${role.name} belongs in the proactive catalog`);
	}
});

test("bodies are written for the child: no routing sections, no result-envelope boilerplate", () => {
	for (const role of roles) {
		assert.doesNotMatch(role.raw, /^## (Use For|Do Not Use For)/m, `${role.name}: routing belongs in description + APPEND_SYSTEM`);
		assert.doesNotMatch(
			role.raw,
			/<result>|machine-readable envelope/,
			`${role.name}: pi-task parses no envelope; the contract lives in APPEND_SYSTEM`,
		);
	}
	const append = readFileSync(join(ROOT, ".pi", "APPEND_SYSTEM.md"), "utf8");
	assert.match(append, /### Task child contract/, "APPEND_SYSTEM carries the shared child contract");
	assert.doesNotMatch(append, /parser's four statuses/, "no phantom envelope parser");
});

test("every declared skill exists and no role loads a coordinator skill", () => {
	for (const role of roles) {
		const skills = (frontmatter(role.raw).skills ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		for (const skill of skills) assert.ok(skillExists(skill), `${role.name} declares unknown skill ${skill}`);
		assert.ok(
			!skills.includes("code-review"),
			`${role.name}: code-review spawns sub-agents, which a child cannot; it is the parent's skill`,
		);
	}
});
