/**
 * Tests that the truncation every adapter uses keeps a value within the
 * protocol's bound, marks a cut value as incomplete, and never cuts a
 * character in half.
 */
import { describe, expect, it } from "vitest";
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hercule/protocol";
import { truncateFact, truncateMessage } from "./text";

describe.each([
  { name: "truncateFact", truncate: truncateFact, maxLength: MAX_FACT_LENGTH },
  { name: "truncateMessage", truncate: truncateMessage, maxLength: MAX_MESSAGE_LENGTH },
])("$name", ({ truncate, maxLength }) => {
  it("keeps a value exactly as long as the bound", () => {
    const value = "a".repeat(maxLength);

    expect(truncate(value)).toBe(value);
  });

  it("marks a value one longer than the bound as cut, and keeps it within the bound", () => {
    const value = "a".repeat(maxLength + 1);

    expect(truncate(value)).toBe(`${"a".repeat(maxLength - 1)}…`);
  });

  it("drops a whole emoji rather than half of one when the cut falls inside it", () => {
    // The emoji is two code units, and the cut keeps maxLength - 1 of them,
    // so it would keep only the emoji's first half.
    const value = `${"a".repeat(maxLength - 2)}😀${"b".repeat(10)}`;

    expect(truncate(value)).toBe(`${"a".repeat(maxLength - 2)}…`);
  });
});
