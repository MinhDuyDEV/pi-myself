#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function findTestFiles(dir) {
	const results = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...findTestFiles(fullPath));
		} else if (entry.endsWith(".test.ts") || entry.endsWith(".test.mjs")) {
			results.push(relative(ROOT, fullPath));
		}
	}
	return results;
}

const testFiles = findTestFiles(join(ROOT, ".pi", "extensions")).sort();
if (testFiles.length === 0) {
	console.error("No test files found under .pi/extensions/");
	process.exit(1);
}

const bunTests = testFiles.filter((file) => readFileSync(file, "utf8").includes("bun:test"));
const nodeTests = testFiles.filter((file) => !bunTests.includes(file));

if (nodeTests.length > 0) run("npx", ["tsx", "--test", ...nodeTests]);
if (bunTests.length > 0) run("bun", ["test", ...bunTests.map((file) => `./${file}`)]);

