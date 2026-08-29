import { describe, expect, it } from "bun:test";

import dcpExtension from "./index.js";

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();
  const tools: Array<{ name?: string }> = [];

  return {
    api: {
      on(event: string, handler: (event: unknown) => unknown) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
      registerTool(tool: { name?: string }) {
        tools.push(tool);
      },
    },
    handlerNames() {
      return [...handlers.keys()];
    },
    toolNames() {
      return tools.map((tool) => tool.name);
    },
  };
}

describe("DCP recall-only extension", () => {
  it("registers only recall and leaves Pi lifecycle events untouched", () => {
    const mock = createMockPi();

    dcpExtension(mock.api as any);

    expect(mock.toolNames()).toEqual(["recall"]);
    expect(mock.handlerNames()).toEqual([]);
  });
});
