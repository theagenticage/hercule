import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../threads/blocks";
import type { RuntimeNote } from "../threads/turns";
import type { McpServerWarningEntry } from "./fix";
import { hasMcpServerBlock, hasMcpServerLine } from "./mcp-line-presence";

const warn = (reason: McpServerWarningEntry["reason"], mcpServerId = "s-work") => ({
  mcpServerId,
  reason,
});

describe("hasMcpServerLine", () => {
  const note = (mcpServers?: RuntimeNote["mcpServers"]): RuntimeNote => ({
    key: "1:warning",
    severity: "warning",
    message: "left out",
    at: "2026-11-20T09:00:00.000Z",
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });

  it("is false for a transcript with no note, or notes that name no server", () => {
    expect(hasMcpServerLine({ turns: [], outsideRuntimeNotes: [] })).toBe(false);
    expect(
      hasMcpServerLine({ turns: [{ runtimeNotes: [note()] }], outsideRuntimeNotes: [note()] }),
    ).toBe(false);
  });

  it("is true for a note in a turn that names servers", () => {
    expect(
      hasMcpServerLine({
        turns: [{ runtimeNotes: [note([warn("unreachable")])] }],
        outsideRuntimeNotes: [],
      }),
    ).toBe(true);
  });

  it("is true for a note outside every turn that names servers", () => {
    expect(
      hasMcpServerLine({ turns: [], outsideRuntimeNotes: [note([warn("needs-sign-in")])] }),
    ).toBe(true);
  });
});

describe("hasMcpServerBlock", () => {
  const warning = (mcpServers?: McpServerWarningEntry[]): ThreadBlock => ({
    kind: "warning",
    key: "1:warning",
    message: "left out",
    at: "2026-11-20T09:00:00.000Z",
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });

  it("is false for no blocks, or a warning that names no server", () => {
    expect(hasMcpServerBlock([])).toBe(false);
    expect(hasMcpServerBlock([warning()])).toBe(false);
  });

  it("is true for a warning that names servers", () => {
    expect(hasMcpServerBlock([warning(), warning([warn("unreachable")])])).toBe(true);
  });
});
