#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_VIEWPORTS = [
	{ name: "desktop", width: 1440, height: 900 },
	{ name: "tablet", width: 834, height: 1112 },
	{ name: "mobile", width: 390, height: 844 },
];

function parseArgs(argv) {
	const args = { browser: "chromium", headless: true, waitMs: 500, viewports: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--help" || arg === "-h") args.help = true;
		else if (arg === "--url") args.url = next();
		else if (arg === "--out-dir") args.outDir = next();
		else if (arg === "--report") args.report = next();
		else if (arg === "--browser") args.browser = next();
		else if (arg === "--headed") args.headless = false;
		else if (arg === "--full-page") args.fullPage = true;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--viewport") args.viewports.push(parseViewport(next()));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function parseViewport(value) {
	const match = value.match(/^([a-zA-Z0-9_-]+):(\d+)x(\d+)$/);
	if (!match) throw new Error(`Invalid viewport ${value}; expected name:WIDTHxHEIGHT`);
	return { name: match[1], width: Number(match[2]), height: Number(match[3]) };
}

function usage() {
	return `browser-screenshot.mjs — capture deterministic screenshots with Playwright

Usage:
  .pi/cli/browser-screenshot.mjs --url http://localhost:3000
  .pi/cli/browser-screenshot.mjs --url https://example.com --out-dir /tmp/shots --viewport desktop:1440x900

Options:
  --url <url>             Page URL to capture. Required
  --out-dir <dir>         Save screenshots under <dir> (default: .pi/browser-artifacts/screenshots)
  --out-dir <dir>         Explicit screenshot output directory
  --report <path>         Explicit markdown report path
  --browser <name>        chromium | firefox | webkit. Default: chromium
  --headed                Show browser window
  --full-page             Capture full-page screenshots
  --wait-ms <ms>          Wait after navigation before capture. Default: 500
  --viewport <name:WxH>   Capture one viewport; repeatable. Defaults: desktop/tablet/mobile
`;
}

async function loadPlaywright() {
	try {
		return await import("playwright");
	} catch {
		throw new Error("Playwright is not installed. Install with: npm install -D playwright && npx playwright install");
	}
}

function paths(args) {
	const outDir = args.outDir ?? join(process.cwd(), ".pi", "browser-artifacts", "screenshots");
	const report = args.report ?? join(outDir, "SCREENSHOTS.md");
	return { outDir, report };
}

function safeName(name) {
	return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "viewport";
}

function report({ url, browser, fullPage, waitMs }, captures) {
	return `# Browser Screenshots

**Generated:** ${new Date().toISOString()}
**URL:** ${url}
**Browser:** ${browser}
**Full page:** ${Boolean(fullPage)}
**Wait:** ${waitMs}ms

## Captures
| Viewport | Size | File |
| --- | ---: | --- |
${captures.map((c) => `| ${c.name} | ${c.width}x${c.height} | ${c.path} |`).join("\n")}
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	if (!args.url) throw new Error("--url is required");
	if (!Number.isFinite(args.waitMs) || args.waitMs < 0) throw new Error("--wait-ms must be a non-negative number");

	const viewports = args.viewports.length ? args.viewports : DEFAULT_VIEWPORTS;
	const { outDir, report: reportPath } = paths(args);
	mkdirSync(outDir, { recursive: true });
	mkdirSync(dirname(reportPath), { recursive: true });

	const { chromium, firefox, webkit } = await loadPlaywright();
	const engines = { chromium, firefox, webkit };
	const engine = engines[args.browser];
	if (!engine) throw new Error(`Unsupported --browser ${args.browser}`);

	const browser = await engine.launch({ headless: args.headless });
	const captures = [];
	try {
		for (const viewport of viewports) {
			const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
			const page = await context.newPage();
			await page.goto(args.url, { waitUntil: "domcontentloaded" });
			if (args.waitMs) await page.waitForTimeout(args.waitMs);
			const path = join(outDir, `${safeName(viewport.name)}-${viewport.width}x${viewport.height}.png`);
			await page.screenshot({ path, fullPage: Boolean(args.fullPage) });
			captures.push({ ...viewport, path });
			await context.close();
		}
	} finally {
		await browser.close();
	}

	writeFileSync(reportPath, report(args, captures), "utf-8");
	console.log(reportPath);
}

main().catch((error) => {
	console.error(`browser-screenshot.mjs: ${error.message}`);
	process.exit(1);
});
