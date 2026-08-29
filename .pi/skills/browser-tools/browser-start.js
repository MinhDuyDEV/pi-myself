#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

if (process.argv.length > 2) {
	if (process.argv.slice(2).includes("--profile")) {
		console.error("Profile copying is unsupported. Start an isolated browser and sign in manually.");
	} else {
		console.error("Usage: browser-start.js");
	}
	process.exit(1);
}

const SCRAPING_DIR = join(homedir(), ".cache", "browser-tools");
const FRESH_PROFILE_MARKER = join(SCRAPING_DIR, ".fresh-profile");
const CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function usesVerifiedProfile(browser) {
	let session;
	try {
		session = await browser.target().createCDPSession();
		const { arguments: commandLine } = await session.send("Browser.getBrowserCommandLine");
		const expectedProfileArg = `--user-data-dir=${SCRAPING_DIR}`;
		return commandLine.includes(expectedProfileArg) && existsSync(FRESH_PROFILE_MARKER);
	} catch {
		return false;
	} finally {
		await session?.detach().catch(() => {});
	}
}

// Reuse only a browser whose live command line points at this isolated profile.
// A marker alone is insufficient because it can outlive the Chrome process.
let existingBrowser;
try {
	existingBrowser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
} catch {
	// No browser on :9222 yet — a fresh launch below will create one.
}

if (existingBrowser) {
	const verified = await usesVerifiedProfile(existingBrowser);
	await existingBrowser.disconnect();

	if (!verified) {
		console.error("✗ Chrome on :9222 does not use the verified isolated profile. Close it and retry.");
		process.exit(1);
	}
	console.log("✓ Isolated Chrome already running on :9222");
	process.exit(0);
}

// A new launch always starts from an empty isolated profile.
rmSync(SCRAPING_DIR, { recursive: true, force: true });
mkdirSync(SCRAPING_DIR, { recursive: true, mode: 0o700 });
writeFileSync(FRESH_PROFILE_MARKER, "browser-tools isolated profile\n", { mode: 0o600 });

// spawn without `shell: true` never interprets arguments through a shell, so
// the profile path (derived from the user's home directory, not user input)
// cannot inject commands.
const userDataDirArg = "--user-data-dir=" + SCRAPING_DIR;
spawn(
	CHROME_BINARY,
	["--remote-debugging-port=9222", userDataDirArg, "--enable-automation", "--no-first-run", "--no-default-browser-check"],
	{ detached: true, stdio: "ignore" },
).unref();

let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: "http://localhost:9222",
			defaultViewport: null,
		});
		const verified = await usesVerifiedProfile(browser);
		await browser.disconnect();
		if (!verified) {
			console.error("✗ Chrome claimed :9222 without the verified isolated profile");
			process.exit(1);
		}
		connected = true;
		break;
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Chrome");
	process.exit(1);
}

console.log("✓ Chrome started on :9222 with a fresh isolated profile");
