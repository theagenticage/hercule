import { describe, expect, it } from "vitest";
import type { DeskKeyPress } from "../desk/desk-keys";
import { readInboxKey } from "./read-inbox-key";

const NO_MODIFIERS = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

/** Returns a key press of `key`, with the modifiers in `held` pressed. */
const press = (key: string, held: Partial<DeskKeyPress> = {}): DeskKeyPress => ({
  key,
  ...NO_MODIFIERS,
  ...held,
});

describe("readInboxKey", () => {
  it.each([
    [press("ArrowUp"), { kind: "walk", walk: "up" }],
    [press("ArrowDown"), { kind: "walk", walk: "down" }],
    [press("ArrowLeft"), { kind: "walk", walk: "left" }],
    [press("ArrowRight"), { kind: "walk", walk: "right" }],
    [press("j"), { kind: "walk", walk: "next" }],
    [press("k"), { kind: "walk", walk: "previous" }],
    [press("Enter"), { kind: "open" }],
    [press(" "), { kind: "open" }],
    [press("h"), { kind: "hand" }],
    [press("1"), { kind: "pick-workflow", position: 1 }],
    [press("3"), { kind: "pick-workflow", position: 3 }],
    [press("t"), { kind: "take" }],
    [press("e"), { kind: "dismiss" }],
    [press("g"), { kind: "see-task" }],
    [press("?", { shiftKey: true }), { kind: "toggle-keys-sheet" }],
    [press("Escape"), { kind: "step-back" }],
  ])("reads %j as %j", (pressed, command) => {
    expect(readInboxKey(pressed)).toEqual(command);
  });

  it.each(["l", "d", "x", "0", "4", "Tab", "Backspace"])(
    "does not use %s, which later slices own or nobody does",
    (key) => {
      expect(readInboxKey(press(key))).toBeNull();
    },
  );

  it("leaves a key to the app or the system when ⌘, Ctrl or Alt is held, Undo's included", () => {
    expect(readInboxKey(press("z", { metaKey: true }))).toBeNull();
    expect(readInboxKey(press("z", { ctrlKey: true }))).toBeNull();
    expect(readInboxKey(press("t", { metaKey: true }))).toBeNull();
    expect(readInboxKey(press("e", { ctrlKey: true }))).toBeNull();
    expect(readInboxKey(press("g", { altKey: true }))).toBeNull();
    expect(readInboxKey(press("z", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(readInboxKey(press("T", { shiftKey: true }))).toBeNull();
    expect(readInboxKey(press("ArrowDown", { shiftKey: true }))).toBeNull();
  });
});
