import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { BoundOperation, MAX_BOUND_INPUT_DEPTH } from "./notification";

const decodeOutcome = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(BoundOperation)({ op: "task.update", input }))._tag;

/** Builds `{ "a": { "a": ... "x" } }`, nesting `levels` objects. */
const buildNestedInput = (levels: number): unknown =>
  levels === 0 ? "x" : { a: buildNestedInput(levels - 1) };

describe("the bound on a bound operation's nesting", () => {
  it("accepts an input nested as deep as the bound, and rejects one a level deeper", () => {
    expect(decodeOutcome(buildNestedInput(MAX_BOUND_INPUT_DEPTH))).toBe("Success");
    expect(decodeOutcome(buildNestedInput(MAX_BOUND_INPUT_DEPTH + 1))).toBe("Failure");
  });

  it("counts arrays as levels too", () => {
    const deep = JSON.parse(
      `${"[".repeat(MAX_BOUND_INPUT_DEPTH + 1)}"x"${"]".repeat(MAX_BOUND_INPUT_DEPTH + 1)}`,
    ) as unknown;
    expect(decodeOutcome(deep)).toBe("Failure");
  });
});
