import { describe, expect, it } from "vitest";
import { buildPrimaryModifier } from "./primary-modifier";

const WITH_COMMAND = { metaKey: true, ctrlKey: false };
const WITH_CONTROL = { metaKey: false, ctrlKey: true };
const WITH_NEITHER = { metaKey: false, ctrlKey: false };

describe("buildPrimaryModifier", () => {
  it("makes ⌘ the primary modifier on a Mac, and never Ctrl, which edits text there", () => {
    const modifier = buildPrimaryModifier("mac");
    expect([WITH_COMMAND, WITH_CONTROL, WITH_NEITHER].map(modifier.isHeld)).toEqual([
      true,
      false,
      false,
    ]);
    expect([WITH_COMMAND, WITH_CONTROL, WITH_NEITHER].map(modifier.isOtherHeld)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("makes Ctrl the primary modifier on Linux", () => {
    const modifier = buildPrimaryModifier("linux");
    expect([WITH_COMMAND, WITH_CONTROL, WITH_NEITHER].map(modifier.isHeld)).toEqual([
      false,
      true,
      false,
    ]);
    expect([WITH_COMMAND, WITH_CONTROL, WITH_NEITHER].map(modifier.isOtherHeld)).toEqual([
      true,
      false,
      false,
    ]);
  });
});
