import assert from "node:assert/strict";

/**
 * Minimal `expect` over node:assert — the subset the extension tests use
 * (toBe, toEqual, toContain, toHaveLength, toBeDefined/Undefined,
 * toBeTrue/False, and `.not` for each). Exists so every extension test runs
 * under the single `node --test` runner that CI has; bun is not a CI
 * dependency.
 */
interface Matchers {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toContain(item: unknown): void;
	toHaveLength(length: number): void;
	toBeDefined(): void;
	toBeUndefined(): void;
	toBeTrue(): void;
	toBeFalse(): void;
	readonly not: Matchers;
}

function contains(haystack: unknown, item: unknown): boolean {
	if (typeof haystack === "string") return haystack.includes(String(item));
	if (Array.isArray(haystack)) return haystack.includes(item);
	if (haystack instanceof Set) return haystack.has(item);
	throw new TypeError(`toContain: unsupported receiver ${typeof haystack}`);
}

function matchers(actual: unknown, negated: boolean): Matchers {
	const check = (passed: boolean, message: string) => {
		assert.equal(passed, !negated, `${negated ? "not " : ""}${message}`);
	};
	return {
		toBe: (expected) => (negated ? assert.notEqual(actual, expected) : assert.equal(actual, expected)),
		toEqual: (expected) => (negated ? assert.notDeepEqual(actual, expected) : assert.deepEqual(actual, expected)),
		toContain: (item) => check(contains(actual, item), `expected ${JSON.stringify(actual)?.slice(0, 200)} to contain ${JSON.stringify(item)}`),
		toHaveLength: (length) => check((actual as { length: number }).length === length, `expected length ${length}, got ${(actual as { length: number }).length}`),
		toBeDefined: () => check(actual !== undefined, "expected a defined value"),
		toBeUndefined: () => check(actual === undefined, `expected undefined, got ${JSON.stringify(actual)}`),
		toBeTrue: () => check(actual === true, `expected true, got ${JSON.stringify(actual)}`),
		toBeFalse: () => check(actual === false, `expected false, got ${JSON.stringify(actual)}`),
		get not() {
			return matchers(actual, !negated);
		},
	};
}

export function expect(actual: unknown): Matchers {
	return matchers(actual, false);
}
