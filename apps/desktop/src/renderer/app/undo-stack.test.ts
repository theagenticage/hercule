/**
 * Tests `createUndoStack`: that Undo reverses one gesture at a time, newest
 * first, and says why when a reversal fails; that a second Undo during a
 * running one is ignored; that a gesture can be taken off the stack; that a
 * gesture is handed the page that is open when Undo is pressed; and that the
 * stack is bounded and can be cleared.
 */
import { describe, expect, it } from "vitest";
import { createUndoStack, MAX_GESTURES, type Gesture } from "./undo-stack";

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
    stack.push(buildGesture("Moved A", log));
    stack.push(buildGesture("Moved B", log));

    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo(PAGE)).toEqual({ kind: "reversed", words: "Moved A" });
    expect(log).toEqual(["Moved B", "Moved A"]);
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("says why a reversal failed, and drops that gesture", async () => {
    const stack = createUndoStack<string>();
    stack.push({ words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) });

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
    stack.push(buildGesture("Moved A", log));
    stack.push({
      words: "Moved B",
      undo: () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(undefined);
          };
        }),
    });

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
    for (let n = 0; n < MAX_GESTURES + 1; n += 1) stack.push(buildGesture(`Move ${n}`, log));

    for (let n = 0; n < MAX_GESTURES; n += 1) await stack.undo(PAGE);
    expect(log.at(-1)).toBe("Move 1");
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("takes a gesture off the stack wherever it is, and does nothing for one that is not there", async () => {
    const log: string[] = [];
    const stack = createUndoStack<string>();
    const first = buildGesture("Moved A", log);
    stack.push(first);
    stack.push(buildGesture("Moved B", log));
    stack.push(buildGesture("Moved C", log));

    stack.remove(first);
    stack.remove(first);
    await stack.undo(PAGE);
    await stack.undo(PAGE);

    expect(log).toEqual(["Moved C", "Moved B"]);
    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("hands the gesture the page that is open when Undo is pressed, and passes on its note", async () => {
    const stack = createUndoStack<string>();
    const seen: string[] = [];
    stack.push({
      words: "Moved A",
      undo: (page) => {
        seen.push(page);
        return Promise.resolve("It went last.");
      },
    });

    expect(await stack.undo("the page after a visit elsewhere")).toEqual({
      kind: "reversed",
      words: "Moved A",
      note: "It went last.",
    });
    expect(seen).toEqual(["the page after a visit elsewhere"]);
  });

  it("empties the stack on clear", async () => {
    const stack = createUndoStack<string>();
    stack.push(buildGesture("Moved A", []));

    stack.clear();

    expect(await stack.undo(PAGE)).toEqual({ kind: "empty" });
  });

  it("tells whether a gesture is still on the stack", async () => {
    const stack = createUndoStack<string>();
    const first = buildGesture("Moved A", []);
    const second = buildGesture("Moved B", []);
    const third = buildGesture("Moved C", []);
    stack.push(first);
    stack.push(second);
    stack.push(third);

    stack.remove(second);
    await stack.undo(PAGE);
    expect([stack.holds(first), stack.holds(second), stack.holds(third)]).toEqual([
      true,
      false,
      false,
    ]);

    stack.clear();
    expect(stack.holds(first)).toBe(false);
  });
});
