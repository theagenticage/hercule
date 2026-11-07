/**
 * Tests `createUndoStack`: that Undo reverses one gesture at a time, newest
 * first, and says why when a reversal fails; that a second Undo during a
 * running one is ignored; that a gesture keeps the place it was reserved at,
 * and leaves when its request holds nothing; that Undo goes through the
 * registered page, else the fallback, which are handed to the gesture and told
 * what happened; and that the stack is bounded and can be cleared.
 */
import { describe, expect, it } from "vitest";
import {
  createUndoStack,
  MAX_GESTURES,
  type Gesture,
  type UndoAdapter,
  type UndoReport,
  type UndoStack,
} from "./undo-stack";

/** A request that changed something that can be reversed. */
const SAVED = Promise.resolve(true);

/** The page the tests lend to a gesture. */
const PAGE = "the page that is open";

/** Builds an adapter that lends `page` and records what it is told in `reports`. */
const buildAdapter = (page: string, reports: UndoReport[] = []): UndoAdapter<string> => ({
  buildPage: () => page,
  report: (report) => reports.push(report),
});

/** Creates a stack whose fallback lends `PAGE`. */
const createStack = (): UndoStack<string> => {
  const stack = createUndoStack<string>();
  stack.registerFallback(buildAdapter(PAGE));
  return stack;
};

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
    const stack = createStack();
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(buildGesture("Moved B", log), SAVED);

    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
    expect(log).toEqual(["Moved B", "Moved A"]);
    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("says why a reversal failed, and drops that gesture", async () => {
    const stack = createStack();
    stack.reserve(
      { words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) },
      SAVED,
    );

    expect(await stack.undo()).toEqual({
      kind: "failed",
      words: "Moved A",
      reason: "The Task is gone.",
    });
    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("ignores an undo while another runs", async () => {
    const log: string[] = [];
    const stack = createStack();
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

    const first = stack.undo();
    expect(await stack.undo()).toEqual({ kind: "busy" });
    expect(log).toEqual([]);
    finish();
    expect(await first).toEqual({ kind: "reversed", words: "Moved B" });
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("keeps the newest gestures only", async () => {
    const log: string[] = [];
    const stack = createStack();
    for (let n = 0; n < MAX_GESTURES + 1; n += 1)
      stack.reserve(buildGesture(`Move ${n}`, log), SAVED);

    for (let n = 0; n < MAX_GESTURES; n += 1) await stack.undo();
    expect(log.at(-1)).toBe("Move 1");
    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("keeps the order of the user's gestures when requests answer in another order", async () => {
    const log: string[] = [];
    const stack = createStack();
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

    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Dismissed B" });
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Took on A" });
  });

  it("takes a gesture off when its request holds nothing, without moving the others", async () => {
    const log: string[] = [];
    const stack = createStack();
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(buildGesture("Moved B", log), Promise.resolve(false));
    stack.reserve(buildGesture("Moved C", log), SAVED);
    await Promise.resolve();

    await stack.undo();
    await stack.undo();

    expect(log).toEqual(["Moved C", "Moved A"]);
    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("does nothing for a request that holds nothing once an undo has taken its gesture", async () => {
    const log: string[] = [];
    const stack = createStack();
    let answer: (isHeld: boolean) => void = () => {};
    stack.reserve(buildGesture("Moved A", log), SAVED);
    stack.reserve(
      buildGesture("Moved B", log),
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    await stack.undo();
    answer(false);
    await Promise.resolve();

    expect(log).toEqual(["Moved B"]);
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("undoes through the registered page, which is handed to the gesture and told what happened", async () => {
    const stack = createStack();
    const reports: UndoReport[] = [];
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
    stack.registerPage(buildAdapter("the page that is open now", reports));

    expect(await stack.undo()).toEqual({
      kind: "reversed",
      words: "Moved A",
      note: "It went last.",
    });
    expect(seen).toEqual(["the page that is open now"]);
    expect(reports).toEqual([{ text: "Put back: Moved A. It went last.", isFailure: false }]);
  });

  it("goes back to the fallback when the page leaves, and a page that was replaced leaves quietly", async () => {
    const stack = createStack();
    const olderReports: UndoReport[] = [];
    const newerReports: UndoReport[] = [];
    const leaveOlder = stack.registerPage(buildAdapter("older", olderReports));
    const leaveNewer = stack.registerPage(buildAdapter("newer", newerReports));
    stack.reserve(buildGesture("Moved A", []), SAVED);
    stack.reserve(buildGesture("Moved B", []), SAVED);
    stack.reserve(buildGesture("Moved C", []), SAVED);

    leaveOlder();
    await stack.undo();
    leaveNewer();
    await stack.undo();

    expect(newerReports).toHaveLength(1);
    expect(olderReports).toEqual([]);
    expect(await stack.undo()).toMatchObject({ kind: "reversed", words: "Moved A" });
  });

  it("does nothing while the page is paused", async () => {
    const log: string[] = [];
    const stack = createStack();
    const reports: UndoReport[] = [];
    let isPaused = true;
    stack.registerPage({ ...buildAdapter(PAGE, reports), isPaused: () => isPaused });
    stack.reserve(buildGesture("Moved A", log), SAVED);

    expect(await stack.undo()).toEqual({ kind: "busy" });
    expect(log).toEqual([]);
    expect(reports).toEqual([]);

    isPaused = false;
    expect(await stack.undo()).toEqual({ kind: "reversed", words: "Moved A" });
  });

  it("empties the stack on clear", async () => {
    const stack = createStack();
    stack.reserve(buildGesture("Moved A", []), SAVED);

    stack.clear();

    expect(await stack.undo()).toEqual({ kind: "empty" });
  });

  it("tells whether a gesture is still on the stack", async () => {
    const stack = createStack();
    const first = buildGesture("Moved A", []);
    const second = buildGesture("Moved B", []);
    const third = buildGesture("Moved C", []);
    stack.reserve(first, SAVED);
    stack.reserve(second, SAVED);
    stack.reserve(third, SAVED);

    stack.remove(second);
    await stack.undo();
    expect([stack.holds(first), stack.holds(second), stack.holds(third)]).toEqual([
      true,
      false,
      false,
    ]);

    stack.clear();
    expect(stack.holds(first)).toBe(false);
  });
});
