import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Roster hygiene: seven roles in three model tiers, bodies written for the
// child (no routing sections, no result-envelope boilerplate — pi-task parses
// none), pipeline roles kept out of the proactive catalog, and every skill a
// role declares must exist (pi-task fails the launch otherwise).

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS = join(ROOT, ".pi", "agents");
const VENDOR = join(ROOT, "vendor", "mattpocock-skills", "skills");
const MAPPING = join(ROOT, ".pi", "skills", "harness-catalog", "pi-mapping.md");

/**
 * Tools a role body may name, minus the names that are also ordinary shell
 * commands (`grep`, `find`, `ls`, `sed`): a body may be naming the command it
 * runs inside `bash`, so those cannot be read as a tool reference.
 */
const KNOWN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"srcwalk",
	"skill",
	"tracker",
	"recall",
	"task",
	"websearch",
	"web_fetch",
	"memory_read",
	"memory_search",
	"memory_write",
	"memory_delete",
]);

/**
 * Skills that tell their reader to spawn agents. A child cannot spawn, so the
 * role that loads one must state the substitution in its body: the child IS the
 * agent the skill would have spawned. The pinned sentence is what fails when
 * that statement is deleted.
 */
const COORDINATOR_SKILLS: Record<string, { role: string; bodyPins: RegExp; why: string }> = {
	research: {
		role: "scout",
		bodyPins: /write exactly that one file/,
		why: "the scout is the background agent the skill would spawn",
	},
	"codebase-design": {
		role: "designer",
		bodyPins: /one design candidate/,
		why: "the designer is one branch of design-it-twice",
	},
};

/** Phrasing that means "spawn an agent" — what the pi mapping has to cover. */
const SPAWN_PHRASING =
	/spawn\s+(?:both\s+)?(?:\d+\+?\s+)?(?:parallel\s+)?sub-?agents?|spin up a sub-?agent|background agent|dispatch a sub-?agent/i;

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

/** Does any markdown under a skill directory tell its reader to spawn an agent? */
function hasSpawnPhrasing(dir: string): boolean {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (hasSpawnPhrasing(path)) return true;
			continue;
		}
		if (entry.name.endsWith(".md") && SPAWN_PHRASING.test(readFileSync(path, "utf8"))) return true;
	}
	return false;
}

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

test("every declared skill exists and a coordinator skill carries its substitution", () => {
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
		for (const skill of skills) {
			const pairing = COORDINATOR_SKILLS[skill];
			if (pairing === undefined) continue;
			assert.equal(role.name, pairing.role, `${skill} belongs to ${pairing.role} — ${pairing.why}`);
			assert.match(
				role.raw,
				pairing.bodyPins,
				`${role.name}: ${skill} instructs a spawn, so the body must state the substitution (${pairing.why})`,
			);
		}
	}
});

test("a tool a body names is reachable through that role's allowlist", () => {
	// An explicit `tools:` line is the only way a pi-runtime child receives
	// `srcwalk` (or any opt-in tool): pi-task intersects the list with the
	// parent's tools, so an instruction to use an unlisted tool is dead text.
	const offenders: string[] = [];
	for (const role of roles) {
		const tools = frontmatter(role.raw).tools;
		if (tools === undefined) continue; // no allowlist: the child inherits every parent tool
		const allowed = new Set(tools.split(",").map((t) => t.trim()));
		const body = role.raw.replace(/^---\n[\s\S]*?\n---/, "");
		for (const match of body.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
			const token = match[1];
			if (token === undefined || !KNOWN_TOOLS.has(token) || allowed.has(token)) continue;
			offenders.push(`${role.name}: body names \`${token}\` but tools: does not list it`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("children cannot write memory, and every role stays on the pi runtime", () => {
	for (const role of roles) {
		const fm = frontmatter(role.raw);
		const denied = (fm.disallowed_tools ?? "").split(",").map((t) => t.trim());
		for (const tool of ["memory_write", "memory_delete"]) {
			assert.ok(denied.includes(tool), `${role.name}: ${tool} must be denied — only the parent writes memory`);
		}
		// The roles name pi-only tools and pi-only denies; pi-task's Claude
		// translator rejects both, so a runtime swap has to fail here, loudly.
		assert.ok(fm.runtime === undefined || fm.runtime === "pi", `${role.name}: harness roles are pi-runtime only, not ${fm.runtime}`);
	}
});

test("every vendored skill that tells an agent to spawn one is mapped for pi", () => {
	// A passing mention is not a mapping: the requirement is a section of its
	// own, `## \`<skill>\``, because that is where the translation is written.
	const mapping = readFileSync(MAPPING, "utf8");
	const offenders: string[] = [];
	for (const bucket of ["engineering", "productivity", "in-progress"]) {
		const dir = join(VENDOR, bucket);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !hasSpawnPhrasing(join(dir, entry.name))) continue;
			if (!mapping.includes(`## \`${entry.name}\``)) offenders.push(entry.name);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"a vendored skill instructs a spawn with no `## \\`<skill>\\`` mapping section in the harness-catalog skill; on pi the child cannot spawn, so the translation has to be written down",
	);
});

test("the catalog routes every discoverable skill", () => {
	// A registered skill with no catalog row is a skill nobody invokes: this is
	// how eight skills stayed invisible until the catalog existed.
	const catalog = readFileSync(join(ROOT, ".pi", "skills", "harness-catalog", "SKILL.md"), "utf8");
	const lock = JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8")) as {
		skills: Record<string, { bucket: string }>;
	};
	const local = readdirSync(join(ROOT, ".pi", "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(ROOT, ".pi", "skills", entry.name, "SKILL.md")))
		.map((entry) => entry.name);
	const offenders = [...Object.keys(lock.skills), ...local].filter(
		(name) => !catalog.includes(`/skill:${name}`) && !catalog.includes(`\`${name}\``),
	);
	assert.deepEqual(offenders, [], "every discoverable skill needs a row in .pi/skills/harness-catalog/SKILL.md");
});
