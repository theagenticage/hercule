import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_FILTER_VALUES, MAX_PROVENANCE_APPEND, MAX_TASK_LABELS } from "../index";
import { TaskCreateInput, TaskFilter, TaskUpdateInput } from "./task";

const decodeOutcome = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag;

const buildLabels = (count: number) =>
  Array.from({ length: count }, (_, index) => `label-${String(index)}`);

describe("the bounds on a task's lists", () => {
  it("accepts a list at the cap, and rejects a list one longer", () => {
    expect(
      decodeOutcome(TaskCreateInput, {
        title: "t",
        description: "",
        labels: buildLabels(MAX_TASK_LABELS),
      }),
    ).toBe("Success");
    expect(
      decodeOutcome(TaskCreateInput, {
        title: "t",
        description: "",
        labels: buildLabels(MAX_TASK_LABELS + 1),
      }),
    ).toBe("Failure");
  });

  it("bounds both sides of a label edit", () => {
    expect(decodeOutcome(TaskUpdateInput, { addLabels: buildLabels(MAX_TASK_LABELS + 1) })).toBe(
      "Failure",
    );
    expect(decodeOutcome(TaskUpdateInput, { removeLabels: buildLabels(MAX_TASK_LABELS + 1) })).toBe(
      "Failure",
    );
  });

  it("bounds one call's provenance append", () => {
    const buildEntries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ref: `github:issue:owner/repo#${String(index)}`,
      }));
    expect(
      decodeOutcome(TaskUpdateInput, { provenance: buildEntries(MAX_PROVENANCE_APPEND) }),
    ).toBe("Success");
    expect(
      decodeOutcome(TaskUpdateInput, { provenance: buildEntries(MAX_PROVENANCE_APPEND + 1) }),
    ).toBe("Failure");
  });

  it("bounds every list of values a filter takes", () => {
    expect(decodeOutcome(TaskFilter, { labels: buildLabels(MAX_FILTER_VALUES + 1) })).toBe(
      "Failure",
    );
    expect(
      decodeOutcome(TaskFilter, {
        status: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "open"),
      }),
    ).toBe("Failure");
    expect(
      decodeOutcome(TaskFilter, {
        refs: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "github:issue:owner/repo#1"),
      }),
    ).toBe("Failure");
  });
});
