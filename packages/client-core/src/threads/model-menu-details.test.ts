/**
 * Tests the detail the model menu shows beside a row's name: "in pi" for an
 * entry in another harness, and "default" on the profile's default entry
 * unless it is the current one.
 */
import { describe, expect, it } from "vitest";
import { describeModelRow } from "./model-menu-details";

const ROW = { inHarness: null, isDefault: false, isCurrent: false };

describe("describeModelRow", () => {
  it("has no detail for an ordinary entry", () => {
    expect(describeModelRow(ROW)).toBeNull();
  });

  it("marks the profile's default entry", () => {
    expect(describeModelRow({ ...ROW, isDefault: true })).toBe("default");
  });

  it("names the harness of an entry that runs in another harness than its lane", () => {
    expect(describeModelRow({ ...ROW, inHarness: "pi" })).toBe("in pi");
    expect(describeModelRow({ ...ROW, inHarness: "pi", isDefault: true })).toBe("in pi · default");
  });

  it("leaves the default mark off the current entry, whose check mark already says it is in use", () => {
    expect(describeModelRow({ ...ROW, isDefault: true, isCurrent: true })).toBeNull();
    expect(describeModelRow({ ...ROW, inHarness: "pi", isDefault: true, isCurrent: true })).toBe(
      "in pi",
    );
  });
});
