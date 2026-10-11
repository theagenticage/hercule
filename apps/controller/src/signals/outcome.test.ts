import { describe, expect, it } from "vitest";
import { MAX_SIGNAL_OUTCOME_LENGTH } from "@hercule/contract";
import { truncateOutcome } from "./outcome";

describe("truncateOutcome", () => {
  it("keeps a line that fits, and cuts a longer one to the limit ending in an ellipsis", () => {
    expect(truncateOutcome("Merged")).toBe("Merged");
    const cut = truncateOutcome("x".repeat(MAX_SIGNAL_OUTCOME_LENGTH + 10));
    expect(cut).toHaveLength(MAX_SIGNAL_OUTCOME_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("never splits a character that takes two code units", () => {
    const line = `${"x".repeat(MAX_SIGNAL_OUTCOME_LENGTH - 2)}😀😀`;
    expect(truncateOutcome(line)).toBe(`${"x".repeat(MAX_SIGNAL_OUTCOME_LENGTH - 2)}…`);
  });
});
