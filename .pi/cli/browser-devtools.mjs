#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";

function parseArgs(argv) {
	const args = { endpoint: DEFAULT_ENDPOINT, waitMs: 1500, evals: [], artifact: undefined, page: 0 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--help" || arg === "-h") args.help = true;
		else if (arg === "--endpoint") args.endpoint = next();
		else if (arg === "--artifact") args.artifact = next();
		else if (arg === "--url") args.url = next();
		else if (arg === "--page") args.page = Number(next());
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--eval") args.evals.push(next());
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function usage() {
	return `browser-devtools.mjs — inspect a Chrome tab through the DevTools Protocol

Prerequisite: start Chrome with remote debugging, e.g.
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

Usage:
      .pi/cli/browser-devtools.mjs [--url <url>] [--eval <js>]...
      .pi/cli/browser-devtools.mjs --artifact <path> --endpoint http://127.0.0.1:9222

    Options:
      --endpoint <url>   DevTools HTTP endpoint. Default: ${DEFAULT_ENDPOINT}
      --artifact <path>  Write markdown report to an explicit path
  --url <url>        Navigate selected tab before inspection
  --page <index>     Page index from /json/list. Default: 0
  --wait-ms <ms>     Wait after navigation before collecting state. Default: 1500
  --eval <js>        Evaluate JavaScript expression in the page; repeatable
  --help             Show this help
`;
}

function artifactPath(args) {
    	if (args.artifact) return args.artifact;
    	return undefined;
}

async function fetchJson(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
	return res.json();
}

class CdpClient {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.nextId = 1;
		this.pending = new Map();
		this.events = [];
	}

	async connect() {
		this.ws = new WebSocket(this.wsUrl);
		this.ws.addEventListener("message", (message) => this.#onMessage(message));
		await new Promise((resolve, reject) => {
			this.ws.addEventListener("open", resolve, { once: true });
			this.ws.addEventListener("error", () => reject(new Error(`Could not connect to ${this.wsUrl}`)), { once: true });
		});
	}

	#onMessage(message) {
		const data = JSON.parse(message.data);
		if (data.id && this.pending.has(data.id)) {
			const { resolve, reject } = this.pending.get(data.id);
			this.pending.delete(data.id);
			if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
			else resolve(data.result ?? {});
			return;
		}
		if (data.method) this.events.push({ method: data.method, params: data.params ?? {} });
	}

	call(method, params = {}) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	close() {
		this.ws?.close();
	}
}

function eventSummary(events) {
	return events
		.filter((event) => event.method.startsWith("Runtime.") || event.method.startsWith("Log.") || event.method.startsWith("Network."))
		.slice(-80)
		.map((event) => `- ${event.method}: ${JSON.stringify(event.params).slice(0, 500)}`)
		.join("\n") || "- No console/network/log events captured during inspection.";
}

function markdown({ endpoint, version, pages, selected, evalResults, events }) {
	return `# Browser DevTools Report

**Endpoint:** ${endpoint}
**Generated:** ${new Date().toISOString()}
**Browser:** ${version.Browser ?? "unknown"}
**Selected page:** ${selected.title || "(untitled)"}
**URL:** ${selected.url || selected.page.url || "unknown"}

## Open Pages
${pages.map((p, i) => `- ${i}: ${p.title || "(untitled)"} — ${p.url}`).join("\n")}

## Evaluations
${evalResults.length ? evalResults.map((item) => `### ${item.expression}\n\n\`\`\`json\n${JSON.stringify(item.result, null, 2)}\n\`\`\``).join("\n\n") : "- No evaluations requested."}

## Recent Events
${eventSummary(events)}
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	if (!Number.isFinite(args.waitMs) || args.waitMs < 0) throw new Error("--wait-ms must be a non-negative number");

	const endpoint = args.endpoint.replace(/\/$/, "");
	const [version, pages] = await Promise.all([
		fetchJson(`${endpoint}/json/version`),
		fetchJson(`${endpoint}/json/list`),
	]);
	const page = pages[args.page];
	if (!page?.webSocketDebuggerUrl) throw new Error(`No inspectable page at index ${args.page}`);

	const cdp = new CdpClient(page.webSocketDebuggerUrl);
	await cdp.connect();
	try {
		await cdp.call("Runtime.enable");
		await cdp.call("Log.enable").catch(() => undefined);
		await cdp.call("Network.enable").catch(() => undefined);
		if (args.url) {
			await cdp.call("Page.enable");
			await cdp.call("Page.navigate", { url: args.url });
			await sleep(args.waitMs);
		}
		const evals = args.evals.length ? args.evals : ["({ title: document.title, url: location.href, textLength: document.body?.innerText?.length ?? 0 })"];
		const evalResults = [];
		for (const expression of evals) {
			const result = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			evalResults.push({ expression, result: result.result?.value ?? result.result ?? null });
		}
		const report = markdown({ endpoint, version, pages, selected: { page, title: page.title, url: args.url }, evalResults, events: cdp.events });
		const out = artifactPath(args);
		if (out) {
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, report, "utf-8");
			console.log(out);
		} else {
			console.log(report);
		}
	} finally {
		cdp.close();
	}
}

main().catch((error) => {
	console.error(`browser-devtools.mjs: ${error.message}`);
	process.exit(1);
});
