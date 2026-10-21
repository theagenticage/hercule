import { describe, expect, it } from "vitest";
import type { RecordedRequest, RecordedPush } from "./perf-collector.ts";
import {
  isLoadWithinBound,
  summarizeActivity,
  isYourWorkLoadWithinBound,
} from "./perf-tracking.ts";

const TOPICS = [
  "task",
  "run",
  "session",
  "signal",
  "workflow",
  "connection",
  "notification",
  "runner",
  "workspace",
  "plugin",
];
const baselines: RecordedPush[] = TOPICS.map((topic) => ({ topic, initial: true }));
const readOf = (url: string): RecordedRequest => ({
  method: "GET",
  url: new URL(url),
  startedAtMs: 0,
  durationMs: 1,
  firstByteMs: 1,
  bodyBytes: 10,
});
const snapshotRead = (): RecordedRequest => readOf("http://127.0.0.1/api/v1/tasks/tracking");
const yourWorkRead = (): RecordedRequest => readOf("http://127.0.0.1/api/v1/signals/your-work");
const toDoRead = (): RecordedRequest => readOf("http://127.0.0.1/api/v1/signals?view=to-do");

describe("isLoadWithinBound", () => {
  it("refuses ten reads when ten topics sent a baseline but only task and run may re-read", () => {
    const load = summarizeActivity({
      requests: Array.from({ length: 10 }, snapshotRead),
      pushes: baselines,
    });
    expect(load.firstMessages).toBe(10);
    expect(isLoadWithinBound(load)).toBe(false);
  });

  it("accepts the start's three reads: one, and one for each of the task and run baselines", () => {
    const load = summarizeActivity({
      requests: Array.from({ length: 3 }, snapshotRead),
      pushes: baselines,
    });
    expect(isLoadWithinBound(load)).toBe(true);
  });

  it("refuses a start that read nothing", () => {
    expect(isLoadWithinBound(summarizeActivity({ requests: [], pushes: baselines }))).toBe(false);
  });
});

describe("summarizeActivity", () => {
  it("counts Your work's read and To do apart from Tracking's read and the other reads", () => {
    const load = summarizeActivity({
      requests: [
        snapshotRead(),
        yourWorkRead(),
        yourWorkRead(),
        toDoRead(),
        readOf("http://127.0.0.1/api/v1/tasks?status=open"),
        readOf("http://127.0.0.1/api/v1/signals?view=later&limit=1"),
      ],
      pushes: [],
    });
    expect(load).toMatchObject({
      snapshots: 1,
      yourWorkReads: 2,
      toDoReads: 1,
      otherReads: 1,
    });
    expect(load.yourWorkTiming).toContain("signal.queryYourWork median");
  });

  it("does not let Your work's reads count as other reads at the start", () => {
    const load = summarizeActivity({
      requests: [snapshotRead(), yourWorkRead()],
      pushes: baselines,
    });
    expect(isLoadWithinBound(load)).toBe(true);
  });
});

describe("isYourWorkLoadWithinBound", () => {
  const loadWith = (yourWorkReads: number) =>
    summarizeActivity({
      requests: Array.from({ length: yourWorkReads }, yourWorkRead),
      pushes: [],
    });

  it("accepts the read of the start, and one more for each of the task and signal topics' first messages", () => {
    for (const reads of [1, 2, 3]) expect(isYourWorkLoadWithinBound(loadWith(reads))).toBe(true);
  });

  it("refuses a start that read Your work too few or too many times", () => {
    expect(isYourWorkLoadWithinBound(loadWith(0))).toBe(false);
    expect(isYourWorkLoadWithinBound(loadWith(4))).toBe(false);
  });
});
