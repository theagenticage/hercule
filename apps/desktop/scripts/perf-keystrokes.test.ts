import { describe, expect, it } from "vitest";
import { summarizeKeystrokeTasks } from "./perf-keystrokes.ts";

// Times are in the trace's microseconds. The keys' keydowns are at 1,000,
// 51,000 and 101,000.
const MARKS = [1_000, 51_000, 101_000];

describe("summarizeKeystrokeTasks", () => {
  it("gives the task that runs a keydown handler to that key, though it starts before the mark", () => {
    const summary = summarizeKeystrokeTasks(
      [
        { ts: 900, dur: 4_000 },
        { ts: 50_900, dur: 2_000 },
        { ts: 100_900, dur: 1_000 },
      ],
      MARKS,
    );
    expect(summary.meanBusyMs).toBeCloseTo((4 + 2 + 1) / 3);
    expect(summary.longestTaskMs).toBeCloseTo(4);
  });

  it("adds up the tasks that follow a keydown, such as the frame it causes, until the next keydown", () => {
    const summary = summarizeKeystrokeTasks(
      [
        { ts: 900, dur: 1_000 },
        { ts: 10_000, dur: 3_000 },
        { ts: 51_000, dur: 500 },
        { ts: 101_000, dur: 500 },
      ],
      MARKS,
    );
    expect(summary.meanBusyMs).toBeCloseTo((4 + 0.5 + 0.5) / 3);
    expect(summary.p95BusyMs).toBeCloseTo(4);
    expect(summary.longestTaskMs).toBeCloseTo(3);
  });

  it("leaves out a task that ended before the first keydown", () => {
    const summary = summarizeKeystrokeTasks([{ ts: 0, dur: 500 }], MARKS);
    expect(summary).toEqual({ meanBusyMs: 0, p95BusyMs: 0, longestTaskMs: 0 });
  });
});
