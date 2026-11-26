/**
 * Tests the mapping from one Antigravity tool call to an item kind and detail,
 * and to the detail of its approval Request. The calls have the shapes `agy`
 * 1.5.15 sent in the recordings of `@hercule/acp`.
 */
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import { buildApprovalDescription, buildToolItem } from "./tool-items";

const HEADER = "Created At: 2026-11-25T12:36:11+01:00\nCompleted At: 2026-11-25T12:36:12+01:00\n";

const buildCommand = (rawOutput?: unknown) => ({
  toolCallId: "c1",
  name: "run_command",
  rawInput: { CommandLine: "ls", toolSummary: "List files" },
  ...(rawOutput === undefined ? {} : { rawOutput }),
});

describe("buildToolItem", () => {
  it("cuts a long search query, never its domain", () => {
    const item = buildToolItem({
      toolCallId: "c1",
      name: "search_web",
      rawInput: { query: "q".repeat(MAX_FACT_LENGTH * 2), domain: "example.com" },
    });

    const query = (item.detail as { query: string }).query;
    expect(query).toHaveLength(MAX_FACT_LENGTH);
    expect(query.endsWith("… site:example.com")).toBe(true);
  });

  it("maps each Antigravity tool by its name to an item kind and detail", () => {
    const cases = [
      [
        { name: "write_file", rawInput: { Path: "/w/a.txt", Content: "x" } },
        "file_change",
        { path: "/w/a.txt" },
      ],
      [{ name: "read_file", rawInput: { Path: "/w/a.txt" } }, "file_read", { path: "/w/a.txt" }],
      [{ name: "search_web", rawInput: { query: "bun" } }, "web_search", { query: "bun" }],
      [
        { name: "invoke_subagent", rawInput: { Role: "Notes File Reader", Prompt: "secret" } },
        "subagent",
        { description: "Notes File Reader", subagentIds: [] },
      ],
      [
        { name: "ask_question", rawInput: {} },
        "tool_call",
        { name: "ask_question", kind: "native" },
      ],
      [{ name: "constructor", rawInput: {} }, "tool_call", { name: "constructor", kind: "native" }],
    ] as const;
    for (const [call, kind, detail] of cases) {
      expect(buildToolItem({ toolCallId: "c", ...call })).toEqual({ kind, detail });
    }
  });

  it("splits an MCP tool name at the first double underscore and never reads its arguments", () => {
    expect(
      buildToolItem({
        toolCallId: "c",
        name: "mcp_tools_sentry__search__issues",
        kind: "other",
        rawInput: { command: "rm -rf /", Path: "/etc/passwd" },
      }),
    ).toEqual({
      kind: "tool_call",
      detail: { server: "sentry", name: "search__issues", kind: "mcp" },
    });
  });

  it("treats a gateway name with no tool part as a native tool", () => {
    expect(buildToolItem({ toolCallId: "c", name: "mcp_tools_sentry__" }).detail).toEqual({
      name: "mcp_tools_sentry__",
      kind: "native",
    });
  });

  it("takes the path from rawInput and ignores locations", () => {
    const item = buildToolItem({
      toolCallId: "c",
      name: "edit_file",
      rawInput: { Path: "/tmp/w/a.txt" },
      // `locations` is not part of the ToolCall fields, so a call that carries it
      // must still give the same item.
      ...({ locations: [{ path: "/private/tmp/w/a.txt" }] } as object),
    });
    expect(item.detail).toEqual({ path: "/tmp/w/a.txt" });
  });

  it("falls back to the tool's name for a file change with no usable path", () => {
    expect(buildToolItem({ toolCallId: "c", name: "write_file", rawInput: {} }).detail).toEqual({
      name: "write_file",
    });
    const tooLong = "/" + "a".repeat(MAX_FACT_LENGTH);
    expect(
      buildToolItem({ toolCallId: "c", name: "write_file", rawInput: { Path: tooLong } }).detail,
    ).toEqual({ name: "write_file" });
  });

  describe("command_execution", () => {
    it("shows the command and its title before the output is known", () => {
      expect(buildToolItem(buildCommand())).toEqual({
        kind: "command_execution",
        detail: { command: "ls", description: "List files" },
      });
    });

    it("removes the header, turns CRLF into LF and reports the exit code", () => {
      const output = `${HEADER}Command exited with code 2.\n\nCommand output:\na\r\nb\r\n`;
      expect(buildToolItem(buildCommand({ output, exit_code: 2 })).detail).toEqual({
        command: "ls",
        description: "List files",
        content: "a\nb\n",
        exitCode: 2,
      });
    });

    it("removes a header that a transcript step repeats", () => {
      const output = `${HEADER}${HEADER}Command exited with code 0.\n\nCommand output:\nSUBMARK\r\n`;
      expect(buildToolItem(buildCommand({ output })).detail).toMatchObject({
        content: "SUBMARK\n",
      });
    });

    it("shows no content for a command that printed nothing", () => {
      const output = `${HEADER}Command exited with code 0.\n\nNo output from the command.`;
      expect(buildToolItem(buildCommand({ output, exit_code: 0 })).detail).toEqual({
        command: "ls",
        description: "List files",
        exitCode: 0,
      });
    });

    it("keeps the truncation notice and removes the header after it", () => {
      const notice =
        "The tool's output was truncated due to being too long.\n\nHere is a preview with the middle of the output truncated:\n";
      const output = `${notice}${HEADER}Command exited with code 0.\n\nCommand output:\nhead\n<truncated>\ntail`;
      expect(buildToolItem(buildCommand({ output, exit_code: 0 })).detail).toMatchObject({
        content: `${notice}head\n<truncated>\ntail`,
      });
    });

    it("keeps text that has no header whole, and leaves out the exit code of a stopped command", () => {
      expect(buildToolItem(buildCommand({ output: "plain text" })).detail).toEqual({
        command: "ls",
        description: "List files",
        content: "plain text",
      });
    });

    it("shows no content when the output is an error string", () => {
      expect(buildToolItem(buildCommand("permission check failed")).detail).toEqual({
        command: "ls",
        description: "List files",
      });
    });

    it("cuts a command and its output to the message bound", () => {
      const long = "x".repeat(MAX_MESSAGE_LENGTH + 10);
      const item = buildToolItem({
        toolCallId: "c",
        name: "run_command",
        rawInput: { CommandLine: long },
        rawOutput: { output: long },
      });
      const detail = item.detail as { command: string; content: string };
      expect(detail.command).toHaveLength(MAX_MESSAGE_LENGTH);
      expect(detail.content).toHaveLength(MAX_MESSAGE_LENGTH);
    });
  });
});

describe("buildApprovalDescription", () => {
  it("follows the kind of the item", () => {
    expect(buildApprovalDescription(buildCommand())).toEqual({
      kind: "command_approval",
      detail: { command: "ls" },
    });
    expect(
      buildApprovalDescription({ toolCallId: "c", name: "edit_file", rawInput: { Path: "/w/a" } }),
    ).toEqual({ kind: "file_change_approval", detail: { paths: ["/w/a"] } });
    expect(
      buildApprovalDescription({ toolCallId: "c", name: "read_file", rawInput: { Path: "/w/a" } }),
    ).toEqual({ kind: "file_read_approval", detail: { paths: ["/w/a"] } });
    expect(buildApprovalDescription({ toolCallId: "c", name: "search_web" })).toEqual({
      kind: "tool_approval",
      detail: { toolName: "search_web" },
    });
  });

  it("lists no paths when the call has none, and names a tool that has no name by its title", () => {
    expect(buildApprovalDescription({ toolCallId: "c", name: "write_file" }).detail).toEqual({
      paths: [],
    });
    expect(buildApprovalDescription({ toolCallId: "c", title: "Ask" }).detail).toEqual({
      toolName: "Ask",
    });
  });
});
