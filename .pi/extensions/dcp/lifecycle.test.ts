import { describe, it } from "node:test";
import assert from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dcpExtension from "./index.ts";

describe("DCP recall-only extension", () => {
	it("exports dcpExtension accepting ExtensionAPI", () => {
		assert.strictEqual(typeof dcpExtension, "function", "dcpExtension must be a function");
		assert.strictEqual(dcpExtension.length, 1, "dcpExtension should accept 1 argument (pi)");
	});

	it("registers recall without lifecycle handlers", () => {
		const tools: Array<{ name?: string }> = [];
		const events: string[] = [];
		const pi: ExtensionAPI = {
			registerTool(tool: { name?: string }) {
				tools.push(tool);
			},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		dcpExtension(pi);

		assert.deepStrictEqual(tools.map((tool) => tool.name), ["recall"]);
		assert.deepStrictEqual(events, []);
	});
});
