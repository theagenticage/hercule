/**
 * Tests `buildWorkRows(items)`, which turns a work stretch's items into the
 * rows the desktop draws when the stretch's divider is open: one row per
 * step, with consecutive steps of a kind that folds grouped into one row.
 */
import { describe, expect, it } from "vitest";
import type { WorkItem } from "./blocks";
import { buildWorkRows } from "./work-rows";

let itemSeq = 0;

/** Builds a completed item of `kind` that started at 09:00 and returned nothing. */
const buildItem = (kind: WorkItem["kind"], fields: Partial<WorkItem> = {}): WorkItem => ({
  itemId: `i${itemSeq++}`,
  kind,
  verb: "verb",
  target: "",
  targetIsCode: false,
  result: "completed",
  paths: [],
  startedAt: "2026-09-30T09:00:00.000Z",
  toolName: "",
  resultContent: undefined,
  ...fields,
});

describe("buildWorkRows", () => {
  it.each([
    ["reasoning", "sparkle", "Thought"],
    ["command_execution", "terminal", "Ran"],
    ["file_change", "file", "Edited"],
    ["file_read", "eye", "Read"],
    ["file_search", "search", "Searched"],
    ["web_search", "globe", "Searched the web"],
    ["tool_call", "puzzle", "Used a tool"],
    ["subagent", "crew", "Subagent"],
    ["plan", "list", "Planned"],
    ["context_compaction", "more", "Compacted the context"],
    ["error", "close", "Error"],
    ["unknown", "more", "Step"],
  ] as const)("draws a single %s step with the %s icon and the label %s", (kind, icon, label) => {
    const [row] = buildWorkRows([buildItem(kind)]);

    expect(row).toMatchObject({ icon, label, steps: [] });
  });

  it("draws a single step with its key, target, start, result and output", () => {
    const item = buildItem("command_execution", {
      itemId: "c1",
      target: "pnpm test",
      targetIsCode: true,
      startedAt: "2026-09-30T09:00:05.000Z",
      result: "failed",
      resultContent: "1 test failed",
    });

    expect(buildWorkRows([item])).toEqual([
      {
        key: "row:c1",
        icon: "terminal",
        label: "Ran",
        target: "pnpm test",
        targetIsCode: true,
        startedAt: "2026-09-30T09:00:05.000Z",
        result: "failed",
        output: "1 test failed",
        steps: [],
        canOpen: true,
      },
    ]);
  });

  it("names no target for reasoning, whose detail is the thought itself", () => {
    const [row] = buildWorkRows([buildItem("reasoning", { target: "Let me look at the tests" })]);

    expect(row!.target).toBe("");
  });

  it("uses a tool's name as a tool call's label", () => {
    const rows = buildWorkRows([
      buildItem("tool_call", { toolName: "WebFetch", target: "https://example.com" }),
      buildItem("tool_call", { target: "something" }),
    ]);

    expect(rows.map((row) => [row.label, row.target])).toEqual([
      ["WebFetch", "https://example.com"],
      ["Used a tool", "something"],
    ]);
  });

  it("takes whether a step's target is code from the step", () => {
    const rows = buildWorkRows([
      buildItem("command_execution", { target: "ls", targetIsCode: true }),
      buildItem("web_search", { target: "stripe 3ds" }),
    ]);

    expect(rows.map((row) => row.targetIsCode)).toEqual([true, false]);
  });

  it("lets a step be opened only when it returned text", () => {
    const rows = buildWorkRows([
      buildItem("command_execution", { resultContent: "ok" }),
      buildItem("file_change", { resultContent: [{ type: "image" }] }),
      buildItem("plan"),
    ]);

    expect(rows.map((row) => row.canOpen)).toEqual([true, false, false]);
  });

  it.each([
    ["a string as it is", "a.ts\nb.ts", "a.ts\nb.ts"],
    [
      "the text blocks of a list, joined by line breaks",
      [
        { type: "text", text: "first" },
        { type: "image", source: {} },
        { type: "text", text: "second" },
      ],
      "first\nsecond",
    ],
    [
      "nothing from blocks that are null, have no text, or are not objects",
      [null, { type: "text" }, { type: "text", text: 7 }, "loose", { type: "text", text: "kept" }],
      "kept",
    ],
    ["nothing from any other value", 42, ""],
    ["nothing when the step returned nothing", undefined, ""],
  ] as const)("reads %s as a step's output", (_name, resultContent, output) => {
    const [row] = buildWorkRows([buildItem("command_execution", { resultContent })]);

    expect(row!.output).toBe(output);
  });

  it("cuts the output to 4096 characters, across text blocks", () => {
    const [row] = buildWorkRows([
      buildItem("command_execution", {
        resultContent: [
          { type: "text", text: "x".repeat(3000) },
          { type: "text", text: "y".repeat(3000) },
          { type: "text", text: "z" },
        ],
      }),
    ]);

    expect(row!.output).toBe(`${"x".repeat(3000)}\n${"y".repeat(1095)}`);
  });

  it("never cuts the output between the two halves of a character", () => {
    const [row] = buildWorkRows([
      buildItem("command_execution", { resultContent: `${"x".repeat(4095)}😀` }),
    ]);

    expect(row!.output).toBe("x".repeat(4095));
  });

  it("drops the broken half of a character the adapter's cut left at the end", () => {
    // The adapter cuts a string result to 4096 characters, which can split
    // the last character in two: here the emoji's second half is gone.
    const cutByAdapter = `${"x".repeat(4095)}😀`.slice(0, 4096);
    const [row] = buildWorkRows([buildItem("command_execution", { resultContent: cutByAdapter })]);

    expect(row!.output).toBe("x".repeat(4095));
  });

  it("cuts the output to 4096 characters when one text block is huge", () => {
    const huge = "y".repeat(1_000_000);
    const [row] = buildWorkRows([
      buildItem("command_execution", {
        resultContent: [
          { type: "text", text: "x".repeat(3000) },
          { type: "text", text: huge },
        ],
      }),
    ]);

    expect(row!.output).toHaveLength(4096);
  });

  it.each([
    ["command_execution", 3, "Ran 3 commands"],
    ["web_search", 2, "Searched the web 2 times"],
    ["file_read", 6, "Read 6 files"],
    ["file_search", 2, "Searched 2 times"],
  ] as const)("folds %s steps, %i in a row, into the group %s", (kind, count, label) => {
    const items = Array.from({ length: count }, () => buildItem(kind));

    const rows = buildWorkRows(items);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label, target: "", output: "", canOpen: true });
    expect(rows[0]!.steps.map((step) => step.key)).toEqual(
      items.map((item) => `step:${item.itemId}`),
    );
  });

  it("keys a group by its first step, and starts it when its first step started", () => {
    const rows = buildWorkRows([
      buildItem("command_execution", { itemId: "c1", startedAt: "2026-09-30T09:00:01.000Z" }),
      buildItem("command_execution", { itemId: "c2", startedAt: "2026-09-30T09:00:02.000Z" }),
    ]);

    expect(rows[0]).toMatchObject({ key: "row:c1", startedAt: "2026-09-30T09:00:01.000Z" });
  });

  it("keeps a row's key when a second step folds onto it, so an open row stays open", () => {
    const first = buildItem("command_execution", { itemId: "c1", resultContent: "ok" });
    const second = buildItem("command_execution", { itemId: "c2" });

    const [alone] = buildWorkRows([first]);
    const [group] = buildWorkRows([first, second]);

    expect(alone!.key).toBe("row:c1");
    expect(group!.key).toBe("row:c1");
    expect(group!.steps.map((step) => step.key)).toEqual(["step:c1", "step:c2"]);
  });

  it("counts the distinct files of a group of edits, plus one per edit that names none", () => {
    const rows = buildWorkRows([
      buildItem("file_change", { paths: ["src/a.ts"] }),
      buildItem("file_change", { paths: ["src/a.ts"] }),
      buildItem("file_change"),
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Edited 2 files"]);
  });

  it("counts the distinct files of a group of reads", () => {
    const rows = buildWorkRows([
      buildItem("file_read", { paths: ["src/a.ts"], target: "src/a.ts" }),
      buildItem("file_read", { paths: ["src/a.ts"], target: "src/a.ts" }),
      buildItem("file_read", { paths: ["src/b.ts"], target: "src/b.ts" }),
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Read 2 files"]);
    expect(rows[0]!.steps.map((step) => [step.label, step.target])).toEqual([
      ["Read", "src/a.ts"],
      ["Read", "src/a.ts"],
      ["Read", "src/b.ts"],
    ]);
  });

  it("folds tool calls only with calls of the same tool", () => {
    const rows = buildWorkRows([
      buildItem("tool_call", { toolName: "WebFetch" }),
      buildItem("tool_call", { toolName: "WebFetch" }),
      buildItem("tool_call", { toolName: "TodoWrite" }),
      buildItem("tool_call"),
      buildItem("tool_call"),
    ]);

    expect(rows.map((row) => row.label)).toEqual([
      "Used WebFetch 2 times",
      "TodoWrite",
      "Used a tool 2 times",
    ]);
  });

  it.each(["reasoning", "subagent", "plan", "context_compaction", "error", "unknown"] as const)(
    "never folds consecutive %s steps",
    (kind) => {
      const rows = buildWorkRows([buildItem(kind), buildItem(kind)]);

      expect(rows.map((row) => row.steps.length)).toEqual([0, 0]);
    },
  );

  it("ends a run where a step of another kind starts", () => {
    const rows = buildWorkRows([
      buildItem("command_execution"),
      buildItem("command_execution"),
      buildItem("file_change"),
      buildItem("command_execution"),
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Ran 2 commands", "Edited", "Ran"]);
  });

  it.each([
    [["completed", "running", "awaiting approval"], "awaiting approval"],
    [["failed", "running"], "running"],
    [["declined", "failed"], "failed"],
    [["completed", "declined"], "declined"],
    [["completed", "completed"], "completed"],
  ] as const)("gives a group of %j the result %s", (results, result) => {
    const rows = buildWorkRows(
      results.map((stepResult) => buildItem("command_execution", { result: stepResult })),
    );

    expect(rows[0]!.result).toBe(result);
  });
});
