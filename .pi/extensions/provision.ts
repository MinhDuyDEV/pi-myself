import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./lib/agent-dir.js";
import { packageRoot, resolveRepoRoot } from "./lib/repo-root.js";

/**
 * provision — `/setup-pi-myself` runs scripts/setup-project.mjs from this
 * package against the repository root (no path hunting: the extension knows
 * where it lives), copying the one thing pi-task loads only from the project's
 * own `.pi/`: the task roles.
 *
 * No session-start check: rerunning the command IS the update path, and the
 * script owns the outcome. It refreshes the roles from the package — keeping a
 * `model`, `thinking`, or `max_turns` the project chose — backs up a copy the
 * project changed in any other line as `.local` first, and removes an
 * APPEND_SYSTEM.md an older run copied (the `policy` extension injects the
 * workflow now). settings.json is not touched.
 *
 * `/setup-pi-myself --check` is the read-only doctor instead: `runDoctor` (pure
 * over injected tool names, file reader, and spawn) reports `ok`/`warn` per
 * check — stale roles (the script's own `--check`), the reviewer's model family
 * against the reason tier (ADR 0009),
 * companion tools, the `srcwalk` tool against the CLI it runs, tracker docs, a
 * globally installed pi-myself (ADR 0007), and runtime state git does not
 * ignore — each warning with its fix.
 */

/** Long enough for any real provisioning run; a wedged child must not freeze the TUI forever. */
export const SETUP_TIMEOUT_MS = 60_000;

export const NEXT_STEPS =
	"Run /reload before the roles are usable: pi-task builds the task tool's agent list when it registers, so this session still shows the set it loaded with. Remaining setup: /skill:setup-matt-pocock-skills in each repo (tracker, domain docs, triage labels). Once per machine: pi install npm:@heyhuynhgiabuu/pi-task (the task tool the roles run on) and pi install git:github.com/sting8k/pi-workspace-memory (memory records).";

/** The notice for one run of the script: its own output on success, the reason it did not finish otherwise. */
export function setupReport(result: Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stdout" | "stderr">): {
	message: string;
	type: "info" | "error";
} {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.error) {
		const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		const reason = timedOut ? `timed out after ${SETUP_TIMEOUT_MS / 1000}s` : `could not run (${result.error.message})`;
		return { message: `setup-project ${reason}; nothing after its last line below was done.${output ? `\n${output}` : ""}`, type: "error" };
	}
	if (result.status !== 0) {
		const how = result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit ${result.status}`;
		return { message: `setup-project failed (${how}):\n${output}`, type: "error" };
	}
	return { message: `${output}\n\n${NEXT_STEPS}`, type: "info" };
}

export type DoctorSpawnResult = Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stdout" | "stderr">;
export interface DoctorInputs {
	/** `ctx.isProjectTrusted()`: pi loads a project's .pi/ resources only when trusted. */
	projectTrusted: boolean;
	repoRoot: string;
	packageRoot: string;
	agentDir: string;
	nodePath: string;
	toolNames: readonly string[];
	readFile(path: string): string | undefined;
	spawn(command: string, args: readonly string[], cwd: string): DoctorSpawnResult;
}
export interface DoctorFinding {
	status: "ok" | "warn";
	check: string;
	detail: string;
	fix?: string;
}

const READ_TIER = ["explore", "scout"] as const;
const REASON_TIER = ["general", "designer", "ultra-verifier"] as const;
/** The one review-tier role the family rule binds (ADR 0009). */
const REVIEWER = "reviewer";
/** Any one of these counts as a web tool: the harness installs `pi-web-access`, and the alternates are accepted so a host running a different web-research package is not warned. */
const WEB_TOOLS = ["web_search", "websearch", "fetch_content", "web_fetch"] as const;
/**
 * `srcwalk` is the one companion whose tool is a passthrough to a binary that
 * ships separately: `pi-srcwalk` v2 declares neither a dependency nor a bin, and
 * its tool runs whatever `srcwalk` is on PATH. A registered tool is therefore no
 * evidence the tool works — it fails on every call with "binary not found" — so
 * the doctor probes the binary, and only when the tool is registered, because
 * the companion is optional (`CHILD-CONTRACT.md` prefers it "when installed").
 */
const SRCWALK_TOOL = "srcwalk";
const SRCWALK_SOURCE = "npm:@sting8k/pi-srcwalk";
const TRACKER_DOCS = ["docs/agents/issue-tracker.md", "docs/agents/domain.md"] as const;
/** One probe path per runtime-state entry git must ignore, and the .gitignore line that covers it. */
const RUNTIME_STATE: ReadonlyArray<readonly [probe: string, line: string]> = [
	[".pi/sessions/x", ".pi/sessions/"],
	[".pi/task-exits/x", ".pi/task-exits/"],
	[".pi/artifacts/x", ".pi/artifacts/"],
	[".pi/task-session-history.json", ".pi/task-session-history.json"],
	[".pi/task-registry.json", ".pi/task-registry.json"],
	[".pi/git/x", ".pi/git/"],
	[".pi/npm/x", ".pi/npm/"],
];

/** `opencode-go/deepseek-v4-flash` → `deepseek` — mirror of tests/agents.test.ts `modelFamily`. */
export function modelFamily(model: string): string {
	return (
		model
			.split("/")
			.pop()
			?.match(/^[a-z]+/)?.[0] ?? model
	);
}

function roleModel(inputs: DoctorInputs, name: string): string | undefined {
	const text = inputs.readFile(join(inputs.repoRoot, ".pi", "agents", `${name}.md`));
	const frontmatter = text === undefined ? undefined : /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
	return frontmatter === undefined ? undefined : /^model:[ \t]*(\S.*)$/m.exec(frontmatter)?.[1]?.trim();
}

function checkTrust(inputs: DoctorInputs): DoctorFinding {
	if (inputs.projectTrusted) return { status: "ok", check: "trust", detail: "pi loads this project's .pi/ resources" };
	return {
		status: "warn",
		check: "trust",
		detail:
			"this project is not trusted: pi loads none of its .pi/ settings, extensions, or APPEND_SYSTEM.md, and a task that declares skills does not resolve",
		fix: "run /trust in an interactive pi session here (or accept the trust prompt on the next start)",
	};
}

function checkRoles(inputs: DoctorInputs): DoctorFinding {
	const script = join(inputs.packageRoot, "scripts", "setup-project.mjs");
	const result = inputs.spawn(inputs.nodePath, [script, inputs.repoRoot, "--check"], inputs.repoRoot);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (!result.error && result.status === 0) {
		const notes = output.split("\n").filter((line) => line.startsWith("note: "));
		return { status: "ok", check: "roles", detail: ["the task roles match the package", ...notes].join("\n") };
	}
	if (!result.error && result.status === 1 && /^setup-project --check: /m.test(output)) {
		return { status: "warn", check: "roles", detail: `stale against the package:\n${output}`, fix: "run /setup-pi-myself" };
	}
	return {
		status: "warn",
		check: "roles",
		detail: setupReport(result).message,
		fix: "resolve the error above, then rerun /setup-pi-myself --check",
	};
}

/**
 * ADR 0009: the `reviewer` — the merge gate, and both `code-review` axes — runs
 * a model family different from every reason-tier role, since any of them may
 * have authored what it judges. A tier may mix models; `ultra-scout` (an opt-in
 * sweep whose findings the `ultra-verifier` dispositions) and the read tier are
 * not compared.
 */
function checkModelTiers(inputs: DoctorInputs): DoctorFinding {
	const withModels = (names: readonly string[]) =>
		names.flatMap((name) => {
			const model = roleModel(inputs, name);
			return model === undefined ? [] : [{ name, family: modelFamily(model) }];
		});
	const reason = withModels(REASON_TIER);
	const reviewer = withModels([REVIEWER])[0];
	if (reason.length === 0 || reviewer === undefined) {
		return {
			status: "warn",
			check: "model tiers",
			detail: `no model: line to compare in .pi/agents/ for ${reason.length === 0 ? "the reason tier" : REVIEWER}`,
			fix: "run /setup-pi-myself",
		};
	}
	const shared = reason.filter((role) => role.family === reviewer.family);
	const describe = (roles: typeof reason) => roles.map((role) => `${role.name} (${role.family})`).join(", ");
	if (shared.length > 0) {
		return {
			status: "warn",
			check: "model tiers",
			detail: `the reviewer shares a reason-tier model family, and with it the author's blind spots: ${describe([reviewer])} vs ${describe(shared)}`,
			fix: `set a model: in .pi/agents/${REVIEWER}.md whose family differs from every reason-tier role (${REASON_TIER.join(", ")}), or move those roles off it`,
		};
	}
	return {
		status: "ok",
		check: "model tiers",
		detail: `${REVIEWER} ${reviewer.family} ≠ reason ${[...new Set(reason.map((role) => role.family))].join("/")} (not compared: ultra-scout, read tier ${READ_TIER.join(", ")})`,
	};
}

function checkCompanions(inputs: DoctorInputs): DoctorFinding {
	const tools = new Set(inputs.toolNames);
	const missing: string[] = [];
	const fixes: string[] = [];
	if (!tools.has("task")) {
		missing.push("task (pi-task: the roles are dead without it)");
		fixes.push("pi install npm:@heyhuynhgiabuu/pi-task");
	}
	if (!tools.has("memory_search")) {
		missing.push("memory_search (pi-workspace-memory)");
		fixes.push("pi install git:github.com/sting8k/pi-workspace-memory");
	}
	if (!WEB_TOOLS.some((name) => tools.has(name))) {
		missing.push(`a web tool (${WEB_TOOLS.join(", ")})`);
		fixes.push("pi install npm:pi-web-access");
	}
	if (missing.length === 0) return { status: "ok", check: "companions", detail: "task, memory_search, and a web tool are registered" };
	return {
		status: "warn",
		check: "companions",
		detail: `not registered in this session: ${missing.join("; ")}`,
		fix: `${fixes.join("; ")}, then /reload`,
	};
}

/**
 * The tool is a passthrough, so a registered `srcwalk` proves only that
 * `pi-srcwalk` is installed — not that the CLI it runs is. Absence is not a
 * finding: the companion is optional and the child contract says "when
 * installed", so a host that wants no code-intelligence tool is left alone.
 */
function checkSrcwalk(inputs: DoctorInputs): DoctorFinding {
	if (!inputs.toolNames.includes(SRCWALK_TOOL)) {
		return {
			status: "ok",
			check: SRCWALK_TOOL,
			detail: "not installed — optional; the child contract prefers it only when the host has it",
		};
	}
	const probe = inputs.spawn(SRCWALK_TOOL, ["--version"], inputs.repoRoot);
	if (probe.error) {
		const missing = (probe.error as NodeJS.ErrnoException).code === "ENOENT";
		return {
			status: "warn",
			check: SRCWALK_TOOL,
			detail: missing
				? `the ${SRCWALK_TOOL} tool is registered but the CLI it runs is not on PATH: every call fails with "binary not found"`
				: `the ${SRCWALK_TOOL} tool is registered but probing the CLI failed (${probe.error.message})`,
			fix: missing
				? `npm install -g ${SRCWALK_TOOL}, then /reload (or pi remove ${SRCWALK_SOURCE} to drop the tool)`
				: `check that \`${SRCWALK_TOOL} --version\` runs in a shell, then /reload`,
		};
	}
	return { status: "ok", check: SRCWALK_TOOL, detail: `the ${SRCWALK_TOOL} tool and the CLI it runs are both present` };
}

function checkTrackerDocs(inputs: DoctorInputs): DoctorFinding {
	const missing = TRACKER_DOCS.filter((doc) => inputs.readFile(join(inputs.repoRoot, doc)) === undefined);
	if (missing.length === 0) return { status: "ok", check: "tracker docs", detail: TRACKER_DOCS.join(" and ") };
	return { status: "warn", check: "tracker docs", detail: `missing: ${missing.join(", ")}`, fix: "run /skill:setup-matt-pocock-skills" };
}

/** The `packages` entry of a settings file that installs pi-myself, as its source text. */
function piMyselfSource(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	let settings: unknown;
	try {
		settings = JSON.parse(text);
	} catch {
		return undefined;
	}
	const packages = (settings as { packages?: unknown } | null)?.packages;
	if (!Array.isArray(packages)) return undefined;
	const entry = packages.find((item) => JSON.stringify(item).includes("pi-myself"));
	if (entry === undefined) return undefined;
	const source = typeof entry === "string" ? entry : (entry as { source?: unknown }).source;
	return typeof source === "string" ? source : JSON.stringify(entry);
}

function checkInstallScope(inputs: DoctorInputs): DoctorFinding {
	const globalSettings = join(inputs.agentDir, "settings.json");
	const globalSource = piMyselfSource(inputs.readFile(globalSettings));
	const projectSource = piMyselfSource(inputs.readFile(join(inputs.repoRoot, ".pi", "settings.json")));
	if (globalSource !== undefined) {
		// ADR 0007: pi-myself carries process, so it stays per-repo. A global entry
		// reaches every repository on the machine rather than the ones that opted in,
		// which project trust enforces. A project entry beside it is neither a second
		// load to fear nor a conflict: the same identity is deduped (project wins) and
		// a different one is fatal at startup, not resolved by load order.
		return {
			status: "warn",
			check: "install scope",
			detail: `pi-myself is installed globally (${globalSettings}): its workflow policy and guard would load in every repository, not only the ones that opted in${projectSource === undefined ? "" : `, and this project declares it too (${projectSource})`}`,
			fix:
				projectSource === undefined
					? `pi remove ${globalSource}, then install it in this project: pi install ${globalSource} -l`
					: `keep the project install: pi remove ${globalSource}`,
		};
	}
	const where = projectSource !== undefined ? "this project" : "neither settings file (a local path or checkout)";
	return { status: "ok", check: "install scope", detail: `installed once: ${where}` };
}

function checkGitignore(inputs: DoctorInputs): DoctorFinding {
	const probes = RUNTIME_STATE.map(([probe]) => probe);
	const result = inputs.spawn("git", ["check-ignore", ...probes], inputs.repoRoot);
	// check-ignore exits 0 when some path is ignored, 1 when none is; anything else is an error
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		const reason = result.error ? result.error.message : `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || `exit ${result.status}`;
		return {
			status: "warn",
			check: "gitignore",
			detail: `git check-ignore failed: ${reason}`,
			fix: "run from inside the repository's git checkout",
		};
	}
	const ignored = new Set((result.stdout ?? "").split("\n").map((line) => line.trim()));
	const missing = RUNTIME_STATE.filter(([probe]) => !ignored.has(probe)).map(([, line]) => line);
	if (missing.length === 0) return { status: "ok", check: "gitignore", detail: "pi runtime state is ignored by git" };
	// ADR 0008: a consuming repository ignores its whole .pi/ with one line, so the
	// blanket fix is right there. The checkout is the exception — its .pi/ is the
	// package source — and only there do the individual runtime paths need naming.
	const inCheckout = resolve(inputs.repoRoot) === resolve(inputs.packageRoot);
	return {
		status: "warn",
		check: "gitignore",
		detail: `git would track pi runtime state: ${missing.join(", ")}`,
		fix: inCheckout
			? `add to .gitignore:\n${missing.join("\n")}`
			: `add to .gitignore (one line: a consuming repository's .pi/ is local state, ADR 0008):\n.pi/*`,
	};
}

/** The read-only doctor: one finding per check, in a fixed order. Pure over its inputs. */
export function runDoctor(inputs: DoctorInputs): DoctorFinding[] {
	return [
		checkTrust(inputs),
		checkRoles(inputs),
		checkModelTiers(inputs),
		checkCompanions(inputs),
		checkSrcwalk(inputs),
		checkTrackerDocs(inputs),
		checkInstallScope(inputs),
		checkGitignore(inputs),
	];
}

/** One notice for the whole report: `ok`/`warn` lines, each warning with its fix. */
export function doctorReport(findings: readonly DoctorFinding[]): { message: string; type: "info" | "warning" } {
	const warnings = findings.filter((f) => f.status === "warn").length;
	const indent = (text: string) => text.replace(/\n/g, "\n       ");
	const lines = findings.map((f) => {
		const head = `${f.status.padEnd(4)} ${f.check}: ${indent(f.detail)}`;
		return f.fix === undefined ? head : `${head}\n     fix: ${indent(f.fix)}`;
	});
	const summary = `pi-myself doctor (read-only, nothing written): ${findings.length - warnings} ok, ${warnings} warn`;
	return { message: `${lines.join("\n")}\n\n${summary}`, type: warnings > 0 ? "warning" : "info" };
}

export default function provisionExtension(pi: ExtensionAPI): void {
	const pkg = packageRoot(import.meta.url);

	pi.registerCommand("setup-pi-myself", {
		description:
			"Provision or update this repository for pi-myself: refresh the task roles (keeping a model, thinking, or max_turns the project chose; a copy changed in any other line is kept as .local) and remove an APPEND_SYSTEM.md an older run copied (the workflow is injected now). A project-added role and settings.json are never touched. `--check`: a read-only doctor that reports what is stale or missing, with fixes, and writes nothing",
		async handler(args, ctx) {
			const root = resolveRepoRoot(ctx.cwd);
			if (args.trim().split(/\s+/).includes("--check")) {
				const findings = runDoctor({
					projectTrusted: ctx.isProjectTrusted(),
					repoRoot: root,
					packageRoot: pkg,
					agentDir: agentDir(),
					nodePath: process.execPath,
					toolNames: pi.getAllTools().map((tool) => tool.name),
					readFile: (path) => {
						try {
							return readFileSync(path, "utf8");
						} catch {
							return undefined;
						}
					},
					spawn: (command, spawnArgs, cwd) => spawnSync(command, spawnArgs, { cwd, encoding: "utf8", timeout: SETUP_TIMEOUT_MS }),
				});
				const { message, type } = doctorReport(findings);
				ctx.ui?.notify?.(message, type);
				return;
			}
			const script = join(pkg, "scripts", "setup-project.mjs");
			const result = spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: SETUP_TIMEOUT_MS });
			const { message, type } = setupReport(result);
			ctx.ui?.notify?.(message, type);
		},
	});
}
