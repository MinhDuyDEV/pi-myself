import assert from "node:assert/strict";
import { test } from "node:test";
import { SmartZoneReading, lastTurnTokens, smartZone, smartZoneLimit, SMART_ZONE_LIMIT } from "../smart-zone.js";

const LIMIT = SMART_ZONE_LIMIT; // 150k

test("thresholds hold exactly at the boundaries", () => {
	const cases: Array<[number, SmartZoneReading["level"], number]> = [
		[Math.floor(LIMIT * 0.6) - 1, "ok", 60],
		[Math.floor(LIMIT * 0.6), "watch", 60],
		[Math.floor(LIMIT * 0.85) - 1, "watch", 85],
		[Math.floor(LIMIT * 0.85), "boundary", 85],
		[LIMIT - 1, "boundary", 100],
		[LIMIT, "over", 100],
		[LIMIT * 2, "over", 200],
	];
	for (const [used, level, pct] of cases) {
		const reading = smartZone(used);
		assert.equal(reading.level, level, `${used}: expected ${level}, got ${reading.level}`);
		assert.equal(Math.round(reading.pct), pct, `${used}: pct`);
		assert.ok(reading.note.length > 10);
	}
});

test("lastTurnTokens sums the last assistant message's full accounting", () => {
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", usage: { input: 10_000, output: 500, cacheRead: 30_000, cacheWrite: 9_500 } },
		{ role: "toolResult", content: "x" },
		{ role: "assistant", usage: { input: 100_000, output: 2_000, cacheRead: 40_000, cacheWrite: 6_000 } },
	];
	assert.equal(lastTurnTokens(messages), 148_000);
	assert.equal(lastTurnTokens([{ role: "user", content: "hi" }]), undefined);
	assert.equal(lastTurnTokens([]), undefined);
	const zeroUsage = [{ role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
	assert.equal(lastTurnTokens(zeroUsage), 0);
});

test("PI_SMART_ZONE_LIMIT: honoured at >=1000, falls back otherwise", () => {
	process.env.PI_SMART_ZONE_LIMIT = "4000";
	assert.equal(smartZoneLimit(), 4000);
	assert.equal(smartZone(3500, smartZoneLimit()).level, "boundary"); // 87.5% of 4k
	assert.equal(smartZone(4200, smartZoneLimit()).level, "over");
	process.env.PI_SMART_ZONE_LIMIT = "garbage";
	assert.equal(smartZoneLimit(), SMART_ZONE_LIMIT);
	process.env.PI_SMART_ZONE_LIMIT = "500";
	assert.equal(smartZoneLimit(), SMART_ZONE_LIMIT);
	delete process.env.PI_SMART_ZONE_LIMIT;
	assert.equal(smartZoneLimit(), SMART_ZONE_LIMIT);
});

test("notes carry the phase-boundary decision order when it matters", () => {
	assert.match(smartZone(LIMIT).note, /compact/);
	assert.match(smartZone(Math.floor(LIMIT * 0.85)).note, /\/clear > \/handoff > subagent > \/compact/);
	assert.match(smartZone(1000).note, /room left/);
});