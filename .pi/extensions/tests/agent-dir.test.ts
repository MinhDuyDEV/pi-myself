import { join } from "node:path";
import { test } from "node:test";

import { agentDir, defaultSessionDirName } from "../lib/agent-dir.js";
import { expect } from "./expect.js";

// recall and skill-tool read pi's user dir; pi moves it with
// PI_CODING_AGENT_DIR, so a hardcoded ~/.pi/agent silently reads nothing.

test("agentDir mirrors pi: PI_CODING_AGENT_DIR wins untrimmed (tilde-expanded), else ~/.pi/agent", () => {
	expect(agentDir({}, "/home/me")).toBe(join("/home/me", ".pi", "agent"));
	// pi reads the env var verbatim: an empty value is falsy and falls back, but
	// whitespace is a path pi accepts as written (it is not trimmed).
	expect(agentDir({ PI_CODING_AGENT_DIR: "" }, "/home/me")).toBe(join("/home/me", ".pi", "agent"));
	expect(agentDir({ PI_CODING_AGENT_DIR: "   " }, "/home/me")).toBe("   ");
	expect(agentDir({ PI_CODING_AGENT_DIR: "/opt/pi-agent" }, "/home/me")).toBe("/opt/pi-agent");
	expect(agentDir({ PI_CODING_AGENT_DIR: "~/.omp/agent" }, "/home/me")).toBe(join("/home/me", ".omp", "agent"));
	expect(agentDir({ PI_CODING_AGENT_DIR: "~" }, "/home/me")).toBe("/home/me");
	// ~\ is expanded only on win32, matching pi's normalizePath.
	expect(agentDir({ PI_CODING_AGENT_DIR: "~\\omp\\agent" }, "/home/me", "darwin")).toBe("~\\omp\\agent");
	expect(agentDir({ PI_CODING_AGENT_DIR: "~\\omp\\agent" }, "C:\\Users\\me", "win32")).toBe(join("C:\\Users\\me", "omp\\agent"));
});

test("defaultSessionDirName mirrors pi's per-launch-cwd session directory", () => {
	expect(defaultSessionDirName("/Users/me/repo")).toBe("--Users-me-repo--");
	expect(defaultSessionDirName("C:\\work\\repo")).toBe("--C--work-repo--");
});
