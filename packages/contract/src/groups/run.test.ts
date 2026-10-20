import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_RUN_FILTER_TASK_IDS } from "../index";
import { RunFilter } from "./run";

const decodeOutcome = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(RunFilter)(input))._tag;

const buildTaskIds = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `01a06d02-7b00-7000-8000-${String(index).padStart(12, "0")}`,
  );

describe("the Task ids of a run filter", () => {
  it("accepts 100 ids, and rejects 101, because the ids travel in the request's address", () => {
    expect(MAX_RUN_FILTER_TASK_IDS).toBe(100);
    expect(decodeOutcome({ taskIds: buildTaskIds(MAX_RUN_FILTER_TASK_IDS) })).toBe("Success");
    expect(decodeOutcome({ taskIds: buildTaskIds(MAX_RUN_FILTER_TASK_IDS + 1) })).toBe("Failure");
  });
});
