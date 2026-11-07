/** Tests the words of Try again and of its Undo. */
import { describe, expect, it } from "vitest";
import { describeEndWhileTryingAgain, describeTryAgain, describeTryAgainUndo } from "./try-again";

describe("the words of Try again", () => {
  it("names the Task, in the past tense", () => {
    expect(describeTryAgain("Review PR")).toBe("Tried again on Review PR");
  });
});

describe("what Undo of Try again says", () => {
  it.each([
    ["the failure is back", { outcome: "restored", stopRequested: true }, { kind: "put-back" }],
    [
      "the run had ended",
      { outcome: "too-late", stopRequested: false },
      { kind: "stayed", reason: "The run had already ended, so nothing was put back." },
    ],
    [
      "something newer holds the Task, with the controller's reason",
      { outcome: "stopped", stopRequested: true, reason: "The Task is already done or dropped." },
      {
        kind: "stayed",
        reason: "The Task is already done or dropped. The run was asked to stop.",
      },
    ],
    [
      "something newer holds the Task, with no reason given",
      { outcome: "stopped", stopRequested: true },
      {
        kind: "stayed",
        reason:
          "Something newer holds this Task, so what it shows now stays. The run was asked to stop.",
      },
    ],
    [
      "a stop that was not asked for",
      { outcome: "stopped", stopRequested: false, reason: "The Task was deleted." },
      { kind: "stayed", reason: "The Task was deleted." },
    ],
  ] as const)("%s", (_name, answer, expected) => {
    expect(describeTryAgainUndo(answer)).toEqual(expected);
  });
});

describe("what Done and Drop say while Try again is starting", () => {
  it.each([
    [
      "done",
      "Review PR is starting again, so it cannot be marked Done yet. Try again in a moment.",
    ],
    ["dropped", "Review PR is starting again, so it cannot be Dropped yet. Try again in a moment."],
  ] as const)("refuses %s and says why", (stage, expected) => {
    expect(describeEndWhileTryingAgain("Review PR", stage)).toBe(expected);
  });
});
