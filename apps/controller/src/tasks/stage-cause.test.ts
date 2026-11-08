/** Tests the words of a stage cause: one row for each lifecycle change and each fallback. */
import { describe, expect, it } from "vitest";
import { MAX_STAGE_CAUSE_TEXT, type EntityLifecycle } from "@hercule/contract";
import { describeStageCause, type StageCauseThing } from "./stage-cause";

const pullRequest = (overrides: Partial<StageCauseThing> = {}): StageCauseThing => ({
  noun: "Pull request",
  identifier: "#6221",
  lifecycle: "open",
  statusWord: "Open",
  ...overrides,
});

describe("describeStageCause", () => {
  it.each<
    [string, EntityLifecycle, EntityLifecycle | null, StageCauseThing | undefined, expected: string]
  >([
    ["a thing seen open", "open", null, pullRequest(), "Pull request #6221 opened"],
    ["a thing open again", "open", "completed", pullRequest(), "Pull request #6221 reopened"],
    [
      "a thing open after being abandoned",
      "open",
      "abandoned",
      pullRequest(),
      "Pull request #6221 reopened",
    ],
    [
      "a thing open again with nothing changed",
      "open",
      "open",
      pullRequest(),
      "Pull request #6221 opened",
    ],
    [
      "completed, with the status word the thing still holds",
      "completed",
      "open",
      pullRequest({ lifecycle: "completed", statusWord: "Merged" }),
      "Pull request #6221 merged",
    ],
    [
      "completed, but the thing moved on since",
      "completed",
      "open",
      pullRequest({ lifecycle: "open", statusWord: "Open" }),
      "Pull request #6221 completed",
    ],
    [
      "completed, with a thing that has no status",
      "completed",
      "open",
      pullRequest({ lifecycle: "completed", statusWord: null }),
      "Pull request #6221 completed",
    ],
    [
      "abandoned, with the status word the thing still holds",
      "abandoned",
      "open",
      pullRequest({ lifecycle: "abandoned", statusWord: "Closed" }),
      "Pull request #6221 closed",
    ],
    [
      "abandoned, but the thing moved on since",
      "abandoned",
      "open",
      pullRequest({ lifecycle: "completed", statusWord: "Merged" }),
      "Pull request #6221 closed",
    ],
    [
      "a thing without an identifier",
      "completed",
      null,
      pullRequest({ identifier: null, lifecycle: "completed", statusWord: "Done" }),
      "Pull request done",
    ],
    ["a thing whose record is gone", "completed", "open", undefined, "A linked thing completed"],
  ])("%s", (_name, lifecycle, previousLifecycle, thing, expected) => {
    expect(describeStageCause({ lifecycle, previousLifecycle, thing })).toBe(expected);
  });

  it("cuts a long text to the most the card holds", () => {
    const text = describeStageCause({
      lifecycle: "open",
      previousLifecycle: null,
      thing: pullRequest({ identifier: `#${"word ".repeat(60)}` }),
    });
    expect(text.length).toBeLessThanOrEqual(MAX_STAGE_CAUSE_TEXT);
    expect(text.endsWith("…")).toBe(true);
  });
});
