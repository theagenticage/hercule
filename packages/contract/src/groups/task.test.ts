import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_FILTER_VALUES, MAX_PROVENANCE_APPEND, MAX_TASK_LABELS } from "../index";
import { TaskCreateInput, TaskFilter, TaskUpdateInput } from "./task";

const outcome = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag;

const labels = (count: number) =>
  Array.from({ length: count }, (_, index) => `label-${String(index)}`);

describe("the bounds on a task's lists", () => {
  it("takes a list at the cap and refuses the one past it", () => {
    expect(
      outcome(TaskCreateInput, { title: "t", description: "", labels: labels(MAX_TASK_LABELS) }),
    ).toBe("Success");
    expect(
      outcome(TaskCreateInput, {
        title: "t",
        description: "",
        labels: labels(MAX_TASK_LABELS + 1),
      }),
    ).toBe("Failure");
  });

  it("bounds both sides of a label edit", () => {
    expect(outcome(TaskUpdateInput, { addLabels: labels(MAX_TASK_LABELS + 1) })).toBe("Failure");
    expect(outcome(TaskUpdateInput, { removeLabels: labels(MAX_TASK_LABELS + 1) })).toBe("Failure");
  });

  it("bounds one call's provenance append", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ref: `github:issue:owner/repo#${String(index)}`,
      }));
    expect(outcome(TaskUpdateInput, { provenance: entries(MAX_PROVENANCE_APPEND) })).toBe(
      "Success",
    );
    expect(outcome(TaskUpdateInput, { provenance: entries(MAX_PROVENANCE_APPEND + 1) })).toBe(
      "Failure",
    );
  });

  it("bounds every any-of list a filter takes", () => {
    expect(outcome(TaskFilter, { labels: labels(MAX_FILTER_VALUES + 1) })).toBe("Failure");
    expect(
      outcome(TaskFilter, {
        status: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "open"),
      }),
    ).toBe("Failure");
    expect(
      outcome(TaskFilter, {
        refs: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "github:issue:owner/repo#1"),
      }),
    ).toBe("Failure");
  });
});
