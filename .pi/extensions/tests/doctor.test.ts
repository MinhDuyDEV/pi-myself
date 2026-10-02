import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import provisionExtension, { type DoctorFinding, type DoctorInputs, type DoctorSpawnResult, runDoctor } from "../provision.js";

// `/setup-pi-myself --check` is a read-only doctor: every finding is `ok` or a
// `warn` that names its fix. runDoctor is pure over injected inputs; the
// handler only gathers them (tools, files, spawn) and notifies one report.

const REPO = "/repo";
const PKG = "/pkg";
const AGENT_DIR = "/home/me/.pi/agent";
const IGNORED = [
	".pi/sessions/x",
	".pi/task-exits/x",
	".pi/artifacts/x",
	".pi/task-session-history.json",
	".pi/task-registry.json",
	".pi/git/x",
	".pi/npm/x",
];

const role = (model: string) => `---\ndescription: a role\nmodel: ${model}\n---\nbody\n`;

function healthyFiles(): Record<string, string> {
	const files: Record<string, string> = {
		[`${REPO}/docs/agents/issue-tracker.md`]: "# tracker\n",
		[`${REPO}/docs/agents/domain.md`]: "# domain\n",
		[`${REPO}/.pi/settings.json`]: JSON.stringify({ packages: ["git:github.com/MinhDuyDEV/pi-myself"] }),
		[`${AGENT_DIR}/settings.json`]: JSON.stringify({ packages: ["npm:@heyhuynhgiabuu/pi-task"] }),
	};
	for (const name of ["explore", "scout", "general", "designer", "ultra-verifier"]) {
		files[`${REPO}/.pi/agents/${name}.md`] = role("opencode-go/deepseek-v4-flash");
	}
	for (const name of ["reviewer", "ultra-scout"]) files[`${REPO}/.pi/agents/${name}.md`] = role("opencode-go/kimi-k3");
	return files;
}

const done = (stdout: string, status = 0): DoctorSpawnResult => ({ status, signal: null, error: undefined, stdout, stderr: "" });

function inputs(
	overrides: {
		files?: Record<string, string>;
		tools?: string[];
		spawn?: DoctorInputs["spawn"];
		trusted?: boolean;
		repoRoot?: string;
		rootEntries?: string[];
	} = {},
): DoctorInputs {
	const files = overrides.files ?? healthyFiles();
	const repoRoot = overrides.repoRoot ?? REPO;
	return {
		projectTrusted: overrides.trusted ?? true,
		repoRoot,
		packageRoot: PKG,
		agentDir: AGENT_DIR,
		nodePath: "/usr/bin/node",
		toolNames: overrides.tools ?? ["read", "task", "memory_search", "web_search"],
		readFile: (path) => files[path],
		// the root listing, spelled as the directory spells it: by default the files given directly under the root
		rootEntries:
			overrides.rootEntries ??
			Object.keys(files)
				.filter((path) => path.startsWith(`${repoRoot}/`) && !path.slice(repoRoot.length + 1).includes("/"))
				.map((path) => path.slice(repoRoot.length + 1)),
		spawn:
			overrides.spawn ??
			((command, args) => {
				if (command === "git") return done(`${args.slice(1).join("\n")}\n`);
				return done("setup-project --check: 0 created, 0 updated, 7 unchanged in /repo/.pi — dry run, nothing written; current\n");
			}),
	};
}

function finding(findings: DoctorFinding[], check: string): DoctorFinding {
	const found = findings.find((f) => f.check === check);
	assert.ok(found, `no ${check} finding in ${JSON.stringify(findings)}`);
	return found;
}

test("a healthy project gets one ok per check and no warning", () => {
	const findings = runDoctor(inputs());
	assert.deepEqual(
		findings.map((f) => `${f.status} ${f.check}`),
		[
			"ok trust",
			"ok roles",
			"ok model tiers",
			"ok companions",
			"ok srcwalk",
			"ok tracker docs",
			"ok domain docs",
			"ok install scope",
			"ok gitignore",
		],
	);
});

test("a note from a current --check (a linked .pi/agents outside the repo) reaches the roles finding", () => {
	const note = "note: .pi/agents resolves to /shared/roles, outside this repository; a run writes there";
	const spawn: DoctorInputs["spawn"] = (command, args) =>
		command === "git"
			? done(`${args.slice(1).join("\n")}\n`)
			: done(`${note}\nsetup-project --check: 0 created, 0 updated, 7 unchanged in /repo/.pi — dry run, nothing written; current\n`);
	const roles = finding(runDoctor(inputs({ spawn })), "roles");
	assert.equal(roles.status, "ok");
	assert.match(roles.detail, /resolves to \/shared\/roles, outside this repository/);
});

test("an untrusted project is a warning: pi loads none of its .pi/ resources", () => {
	// Without trust pi skips the project's .pi/ settings, extensions, and
	// APPEND_SYSTEM.md, and a task that declares skills does not resolve.
	const trust = finding(runDoctor(inputs({ trusted: false })), "trust");
	assert.equal(trust.status, "warn");
	assert.match(trust.detail, /not trusted/);
	assert.match(trust.fix ?? "", /\/trust/);
});

test("stale roles: the doctor runs the script's --check against the repo and relays what would change", () => {
	const calls: string[][] = [];
	const findings = runDoctor(
		inputs({
			spawn: (command, args) => {
				calls.push([command, ...args]);
				if (command === "git") return done(`${args.slice(1).join("\n")}\n`);
				return done("[check] updated  agents/general.md\nsetup-project --check: 0 created, 1 updated, 6 unchanged — stale\n", 1);
			},
		}),
	);
	assert.deepEqual(calls[0], ["/usr/bin/node", `${PKG}/scripts/setup-project.mjs`, REPO, "--check"]);
	const roles = finding(findings, "roles");
	assert.equal(roles.status, "warn");
	assert.match(roles.detail, /\[check\] updated {2}agents\/general\.md/);
	assert.match(roles.fix ?? "", /run \/setup-pi-myself/);
});

test("a script that could not run is reported the way /setup-pi-myself reports it, not as stale roles", () => {
	const timedOut = runDoctor(
		inputs({
			spawn: (command, args) =>
				command === "git"
					? done(`${args.slice(1).join("\n")}\n`)
					: {
							...done(""),
							status: null,
							error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
						},
		}),
	);
	assert.equal(finding(timedOut, "roles").status, "warn");
	assert.match(finding(timedOut, "roles").detail, /setup-project timed out after 60s/);

	const crashed = runDoctor(
		inputs({ spawn: (command, args) => (command === "git" ? done(`${args.slice(1).join("\n")}\n`) : done("boom", 1)) }),
	);
	assert.match(finding(crashed, "roles").detail, /setup-project failed \(exit 1\):\nboom/);
});

test("the reviewer sharing a reason-tier model family is a warning naming both (ADR 0009)", () => {
	const files = healthyFiles();
	files[`${REPO}/.pi/agents/reviewer.md`] = role("other-provider/deepseek-r2");
	const tiers = finding(runDoctor(inputs({ files })), "model tiers");
	assert.equal(tiers.status, "warn");
	assert.match(tiers.detail, /reviewer \(deepseek\)/);
	assert.match(tiers.detail, /general \(deepseek\)/);
	assert.match(tiers.fix ?? "", /model:/);
});

test("the reviewer is compared with every reason-tier role, and ultra-scout with none (ADR 0009)", () => {
	// A mixed reason tier: any of its roles may have authored what the reviewer
	// judges, so one shared family with any of them is a shared blind spot.
	const mixed = healthyFiles();
	mixed[`${REPO}/.pi/agents/designer.md`] = role("vector/claude-opus-5-5");
	mixed[`${REPO}/.pi/agents/reviewer.md`] = role("vector/claude-sonnet-5");
	const clash = finding(runDoctor(inputs({ files: mixed })), "model tiers");
	assert.equal(clash.status, "warn");
	assert.match(clash.detail, /designer \(claude\)/);
	assert.doesNotMatch(clash.detail, /general/, "only the roles that share the family are named");

	mixed[`${REPO}/.pi/agents/reviewer.md`] = role("vector/gpt-5.6-sol");
	assert.equal(finding(runDoctor(inputs({ files: mixed })), "model tiers").status, "ok");

	// ultra-review is an opt-in sweep, not the merge gate: its scouts may share the author's family.
	const scouts = healthyFiles();
	scouts[`${REPO}/.pi/agents/ultra-scout.md`] = role("vector/ocg/deepseek-v4.1-flash");
	assert.equal(finding(runDoctor(inputs({ files: scouts })), "model tiers").status, "ok");
});

test("each missing companion tool is named with its install command", () => {
	const companions = finding(runDoctor(inputs({ tools: ["read", "bash"] })), "companions");
	assert.equal(companions.status, "warn");
	assert.match(companions.detail, /task/);
	assert.match(companions.detail, /memory_search/);
	assert.match(companions.detail, /web/);
	assert.match(companions.fix ?? "", /pi install npm:@heyhuynhgiabuu\/pi-task/);
	assert.match(companions.fix ?? "", /pi install git:github\.com\/sting8k\/pi-workspace-memory/);
	for (const web of ["websearch", "fetch_content", "web_fetch"]) {
		assert.equal(finding(runDoctor(inputs({ tools: ["task", "memory_search", web] })), "companions").status, "ok", web);
	}
});

test("the srcwalk tool without the CLI it runs is a warning; absence is not", () => {
	// pi-srcwalk is a passthrough, so a registered tool proves only that the
	// package is installed: every call fails while the binary is off PATH.
	// Absence stays ok — the companion is optional and the child contract
	// prefers it only "when installed".
	const without = ["read", "task", "memory_search", "web_search"];
	assert.equal(finding(runDoctor(inputs({ tools: without })), "srcwalk").status, "ok");

	const tools = [...without, "srcwalk"];
	const missing = finding(
		runDoctor(
			inputs({
				tools,
				spawn: (command) =>
					command === "srcwalk"
						? { ...done(""), error: Object.assign(new Error("spawnSync srcwalk ENOENT"), { code: "ENOENT" }) }
						: done("setup-project --check: current\n"),
			}),
		),
		"srcwalk",
	);
	assert.equal(missing.status, "warn");
	assert.match(missing.detail, /not on PATH/);
	assert.match(missing.fix ?? "", /npm install -g srcwalk/);

	const hung = finding(
		runDoctor(
			inputs({
				tools,
				spawn: (command) =>
					command === "srcwalk"
						? { ...done(""), status: null, error: Object.assign(new Error("spawnSync srcwalk ETIMEDOUT"), { code: "ETIMEDOUT" }) }
						: done("setup-project --check: current\n"),
			}),
		),
		"srcwalk",
	);
	assert.equal(hung.status, "warn");
	assert.match(hung.detail, /probing the CLI failed/);
	assert.doesNotMatch(hung.detail, /not on PATH/, "a timeout is not a missing binary");
});

test("missing tracker or domain docs point at /skill:setup-matt-pocock-skills", () => {
	const files = healthyFiles();
	delete files[`${REPO}/docs/agents/domain.md`];
	const docs = finding(runDoctor(inputs({ files })), "tracker docs");
	assert.equal(docs.status, "warn");
	assert.match(docs.detail, /docs\/agents\/domain\.md/);
	assert.match(docs.fix ?? "", /\/skill:setup-matt-pocock-skills/);
});

test("a glossary under a name the skills stopped reading is a warning, and the fix is the command that moves it", () => {
	// mattpocock/skills renamed CONTEXT.md / CONTEXT-MAP.md to GLOSSARY.md /
	// GLOSSARY-MAP.md and reads only the new names. /setup-pi-myself moves a root
	// CONTEXT.md, a map with the per-context glossaries it lists, and the pointer
	// in domain.md, so for those the fix is the command. What it never does is
	// named as hand work: merging two files, editing the repository's own context
	// file.
	const files = healthyFiles();
	files[`${REPO}/CONTEXT.md`] = "# glossary\n";
	const renamed = finding(runDoctor(inputs({ files })), "domain docs");
	assert.equal(renamed.status, "warn");
	assert.match(renamed.detail, /nothing consults CONTEXT\.md/);
	assert.match(renamed.fix ?? "", /run \/setup-pi-myself/);
	assert.doesNotMatch(renamed.fix ?? "", /by hand|CONTEXT-MAP/, "only what is there is named");

	// both names present: the command never overwrites, so the merge is a human's
	files[`${REPO}/GLOSSARY.md`] = "# newer glossary\n";
	const both = finding(runDoctor(inputs({ files })), "domain docs");
	assert.equal(both.status, "warn");
	assert.match(both.fix ?? "", /merge CONTEXT\.md into GLOSSARY\.md by hand/);
	assert.doesNotMatch(both.fix ?? "", /setup-pi-myself/);

	// a glossary split per context: the command moves the map and the glossaries it lists
	const mapped = healthyFiles();
	mapped[`${REPO}/CONTEXT-MAP.md`] = "- [Ordering](./ordering/CONTEXT.md)\n";
	const map = finding(runDoctor(inputs({ files: mapped })), "domain docs");
	assert.equal(map.status, "warn");
	assert.match(map.detail, /nothing consults CONTEXT-MAP\.md/);
	assert.match(map.fix ?? "", /run \/setup-pi-myself \(it moves CONTEXT-MAP\.md and the per-context glossaries it lists/);
	assert.doesNotMatch(map.fix ?? "", /by hand/);

	// two maps: the command never overwrites, so the merge is a human's
	mapped[`${REPO}/GLOSSARY-MAP.md`] = "- [Ordering](./ordering/GLOSSARY.md)\n";
	const maps = finding(runDoctor(inputs({ files: mapped })), "domain docs");
	assert.match(maps.fix ?? "", /merge CONTEXT-MAP\.md into GLOSSARY-MAP\.md by hand/);
	assert.doesNotMatch(maps.fix ?? "", /setup-pi-myself/);

	// a moved map that still lists a CONTEXT.md: a run moves what it can and names what it keeps
	const partial = healthyFiles();
	partial[`${REPO}/GLOSSARY-MAP.md`] = "- [Billing](./billing/CONTEXT.md)\n";
	const listed = finding(runDoctor(inputs({ files: partial })), "domain docs");
	assert.equal(listed.status, "warn");
	assert.match(listed.detail, /GLOSSARY-MAP\.md still lists a CONTEXT\.md/);
	assert.match(listed.fix ?? "", /run \/setup-pi-myself/);

	const stale = healthyFiles();
	stale[`${REPO}/docs/agents/domain.md`] = "- **`CONTEXT.md`** at the repo root, or\n";
	const pointer = finding(runDoctor(inputs({ files: stale })), "domain docs");
	assert.equal(pointer.status, "warn");
	assert.match(pointer.detail, /docs\/agents\/domain\.md/);
	assert.match(pointer.fix ?? "", /run \/setup-pi-myself/);

	// the repository's own context file is never edited by the command: the mention is named
	const mentioned = healthyFiles();
	mentioned[`${REPO}/AGENTS.md`] = "Single-context: `CONTEXT.md` at the repo root.\n";
	const context = finding(runDoctor(inputs({ files: mentioned })), "domain docs");
	assert.equal(context.status, "warn");
	assert.match(context.detail, /AGENTS\.md still names CONTEXT\.md/);
	assert.match(context.fix ?? "", /edit the mention in AGENTS\.md/);
	assert.doesNotMatch(context.fix ?? "", /setup-pi-myself/);

	// On a case-insensitive filesystem an unrelated lowercase context.md answers
	// to the old name when read. It is not the glossary and the command never
	// moves it, so the directory's own spelling decides.
	const lower = healthyFiles();
	lower[`${REPO}/CONTEXT.md`] = "notes\n";
	const entries = ["context.md", "docs", ".pi"];
	assert.equal(finding(runDoctor(inputs({ files: lower, rootEntries: entries })), "domain docs").status, "ok");
});

test("a globally installed pi-myself is a warning; project-scoped is not", () => {
	const files = healthyFiles();
	const projectOnly = finding(runDoctor(inputs({ files })), "install scope");
	assert.equal(projectOnly.status, "ok");
	assert.match(projectOnly.detail, /installed once: this project/);

	// ADR 0007: the package carries process, so a global entry is the warning —
	// with or without a project copy beside it (the pair is deduped or fatal, never
	// the "loads twice" conflict this check used to name).
	files[`${AGENT_DIR}/settings.json`] = JSON.stringify({ packages: [{ source: "git:github.com/MinhDuyDEV/pi-myself" }] });
	const both = finding(runDoctor(inputs({ files })), "install scope");
	assert.equal(both.status, "warn");
	assert.match(both.detail, /installed globally/);
	assert.match(both.detail, /this project declares it too/);
	assert.match(both.fix ?? "", /keep the project install: pi remove git:github\.com\/MinhDuyDEV\/pi-myself/);

	// no project declaration: the fix installs it here rather than keeping a copy that is not there
	files[`${REPO}/.pi/settings.json`] = JSON.stringify({ packages: ["npm:@heyhuynhgiabuu/pi-task"] });
	const globalOnly = finding(runDoctor(inputs({ files })), "install scope");
	assert.equal(globalOnly.status, "warn");
	assert.match(globalOnly.fix ?? "", /pi install git:github\.com\/MinhDuyDEV\/pi-myself -l/);

	files[`${AGENT_DIR}/settings.json`] = "{ not json";
	assert.equal(finding(runDoctor(inputs({ files })), "install scope").status, "ok", "an unreadable settings file declares no install");
});

test("runtime state git does not ignore is listed as the .gitignore lines to add", () => {
	const gitCalls: string[][] = [];
	const findings = runDoctor(
		inputs({
			spawn: (command, args) => {
				if (command !== "git") return done("setup-project --check: current\n");
				gitCalls.push([...args]);
				return done(".pi/sessions/x\n.pi/git/x\n.pi/npm/x\n");
			},
		}),
	);
	assert.deepEqual(gitCalls[0], ["check-ignore", ...IGNORED]);
	const ignore = finding(findings, "gitignore");
	assert.equal(ignore.status, "warn");
	assert.match(ignore.detail, /\.pi\/task-exits\/.*\.pi\/artifacts\/.*\.pi\/task-session-history\.json/);
	assert.doesNotMatch(ignore.detail, /\.pi\/sessions\//);
	// ADR 0008: a consuming repository ignores its whole .pi/ with one line, so the
	// fix is the blanket pattern rather than the list of paths that happen to leak.
	assert.match(ignore.fix ?? "", /\.pi\/\*/, "a consuming repo gets the one-line fix");
	assert.doesNotMatch(ignore.fix ?? "", /\.pi\/task-exits\//, "and not the per-path list the checkout needs");

	// the checkout is the exception: there .pi/ is the package source, so the
	// individual runtime paths are what has to be named
	const partial = (command: string) =>
		command === "git" ? done(".pi/sessions/x\n.pi/git/x\n.pi/npm/x\n") : done("setup-project --check: current\n");
	const checkout = finding(runDoctor(inputs({ repoRoot: PKG, spawn: partial })), "gitignore");
	assert.equal(checkout.status, "warn");
	assert.match(checkout.fix ?? "", /\.pi\/task-exits\/\n.*\.pi\/artifacts\/\n.*\.pi\/task-session-history\.json/);
	assert.doesNotMatch(checkout.fix ?? "", /\.pi\/\*/, "the checkout must not ignore its own source");

	const notRepo = runDoctor(
		inputs({ spawn: (command) => (command === "git" ? { ...done(""), status: 128, stderr: "fatal: not a git repository" } : done("")) }),
	);
	assert.equal(finding(notRepo, "gitignore").status, "warn");
	assert.match(finding(notRepo, "gitignore").detail, /not a git repository/);
});

test("/setup-pi-myself --check notifies one read-only report and provisions nothing", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		on: () => undefined,
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
		getAllTools: () => [{ name: "task" }, { name: "memory_search" }, { name: "web_search" }],
	};
	provisionExtension(pi as unknown as ExtensionAPI);
	const repo = mkdtempSync(join(tmpdir(), "doctor-repo-"));
	const agentDir = mkdtempSync(join(tmpdir(), "doctor-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const notices: Array<[string, string | undefined]> = [];
		await handler!("--check", {
			cwd: repo,
			isProjectTrusted: () => true,
			ui: { notify: (message: string, type?: string) => notices.push([message, type]) },
		});
		assert.equal(notices.length, 1, "one report");
		const [message, type] = notices[0]!;
		assert.equal(type, "warning");
		assert.match(message, /^warn roles/m, "a fresh repo's roles are stale");
		assert.match(message, /^ok {3}companions/m);
		assert.match(message, /^warn gitignore/m);
		assert.deepEqual(readdirSync(repo), [".git"], "the doctor wrote nothing");
		assert.ok(!existsSync(join(repo, ".pi")));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(repo, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
