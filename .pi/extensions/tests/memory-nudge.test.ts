import assert from "node:assert/strict";
import { test } from "node:test";
import { quitNudge } from "../memory-nudge.js";

test("quitNudge: created/updated pass silently; unchanged and absent nudge", () => {
	assert.equal(quitNudge({ existed: false, content: "" }, { existed: true, content: "hello" }), "created");
	assert.equal(quitNudge({ existed: true, content: "old" }, { existed: true, content: "new" }), "updated");
	assert.equal(quitNudge({ existed: true, content: "same" }, { existed: true, content: "same" }), "unchanged");
	assert.equal(quitNudge({ existed: false, content: "" }, { existed: false, content: "" }), "absent");
});