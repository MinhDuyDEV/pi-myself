import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The ultra-review scaffold is a shipped helper whose output is the report's
// identity: `/skill:ultra-review-receive` compares the digest, scope, and round
// in the artifact against the workspace. So the values the script is handed
// must actually land in the file, and the invocation it prints must be the
// command pi really exposes (`/skill:<name>` — the generated-wrapper layer was
// removed, so a bare `/ultra-review-receive` is not a command).

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, ".pi", "skills", "ultra-review", "scripts", "create_ultra_review_report.py");
const DIGEST = "a".repeat(64);

function runScaffold(workspace: string, extra: string[] = []): string {
	return execFileSync(
		"python3",
		[
			SCRIPT,
			"--workspace",
			workspace,
			"--review-name",
			"Probe Review",
			"--scope",
			"the review diff",
			"--review-brief-sha256",
			DIGEST,
			"--scout-count",
			"10",
			"--directive-count",
			"3",
			"--date",
			"26-01-02",
			...extra,
		],
		{ encoding: "utf8" },
	);
}

test("the ultra-review scaffold writes the report identity it was handed", () => {
	const workspace = mkdtempSync(join(tmpdir(), "ultra-review-"));
	try {
		const output = runScaffold(workspace);
		const meta = JSON.parse(output.slice(0, output.indexOf("---BEGIN ULTRA REVIEW TEMPLATE---"))) as {
			review_name: string;
			round: number;
			report_path: string;
		};
		assert.equal(meta.review_name, "probe-review", "the review name is slugged");
		assert.equal(meta.round, 1);
		assert.equal(meta.report_path, "docs/ultrareview/26-01-02-probe-review-round-1.md");

		const report = readFileSync(join(workspace, meta.report_path), "utf8");
		// the digest and counts are what the receive step preflights against
		assert.match(report, new RegExp(`^Review brief sha256: ${DIGEST}$`, "m"));
		assert.match(report, /^Scouts: 10$/m);
		assert.match(report, /^Caller directives: 3$/m);
		assert.match(report, /^Round: 1$/m);
		assert.match(report, /^Scope: the review diff$/m);
		// the printed next step must be a command pi actually exposes
		assert.match(report, /Run \/skill:ultra-review-receive to verify docs\/ultrareview\/26-01-02-probe-review-round-1\.md/);
		assert.equal(/Run \/ultra-review-receive/.test(report), false, "a bare /ultra-review-receive is not a command");
		// the digest must actually be rendered, not only validated
		assert.equal(report.includes("{review_brief_sha256}"), false, "no unrendered placeholders");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("the scaffold increments the round and lists the prior reports", () => {
	const workspace = mkdtempSync(join(tmpdir(), "ultra-review-round-"));
	try {
		runScaffold(workspace);
		const output = runScaffold(workspace);
		const meta = JSON.parse(output.slice(0, output.indexOf("---BEGIN ULTRA REVIEW TEMPLATE---"))) as {
			round: number;
			report_path: string;
		};
		assert.equal(meta.round, 2);
		const report = readFileSync(join(workspace, meta.report_path), "utf8");
		assert.match(report, /^Round: 2$/m);
		assert.match(report, /Previous reports read:\n- docs\/ultrareview\/26-01-02-probe-review-round-1\.md/);
		assert.equal(existsSync(join(workspace, "docs/ultrareview/26-01-02-probe-review-round-1.md")), true, "the earlier report is kept");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("the scaffold refuses a malformed brief digest", () => {
	const workspace = mkdtempSync(join(tmpdir(), "ultra-review-bad-digest-"));
	try {
		assert.throws(() =>
			execFileSync(
				"python3",
				[
					SCRIPT,
					"--workspace",
					workspace,
					"--review-name",
					"x",
					"--scope",
					"s",
					"--review-brief-sha256",
					"not-a-digest",
					"--scout-count",
					"10",
					"--directive-count",
					"0",
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
