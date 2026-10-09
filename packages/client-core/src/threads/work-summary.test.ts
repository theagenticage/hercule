/**
 * Tests the words on a work stretch's divider:
 *
 * - `summarizeWork(items)` counts the stretch's items by kind;
 * - `describeWorkStretch(block, now)` returns "Working for" or "Worked for";
 * - `describePending(since, now)` returns "Working for" or "Starting…".
 */
import { describe, expect, it } from "vitest";
import type { WorkBlock, WorkItem } from "./blocks";
import { describePending, describeWorkStretch, summarizeWork } from "./work-summary";

let itemSeq = 0;

/** Builds a completed item of `kind`, touching `paths` when it is a file change. */
const buildItem = (kind: WorkItem["kind"], paths: readonly string[] = []): WorkItem => ({
  itemId: `i${itemSeq++}`,
  kind,
  paths,
  verb: "verb",
  target: "",
  result: "completed",
});

/** Builds `count` items of `kind`. */
const buildItems = (kind: WorkItem["kind"], count: number): WorkItem[] =>
  Array.from({ length: count }, () => buildItem(kind));

describe("summarizeWork", () => {
  it.each([
    ["command_execution", 1, "ran 1 command"],
    ["command_execution", 2, "ran 2 commands"],
    ["file_change", 1, "edited 1 file"],
    ["file_change", 3, "edited 3 files"],
    ["web_search", 1, "searched the web"],
    ["web_search", 2, "searched the web 2 times"],
    ["tool_call", 1, "used 1 tool"],
    ["tool_call", 6, "used 6 tools"],
    ["subagent", 1, "ran 1 subagent"],
    ["subagent", 2, "ran 2 subagents"],
    ["plan", 1, "made a plan"],
    ["plan", 2, "made 2 plans"],
    ["context_compaction", 1, "compacted the context"],
    ["context_compaction", 2, "compacted the context 2 times"],
    ["error", 1, "hit 1 error"],
    ["error", 2, "hit 2 errors"],
    ["unknown", 1, "did 1 other step"],
    ["unknown", 2, "did 2 other steps"],
  ] as const)("counts %s items %i time(s) as %s", (kind, count, phrase) => {
    expect(summarizeWork(buildItems(kind, count))).toEqual([phrase]);
  });

  it("lists the kinds in the order each first appears", () => {
    const items = [
      buildItem("tool_call"),
      buildItem("command_execution"),
      buildItem("tool_call"),
      buildItem("file_change"),
      buildItem("command_execution"),
    ];

    expect(summarizeWork(items)).toEqual(["used 2 tools", "ran 2 commands", "edited 1 file"]);
  });

  it("leaves reasoning out", () => {
    const items = [buildItem("reasoning"), buildItem("command_execution"), buildItem("reasoning")];

    expect(summarizeWork(items)).toEqual(["ran 1 command"]);
  });

  it("counts distinct files where the changes name them, and each change that names none", () => {
    const items = [
      buildItem("file_change", ["src/a.ts"]),
      buildItem("file_change", ["src/a.ts"]),
      buildItem("file_change", ["src/b.ts", "src/c.ts"]),
      buildItem("file_change"),
    ];

    expect(summarizeWork(items)).toEqual(["edited 4 files"]);
  });
});

describe("describeWorkStretch", () => {
  const STARTED_AT = "2026-09-30T09:00:00.000Z";

  const buildBlock = (endedAt: string | null): WorkBlock => ({
    kind: "work",
    key: "work:c1",
    turnId: "t1",
    items: [buildItem("command_execution")],
    startedAt: STARTED_AT,
    endedAt,
  });

  it("counts a running stretch from its start to now", () => {
    expect(describeWorkStretch(buildBlock(null), Date.parse(STARTED_AT) + 12_000)).toBe(
      "Working for 12s",
    );
  });

  it("gives a closed stretch its length, whatever the time now", () => {
    const block = buildBlock("2026-09-30T09:02:14.000Z");

    expect(describeWorkStretch(block, Date.parse(STARTED_AT) + 3_600_000)).toBe(
      "Worked for 2m 14s",
    );
  });
});

describe("describePending", () => {
  const SINCE = "2026-09-30T09:00:00.000Z";

  it("counts the wait from its start to now", () => {
    expect(describePending(SINCE, Date.parse(SINCE) + 12_000)).toBe("Working for 12s");
  });

  it("reads Starting… while no turn has started", () => {
    expect(describePending(null, Date.parse(SINCE))).toBe("Starting…");
  });
});
