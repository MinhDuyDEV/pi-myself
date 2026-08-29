#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
	const args = { browser: "chromium", headless: true, steps: [], waitMs: 0 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--help" || arg === "-h") args.help = true;
		else if (arg === "--artifact") args.artifact = next();
		else if (arg === "--url") args.url = next();
		else if (arg === "--browser") args.browser = next();
		else if (arg === "--headed") args.headless = false;
		else if (arg === "--headless") args.headless = true;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--step") args.steps.push(next());
		else if (arg === "--steps-file") args.steps.push(...JSON.parse(readFileSync(next(), "utf-8")));
		else if (arg === "--screenshot-dir") args.screenshotDir = next();
		else if (arg === "--trace") args.trace = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function usage() {
	return `playwright-flow.mjs — run a repeatable browser flow and save evidence

Usage:
      .pi/cli/playwright-flow.mjs --url <url> --step snapshot --step screenshot=home.png
  .pi/cli/playwright-flow.mjs --artifact /tmp/FLOW.md --url http://localhost:3000 --step 'click=button[type=submit]'

    Options:
      --artifact <path>      Write markdown report to an explicit path
      --url <url>            Initial URL to open
  --browser <name>       chromium | firefox | webkit. Default: chromium
  --headed               Show browser window
  --headless             Force headless mode. Default
  --wait-ms <ms>         Wait after navigation before steps
  --step <step>          Add a step; repeatable
  --steps-file <json>    JSON array of step strings
  --screenshot-dir <dir> Save screenshots here. Default: artifact sibling screenshots/
  --trace                Save Playwright trace.zip beside the artifact

Step syntax:
  snapshot                         record title/url/body text length
  wait=<ms>                        wait milliseconds
  click=<selector>                 click selector
  fill=<selector>::<value>         fill selector with value
  press=<selector>::<key>          press key on selector
  expect-text=<text>               require visible body text
  eval=<js expression>             evaluate expression in page
  screenshot=<file.png>            save screenshot
`;
}

function artifactPath(args) {
	if (args.artifact) return args.artifact;
	return undefined;
}

async function loadPlaywright() {
	try {
		return await import("playwright");
	} catch {
		throw new Error("Playwright is not installed. Install with: npm install -D playwright && npx playwright install");
	}
}

function splitPair(step, prefix) {
	const body = step.slice(prefix.length);
	const sep = body.indexOf("::");
	if (sep === -1) throw new Error(`${prefix.slice(0, -1)} step requires <selector>::<value>`);
	return [body.slice(0, sep), body.slice(sep + 2)];
}

function mdEscape(value) {
	return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function runStep(page, step, screenshotDir) {
	const started = Date.now();
	if (step === "snapshot") {
		const data = await page.evaluate(() => ({ title: document.title, url: location.href, textLength: document.body?.innerText?.length ?? 0 }));
		return { step, status: "ok", evidence: JSON.stringify(data), durationMs: Date.now() - started };
	}
	if (step.startsWith("wait=")) {
		const ms = Number(step.slice("wait=".length));
		if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid wait step: ${step}`);
		await page.waitForTimeout(ms);
		return { step, status: "ok", evidence: `waited ${ms}ms`, durationMs: Date.now() - started };
	}
	if (step.startsWith("click=")) {
		const selector = step.slice("click=".length);
		await page.locator(selector).click();
		return { step, status: "ok", evidence: `clicked ${selector}`, durationMs: Date.now() - started };
	}
	if (step.startsWith("fill=")) {
		const [selector, value] = splitPair(step, "fill=");
		await page.locator(selector).fill(value);
		return { step, status: "ok", evidence: `filled ${selector}`, durationMs: Date.now() - started };
	}
	if (step.startsWith("press=")) {
		const [selector, key] = splitPair(step, "press=");
		await page.locator(selector).press(key);
		return { step, status: "ok", evidence: `pressed ${key} on ${selector}`, durationMs: Date.now() - started };
	}
	if (step.startsWith("expect-text=")) {
		const text = step.slice("expect-text=".length);
		await page.getByText(text).first().waitFor({ state: "visible", timeout: 5000 });
		return { step, status: "ok", evidence: `found text ${JSON.stringify(text)}`, durationMs: Date.now() - started };
	}
	if (step.startsWith("eval=")) {
		const expression = step.slice("eval=".length);
		const value = await page.evaluate(`(${expression})`);
		return { step, status: "ok", evidence: JSON.stringify(value), durationMs: Date.now() - started };
	}
	if (step.startsWith("screenshot=")) {
		const name = step.slice("screenshot=".length);
		const path = join(screenshotDir, name);
		mkdirSync(dirname(path), { recursive: true });
		await page.screenshot({ path, fullPage: true });
		return { step, status: "ok", evidence: path, durationMs: Date.now() - started };
	}
	throw new Error(`Unknown step: ${step}`);
}

function report(args, results, consoleMessages, requests, tracePath) {
	return `# Playwright Flow Report

**Generated:** ${new Date().toISOString()}
**URL:** ${args.url ?? "(none)"}
**Browser:** ${args.browser}
**Headless:** ${args.headless}

## Steps
| Step | Status | Duration | Evidence |
| --- | --- | ---: | --- |
${results.map((r) => `| ${mdEscape(r.step)} | ${r.status} | ${r.durationMs}ms | ${mdEscape(r.evidence)} |`).join("\n")}

## Console
${consoleMessages.length ? consoleMessages.map((m) => `- ${m.type}: ${m.text}`).join("\n") : "- No console messages captured."}

## Network Summary
- Requests observed: ${requests.length}
${requests.slice(-20).map((r) => `- ${r.method} ${r.url}`).join("\n")}

${tracePath ? `## Trace\n- ${tracePath}\n` : ""}`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	if (!args.url) throw new Error("--url is required");
	const out = artifactPath(args);
	const screenshotDir = args.screenshotDir ?? (out ? join(dirname(out), "screenshots") : join(process.cwd(), ".pi", "browser-artifacts", "screenshots"));
	const { chromium, firefox, webkit } = await loadPlaywright();
	const engines = { chromium, firefox, webkit };
	const engine = engines[args.browser];
	if (!engine) throw new Error(`Unsupported --browser ${args.browser}`);

	const browser = await engine.launch({ headless: args.headless });
	const context = await browser.newContext();
	const tracePath = args.trace ? (out ? join(dirname(out), "trace.zip") : join(process.cwd(), ".pi", "browser-artifacts", "trace.zip")) : undefined;
	if (args.trace && tracePath) mkdirSync(dirname(tracePath), { recursive: true });
	if (args.trace) await context.tracing.start({ screenshots: true, snapshots: true });
	const page = await context.newPage();
	const consoleMessages = [];
	const requests = [];
	page.on("console", (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
	page.on("request", (req) => requests.push({ method: req.method(), url: req.url() }));

	const results = [];
	try {
		await page.goto(args.url, { waitUntil: "domcontentloaded" });
		if (args.waitMs) await page.waitForTimeout(args.waitMs);
		const steps = args.steps.length ? args.steps : ["snapshot", "screenshot=page.png"];
		for (const step of steps) results.push(await runStep(page, step, screenshotDir));
	} finally {
		if (args.trace) await context.tracing.stop({ path: tracePath });
		await browser.close();
	}

	const text = report(args, results, consoleMessages, requests, tracePath);
	if (out) {
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, text, "utf-8");
		console.log(out);
	} else {
		console.log(text);
	}
}

main().catch((error) => {
	console.error(`playwright-flow.mjs: ${error.message}`);
	process.exit(1);
});
