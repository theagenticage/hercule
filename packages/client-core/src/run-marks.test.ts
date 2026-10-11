import { assert, describe, it } from "vitest";
import { hasRunMark, type RunMarkState } from "./run-marks";

describe("hasRunMark", () => {
  it("gives a mark to every state but a cancelled run and one that has not started", () => {
    const states: ReadonlyArray<RunMarkState> = [
      "waiting",
      "working",
      "done",
      "failed",
      "cancelled",
      "starting",
    ];
    assert.deepStrictEqual(
      states.filter((state) => hasRunMark(state)),
      ["waiting", "working", "done", "failed"],
    );
  });
});
