import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildStartMarkHook, trackShellProcess } from "./claude-code-edit-marks";
import type { EditMarks } from "./index";

/** Builds edit marks that record every start mark and every process start and end they get. */
const createEditMarks = () => {
  const calls: Array<string> = [];
  const editMarks: EditMarks = {
    sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
    recordToolStart: (toolUseId) => void calls.push(`mark:${toolUseId}`),
    recordProcessStart: (itemId) => void calls.push(`start:${itemId}`),
    recordProcessEnd: (itemId) => void calls.push(`end:${itemId}`),
    recordRequestOnRunningItem: () => {},
  };
  return { editMarks, calls };
};

/** Calls the gate the way the CLI calls a `PreToolUse` hook, and returns its answer. */
const callGate = (editMarks: EditMarks, toolName: string, agentId?: string) =>
  buildStartMarkHook(editMarks)(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {},
      tool_use_id: "toolu_01",
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      session_id: "native",
      transcript_path: "",
      cwd: "",
    },
    "toolu_01",
    { signal: new AbortController().signal },
  );

describe("the gate", () => {
  it("records the mark of a tool that can write files, whichever agent called it", async () => {
    const { editMarks, calls } = createEditMarks();
    expect(await callGate(editMarks, "Bash")).toEqual({});
    expect(await callGate(editMarks, "Edit", "a1b2c3")).toEqual({});
    expect(calls).toEqual(["mark:toolu_01", "mark:toolu_01"]);
  });

  it("records no mark for a tool that cannot write files", async () => {
    const { editMarks, calls } = createEditMarks();
    expect(await callGate(editMarks, "Read")).toEqual({});
    expect(calls).toEqual([]);
  });
});

const message = (fields: object) => ({ type: "system", ...fields }) as unknown as SDKMessage;

describe("shells", () => {
  /** Passes the messages to `trackShellProcess` in order, and returns the calls they made and the shells left running. */
  const track = (messages: ReadonlyArray<object>) => {
    const { editMarks, calls } = createEditMarks();
    const shells = new Map<string, string>();
    for (const fields of messages) trackShellProcess(editMarks, shells, message(fields));
    return { calls, shells };
  };
  const started = (taskId: string, toolUseId: string) => ({
    subtype: "task_started",
    task_id: taskId,
    task_type: "local_bash",
    tool_use_id: toolUseId,
  });

  it("reports every shell from its start to its task notification", () => {
    const { calls, shells } = track([
      started("b1", "toolu_bash"),
      { subtype: "task_notification", task_id: "b1", status: "completed" },
    ]);
    expect(calls).toEqual(["start:toolu_bash", "end:toolu_bash"]);
    expect(shells.size).toBe(0);
  });

  it("reports the end of a shell from a final status, once", () => {
    const { calls } = track([
      started("b2", "toolu_slow"),
      { subtype: "task_updated", task_id: "b2", patch: { is_backgrounded: true } },
      { subtype: "task_updated", task_id: "b2", patch: { status: "killed" } },
      // A notification after the final status finds no shell.
      { subtype: "task_notification", task_id: "b2" },
    ]);
    expect(calls).toEqual(["start:toolu_slow", "end:toolu_slow"]);
  });

  it("ignores tasks that are not shells, and shells it never saw start", () => {
    const { calls } = track([
      {
        subtype: "task_started",
        task_id: "agent1",
        task_type: "local_agent",
        tool_use_id: "toolu_task",
      },
      { subtype: "task_notification", task_id: "unknown", status: "completed" },
    ]);
    expect(calls).toEqual([]);
  });
});
