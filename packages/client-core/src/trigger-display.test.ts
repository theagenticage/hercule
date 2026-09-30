import { describe, expect, it } from "vitest";
import type { Trigger } from "@hercule/contract";
import { describeTrigger } from "./trigger-display";

const CONNECTION_ID = "01a06d02-beff-7037-9f5b-042822015952";

/** A signal trigger: it has no status and no health, because it cannot be paused. */
const ON_REVIEW: Trigger = {
  workflowId: "01a06d02-beff-7037-9f5b-0428220159aa",
  workflowName: "triage",
  triggerId: "on_review",
  kind: "signal",
  on: { kind: "github.pull_request.reviewed", connectionId: "any" },
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

const ON_ISSUE: Trigger = {
  ...ON_REVIEW,
  triggerId: "on_issue",
  kind: "start",
  on: { kind: "github.issue.opened", connectionId: "any" },
  status: "active",
  health: { state: "ok" },
};

/** A cron trigger. It fires on a schedule, so it names no event kind and no Connection. */
const WEEKDAYS: Trigger = {
  workflowId: ON_ISSUE.workflowId,
  workflowName: ON_ISSUE.workflowName,
  triggerId: "weekdays",
  kind: "start",
  on: { schedule: "0 9 * * 1-5" },
  status: "active",
  health: { state: "ok" },
  nextFireAt: "2026-09-04T09:00:00.000Z",
  createdAt: ON_ISSUE.createdAt,
  updatedAt: ON_ISSUE.updatedAt,
};

describe("describeTrigger", () => {
  it("reads a start trigger on any connection that can be paused", () => {
    expect(describeTrigger(ON_ISSUE, "UTC", true)).toEqual({
      mark: undefined,
      status: { text: "active", tone: "muted" },
      firesOn: "event",
      firesOnText: "github.issue.opened · any connection",
      nextFireText: undefined,
      healthError: undefined,
      skippedTicksText: undefined,
      toggle: "pause",
    });
  });

  it("names one connection by its id's tail", () => {
    const on = { kind: "github.issue.opened", connectionId: CONNECTION_ID };
    expect(describeTrigger({ ...ON_ISSUE, on }, "UTC", true).firesOnText).toBe(
      "github.issue.opened · connection 22015952",
    );
  });

  it("shows only the event kind of a trigger on a kind the core emits", () => {
    expect(
      describeTrigger({ ...ON_ISSUE, on: { kind: "task.created" } }, "UTC", true).firesOnText,
    ).toBe("task.created");
  });

  it("reads a cron trigger's schedule and next fire time in the display timezone", () => {
    const reading = describeTrigger(WEEKDAYS, "Europe/Amsterdam", true);
    expect(reading.firesOn).toBe("schedule");
    expect(reading.firesOnText).toBe("0 9 * * 1-5");
    expect(reading.nextFireText).toBe("next 4 Sep 11:00");
  });

  it("shows the schedule's timezone beside the schedule", () => {
    const on = { schedule: "0 9 * * 1-5", timezone: "Europe/Amsterdam" };
    expect(describeTrigger({ ...WEEKDAYS, on }, "UTC", true).firesOnText).toBe(
      "0 9 * * 1-5 in Europe/Amsterdam",
    );
  });

  it("marks a paused trigger, shows its status as needing attention, and offers resume", () => {
    const reading = describeTrigger({ ...WEEKDAYS, status: "paused" }, "UTC", true);
    expect(reading.mark).toBe("paused");
    expect(reading.status).toEqual({ text: "paused", tone: "attn" });
    expect(reading.nextFireText).toBeUndefined();
    expect(reading.toggle).toBe("resume");
  });

  it("shows no next fire time while the workflow is disabled, and keeps the toggle", () => {
    const reading = describeTrigger(WEEKDAYS, "UTC", false);
    expect(reading.nextFireText).toBeUndefined();
    expect(reading.toggle).toBe("pause");
  });

  it("reads the error that stops the trigger matching, with when it happened", () => {
    const health = {
      state: "error",
      message: "No field labels",
      at: "2026-09-03T17:21:00.000Z",
    } as const;
    const reading = describeTrigger({ ...ON_ISSUE, health }, "UTC", true);
    expect(reading.mark).toBe("failed");
    expect(reading.healthError).toEqual({ message: "No field labels", atText: "3 Sep 17:21" });
    // A paused trigger shows the paused mark even while its filter fails.
    expect(describeTrigger({ ...ON_ISSUE, health, status: "paused" }, "UTC", true).mark).toBe(
      "paused",
    );
  });

  it("reads a stretch of missed scheduled times, and a single missed time", () => {
    const stretch = { from: "2026-09-02T09:00:00.000Z", until: "2026-09-03T09:00:00.000Z" };
    expect(
      describeTrigger({ ...WEEKDAYS, skippedTicks: stretch }, "UTC", true).skippedTicksText,
    ).toBe("Missed scheduled times from 2 Sep 09:00 to 3 Sep 09:00");
    const single = { from: stretch.from, until: stretch.from };
    expect(
      describeTrigger({ ...WEEKDAYS, skippedTicks: single }, "UTC", true).skippedTicksText,
    ).toBe("Missed the scheduled time 2 Sep 09:00");
  });

  it("offers no status and no toggle on a signal trigger", () => {
    const reading = describeTrigger(ON_REVIEW, "UTC", true);
    expect(reading.status).toBeUndefined();
    expect(reading.toggle).toBeUndefined();
  });
});
