/**
 * Tests `createUndoStack`: that Undo reverses one gesture at a time, newest
 * first, and says why when a reversal fails; that a second Undo during a
 * running one is ignored; and that the stack is bounded and can be cleared.
 */
import { describe, expect, it } from "vitest";
import { createUndoStack, MAX_GESTURES, type Gesture } from "./undo-stack";

/** Builds a gesture that records its words in `log` when it is reversed. */
const buildGesture = (words: string, log: string[]): Gesture => ({
  words,
  undo: () => {
    log.push(words);
    return Promise.resolve();
  },
});

describe("createUndoStack", () => {
  it("reverses one gesture per undo, newest first", async () => {
    const log: string[] = [];
    const stack = createUndoStack();
    stack.push(buildGesture("Moved A", log));
    stack.push(buildGesture("Moved B", log));

    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved B" });
    expect(stack.peek()?.words).toBe("Moved A");
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
    expect(log).toEqual(["Moved B", "Moved A"]);
    expect(await stack.undo()).toEqual({ kind: "empty" });
    expect(stack.peek()).toBeNull();
  });

  it("says why a reversal failed, and drops that gesture", async () => {
    const stack = createUndoStack();
    stack.push({ words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) });

    expect(await stack.undo()).toEqual({
      kind: "failed",
      words: "Moved A",
      reason: "The Task is gone.",
    });
    expect(stack.peek()).toBeNull();
  });

  it("ignores an undo while another runs", async () => {
    const log: string[] = [];
    const stack = createUndoStack();
    let finish = (): void => {};
    stack.push(buildGesture("Moved A", log));
    stack.push({
      words: "Moved B",
      undo: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });

    const first = stack.undo();
    expect(await stack.undo()).toEqual({ kind: "busy" });
    expect(log).toEqual([]);
    finish();
    expect(await first).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("keeps the newest gestures only", async () => {
    const log: string[] = [];
    const stack = createUndoStack();
    for (let n = 0; n < MAX_GESTURES + 1; n += 1) stack.push(buildGesture(`Move ${n}`, log));

    for (let n = 0; n < MAX_GESTURES; n += 1) await stack.undo();
    expect(log.at(-1)).toBe("Move 1");
    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("tells subscribers about each change and about nothing after they stop", async () => {
    const stack = createUndoStack();
    let calls = 0;
    const stop = stack.subscribe(() => {
      calls += 1;
    });
    stack.push(buildGesture("Moved A", []));
    expect(calls).toBe(1);
    stack.clear();
    expect(calls).toBe(2);
    expect(stack.peek()).toBeNull();
    stack.clear();
    expect(calls).toBe(2);
    stop();
    stack.push(buildGesture("Moved B", []));
    expect(calls).toBe(2);
  });
});
