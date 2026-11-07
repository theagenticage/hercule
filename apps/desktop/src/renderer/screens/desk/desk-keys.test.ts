import { describe, expect, it } from "vitest";
import { isUndoKey, type DeskKeyPress } from "./desk-keys";

const NO_MODIFIERS = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

/** Returns a key press of `key`, with the modifiers in `held` pressed. */
const press = (key: string, held: Partial<DeskKeyPress> = {}): DeskKeyPress => ({
  key,
  ...NO_MODIFIERS,
  ...held,
});

describe("isUndoKey", () => {
  it("is Z with ⌘ on a Mac and Z with Ctrl on Linux, and not the other platform's key", () => {
    expect(isUndoKey(press("z", { metaKey: true }), "mac")).toBe(true);
    expect(isUndoKey(press("z", { ctrlKey: true }), "linux")).toBe(true);
    expect(isUndoKey(press("z", { ctrlKey: true }), "mac")).toBe(false);
    expect(isUndoKey(press("z", { metaKey: true }), "linux")).toBe(false);
  });

  it("is not Z with Shift (redo) or Alt, or Z alone", () => {
    expect(isUndoKey(press("Z", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(isUndoKey(press("z", { metaKey: true, altKey: true }), "mac")).toBe(false);
    expect(isUndoKey(press("z"), "mac")).toBe(false);
  });
});
