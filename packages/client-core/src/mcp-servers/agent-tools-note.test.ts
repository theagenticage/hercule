import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import { describeAgentToolsNote, describeUnavailableAgentToolsNote } from "./agent-tools-note";
import { SENTRY_WORK } from "./testing";

const describeNote = (overrides: Partial<McpServer>) =>
  describeAgentToolsNote({ ...SENTRY_WORK, ...overrides });

describe("describeAgentToolsNote", () => {
  it("says off for a server with no record", () => {
    expect(describeAgentToolsNote(null)).toEqual({ words: "agent tools off", failing: false });
  });

  it("says off for a server switched off, whatever its status was", () => {
    expect(describeNote({ enabled: false, status: "needs-sign-in" })).toEqual({
      words: "agent tools off",
      failing: false,
    });
  });

  it("says on for a ready server", () => {
    expect(describeNote({ status: "ready" })).toEqual({ words: "agent tools on", failing: false });
  });

  it("says checking, not failing, while the server is being checked", () => {
    expect(describeNote({ status: "checking" })).toEqual({
      words: "agent tools: checking",
      failing: false,
    });
  });

  it.each([
    ["needs-sign-in", "agent tools: needs sign-in"],
    ["unreachable", "agent tools: unreachable"],
    ["error", "agent tools: error"],
  ] as const)("says the status of a server that is %s, and marks it failing", (status, words) => {
    expect(describeNote({ status })).toEqual({ words, failing: true });
  });
});

describe("describeUnavailableAgentToolsNote", () => {
  it("says the tools are not available, and does not mark it failing", () => {
    expect(describeUnavailableAgentToolsNote()).toEqual({
      words: "agent tools: not available",
      failing: false,
    });
  });
});
