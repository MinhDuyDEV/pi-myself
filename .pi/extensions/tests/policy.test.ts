import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import policyExtension, { createPolicyExtension, POLICY_SECTION, STALE_COPY_MARKER } from "../policy.js";

// The workflow policy used to be copied into each consuming repo as
// .pi/APPEND_SYSTEM.md, where it went stale and never reached a task child
// anyway. The policy extension injects the package's own copy into the
// parent's system prompt instead, before every agent run.

const PKG = resolve(import.meta.dirname, "..", "..", "..");
const WORKFLOW = join(PKG, ".pi", "policy", "WORKFLOW.md");

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(factory: (pi: ExtensionAPI) => void) {
	const handlers = new Map<string, Handler>();
	const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
	factory(pi as unknown as ExtensionAPI);
	const notices: Array<{ message: string; type: string | undefined }> = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, type?: string) => notices.push({ message, type }) } };
	const run = (appendSystemPrompt = "") => {
		const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: { appendSystemPrompt, sections: {} } };
		handlers.get("before_agent_start")?.(event, ctx);
		return event.systemPromptOptions.sections as Record<string, string>;
	};
	return { handlers, notices, run };
}

const saved = process.env.PI_TASK_TOOL_DISABLED;
afterEach(() => {
	if (saved === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
	else process.env.PI_TASK_TOOL_DISABLED = saved;
});

test("the parent gets the package's workflow policy as its own prompt section on every run", () => {
	delete process.env.PI_TASK_TOOL_DISABLED;
	const { run, notices } = load(policyExtension);
	const text = readFileSync(WORKFLOW, "utf8").trim();
	assert.equal(run()[POLICY_SECTION], text);
	assert.equal(run()[POLICY_SECTION], text, "the same text on the next run: the section never churns");
	assert.deepEqual(notices, []);
	assert.ok(text.includes(STALE_COPY_MARKER), "the marker that identifies an old provisioned copy is the policy's own opening line");
});

test("a task child gets nothing: the child contract in its role body is what binds it", () => {
	process.env.PI_TASK_TOOL_DISABLED = "1";
	const { handlers, run } = load(policyExtension);
	assert.equal(handlers.size, 0, "a child registers no handler at all");
	assert.deepEqual(run(), {});
});

test("the child flag is read at load: an in-process SDK child flipping it later does not starve the parent", () => {
	// pi-task's SDK backend sets PI_TASK_TOOL_DISABLED=1 in the parent's own
	// process for the child's lifetime (runSdk.js), so reading it per event would
	// drop the parent's policy while an SDK child runs.
	delete process.env.PI_TASK_TOOL_DISABLED;
	const { run } = load(policyExtension);
	process.env.PI_TASK_TOOL_DISABLED = "1";
	assert.ok(run()[POLICY_SECTION]?.includes(STALE_COPY_MARKER));
});

test("an old provisioned APPEND_SYSTEM.md suppresses the injection and says how to migrate, once", () => {
	delete process.env.PI_TASK_TOOL_DISABLED;
	const { run, notices } = load(policyExtension);
	const stale = `# Workflow\n\n${STALE_COPY_MARKER}, when to delegate, how to complete.\n`;
	assert.equal(run(stale)[POLICY_SECTION], undefined, "no second copy of the policy beside the stale one");
	assert.equal(run(stale)[POLICY_SECTION], undefined);
	assert.equal(notices.length, 1, "one notice per session, not one per turn");
	assert.match(notices[0]?.message ?? "", /\/setup-pi-myself/);
	assert.equal(notices[0]?.type, "warning");
});

test("a repository's own APPEND_SYSTEM.md stays, and the harness section is added beside it", () => {
	delete process.env.PI_TASK_TOOL_DISABLED;
	const { run, notices } = load(policyExtension);
	const sections = run("Project rule: answer in French.\n");
	assert.ok(sections[POLICY_SECTION]?.includes(STALE_COPY_MARKER));
	assert.deepEqual(notices, []);
});

test("a missing policy file is reported once and never breaks a run", () => {
	delete process.env.PI_TASK_TOOL_DISABLED;
	const { run, notices } = load(createPolicyExtension(join(PKG, "no-such-dir", "WORKFLOW.md")));
	assert.deepEqual(run(), {});
	assert.deepEqual(run(), {});
	assert.equal(notices.length, 1);
	assert.match(notices[0]?.message ?? "", /WORKFLOW\.md/);
	assert.equal(notices[0]?.type, "error");
});

test("the package ships no .pi/APPEND_SYSTEM.md: pi would append it beside the injected section", () => {
	assert.equal(existsSync(join(PKG, ".pi", "APPEND_SYSTEM.md")), false);
	assert.equal(existsSync(WORKFLOW), true);
});

test("/setup-pi-myself recognises an old copy by the same marker this extension yields to", () => {
	// The script is plain .mjs and cannot import the constant; this pins the two copies together.
	const script = readFileSync(join(PKG, "scripts", "setup-project.mjs"), "utf8");
	assert.ok(script.includes(`"${STALE_COPY_MARKER}"`), "scripts/setup-project.mjs must detect a stale copy by STALE_COPY_MARKER");
});
