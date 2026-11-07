import { describe, expect, it } from "vitest";
import type { DesktopPlatform } from "../../ipc/platform/desktop-platform";
import { describeUndoKey, isOtherModifierHeld, isPrimaryModifierHeld } from "./primary-modifier";

const WITH_COMMAND = { metaKey: true, ctrlKey: false };
const WITH_CONTROL = { metaKey: false, ctrlKey: true };
const WITH_NEITHER = { metaKey: false, ctrlKey: false };

describe("the primary modifier", () => {
  it.each<[DesktopPlatform, [boolean, boolean, boolean], [boolean, boolean, boolean]]>([
    // On a Mac, Ctrl is never the primary modifier: it edits text there.
    ["mac", [true, false, false], [false, true, false]],
    ["linux", [false, true, false], [true, false, false]],
  ])(
    "is held, and the other one is held, on %s for ⌘, Ctrl and neither",
    (platform, primary, other) => {
      const events = [WITH_COMMAND, WITH_CONTROL, WITH_NEITHER];
      expect(events.map((event) => isPrimaryModifierHeld(event, platform))).toEqual(primary);
      expect(events.map((event) => isOtherModifierHeld(event, platform))).toEqual(other);
    },
  );
});

describe("describeUndoKey", () => {
  it("reads ⌘Z on a Mac and Ctrl Z on Linux", () => {
    expect(describeUndoKey("mac")).toBe("⌘Z");
    expect(describeUndoKey("linux")).toBe("Ctrl Z");
  });
});
