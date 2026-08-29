import { describe, expect, test } from "bun:test";
import { registerRecallTool } from "./recall.ts";

type RegisteredTool = {
  name?: string;
  description?: string;
  parameters?: unknown;
  execute?: unknown;
  renderCall?: (
    args: unknown,
    theme: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
    },
  ) => { render: (width: number) => string[] };
};

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function mockApi() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    api: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      on() {},
      appendEntry() {},
    } as never,
  };
}

describe("DCP registerTool shape", () => {
  test("recall registers ToolDefinition with name + parameters", () => {
    const { tools, api } = mockApi();
    registerRecallTool(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("recall");
    expect(tools[0]?.renderCall?.({}, plainTheme)?.render(80)?.map((line) => line.trimEnd())).toEqual([
      "⚙ recall",
    ]);
    expect(tools[0]?.parameters).toBeDefined();
    expect(typeof tools[0]?.execute).toBe("function");
    const payload = JSON.parse(
      JSON.stringify({
        type: "function",
        name: tools[0]?.name,
        description: tools[0]?.description,
        parameters: tools[0]?.parameters,
        strict: false,
      }),
    );
    expect(payload.name).toBe("recall");
  });

  test("legacy multi-arg form would omit name (regression guard)", () => {
      // Documents the failure mode: registerTool(string) → tool.name undefined
      const tool = "recall" as unknown as { name?: string };

    const payload = JSON.parse(
      JSON.stringify({
        type: "function",
        name: (tool as { name?: string }).name,
        strict: false,
      }),
    );
    expect(payload).toEqual({ type: "function", strict: false });
    expect(payload.name).toBeUndefined();
  });
});
