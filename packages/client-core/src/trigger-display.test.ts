import { describe, expect, it } from "vitest";
import type { EventWithFacts, Trigger } from "@hercule/contract";
import { isPausedWithHeldEvents } from "./spawn-bounds";
import { describeHeldEvents, describeTrigger } from "./trigger-display";

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

// The trigger's workflow: enabled and valid, so its triggers fire; disabled;
// and enabled but invalid. Only the last two stop its triggers firing.
const ENABLED = { enabled: true };
const DISABLED = { enabled: false };
const INVALID = { enabled: true, invalidSince: "2026-09-02T08:00:00.000Z" };

describe("describeTrigger", () => {
  it("reads a start trigger on any connection that can be paused", () => {
    expect(describeTrigger(ON_ISSUE, "UTC", ENABLED)).toEqual({
      mark: undefined,
      status: { text: "active", tone: "muted" },
      firesOn: "event",
      firesOnText: "github.issue.opened · any connection",
      nextFireText: undefined,
      bound: undefined,
      held: undefined,
      canDiscardHeldEvents: false,
      healthError: undefined,
      skippedTicksText: undefined,
      toggle: "pause",
      isPausedByBreaker: false,
    });
  });

  it("names one connection by its id's tail", () => {
    const on = { kind: "github.issue.opened", connectionId: CONNECTION_ID };
    expect(describeTrigger({ ...ON_ISSUE, on }, "UTC", ENABLED).firesOnText).toBe(
      "github.issue.opened · connection 22015952",
    );
  });

  it("shows only the event kind of a trigger on a kind the core emits", () => {
    expect(
      describeTrigger({ ...ON_ISSUE, on: { kind: "task.created" } }, "UTC", ENABLED).firesOnText,
    ).toBe("task.created");
  });

  it("reads a cron trigger's schedule and next fire time in the display timezone", () => {
    const reading = describeTrigger(WEEKDAYS, "Europe/Amsterdam", ENABLED);
    expect(reading.firesOn).toBe("schedule");
    expect(reading.firesOnText).toBe("0 9 * * 1-5");
    expect(reading.nextFireText).toBe("next 4 Sep 11:00");
  });

  it("shows the schedule's timezone beside the schedule", () => {
    const on = { schedule: "0 9 * * 1-5", timezone: "Europe/Amsterdam" };
    expect(describeTrigger({ ...WEEKDAYS, on }, "UTC", ENABLED).firesOnText).toBe(
      "0 9 * * 1-5 in Europe/Amsterdam",
    );
  });

  it("marks a paused trigger, shows its status as needing attention, and offers resume", () => {
    const reading = describeTrigger({ ...WEEKDAYS, status: "paused" }, "UTC", ENABLED);
    expect(reading.mark).toBe("paused");
    expect(reading.status).toEqual({ text: "paused manually", tone: "attn" });
    expect(reading.nextFireText).toBeUndefined();
    expect(reading.toggle).toBe("resume");
    expect(reading.isPausedByBreaker).toBe(false);
  });

  it("tells a trigger the breaker paused apart from one paused manually", () => {
    const reading = describeTrigger(
      { ...ON_ISSUE, status: "paused", pausedBy: "breaker" },
      "UTC",
      ENABLED,
    );
    expect(reading.mark).toBe("paused");
    expect(reading.status).toEqual({ text: "paused by the breaker", tone: "attn" });
    expect(reading.toggle).toBe("resume");
    expect(reading.isPausedByBreaker).toBe(true);
    const pausedManually = describeTrigger(
      { ...ON_ISSUE, status: "paused", pausedBy: "manual" },
      "UTC",
      ENABLED,
    );
    expect(pausedManually.status?.text).toBe("paused manually");
    expect(pausedManually.isPausedByBreaker).toBe(false);
  });

  it("reads how much of its spawn bound a start trigger used", () => {
    const hourly = { maxRuns: 30, windowSeconds: 3600, isDefault: true };
    expect(
      describeTrigger({ ...ON_ISSUE, spawnBound: hourly, runsInWindow: 12 }, "UTC", ENABLED).bound
        ?.text,
    ).toBe("12 of 30 per hour");
    // A trigger whose window holds no runs reports no count, which reads as 0.
    expect(describeTrigger({ ...ON_ISSUE, spawnBound: hourly }, "UTC", ENABLED).bound?.text).toBe(
      "0 of 30 per hour",
    );
    expect(describeTrigger(ON_REVIEW, "UTC", ENABLED).bound).toBeUndefined();
  });

  it("counts a paused trigger's held events and offers to discard them", () => {
    const tripped: Trigger = { ...ON_ISSUE, status: "paused", pausedBy: "breaker", heldCount: 45 };
    const reading = describeTrigger(tripped, "UTC", ENABLED);
    expect(reading.held).toEqual({
      countText: "45 held",
      nextText:
        "They start runs in order once you resume the trigger, as fast as the bound allows.",
    });
    expect(reading.canDiscardHeldEvents).toBe(true);
    expect(isPausedWithHeldEvents(tripped)).toBe(true);
  });

  it("counts an active trigger's held events as starting, with nothing to discard", () => {
    const draining: Trigger = { ...ON_ISSUE, heldCount: 3 };
    const reading = describeTrigger(draining, "UTC", ENABLED);
    expect(reading.held).toEqual({
      countText: "3 held",
      nextText: "They start runs in order, as fast as the bound allows.",
    });
    expect(reading.canDiscardHeldEvents).toBe(false);
    expect(isPausedWithHeldEvents(draining)).toBe(false);
  });

  it("shows no held events for a paused trigger that holds none", () => {
    const paused: Trigger = { ...ON_ISSUE, status: "paused", heldCount: 0 };
    expect(describeTrigger(paused, "UTC", ENABLED).held).toBeUndefined();
    expect(describeTrigger(paused, "UTC", ENABLED).canDiscardHeldEvents).toBe(false);
    expect(isPausedWithHeldEvents(paused)).toBe(false);
  });

  it("shows no next fire time while the workflow is disabled, and keeps the toggle", () => {
    const reading = describeTrigger(WEEKDAYS, "UTC", DISABLED);
    expect(reading.nextFireText).toBeUndefined();
    expect(reading.toggle).toBe("pause");
  });

  it("shows no next fire time while the workflow is invalid, and keeps the toggle", () => {
    const reading = describeTrigger(WEEKDAYS, "UTC", INVALID);
    expect(reading.nextFireText).toBeUndefined();
    expect(reading.toggle).toBe("pause");
  });

  it("says held events wait for the workflow while it is invalid or disabled", () => {
    const holding: Trigger = { ...ON_ISSUE, heldCount: 3 };
    expect(describeTrigger(holding, "UTC", INVALID).held?.nextText).toBe(
      "They start runs in order once the workflow is valid again, as fast as the bound allows.",
    );
    expect(describeTrigger(holding, "UTC", DISABLED).held?.nextText).toBe(
      "They start runs in order once the workflow is enabled again, as fast as the bound allows.",
    );
    // The workflow is named first: resuming a paused trigger of an invalid
    // workflow still starts no runs.
    expect(describeTrigger({ ...holding, status: "paused" }, "UTC", INVALID).held?.nextText).toBe(
      "They start runs in order once the workflow is valid again, as fast as the bound allows.",
    );
  });

  it("reads the error that stops the trigger matching, with when it happened", () => {
    const health = {
      state: "error",
      message: "No field labels",
      at: "2026-09-03T17:21:00.000Z",
    } as const;
    const reading = describeTrigger({ ...ON_ISSUE, health }, "UTC", ENABLED);
    expect(reading.mark).toBe("failed");
    expect(reading.healthError).toEqual({ message: "No field labels", atText: "3 Sep 17:21" });
    // A paused trigger shows the paused mark even while its filter fails.
    expect(describeTrigger({ ...ON_ISSUE, health, status: "paused" }, "UTC", ENABLED).mark).toBe(
      "paused",
    );
  });

  it("reads a stretch of missed scheduled times, and a single missed time", () => {
    const stretch = { from: "2026-09-02T09:00:00.000Z", until: "2026-09-03T09:00:00.000Z" };
    expect(
      describeTrigger({ ...WEEKDAYS, skippedTicks: stretch }, "UTC", ENABLED).skippedTicksText,
    ).toBe("Missed scheduled times from 2 Sep 09:00 to 3 Sep 09:00");
    const single = { from: stretch.from, until: stretch.from };
    expect(
      describeTrigger({ ...WEEKDAYS, skippedTicks: single }, "UTC", ENABLED).skippedTicksText,
    ).toBe("Missed the scheduled time 2 Sep 09:00");
  });

  it("offers no status and no toggle on a signal trigger", () => {
    const reading = describeTrigger(ON_REVIEW, "UTC", ENABLED);
    expect(reading.status).toBeUndefined();
    expect(reading.toggle).toBeUndefined();
  });
});

describe("describeHeldEvents", () => {
  const buildEvent = (id: number, title: string | null, author: string | null): EventWithFacts =>
    ({
      id,
      kind: "github.issue.opened",
      title,
      author,
      receivedAt: "2026-09-04T15:21:00.000Z",
    }) as never;

  it("lists the events with their titles, authors and received times, and counts the rest", () => {
    const events = [buildEvent(7, "Login fails on Safari", "marta"), buildEvent(8, null, null)];
    expect(describeHeldEvents(events, 45, "Europe/Amsterdam")).toEqual({
      rows: [
        {
          id: 7,
          title: "Login fails on Safari",
          isKindTitle: false,
          author: "marta",
          receivedText: "4 Sep 17:21",
        },
        // An event with no title is named by its kind.
        {
          id: 8,
          title: "github.issue.opened",
          isKindTitle: true,
          author: undefined,
          receivedText: "4 Sep 17:21",
        },
      ],
      moreText: "and 43 more",
    });
  });

  it("adds no count when every held event is listed", () => {
    expect(
      describeHeldEvents([buildEvent(7, "Login fails", null)], 1, "UTC").moreText,
    ).toBeUndefined();
  });
});
