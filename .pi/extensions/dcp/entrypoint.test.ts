import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(DIR, "index.ts");

test("dcp extension entrypoint exists and loads", async () => {
	assert.equal(existsSync(ENTRYPOINT), true, "expected .pi/extensions/dcp/index.ts to exist");
	const mod = await import(pathToFileURL(ENTRYPOINT).href);
	assert.equal(typeof mod.default, "function", "expected dcp extension default export to be a function");
});
