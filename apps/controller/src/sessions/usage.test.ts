import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { addUsageSnapshot, addUsageReport, buildUsageFields, clearProcessShare } from "./usage";

describe("addUsageSnapshot", () => {
  it("starts the total at the first snapshot", () => {
    expect(
      addUsageSnapshot(
        { usage: undefined, usageProcess: undefined },
        { inputTokens: 10, outputTokens: 2 },
      ),
    ).toEqual({
      usage: { inputTokens: 10, outputTokens: 2 },
      usageProcess: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("replaces the current process's share as its snapshot grows", () => {
    const first = addUsageSnapshot(
      { usage: undefined, usageProcess: undefined },
      { inputTokens: 10, outputTokens: 2, costUsd: 0.1 },
    );
    const second = addUsageSnapshot(first, { inputTokens: 25, outputTokens: 5, costUsd: 0.3 });
    expect(second.usage).toEqual({ inputTokens: 25, outputTokens: 5, costUsd: 0.3 });
  });

  it("adds a new process's count to what earlier processes used", () => {
    // A resume clears the process's share, and the new process counts from 0.
    const earlier = { usage: { inputTokens: 25, outputTokens: 5 }, usageProcess: undefined };
    const resumed = addUsageSnapshot(earlier, { inputTokens: 4, outputTokens: 1 });
    expect(resumed.usage).toEqual({ inputTokens: 29, outputTokens: 6 });
    expect(addUsageSnapshot(resumed, { inputTokens: 10, outputTokens: 3 }).usage).toEqual({
      inputTokens: 35,
      outputTokens: 8,
    });
  });

  it("keeps an optional count absent until a snapshot reports it", () => {
    const stored = { usage: { inputTokens: 1, outputTokens: 1 }, usageProcess: undefined };
    expect(addUsageSnapshot(stored, { inputTokens: 2, outputTokens: 2 }).usage).not.toHaveProperty(
      "cacheReadTokens",
    );
    expect(
      addUsageSnapshot(stored, { inputTokens: 2, outputTokens: 2, cacheReadTokens: 7 }).usage,
    ).toEqual({ inputTokens: 3, outputTokens: 3, cacheReadTokens: 7 });
  });

  it("never lowers the total when a snapshot leaves out a count it reported before", () => {
    const first = addUsageSnapshot(
      { usage: undefined, usageProcess: undefined },
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 40, costUsd: 0.5 },
    );
    const silent = addUsageSnapshot(first, { inputTokens: 12, outputTokens: 3 });
    expect(silent.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 40,
      costUsd: 0.5,
    });
    // The share carried forward is what the next snapshot replaces.
    expect(silent.usageProcess).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 40,
      costUsd: 0.5,
    });
    const next = addUsageSnapshot(silent, {
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 60,
      costUsd: 0.7,
    });
    expect(next.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 60,
      costUsd: 0.7,
    });
  });
});

describe("clearProcessShare", () => {
  it("keeps the total and clears the process's share", () => {
    const usage = { inputTokens: 5, outputTokens: 1 };
    expect(clearProcessShare({ usage, usageProcess: usage })).toEqual({
      usage,
      usageProcess: undefined,
    });
  });
});

describe("incomplete lifetime token accounting", () => {
  it("preserves known totals and the missing interval over later exact reports and a resume", () => {
    const earlier = addUsageSnapshot(
      { usage: undefined, usageProcess: undefined },
      { inputTokens: 100, outputTokens: 10 },
    );
    const partial = addUsageReport(clearProcessShare(earlier), {
      status: "incomplete",
      counts: { inputTokens: 0, outputTokens: 0 },
    });
    expect(partial.usage).toEqual({ inputTokens: 100, outputTokens: 10, incomplete: true });
    const recovered = addUsageReport(partial, {
      status: "complete",
      counts: { inputTokens: 20, outputTokens: 2 },
    });
    expect(recovered.usage).toEqual({ inputTokens: 120, outputTokens: 12, incomplete: true });
    const resumed = addUsageReport(clearProcessShare(recovered), {
      status: "complete",
      counts: { inputTokens: 5, outputTokens: 1 },
    });
    expect(buildUsageFields(resumed.usage)).toEqual({
      usageReport: {
        status: "incomplete",
        counts: { inputTokens: 125, outputTokens: 13 },
      },
    });
    expect(resumed.usageProcess).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it("projects unchanged historical counts as exact and an absent count as absent", () => {
    expect(buildUsageFields({ inputTokens: 12, outputTokens: 3 })).toEqual({
      usage: { inputTokens: 12, outputTokens: 3 },
      usageReport: { status: "complete", counts: { inputTokens: 12, outputTokens: 3 } },
    });
    expect(buildUsageFields(undefined)).toEqual({});
  });
});

it("keeps incomplete counts unavailable to a legacy HTTP decoder", () => {
  const legacyRecord = Schema.Struct({
    usage: Schema.optionalKey(
      Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }),
    ),
  });
  const record = buildUsageFields({ inputTokens: 100, outputTokens: 10, incomplete: true });
  expect(Schema.decodeUnknownSync(legacyRecord)(record)).toEqual({});
});
