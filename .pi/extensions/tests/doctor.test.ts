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
const IGNORED = [".pi/sessions/x", ".pi/task-exits/x", ".pi/artifacts/x", ".pi/task-session-history.json", ".pi/git/x", ".pi/npm/x"];

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

function inputs(overrides: { files?: Record<string, string>; tools?: string[]; spawn?: DoctorInputs["spawn"] } = {}): DoctorInputs {
	const files = overrides.files ?? healthyFiles();
	return {
		repoRoot: REPO,
		packageRoot: PKG,
		agentDir: AGENT_DIR,
		nodePath: "/usr/bin/node",
		toolNames: overrides.tools ?? ["read", "task", "memory_search", "web_search"],
		readFile: (path) => files[path],
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
		["ok roles", "ok model tiers", "ok companions", "ok tracker docs", "ok install scope", "ok gitignore"],
	);
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

test("the review tier sharing the reason tier's model family is a warning naming both", () => {
	const files = healthyFiles();
	files[`${REPO}/.pi/agents/ultra-scout.md`] = role("other-provider/deepseek-r2");
	const tiers = finding(runDoctor(inputs({ files })), "model tiers");
	assert.equal(tiers.status, "warn");
	assert.match(tiers.detail, /ultra-scout \(deepseek\)/);
	assert.match(tiers.fix ?? "", /model:/);
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

test("missing tracker or domain docs point at /skill:setup-matt-pocock-skills", () => {
	const files = healthyFiles();
	delete files[`${REPO}/docs/agents/domain.md`];
	const docs = finding(runDoctor(inputs({ files })), "tracker docs");
	assert.equal(docs.status, "warn");
	assert.match(docs.detail, /docs\/agents\/domain\.md/);
	assert.match(docs.fix ?? "", /\/skill:setup-matt-pocock-skills/);
});

test("pi-myself installed both globally and in the project is a warning", () => {
	const files = healthyFiles();
	files[`${AGENT_DIR}/settings.json`] = JSON.stringify({ packages: [{ source: "git:github.com/MinhDuyDEV/pi-myself" }] });
	const scope = finding(runDoctor(inputs({ files })), "install scope");
	assert.equal(scope.status, "warn");
	assert.match(scope.detail, /globally .* and in this project/);
	assert.match(scope.fix ?? "", /pi remove git:github\.com\/MinhDuyDEV\/pi-myself/);

	files[`${AGENT_DIR}/settings.json`] = "{ not json";
	assert.equal(finding(runDoctor(inputs({ files })), "install scope").status, "ok", "an unreadable settings file is not a duplicate");
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
	assert.match(ignore.fix ?? "", /\.pi\/task-exits\/\n.*\.pi\/artifacts\/\n.*\.pi\/task-session-history\.json/);
	assert.doesNotMatch(ignore.fix ?? "", /\.pi\/sessions\//);

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
		await handler!("--check", { cwd: repo, ui: { notify: (message: string, type?: string) => notices.push([message, type]) } });
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
