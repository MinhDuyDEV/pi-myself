import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { TRACKER_OPS, type TrackerOp } from "./params.js";

// The `tracker` tool's contract is not ours: github.ts says it "implements
// docs/agents/issue-tracker.md's GitHub conventions, which come from
// setup-matt-pocock-skills' issue-tracker-github.md", and tracker.ts says the
// local backend is the `.scratch/` convention. Those two templates are vendored
// and are replaced wholesale on `npm run sync:skills`, so this gate re-derives
// the operations they document and fails when one is neither wired into
// TRACKER_OPS nor recorded below as deliberately left to prose. Without it, a
// sync that adds a tracker convention diverges silently — the op set was last
// audited by hand (PLAN.md §5, extension pass 2026-09-15) and nothing has
// watched it since.

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const TEMPLATES = join(ROOT, "vendor", "mattpocock-skills", "skills", "engineering", "setup-matt-pocock-skills");

/** Template file → the operations it documents, and the ops that serve them.
 * A `proseOnly` entry carries the recorded reason it is not a tool op. */
interface Coverage {
	file: string;
	/** Normalized documented operation → serving ops (`[]` = prose-only). */
	operations: Record<string, { ops: TrackerOp[]; proseOnly?: string }>;
}

const COVERAGE: Coverage[] = [
	{
		file: "issue-tracker-local.md",
		operations: {
			"publish to the issue tracker": { ops: ["create-spec", "create-ticket"] },
			"fetch the relevant ticket": { ops: ["show"] },
			map: { ops: ["create-map"] },
			"child ticket": { ops: ["create-ticket"] },
			blocking: { ops: ["block"] },
			frontier: { ops: ["frontier"] },
			claim: { ops: ["claim"] },
			resolve: { ops: ["resolve"] },
		},
	},
	{
		file: "issue-tracker-github.md",
		operations: {
			"publish to the issue tracker": { ops: ["gh-create-spec", "gh-create-ticket"] },
			"fetch the relevant ticket": { ops: ["gh-show"] },
			"create an issue": { ops: ["gh-create-ticket"] },
			"read an issue": { ops: ["gh-show"] },
			"list issues": { ops: ["gh-list"] },
			"comment on an issue": { ops: ["gh-comment"] },
			"apply / remove labels": { ops: ["gh-status"] },
			close: { ops: ["gh-resolve", "gh-out-of-scope"] },
			// The PR surface is a triage entry point, not a tracker field op:
			// PLAN.md §5/§130 record it as left to prose. If upstream turns PRs
			// into a request surface this entry is the prompt to wire it.
			"read a pr": { ops: [], proseOnly: "PR triage reads go through plain `gh pr view`; recorded as left to prose in PLAN.md §5" },
			"list external prs for triage": { ops: [], proseOnly: "same PR surface; PLAN.md §5" },
			"comment / label / close": { ops: [], proseOnly: "same PR surface; PLAN.md §5" },
			map: { ops: ["gh-create-map"] },
			"child ticket": { ops: ["gh-create-ticket"] },
			blocking: { ops: ["gh-block"] },
			"frontier query": { ops: ["gh-frontier"] },
			claim: { ops: ["gh-claim"] },
			resolve: { ops: ["gh-resolve"] },
		},
	},
];

/** `**Bold**` leading a bullet, and `## When a skill says "…"` headings: the two
 * shapes the templates use to name an operation. */
function documentedOperations(text: string): string[] {
	const terms: string[] = [];
	for (const line of text.split("\n")) {
		const bullet = /^\s*-\s+\*\*([^*]+)\*\*/.exec(line);
		if (bullet?.[1]) terms.push(normalize(bullet[1]));
	}
	for (const header of text.matchAll(/^##\s+When a skill says "([^"]+)"/gm)) {
		if (header[1]) terms.push(normalize(header[1]));
	}
	return [...new Set(terms)];
}

function normalize(term: string): string {
	return term
		.toLowerCase()
		.replace(/\s*\/\s*/g, " / ")
		.replace(/[.]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

test("the vendored tracker templates are where this gate thinks they are", () => {
	for (const { file } of COVERAGE) {
		assert.equal(existsSync(join(TEMPLATES, file)), true, `missing vendored template ${file}`);
	}
	assert.ok(TRACKER_OPS.length >= 26, "the op list looks truncated");
});

test("every tracker operation the vendored templates document is wired or recorded", () => {
	const offenders: string[] = [];
	const proseOnly: string[] = [];
	for (const { file, operations } of COVERAGE) {
		const documented = documentedOperations(readFileSync(join(TEMPLATES, file), "utf8"));
		assert.ok(documented.length >= 6, `${file}: the operation list did not parse (${documented.length} found)`);
		for (const term of documented) {
			const entry = operations[term];
			if (!entry) {
				offenders.push(`${file}: documented operation "${term}" is neither wired into TRACKER_OPS nor recorded as prose-only in this test`);
				continue;
			}
			if (entry.ops.length === 0) {
				if (!entry.proseOnly) offenders.push(`${file}: "${term}" has no ops and no proseOnly reason`);
				else proseOnly.push(`${file}: ${term} — ${entry.proseOnly}`);
				continue;
			}
			for (const op of entry.ops) {
				if (!(TRACKER_OPS as readonly string[]).includes(op)) {
					offenders.push(`${file}: "${term}" maps to unknown op ${op}`);
				}
			}
		}
	}
	assert.deepEqual(offenders, []);
	// keeps the prose-only exceptions visible in the test output rather than hidden
	assert.ok(proseOnly.length <= 3, `more prose-only tracker operations than the recorded exceptions:\n${proseOnly.join("\n")}`);
});

test("every mapped op exists and each backend covers its own template", () => {
	const mapped = new Set<string>();
	for (const { operations } of COVERAGE) {
		for (const entry of Object.values(operations)) for (const op of entry.ops) mapped.add(op);
	}
	for (const op of mapped) {
		assert.ok((TRACKER_OPS as readonly string[]).includes(op), `coverage map names an op the tool does not have: ${op}`);
	}
	// the local template must not be served only by gh- ops, or vice versa
	const localOps = Object.values(COVERAGE[0]!.operations).flatMap((entry) => entry.ops);
	const remoteOps = Object.values(COVERAGE[1]!.operations).flatMap((entry) => entry.ops);
	assert.ok(
		localOps.some((op) => !op.startsWith("gh-")),
		"the local template needs local ops",
	);
	assert.ok(
		remoteOps.some((op) => op.startsWith("gh-")),
		"the GitHub template needs gh- ops",
	);
	assert.equal(
		localOps.some((op) => op.startsWith("gh-")),
		false,
		"the local template is served by local ops only",
	);
	assert.equal(
		remoteOps.some((op) => !op.startsWith("gh-")),
		false,
		"the GitHub template is served by gh- ops only",
	);
});

/** Ops whose requirement comes from a *skill's prose* rather than from a bullet
 * in the two tracker templates this gate parses, plus the ops this harness adds.
 * Recorded with their source so that adding an op is a decision rather than
 * drift, and so an op with no source at all is visible. */
const PROSE_DERIVED_OPS: Record<string, string> = {
	list: "to-tickets / triage: list the tickets of a feature, or the attention queue",
	status: "triage: apply a state role or a category role",
	tick: "to-tickets / to-spec: tick an acceptance-criteria checkbox",
	comment: "triage notes, verification blocks, closeout evidence",
	"out-of-scope": "wayfinder: rule a ticket out; the map's Out of scope section",
	"gh-triage": "triage: the attention queue (gh-list cannot express it)",
	"gh-tick": "to-tickets / to-spec: tick an acceptance-criteria checkbox",
	edit: "harness addition — reword a ticket's title/body after research",
	note: "harness addition — append a map section line (Notes, fog, Out of scope)",
	"gh-edit": "harness addition — same as edit, GitHub backend",
	"gh-note": "harness addition — same as note, GitHub backend",
};

test("every tracker op is template-derived, prose-derived, or a recorded addition", () => {
	const derived = new Set<string>();
	for (const { operations } of COVERAGE) {
		for (const entry of Object.values(operations)) {
			for (const op of entry.ops) derived.add(op);
		}
	}
	const orphans = TRACKER_OPS.filter((op) => !derived.has(op) && PROSE_DERIVED_OPS[op] === undefined);
	assert.deepEqual(
		orphans,
		[],
		"an op is neither required by the vendored templates nor recorded in PROSE_DERIVED_OPS — wire it, drop it, or record where it comes from",
	);
	const stale = Object.keys(PROSE_DERIVED_OPS).filter((op) => !(TRACKER_OPS as readonly string[]).includes(op));
	assert.deepEqual(stale, [], "PROSE_DERIVED_OPS names an op TRACKER_OPS does not have");
	const duplicated = Object.keys(PROSE_DERIVED_OPS).filter((op) => derived.has(op));
	assert.deepEqual(duplicated, [], "these ops are template-derived already; drop them from PROSE_DERIVED_OPS");
	for (const [op, source] of Object.entries(PROSE_DERIVED_OPS)) {
		assert.ok(source.trim().length > 0, `${op} is recorded without a source`);
	}
});
