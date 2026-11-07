import { describe, expect, it } from "vitest";
import { readBoardKey, type BoardKeyPress } from "./read-board-key";

const NO_MODIFIERS = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

/** Returns a key press of `key`, with the modifiers in `held` pressed. */
const press = (key: string, held: Partial<BoardKeyPress> = {}): BoardKeyPress => ({
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
    [press("f"), { kind: "fold-lane" }],
    [press("F", { shiftKey: true }), { kind: "fold-all-lanes" }],
    [press("/"), { kind: "find" }],
    [press("?", { shiftKey: true }), { kind: "toggle-keys-sheet" }],
    [press("Escape"), { kind: "step-back" }],
    [press("z", { metaKey: true }), { kind: "undo" }],
  ])("reads %j as %j on a Mac", (pressed, command) => {
    expect(readBoardKey(pressed, true, "mac")).toEqual(command);
  });

  it.each(["6", "0", "d", "m", "t", "x", "w", "Backspace", "Tab", "Delete"])(
    "does not use %s, which later slices own or nobody does",
    (key) => {
      expect(readBoardKey(press(key), true, "mac")).toBeNull();
    },
  );

  it("does not use Shift with the up and down arrows, or with a letter that is not F", () => {
    expect(readBoardKey(press("ArrowUp", { shiftKey: true }), true, "mac")).toBeNull();
    expect(readBoardKey(press("H", { shiftKey: true }), true, "mac")).toBeNull();
    expect(readBoardKey(press("A", { shiftKey: true }), true, "mac")).toBeNull();
  });

  it("turns off the keys that type a character with the single-keys switch, and no other", () => {
    const typed = ["h", "j", "k", "l", "[", "]", "1", "5", "a", "f", "/", "?"].map((key) =>
      press(key, { shiftKey: key === "?" }),
    );
    expect(typed.map((pressed) => readBoardKey(pressed, false, "mac"))).toEqual(
      typed.map(() => null),
    );
    expect(readBoardKey(press("F", { shiftKey: true }), false, "mac")).toBeNull();

    expect(readBoardKey(press("ArrowDown"), false, "mac")).toEqual({ kind: "walk", walk: "down" });
    expect(readBoardKey(press("ArrowRight", { shiftKey: true }), false, "mac")).toEqual({
      kind: "shift-stage",
      direction: 1,
    });
    expect(readBoardKey(press("Enter"), false, "mac")).toEqual({ kind: "open-card" });
    expect(readBoardKey(press(" "), false, "mac")).toEqual({ kind: "open-card" });
    expect(readBoardKey(press("Escape"), false, "mac")).toEqual({ kind: "step-back" });
    expect(readBoardKey(press("z", { metaKey: true }), false, "mac")).toEqual({ kind: "undo" });
  });

  it("keeps a single key with ⌘, Ctrl or Alt held for the app, and undoes only with the primary modifier", () => {
    for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(readBoardKey(press("a", held), true, "mac")).toBeNull();
      expect(readBoardKey(press("ArrowRight", held), true, "mac")).toBeNull();
    }
    // On a Mac Ctrl+Z is not undo, and on Linux ⌘Z is not.
    expect(readBoardKey(press("z", { ctrlKey: true }), true, "mac")).toBeNull();
    expect(readBoardKey(press("z", { metaKey: true }), true, "linux")).toBeNull();
    expect(readBoardKey(press("z", { ctrlKey: true }), true, "linux")).toEqual({ kind: "undo" });
    // Shift with Z is redo, which the board does not have.
    expect(readBoardKey(press("Z", { metaKey: true, shiftKey: true }), true, "mac")).toBeNull();
  });
});
