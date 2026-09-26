import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import hostCommands from "../host-commands.js";

// The vendored skills tell the human to type `/to-spec`, `/wayfinder`, `/clear`…
// pi exposes a skill only as `/skill:<name>` and has no `/clear`. This
// extension bridges both.

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };

const sourceInfo = { path: "<test>", source: "local", scope: "project", origin: "top-level" };
const skill = (name: string): SlashCommandInfo => ({ name: `skill:${name}`, source: "skill", sourceInfo }) as SlashCommandInfo;
const prompt = (name: string): SlashCommandInfo => ({ name, source: "prompt", sourceInfo }) as SlashCommandInfo;
const extension = (name: string): SlashCommandInfo => ({ name, source: "extension", sourceInfo }) as SlashCommandInfo;

function load(commands: SlashCommandInfo[]) {
	const handlers = new Map<string, Handler>();
	const registered = new Map<string, Command>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: Command) => registered.set(name, options),
		getCommands: () => commands,
	};
	hostCommands(pi as unknown as ExtensionAPI);
	const input = async (text: string, source = "interactive") =>
		(await handlers.get("input")?.({ type: "input", text, source }, { cwd: process.cwd(), hasUI: true })) as
			| { action: "continue" }
			| { action: "transform"; text: string }
			| undefined;
	return { input, registered };
}

const COMMANDS = [
	skill("to-spec"),
	skill("wayfinder"),
	skill("verify"),
	prompt("verify"),
	extension("setup-pi-myself"),
	skill("setup-pi-myself"),
];

test("a bare skill command is rewritten to pi's /skill:<name>, keeping the rest of the input", async () => {
	const { input } = load(COMMANDS);
	assert.deepEqual(await input("/to-spec"), { action: "transform", text: "/skill:to-spec" });
	assert.deepEqual(await input("/wayfinder map the auth rewrite"), { action: "transform", text: "/skill:wayfinder map the auth rewrite" });
	// pi's _expandSkillCommand takes the skill name up to the FIRST SPACE and trims the
	// arguments, so a newline right after the name must become "name " + newline, or
	// "/skill:to-spec\nplan" is read as a skill named "to-spec\nplan" and never expands.
	const multiline = await input("/to-spec\nwith a second line");
	assert.deepEqual(multiline, { action: "transform", text: "/skill:to-spec \nwith a second line" });
	for (const text of ["/to-spec\nwith a second line", "/to-spec\n\nplan:\n- a", "/to-spec\tx", "/to-spec"]) {
		const out = (await input(text)) as { text: string };
		const space = out.text.indexOf(" ");
		const name = space === -1 ? out.text.slice("/skill:".length) : out.text.slice("/skill:".length, space);
		assert.equal(name, "to-spec", `pi would read the skill name from ${JSON.stringify(out.text)} as ${JSON.stringify(name)}`);
	}
});

test("input that is not a bare registered skill is left alone", async () => {
	const { input } = load(COMMANDS);
	for (const text of [
		"/skill:to-spec now",
		"/unknown-thing",
		"/to-specs",
		"/to-spec:x",
		"please run /to-spec",
		" /to-spec",
		"to-spec",
		"/",
		"",
	]) {
		const result = await input(text);
		assert.ok(result === undefined || result.action === "continue", `${JSON.stringify(text)} → ${JSON.stringify(result)}`);
	}
});

test("a prompt template or extension command that owns /<name> wins over a same-named skill", async () => {
	const { input } = load(COMMANDS);
	for (const text of ["/verify", "/verify the branch", "/setup-pi-myself"]) {
		const result = await input(text);
		assert.ok(result === undefined || result.action === "continue", `${text} → ${JSON.stringify(result)}`);
	}
});

test("/clear starts a new session the way /new does", async () => {
	const { registered } = load(COMMANDS);
	const clear = registered.get("clear");
	assert.ok(clear, "/clear is registered");
	let newSessions = 0;
	const notices: string[] = [];
	const fresh = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
	const newSession = async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
		newSessions += 1;
		await options?.withSession?.(fresh);
		return { cancelled: false };
	};
	await clear.handler("", { newSession, hasUI: true });
	assert.equal(newSessions, 1);
	assert.deepEqual(notices, ["New session started"], "confirmed on the fresh session's context, not the replaced one");
});
