/**
 * Tests `createUndoStack`: that Undo reverses one gesture at a time, newest
 * first, and says why when a reversal fails; that a second Undo during a
 * running one is ignored; that a gesture keeps the place it was reserved at, and leaves when its request holds nothing; that a
 * gesture is handed the page that is open when Undo is pressed; and that the
 * stack is bounded and can be cleared.
 */
import { describe, expect, it } from "vitest";
import { createUndoStack, MAX_GESTURES, type Gesture } from "./undo-stack";

/** A request that changed something that can be reversed. */
const SAVED = Promise.resolve(true);

/** The page the tests lend to a gesture. */
const PAGE = "the page that is open";

/** Builds a gesture that records its words in `log` when it is reversed. */
const buildGesture = (words: string, log: string[]): Gesture<string> => ({
  words,
  undo: () => {
    log.push(words);
    return Promise.resolve(undefined);
  },
});

describe("createUndoStack", () => {
  it("reverses one gesture per undo, newest first", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(buildGesture("Moved B", log), SAVED);

    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved A" });
    expect(log).toEqual(["Moved B", "Moved A"]);
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("says why a reversal failed, and drops that gesture", async () => {
    const stack = createUndoStack<string>();
    stack.reserve(
      { words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) },
      SAVED,
    );

    expect(await stack.undo(PAGE)).toEqual({
      kind: "failed",
      words: "Moved A",
      reason: "The Task is gone.",
    });
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("ignores an undo while another runs", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    let finish = (): void => {};
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(
      {
        words: "Moved B",
        undo: () =>
          new Promise((resolve) => {
            finish = () => {
              resolve(undefined);
            };
          }),
      },
      SAVED,
    );

    const first = stack.undo(PAGE);
    expect(await stack.undo(PAGE)).toEqual({ kind: "busy" });
    expect(log).toEqual([]);
    finish();
    expect(await first).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("keeps the newest gestures only", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    for (let n = 0; n < MAX_GESTURES + 1; n += 1)
      stack.reserve(buildGesture(`Move ${n}`, log), SAVED);

    for (let n = 0; n < MAX_GESTURES; n += 1) await stack.undo(PAGE);
    expect(log.at(-1)).toBe("Move 1");
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("keeps the order of the user's gestures when requests answer in another order", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    // Take A is still pending when the user makes Dismiss B, and B's request answers first.
    let answerA: (isHeld: boolean) => void = () => {};
    stack.reserve(
      buildGesture("Took on A", log),
      new Promise((resolve) => {
        answerA = resolve;
      }),
    );
    stack.reserve(buildGesture("Dismissed B", log), Promise.resolve(true));
    await Promise.resolve();
    answerA(true);
    await Promise.resolve();

    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Dismissed B" });
    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Took on A" });
  });

  it("takes a gesture off when its request holds nothing, without moving the others", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(buildGesture("Moved B", log), Promise.resolve(false));
    stack.reserve(buildGesture("Moved C", log), SAVED);
    await Promise.resolve();

    await stack.undo(PAGE);
    await stack.undo(PAGE);

    expect(log).toEqual(["Moved C", "Moved A"]);
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("does nothing for a request that holds nothing once an undo has taken its gesture", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    let answer: (isHeld: boolean) => void = () => {};
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(
      buildGesture("Moved B", log),
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    await stack.undo(PAGE);
    answer(false);
    await Promise.resolve();

    expect(log).toEqual(["Moved B"]);
    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("knows whether a page that undoes by itself is open", () => {
    const stack = createUndoStack<string>();
    expect(stack.hasOpenPage()).toBe(false);

    const leaveFirst = stack.registerOpenPage();
    const leaveSecond = stack.registerOpenPage();
    leaveFirst();
    leaveFirst();
    expect(stack.hasOpenPage()).toBe(true);
    leaveSecond();

    expect(stack.hasOpenPage()).toBe(false);
  });

  it("hands the gesture the page that is open when Undo is pressed, and passes on its note", async () => {
    const stack = createUndoStack<string>();
    const seen: string[] = [];
    stack.reserve(
      {
        words: "Moved A",
        undo: (page) => {
          seen.push(page);
          return Promise.resolve("It went last.");
        },
      },
      SAVED,
    );

    expect(await stack.undo("the page after a visit elsewhere")).toEqual({
      kind: "reversed",
      words: "Moved A",
      note: "It went last.",
    });
    expect(seen).toEqual(["the page after a visit elsewhere"]);
  });

  it("empties the stack on clear", async () => {
    const stack = createUndoStack<string>();
    stack.reserve(buildGesture("Moved A", []), SAVED);

    stack.clear();

    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });
});
