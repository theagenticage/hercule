/**
 * Which tools each access mode parks, and which it lets through. The table is
 * the whole criterion: a wrong entry here is a shell command run that the user
 * asked to review first, which is the one failure in this adapter that costs
 * something. What a parked call is then asked as is the adapter's, and is
 * covered in `approvals.test.ts`.
 *
 * The second half - that a full-access session runs with no approval hook at
 * all - is only partly reachable from a test. What is asserted is what the
 * adapter does with the mode: it tells the launched pi which mode it is under,
 * and a full-access session that runs a shell command is never parked. That the
 * extension's full-access branch registers no `tool_call` handler is left to a
 * reviewer reading the extension source.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AccessMode } from "@hydra/protocol";
import { SUBMIT_RESULT_TOOL } from "./extension";
import { requiresApproval } from "./policy";
import { cleanupHomes, settle, SPEC, started, taggedIn, until } from "./testing";

afterAll(cleanupHomes);

/**
 * pi 0.85.1's own built-ins, Hydra's own tool for a session's answer, and one
 * name from no built-in at all: an MCP tool or a tool a later pi adds is the
 * case the catch-all rows are about.
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
  | "mcp__jira__create";

/** True is a call the approval hook holds and asks about; false is one it lets run. */
const TABLE: Readonly<
  Record<"approval-required" | "auto-accept-edits" | "full-access", Readonly<Record<Tool, boolean>>>
> = {
  "approval-required": {
    read: false,
    grep: false,
    find: false,
    ls: false,
    bash: true,
    // The same shell on another machine, and the same question to the user.
    powershell: true,
    write: true,
    edit: true,
    // Hydra's own: recording the answer the session was asked for touches
    // nothing, and an unattended session has nobody to approve it.
    submit_result: false,
    mcp__jira__create: true,
  },
  "auto-accept-edits": {
    read: false,
    grep: false,
    find: false,
    ls: false,
    bash: true,
    powershell: true,
    // The mode's whole point: edits land without being asked about.
    write: false,
    edit: false,
    submit_result: false,
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
    mcp__jira__create: false,
  },
};

describe("which tools an access mode parks", () => {
  for (const [mode, tools] of Object.entries(TABLE)) {
    for (const [tool, parks] of Object.entries(tools)) {
      it(`${parks ? "parks" : "runs"} ${tool} under ${mode}`, () => {
        expect(requiresApproval(mode as AccessMode, tool)).toBe(parks);
      });
    }
  }
});

describe("Hydra's own tool for a session's answer", () => {
  for (const mode of Object.keys(TABLE) as ReadonlyArray<AccessMode>) {
    it(`runs it unasked under ${mode}`, () => {
      // The name is spelled a second time inside `requiresApproval`, which
      // closes over nothing so that it can be interpolated into the extension;
      // this is what holds that spelling to the one the tool is registered
      // under. An unattended session has nobody to approve its own answer.
      expect(requiresApproval(mode, SUBMIT_RESULT_TOOL)).toBe(false);
    });
  }
});

describe("what a launched pi is told about its access mode", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    it(`launches a ${mode} session under that mode`, async () => {
      const run = await started({}, { ...SPEC, accessMode: mode });

      expect(run.child.env["HYDRA_ACCESS_MODE"]).toBe(mode);
    });
  }

  it("never parks a shell command on a full-access session", async () => {
    const run = await started({}, { ...SPEC, accessMode: "full-access" });

    run.child.push({ type: "agent_start" });
    run.child.push({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "rm -rf /tmp/scratch" },
    });
    await until("reported the command", () => taggedIn(run.seen, "item.started").length === 1);
    await settle();

    // No hook runs, so pi asks nothing and nothing is docked on the composer.
    expect(taggedIn(run.seen, "request.opened")).toEqual([]);
  });
});
