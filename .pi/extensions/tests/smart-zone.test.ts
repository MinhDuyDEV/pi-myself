import assert from "node:assert/strict";
import { test } from "node:test";
import smartZoneExtension, {
	lastTurnTokens,
	SMART_ZONE_LIMIT,
	type SmartZoneReading,
	smartZone,
	smartZoneLimit,
	zoneTransition,
} from "../smart-zone.js";

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
});

test("lastTurnTokens skips failed, aborted, and all-zero usage like pi's own counter", () => {
	// pi records a failed or aborted run with an all-zero usage; reading it as 0
	// tokens cleared the footer and re-toasted the boundary on the next run.
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const real = { input: 100_000, output: 2_000, cacheRead: 20_000, cacheWrite: 0 };
	assert.equal(lastTurnTokens([{ role: "assistant", stopReason: "stop", usage: zero }]), undefined);
	assert.equal(lastTurnTokens([{ role: "assistant", stopReason: "error", usage: real }]), undefined);
	assert.equal(lastTurnTokens([{ role: "assistant", stopReason: "aborted", usage: real }]), undefined);
	// an earlier valid turn of the same run is still the latest real reading
	assert.equal(
		lastTurnTokens([
			{ role: "assistant", stopReason: "toolUse", usage: real },
			{ role: "assistant", stopReason: "aborted", usage: zero },
		]),
		122_000,
	);
});

/** The extension's `agent_end` handler behind a fake pi, with a UI that records
 * the footer status and the toasts. */
function meter(model?: { contextWindow: number }) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const statuses: Array<string | undefined> = [];
	const toasts: string[] = [];
	smartZoneExtension({
		on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
		registerCommand() {},
	} as any);
	const ctx = {
		hasUI: true,
		model,
		ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text), notify: (text: string) => toasts.push(text) },
	};
	const run = (stopReason: string, used: number) =>
		handlers.get("agent_end")!(
			{ type: "agent_end", messages: [{ role: "assistant", stopReason, usage: { input: used, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			ctx,
		);
	return { run, statuses, toasts };
}

test("a failed run keeps the previous reading instead of resetting the meter", () => {
	const { run, statuses, toasts } = meter();
	run("stop", Math.floor(LIMIT * 0.9));
	assert.equal(toasts.length, 1, "crossing into boundary toasts once");
	run("error", 0);
	assert.equal(statuses.length, 1, "the failed run leaves the footer alone");
	run("stop", Math.floor(LIMIT * 0.9));
	assert.equal(toasts.length, 1, "still in boundary: no second toast");
	assert.match(statuses.at(-1) ?? "", /\(boundary\)/);
});

test("a context window smaller than the smart zone becomes the limit", () => {
	// A 128k model: pi auto-compacts near 111.6k, where a 150k limit still reads
	// "watch", so the boundary advice would never fire before compaction.
	const small = meter({ contextWindow: 128_000 });
	small.run("stop", 111_616);
	assert.match(small.statuses.at(-1) ?? "", /\(boundary\)/);
	assert.equal(small.toasts.length, 1);

	// a window larger than the smart zone leaves the limit at the smart zone
	const large = meter({ contextWindow: 1_000_000 });
	large.run("stop", 111_616);
	assert.match(large.statuses.at(-1) ?? "", /\(watch\)/);
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

test("zoneTransition: footer status past ok, toast once per crossing into boundary/over", () => {
	const ok = smartZone(1000);
	const watch = smartZone(Math.floor(LIMIT * 0.7));
	const boundary = smartZone(Math.floor(LIMIT * 0.9));
	const over = smartZone(LIMIT + 1);
	assert.deepEqual(zoneTransition(undefined, ok), { status: undefined, toast: false });
	assert.equal(zoneTransition(ok, watch).toast, false, "watch is footer-only");
	assert.match(zoneTransition(ok, watch).status ?? "", /smart-zone 70% \(watch\)/);
	assert.equal(zoneTransition(watch, boundary).toast, true, "crossing into boundary toasts");
	assert.equal(zoneTransition(boundary, boundary).toast, false, "staying in boundary is silent");
	assert.equal(zoneTransition(boundary, over).toast, true, "crossing into over toasts again");
	assert.equal(zoneTransition(over, over).toast, false);
	assert.equal(zoneTransition(over, ok).status, undefined, "dropping back to ok clears the footer");
});

test("notes carry the phase-boundary decision order when it matters", () => {
	assert.match(smartZone(LIMIT).note, /compact/);
	assert.match(smartZone(Math.floor(LIMIT * 0.85)).note, /\/new > \/skill:handoff > subagent > \/compact/);
	assert.match(smartZone(1000).note, /room left/);
});
