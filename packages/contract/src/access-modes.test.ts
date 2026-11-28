/**
 * Tests the access mode names and the sentence that tells the user a session
 * runs in another mode than the one it asked for.
 */
import { describe, expect, it } from "vitest";
import { ACCESS_MODE_CHAIN, describeAccessModeFallback, formatAccessMode } from "./access-modes";

describe("formatAccessMode", () => {
  it("names each mode with the Bureau book's words", () => {
    expect(ACCESS_MODE_CHAIN.map(formatAccessMode)).toEqual([
      "Approval required",
      "Auto-accept edits",
      "Auto",
      "Full access",
    ]);
  });
});

describe("describeAccessModeFallback", () => {
  it("names the mode the session runs in and the mode it asked for", () => {
    expect(describeAccessModeFallback("auto", "auto-accept-edits")).toBe(
      "Runs in Auto-accept edits, because this harness does not support Auto.",
    );
  });
});
