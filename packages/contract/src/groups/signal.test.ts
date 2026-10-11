import { Cause, Exit, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { listDecodeIssues } from "../errors";
import { MAX_BOUND_INPUT_BYTES } from "./notification";
import {
  Block,
  MAX_CHECK_LOG_LINES,
  MAX_SIGNAL_BLOCKS,
  MAX_SIGNAL_BYTES,
  MAX_TEXT_BLOCK_LENGTH,
  SignalActInput,
  SignalRaiseInput,
} from "./signal";
import { decodeWorkflowDefinition } from "./workflow-definition";

/** Decodes a value with a schema, and returns the issues, or an empty list when it fits. */
const listIssues = (schema: Schema.Decoder<unknown>, value: unknown) => {
  const exit = Schema.decodeUnknownExit(schema)(value);
  return Exit.isSuccess(exit)
    ? []
    : listDecodeIssues(Cause.squash(exit.cause) as Schema.SchemaError);
};

const FYI = {
  kind: "fyi",
  title: "Release 4.2 shipped",
  reason: "Tagged and published by the release workflow",
  eventIds: [81234],
};

const TASK = { title: "Fix the flaky login test", description: "" };

describe("a block", () => {
  it("accepts a block type this contract does not know, so an older client still reads it", () => {
    expect(listIssues(Block, { type: "calendar", day: "2026-10-12" })).toEqual([]);
  });

  it("refuses a known block that breaks its limits, rather than reading it as unknown", () => {
    const issues = listIssues(Block, {
      type: "text",
      markdown: "x".repeat(MAX_TEXT_BLOCK_LENGTH + 1),
    });
    expect(issues.map((issue) => issue.path)).toEqual([["markdown"], ["type"]]);
  });

  it("refuses a check log longer than its line limit", () => {
    const log = Array.from({ length: MAX_CHECK_LOG_LINES + 1 }, () => "line").join("\n");
    const issues = listIssues(Block, {
      type: "checks",
      rows: [{ name: "test", state: "failed", log }],
      passed: 0,
      omitted: 0,
    });
    expect(issues).toEqual([
      {
        path: ["rows", "0", "log"],
        message: `The log has more than ${MAX_CHECK_LOG_LINES} lines. Keep its last ${MAX_CHECK_LOG_LINES} lines.`,
      },
      { path: ["type"], message: "The checks block does not fit its schema." },
    ]);
  });
});

describe("raising a signal", () => {
  it("accepts an FYI with text blocks", () => {
    expect(
      listIssues(SignalRaiseInput, {
        ...FYI,
        blocks: [{ type: "text", markdown: "Notes are on the tag." }],
      }),
    ).toEqual([]);
  });

  it("accepts a proposal that carries its task", () => {
    expect(listIssues(SignalRaiseInput, { ...FYI, kind: "proposal", task: TASK })).toEqual([]);
  });

  it("refuses a plugin's kind, which is raised only from its events", () => {
    expect(listIssues(SignalRaiseInput, { ...FYI, kind: "github/review-requested" })).toEqual([
      {
        path: ["kind"],
        message:
          '"github/review-requested" cannot be raised. Raise one of: proposal, offer, unsure, fyi. A plugin\'s kind is raised only from its events.',
      },
    ]);
  });

  it("refuses the urgent priority", () => {
    expect(listIssues(SignalRaiseInput, { ...FYI, priority: "urgent" })).toEqual([
      { path: ["priority"], message: "A raised signal cannot be urgent. Use high, normal or low." },
    ]);
  });

  it("refuses a block type this contract does not know", () => {
    expect(
      listIssues(SignalRaiseInput, { ...FYI, blocks: [{ type: "calendar", day: "2026-10-12" }] }),
    ).not.toEqual([]);
  });

  it("refuses a proposal without its task", () => {
    expect(listIssues(SignalRaiseInput, { ...FYI, kind: "proposal" })).toEqual([
      { path: ["task"], message: "A proposal needs task: the Task that Accept creates." },
    ]);
  });

  it("refuses a proposal with actions of its own", () => {
    const actions = [{ id: "ok", label: "OK", operation: null }];
    expect(listIssues(SignalRaiseInput, { ...FYI, kind: "proposal", task: TASK, actions })).toEqual(
      [
        {
          path: ["actions"],
          message:
            "A proposal takes no actions of its own: the core adds Accept and Dismiss. Leave out actions, or raise an offer instead.",
        },
      ],
    );
  });

  it("refuses a task on any kind but a proposal", () => {
    expect(listIssues(SignalRaiseInput, { ...FYI, task: TASK })).toEqual([
      {
        path: ["task"],
        message:
          "Only a proposal carries task. Leave out task, or raise a proposal instead of fyi.",
      },
    ]);
  });

  it("refuses an action with an id only the core uses", () => {
    const actions = ["done", "accept", "dismiss", "hand-to-mine"].map((id) => ({
      id,
      label: `Label of ${id}`,
      operation: null,
    }));
    expect(
      listIssues(SignalRaiseInput, { ...FYI, kind: "offer", actions }).map((issue) => issue.path),
    ).toEqual([
      ["actions", "0", "id"],
      ["actions", "1", "id"],
      ["actions", "2", "id"],
      ["actions", "3", "id"],
    ]);
  });

  it("refuses a proposal whose task is larger than Accept may bind", () => {
    const task = { title: "Fix it", description: "x".repeat(MAX_BOUND_INPUT_BYTES) };
    expect(
      listIssues(SignalRaiseInput, { ...FYI, kind: "proposal", task }).map((issue) => issue.path),
    ).toEqual([["task"]]);
  });

  it("refuses a signal larger than a signal may be, even when each block fits", () => {
    const blocks = Array.from({ length: MAX_SIGNAL_BLOCKS }, () => ({
      type: "text",
      markdown: "x".repeat(MAX_TEXT_BLOCK_LENGTH),
    }));
    expect(listIssues(SignalRaiseInput, { ...FYI, blocks })).toEqual([
      {
        path: [],
        message: `The signal is larger than ${MAX_SIGNAL_BYTES} bytes of JSON. Shorten its blocks, and link to the source for the rest.`,
      },
    ]);
  });
});

describe("taking a signal's action", () => {
  it("refuses done, which has its own operation", () => {
    expect(listIssues(SignalActInput, { actionId: "done" })).toEqual([
      {
        path: ["actionId"],
        message: "Done is not taken with signal.act. Call signal.markDone instead.",
      },
    ]);
  });

  it("accepts an action with a typed reply", () => {
    expect(listIssues(SignalActInput, { actionId: "reply", text: "Thanks" })).toEqual([]);
  });
});

describe("a workflow input that takes a signal", () => {
  const define = (input: Record<string, unknown>) =>
    decodeWorkflowDefinition({
      name: "Review",
      inputs: [{ name: "item", required: true, ...input }],
      steps: [{ id: "start", kind: "action", action: "task.create" }],
    });

  it("accepts a list of signal kinds", () => {
    expect(Result.isSuccess(define({ signal: { kinds: ["github/review-requested"] } }))).toBe(true);
  });

  it("refuses an empty list of kinds", () => {
    expect(Result.isFailure(define({ signal: { kinds: [] } }))).toBe(true);
  });

  it("refuses the proposal kind", () => {
    expect(Result.isFailure(define({ signal: { kinds: ["proposal"] } }))).toBe(true);
  });

  it("refuses an input that sets two types", () => {
    const result = define({ schema: { type: "string" }, signal: { kinds: ["fyi"] } });
    expect(Result.isFailure(result)).toBe(true);
  });
});
