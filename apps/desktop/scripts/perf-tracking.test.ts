import { describe, expect, it } from "vitest";
import type { RecordedRequest, RecordedPush } from "./perf-collector.ts";
import { loadWithinBound, summarizeActivity } from "./perf-tracking.ts";

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
const snapshotRead = (): RecordedRequest => ({
  method: "GET",
  url: new URL("http://127.0.0.1/api/v1/tasks/tracking"),
  startedAtMs: 0,
  durationMs: 1,
  firstByteMs: 1,
  bodyBytes: 10,
});

describe("loadWithinBound", () => {
  it("refuses ten reads when ten topics sent a baseline but only task and run may re-read", () => {
    const load = summarizeActivity({
      requests: Array.from({ length: 10 }, snapshotRead),
      pushes: baselines,
    });
    expect(load.firstMessages).toBe(10);
    expect(loadWithinBound(load)).toBe(false);
  });

  it("accepts the start's three reads: one, and one for each of the task and run baselines", () => {
    const load = summarizeActivity({
      requests: Array.from({ length: 3 }, snapshotRead),
      pushes: baselines,
    });
    expect(loadWithinBound(load)).toBe(true);
  });

  it("refuses a start that read nothing", () => {
    expect(loadWithinBound(summarizeActivity({ requests: [], pushes: baselines }))).toBe(false);
  });
});
