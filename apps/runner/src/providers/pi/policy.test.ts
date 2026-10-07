/**
 * Tests which tools each access mode parks and which it lets run. The table
 * below is the whole rule set. A wrong entry means a shell command runs that
 * the user wanted to review first, which is the one mistake in this adapter
 * that does real harm. The request kind a parked call opens is tested in
 * `approvals.test.ts`.
 *
 * That a full-access session runs with no approval hook at all can only partly
 * be tested. These tests check that the adapter passes the mode to pi, and
 * that a shell command on a full-access session is never parked. That the
 * extension registers no `tool_call` handler under full access is left to a
 * reviewer reading the extension source.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/protocol";
import { SUBAGENT_TOOL, SUBMIT_RESULT_TOOL } from "./extension";
import { requiresApproval } from "./policy";
import { cleanupHomes, settle, SPEC, startTestSession, filterByTag, waitUntil } from "./testing";

afterAll(cleanupHomes);

/**
 * pi 0.85.1's built-in tools, Hercule's `submit_result` and `subagent` tools,
 * and one tool that is not built in: it stands for an MCP tool or a tool a
 * later pi adds.
 */
type Tool =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "bash"
  | "powershell"
  | "write"
  | "edit"
  | "submit_result"
  | "subagent"
  | "mcp__jira__create";

/** True means the approval hook holds the call and asks; false means it lets the call run. */
const TABLE: Readonly<
  Record<"approval-required" | "auto-accept-edits" | "full-access", Readonly<Record<Tool, boolean>>>
> = {
  "approval-required": {
    read: false,
    grep: false,
    find: false,
    ls: false,
    bash: true,
    // PowerShell is a shell like bash, so the user is asked the same way.
    powershell: true,
    write: true,
    edit: true,
    // Hercule's own tool: recording the session's answer changes nothing, and
    // an unattended session has nobody to approve it.
    submit_result: false,
    // Hercule's own tool: starting a subagent changes nothing by itself, and
    // each of the subagent's own calls is asked about under the same mode.
    subagent: false,
    mcp__jira__create: true,
  },
  "auto-accept-edits": {
    read: false,
    grep: false,
    find: false,
    ls: false,
    bash: true,
    powershell: true,
    // The point of this mode: edits run without asking.
    write: false,
    edit: false,
    submit_result: false,
    subagent: false,
    mcp__jira__create: true,
  },
  "full-access": {
    read: false,
    grep: false,
    find: false,
    ls: false,
    bash: false,
    powershell: false,
    write: false,
    edit: false,
    submit_result: false,
    subagent: false,
    mcp__jira__create: false,
  },
};

describe("which tools each access mode parks", () => {
  for (const [mode, tools] of Object.entries(TABLE)) {
    for (const [tool, parks] of Object.entries(tools)) {
      it(`${parks ? "parks" : "runs"} ${tool} under ${mode}`, () => {
        expect(requiresApproval(mode as AccessMode, tool)).toBe(parks);
      });
    }
  }
});

describe("the submit_result tool", () => {
  for (const mode of Object.keys(TABLE) as ReadonlyArray<AccessMode>) {
    it(`runs without asking under ${mode}`, () => {
      // `requiresApproval` spells the tool name out itself, because it is
      // copied into the extension as source and cannot import anything. This
      // test checks that its spelling matches the registered tool name.
      expect(requiresApproval(mode, SUBMIT_RESULT_TOOL)).toBe(false);
    });
  }
});

describe("the subagent tool", () => {
  for (const mode of Object.keys(TABLE) as ReadonlyArray<AccessMode>) {
    it(`runs without asking under ${mode}`, () => {
      // Spelled out in `requiresApproval` for the same reason as
      // `submit_result`. This test checks that the spelling matches the
      // registered tool name.
      expect(requiresApproval(mode, SUBAGENT_TOOL)).toBe(false);
    });
  }
});

describe("the access mode a launched pi is given", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    it(`passes ${mode} to pi in its environment`, async () => {
      const run = await startTestSession({}, { ...SPEC, accessMode: mode });

      expect(run.child.env["HERCULE_ACCESS_MODE"]).toBe(mode);
    });
  }

  it("never parks a shell command on a full-access session", async () => {
    const run = await startTestSession({}, { ...SPEC, accessMode: "full-access" });

    run.child.push({ type: "agent_start" });
    run.child.push({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "rm -rf /tmp/scratch" },
    });
    await waitUntil(
      "reported the command",
      () => filterByTag(run.seen, "item.started").length === 1,
    );
    await settle();

    // No hook runs, so pi asks nothing and no card is docked on the composer.
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });
});
