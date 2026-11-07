import { describe, expect, it } from "vitest";
import type { DeskKeyPress } from "../desk/desk-keys";
import { readBoardKey } from "./read-board-key";

const NO_MODIFIERS = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

/** Returns a key press of `key`, with the modifiers in `held` pressed. */
const press = (key: string, held: Partial<DeskKeyPress> = {}): DeskKeyPress => ({
  key,
  ...NO_MODIFIERS,
  ...held,
});

describe("readBoardKey", () => {
  it.each([
    [press("ArrowUp"), { kind: "walk", walk: "up" }],
    [press("ArrowLeft"), { kind: "walk", walk: "left" }],
    [press("h"), { kind: "walk", walk: "left" }],
    [press("j"), { kind: "walk", walk: "down" }],
    [press("k"), { kind: "walk", walk: "up" }],
    [press("l"), { kind: "walk", walk: "right" }],
    [press("["), { kind: "walk", walk: "previousLane" }],
    [press("]"), { kind: "walk", walk: "nextLane" }],
    [press("Enter"), { kind: "open-card" }],
    [press(" "), { kind: "open-card" }],
    [press("ArrowLeft", { shiftKey: true }), { kind: "shift-stage", direction: -1 }],
    [press("ArrowRight", { shiftKey: true }), { kind: "shift-stage", direction: 1 }],
    [press("1"), { kind: "pick-stage", stage: "exploring" }],
    [press("5"), { kind: "pick-stage", stage: "landed" }],
    [press("a"), { kind: "add" }],
    [press("d"), { kind: "end", stage: "done" }],
    [press("Backspace"), { kind: "end", stage: "dropped" }],
    [press("Delete"), { kind: "end", stage: "dropped" }],
    [press("t"), { kind: "start-thread" }],
    [press("m"), { kind: "merge" }],
    [press("x"), { kind: "select" }],
    [press("X", { shiftKey: true }), null],
    [press("f"), { kind: "fold-lane" }],
    [press("F", { shiftKey: true }), { kind: "fold-all-lanes" }],
    [press("/"), { kind: "find" }],
    [press("?", { shiftKey: true }), { kind: "toggle-keys-sheet" }],
    [press("Escape"), { kind: "step-back" }],
  ])("reads %j as %j", (pressed, command) => {
    expect(readBoardKey(pressed, true)).toEqual(command);
  });

  it.each(["6", "0", "w", "Tab"])(
    "does not use %s, which later slices own or nobody does",
    (key) => {
      expect(readBoardKey(press(key), true)).toBeNull();
    },
  );

  it("does not use Shift with the up and down arrows, or with a letter that is not F", () => {
    expect(readBoardKey(press("ArrowUp", { shiftKey: true }), true)).toBeNull();
    expect(readBoardKey(press("H", { shiftKey: true }), true)).toBeNull();
    expect(readBoardKey(press("A", { shiftKey: true }), true)).toBeNull();
  });

  it("turns off the keys that type a character with the single-keys switch, and no other", () => {
    const typed = [
      "h",
      "j",
      "k",
      "l",
      "[",
      "]",
      "1",
      "5",
      "a",
      "d",
      "t",
      "m",
      "x",
      "Backspace",
      "Delete",
      "f",
      "/",
      "?",
    ].map((key) => press(key, { shiftKey: key === "?" }));
    expect(typed.map((pressed) => readBoardKey(pressed, false))).toEqual(typed.map(() => null));
    expect(readBoardKey(press("F", { shiftKey: true }), false)).toBeNull();

    expect(readBoardKey(press("ArrowDown"), false)).toEqual({ kind: "walk", walk: "down" });
    expect(readBoardKey(press("ArrowRight", { shiftKey: true }), false)).toEqual({
      kind: "shift-stage",
      direction: 1,
    });
    expect(readBoardKey(press("Enter"), false)).toEqual({ kind: "open-card" });
    expect(readBoardKey(press(" "), false)).toEqual({ kind: "open-card" });
    expect(readBoardKey(press("Escape"), false)).toEqual({ kind: "step-back" });
  });

  it("does not drop a card for Shift and Backspace", () => {
    expect(readBoardKey(press("Backspace", { shiftKey: true }), true)).toBeNull();
  });

  it("keeps a key with ⌘, Ctrl or Alt held for the app, Undo's included", () => {
    for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(readBoardKey(press("a", held), true)).toBeNull();
      expect(readBoardKey(press("ArrowRight", held), true)).toBeNull();
      expect(readBoardKey(press("z", held), true)).toBeNull();
    }
  });
});
