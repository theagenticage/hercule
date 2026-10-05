import { describe, expect, it } from "vitest";
import { addUsageSnapshot, clearProcessShare } from "./usage";

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
