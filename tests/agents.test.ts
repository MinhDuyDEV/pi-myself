import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Roster hygiene: seven roles in three model tiers, bodies written for the
// child (no routing sections, no result-envelope boilerplate — pi-task parses
// none), pipeline roles kept out of the proactive catalog, and every skill a
// role declares must exist (pi-task fails the launch otherwise). A child sees
// its role body and nothing of the parent's workflow rules — pi-task passes the
// body as --append-system-prompt, which suppresses a discovered APPEND_SYSTEM.md
// — so the child contract is spliced into every body from one source.

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS = join(ROOT, ".pi", "agents");
const CONTRACT_SOURCE = join(ROOT, ".pi", "policy", "CHILD-CONTRACT.md");
/** The generated block `npm run agents:sync` writes at the end of every role body. */
const CONTRACT_BLOCK = /\n<!-- child-contract:begin[^\n]*-->\n([\s\S]*?)\n<!-- child-contract:end -->\n$/;
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

/**
 * Phrasing that means "spawn an agent" — what the pi mapping has to cover. Any
 * mention of a sub-agent counts: a narrow verb list missed phrasings such as
 * "split the work into subagents", so a skill that only *mentions* one is
 * exempted by name below, with the reason, instead.
 */
const SPAWN_PHRASING = /\bsub-?agents?\b|background agent/i;
const SPAWN_MENTION_ONLY: Record<string, string> = {
	"writing-for-agents":
		"names a subagent dispatch as one kind of context boundary a document is written across; it never tells its reader to spawn one",
};

const ROSTER = ["explore", "scout", "general", "reviewer", "designer", "ultra-scout", "ultra-verifier"];
const READ_TIER = new Set(["explore", "scout"]);
const REVIEW_TIER = new Set(["reviewer", "ultra-scout"]);
const PIPELINE = new Set(["ultra-scout", "ultra-verifier"]);
type Tier = "read" | "reason" | "review";
/** Roles that must not change state: readonly, plus scout, whose one write is a named report. */
const NO_TRACKER = new Set(["explore", "scout", "reviewer", "designer", "ultra-scout"]);

/** `provider/deepseek-v4-flash` → `deepseek`: the vendor family, the unit of shared blind spots. */
function modelFamily(model: string): string {
	return (
		model
			.split("/")
			.pop()!
			.match(/^[a-z]+/)?.[0] ?? model
	);
}

function tierOf(name: string): Tier {
	return READ_TIER.has(name) ? "read" : REVIEW_TIER.has(name) ? "review" : "reason";
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** The role body a child receives, minus the generated contract block every role shares. */
function ownBody(raw: string): string {
	return raw.replace(/^---\n[\s\S]*?\n---/, "").replace(CONTRACT_BLOCK, "\n");
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

/** The models the role files themselves declare, per tier — no second copy to keep in step. */
function tierModels(): Record<Tier, Set<string>> {
	const models: Record<Tier, Set<string>> = { read: new Set(), reason: new Set(), review: new Set() };
	for (const role of roles) models[tierOf(role.name)].add(frontmatter(role.raw).model ?? "(none)");
	return models;
}

test("every role sits in a tier that runs one model, with a one-line description", () => {
	// Picking a model is mechanical only while a tier means one model: change a
	// tier by editing the `model:` line of every role in it.
	for (const [tier, models] of Object.entries(tierModels())) {
		assert.equal(models.size, 1, `tier ${tier} runs one model, found ${[...models].join(", ")}`);
	}
	for (const role of roles) {
		const fm = frontmatter(role.raw);
		const tier = tierOf(role.name);
		assert.ok(fm.model, `${role.name}: model is set`);
		assert.ok(fm.description && fm.description.length <= 400, `${role.name}: description present and one line`);
		assert.match(role.raw, new RegExp(`Tier: \\*\\*${tier}\\*\\*`), `${role.name}: body names its tier`);
		assert.notEqual(fm.readonly, "false", `${role.name}: readonly: false is the default, drop it`);
	}
});

test("the review tier judges on a different model family than the reason tier writes", () => {
	// Author and reviewer on one vendor share blind spots; the independent review
	// the workflow requires is only independent if the family differs. Read from
	// the role files, so a swap in any one of them is caught.
	const { reason, review } = tierModels();
	const reasonFamilies = new Set([...reason].map(modelFamily));
	const shared = [...review].map(modelFamily).filter((family) => reasonFamilies.has(family));
	assert.deepEqual(shared, [], "review tier must not share the reason tier's model family");
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
		assert.doesNotMatch(role.raw, /^## (Use For|Do Not Use For)/m, `${role.name}: routing belongs in description + the workflow policy`);
		assert.doesNotMatch(
			role.raw,
			/<result>|machine-readable envelope|parser's four statuses/,
			`${role.name}: pi-task parses no envelope; the child contract states the plain report`,
		);
	}
});

test("every role ends with the generated child contract, identical to its one source", () => {
	// The child never sees the parent's workflow rules, so a rule every child
	// needs lives in the block `npm run agents:sync` splices from the source.
	const source = readFileSync(CONTRACT_SOURCE, "utf8").trim();
	for (const role of roles) {
		const block = CONTRACT_BLOCK.exec(role.raw)?.[1];
		assert.ok(block !== undefined, `${role.name}: no child-contract block at the end of the body — run npm run agents:sync`);
		assert.equal(block, source, `${role.name}: the child-contract block drifted from its source — run npm run agents:sync`);
		assert.equal(role.raw.split("child-contract:begin").length, 2, `${role.name}: exactly one child-contract block`);
	}
	assert.match(source, /Status: success/, "the contract's report line uses pi-task's own status wording");
});

test("a declared skill is named on the body's Load first line, because skills: only lists it", () => {
	// pi-task passes a declared skill's path; loading stays progressive (pi-task
	// README), and the child cannot see its own frontmatter. Without the line a
	// declared skill is never read.
	for (const role of roles) {
		const skills = list(frontmatter(role.raw).skills);
		const loadLine = ownBody(role.raw).match(/^Load first: (.+)$/m)?.[1] ?? "";
		for (const skill of skills) assert.ok(loadLine.includes(`\`${skill}\``), `${role.name}: Load first line must name \`${skill}\``);
		if (skills.length === 0) assert.equal(loadLine, "", `${role.name}: a Load first line with no declared skill`);
	}
});

test("no child can ask the user, and a role that must not change state cannot reach the tracker", () => {
	// A child's question lands in a pane nobody is answering and hangs the task
	// until pi-task's 30-minute ceiling; the tracker writes (claim, resolve,
	// comment) past readonly: true, which denies only write/edit/apply_patch.
	for (const role of roles) {
		const fm = frontmatter(role.raw);
		const denied = list(fm.disallowed_tools);
		assert.ok(denied.includes("ask_user"), `${role.name}: ask_user must be denied — a child returns blocked with the question`);
		if (!NO_TRACKER.has(role.name)) continue;
		const allowed = fm.tools === undefined ? undefined : list(fm.tools);
		const reachable = allowed === undefined ? !denied.includes("tracker") : allowed.includes("tracker");
		assert.ok(!reachable, `${role.name}: tracker must be unreachable (deny it, or leave it off the tools: allowlist)`);
	}
});

test("every role sets max_turns so a long child wraps up before the hard timeout", () => {
	// pi-task steers a wrap-up at max_turns (terminal backends, HerdR here); the
	// only other bound is PI_TASK_HARD_TIMEOUT_MINUTES (default 30), which stops
	// the child wherever it is instead of asking it to report.
	for (const role of roles) {
		const turns = Number(frontmatter(role.raw).max_turns);
		assert.ok(Number.isInteger(turns) && turns > 0 && turns <= 100, `${role.name}: max_turns is a positive integer, got ${turns}`);
	}
});

test("every declared skill exists and a coordinator skill carries its substitution", () => {
	for (const role of roles) {
		const skills = list(frontmatter(role.raw).skills);
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
				ownBody(role.raw),
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
	// The shared contract block names its tools conditionally ("when your
	// tools include it") or to forbid them, so only the role's own text counts.
	const offenders: string[] = [];
	for (const role of roles) {
		const tools = frontmatter(role.raw).tools;
		if (tools === undefined) continue; // no allowlist: the child inherits every parent tool
		const allowed = new Set(list(tools));
		for (const match of ownBody(role.raw).matchAll(/`([a-z][a-z0-9_]*)`/g)) {
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
		const denied = list(fm.disallowed_tools);
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
			if (entry.name in SPAWN_MENTION_ONLY) continue;
			if (!mapping.includes(`## \`${entry.name}\``)) offenders.push(entry.name);
		}
	}
	for (const name of Object.keys(SPAWN_MENTION_ONLY)) {
		const present = ["engineering", "productivity", "in-progress"].some((bucket) => existsSync(join(VENDOR, bucket, name)));
		assert.ok(present, `${name} is exempted from the spawn mapping but no longer vendored; drop the exemption`);
	}
	assert.deepEqual(
		offenders,
		[],
		"a vendored skill instructs a spawn with no `## \\`<skill>\\`` mapping section in the harness-catalog skill; on pi the child cannot spawn, so the translation has to be written down",
	);
});

/**
 * Host tokens a vendored skill can use that pi lacks or names differently. A
 * skill that uses one is covered only when the mapping's host table has a row
 * for it — the spawn scan above never saw `/clear`, `CLAUDE.md` shadowing, or a
 * script that reads stdin, which is how those went unmapped.
 */
const HOST_TOKENS: Array<{ token: string; used: (file: string, text: string) => boolean; row: RegExp }> = [
	{ token: "/clear", used: (_file, text) => /(^|[\s`(])\/clear\b/.test(text), row: /^\| `\/clear` \|/m },
	{ token: "/handoff", used: (_file, text) => /(^|[\s`(])\/handoff\b/.test(text), row: /^\| `\/handoff` \|/m },
	{ token: "CLAUDE.md", used: (_file, text) => text.includes("CLAUDE.md"), row: /^\| `CLAUDE\.md` \|/m },
	{ token: "claude --bg", used: (_file, text) => text.includes("claude --bg"), row: /^\| `claude --bg` \|/m },
	{
		token: "a script reading stdin",
		used: (file, text) => file.endsWith(".sh") && /^[^#\n]*\bread\s+-?[a-z]/m.test(text),
		row: /^\| a script that reads stdin/m,
	},
];

function vendoredFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return vendoredFiles(path);
		return /\.(md|sh)$/.test(entry.name) ? [path] : [];
	});
}

test("every host token a vendored skill uses has a row in the pi mapping", () => {
	const mapping = readFileSync(MAPPING, "utf8");
	const offenders: string[] = [];
	for (const { token, used, row } of HOST_TOKENS) {
		const users = ["engineering", "productivity", "in-progress"]
			.flatMap((bucket) => vendoredFiles(join(VENDOR, bucket)))
			.filter((file) => used(file, readFileSync(file, "utf8")));
		if (users.length > 0 && !row.test(mapping)) offenders.push(`${token} (used by ${users[0]}) has no row`);
	}
	assert.deepEqual(offenders, [], "pi-mapping.md's host table must translate every pinned token the vendored trees use");
});

test("the catalog's actor column matches each skill's invocation class", () => {
	// A model-invoked skill labelled "human" gets handed to the user instead of
	// loaded (domain-modeling did); a user-invoked one labelled "model" is a
	// call the skill tool refuses.
	const catalog = readFileSync(join(ROOT, ".pi", "skills", "harness-catalog", "SKILL.md"), "utf8");
	const lock = JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8")) as { skills: Record<string, { modelInvoked: boolean }> };
	const modelInvoked = new Map<string, boolean>(Object.entries(lock.skills).map(([name, meta]) => [name, meta.modelInvoked]));
	for (const entry of readdirSync(join(ROOT, ".pi", "skills"), { withFileTypes: true })) {
		const file = join(ROOT, ".pi", "skills", entry.name, "SKILL.md");
		if (entry.isDirectory() && existsSync(file)) {
			modelInvoked.set(entry.name, !/^disable-model-invocation:\s*true\s*$/m.test(readFileSync(file, "utf8")));
		}
	}
	const offenders: string[] = [];
	for (const row of catalog.matchAll(/^\|[^|\n]*\| (human|model) \|([^\n]*)\|$/gm)) {
		const [, actor, command = ""] = row;
		for (const name of command.matchAll(/`(?:\/skill:)?([a-z0-9-]+)`/g)) {
			const skill = name[1] ?? "";
			const invoked = modelInvoked.get(skill);
			if (invoked === undefined) continue; // a tool, role, or command, not a skill
			if (actor === "human" && invoked) offenders.push(`${skill} is model-invoked but its row says human`);
			if (actor === "model" && !invoked) offenders.push(`${skill} is user-invoked but its row says model`);
		}
	}
	assert.deepEqual(offenders, []);
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
