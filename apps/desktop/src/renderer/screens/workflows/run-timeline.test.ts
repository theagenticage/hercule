import { describe, expect, it } from "vitest";
import type { RunSummary, Trigger, WorkflowDefinition } from "@hercule/contract";
import {
  buildTimelineAxis,
  buildTimelineBars,
  computeTimelineDay,
  computeTimelineReadRange,
  type TimelineDay,
  type TimelineRecords,
} from "./run-timeline";

// Tuesday 29 September 2026, 09:41 UTC.
const NOW = new Date(Date.UTC(2026, 8, 29, 9, 41));
const AT = "2026-09-01T00:00:00.000Z";
const DAY_LENGTH = 24 * 60;

const RELEASE: WorkflowDefinition = {
  name: "Release",
  triggers: [{ id: "friday", kind: "start", on: { schedule: "0 14 * * 5" } }],
  steps: [{ id: "notes", kind: "agent", agent: "a-writer", prompt: "Write the notes." }],
};

const FRIDAY: Trigger = {
  workflowId: "release",
  workflowName: "Release",
  triggerId: "friday",
  kind: "start",
  on: { schedule: "0 14 * * 5" },
  status: "active",
  health: { state: "ok" },
  createdAt: AT,
  updatedAt: AT,
};

/** Returns the instant `hhmm` on 29 September 2026 in UTC, or on `date` when given. */
const at = (hhmm: string, date = "2026-09-29"): string => `${date}T${hhmm}:00.000Z`;

/** Returns a run that ran from `from` to `to`, or still runs when `to` is `undefined`. */
const buildRun = (id: string, from: string, to: string | undefined): RunSummary => {
  const fields = {
    id,
    workflowId: "release",
    workflowName: "Release",
    origin: { kind: "manual", actor: "user" },
    createdAt: from,
    startedAt: from,
  } as const;
  return to === undefined
    ? { ...fields, status: "running" }
    : { ...fields, status: "completed", finishedAt: to };
};

/** Returns the records of the release with `runs`, and with `extra` in place of any. */
const buildRecords = (
  runs: ReadonlyArray<RunSummary>,
  extra: Partial<TimelineRecords> = {},
): TimelineRecords => ({
  runs,
  definition: RELEASE,
  enabled: true,
  waitingSessions: [],
  triggers: [],
  ...extra,
});

const TODAY = computeTimelineDay(NOW, 0, "UTC");

/** Builds today's bars in UTC from `records`. */
const buildToday = (records: TimelineRecords) => buildTimelineBars(records, TODAY, "UTC", NOW);

/** Returns the minutes since the day's start of a place across a 24-hour day. */
const readMinutes = (place: number): number => Math.round(place * DAY_LENGTH);

describe("computeTimelineDay", () => {
  const readDay = (day: TimelineDay) => [day.start.toISOString(), day.end.toISOString()];

  it("returns today, and the days before it", () => {
    expect(readDay(computeTimelineDay(NOW, 0, "UTC"))).toEqual([
      "2026-09-29T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    ]);
    expect(readDay(computeTimelineDay(NOW, 2, "UTC"))).toEqual([
      "2026-09-27T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
    ]);
  });

  it("steps over a 25-hour day the clock moves back on", () => {
    // Monday 26 October 2026 in Amsterdam; the clock moved back on Sunday.
    const monday = new Date("2026-10-26T09:00:00Z");
    expect(readDay(computeTimelineDay(monday, 1, "Europe/Amsterdam"))).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T23:00:00.000Z",
    ]);
    expect(readDay(computeTimelineDay(monday, 2, "Europe/Amsterdam"))).toEqual([
      "2026-10-23T22:00:00.000Z",
      "2026-10-24T22:00:00.000Z",
    ]);
  });
});

describe("buildTimelineBars", () => {
  it("draws a run from when it started to when it ended, and a live run up to now", () => {
    const { bars, trackCount } = buildToday(
      buildRecords([
        buildRun("r-done", at("06:00"), at("06:30")),
        buildRun("r-live", at("09:12"), undefined),
      ]),
    );
    expect(
      bars.map((bar) => [bar.run.id, readMinutes(bar.from), readMinutes(bar.to), bar.run.isLive]),
    ).toEqual([
      ["r-done", 6 * 60, 6 * 60 + 30, false],
      ["r-live", 9 * 60 + 12, 9 * 60 + 41, true],
    ]);
    expect(bars[1]?.run.status.text).toBe("Running");
    expect(trackCount).toBe(1);
  });

  it("leaves out a run that has not started, and draws a run listed twice once", () => {
    const live = buildRun("r-live", at("09:12"), undefined);
    const pending: RunSummary = {
      id: "r-pending",
      workflowId: "release",
      workflowName: "Release",
      origin: { kind: "manual", actor: "user" },
      createdAt: at("09:40"),
      status: "pending",
    };
    const { bars } = buildToday(buildRecords([live, pending, live]));
    expect(bars.map((bar) => bar.run.id)).toEqual(["r-live"]);
  });

  it("stacks the runs that overlap, and puts a later run back on the first free track", () => {
    const { bars, trackCount } = buildToday(
      buildRecords([
        buildRun("r-c", at("07:00"), at("08:00")),
        buildRun("r-a", at("06:00"), at("06:50")),
        buildRun("r-b", at("06:20"), at("07:30")),
      ]),
    );
    expect(bars.map((bar) => [bar.run.id, bar.track])).toEqual([
      ["r-a", 0],
      ["r-b", 1],
      ["r-c", 0],
    ]);
    expect(trackCount).toBe(2);
  });

  it("keeps a short run's track for 45 minutes, so the next bar clears its mark", () => {
    const { bars } = buildToday(
      buildRecords([
        buildRun("r-short", at("06:00"), at("06:02")),
        buildRun("r-soon", at("06:30"), at("06:35")),
        buildRun("r-later", at("06:45"), at("06:50")),
      ]),
    );
    expect(bars.map((bar) => bar.track)).toEqual([0, 1, 0]);
  });

  it("cuts a run at the day's start when it started the day before", () => {
    const { bars } = buildToday(
      buildRecords([
        buildRun("r-overnight", at("23:30", "2026-09-28"), at("00:40")),
        buildRun("r-yesterday", at("20:00", "2026-09-28"), at("21:00", "2026-09-28")),
      ]),
    );
    expect(bars.map((bar) => [bar.run.id, readMinutes(bar.from), bar.startsBefore])).toEqual([
      ["r-overnight", 0, true],
    ]);
  });

  it("cuts a run still going at the end of a day before today, and marks no fires on it", () => {
    const monday = computeTimelineDay(NOW, 1, "UTC");
    const { bars, fires } = buildTimelineBars(
      buildRecords([buildRun("r-since-monday", at("05:41", "2026-09-28"), undefined)], {
        triggers: [{ ...FRIDAY, nextFireAt: at("14:00", "2026-09-28") }],
      }),
      monday,
      "UTC",
      NOW,
    );
    expect(fires).toEqual([]);
    expect(bars.map((bar) => [readMinutes(bar.to), bar.endsAfter, bar.run.isLive])).toEqual([
      [DAY_LENGTH, true, true],
    ]);
  });

  it("marks a start trigger's next fire when it falls in what is left of today", () => {
    const records = (triggers: ReadonlyArray<Trigger>, enabled = true) =>
      buildRecords([], { triggers, enabled });
    const later = { ...FRIDAY, nextFireAt: at("14:00") };
    expect(buildToday(records([later])).fires).toEqual([
      { triggerId: "friday", at: (14 * 60) / DAY_LENGTH, text: "14:00" },
    ]);
    const tomorrow = { ...FRIDAY, nextFireAt: at("14:00", "2026-09-30") };
    const paused = { ...later, status: "paused" } as const;
    expect(buildToday(records([tomorrow])).fires).toEqual([]);
    expect(buildToday(records([paused])).fires).toEqual([]);
    expect(buildToday(records([later], false)).fires).toEqual([]);
  });
});

describe("buildTimelineAxis", () => {
  it("names the day, draws a line each hour, and labels every third on a narrow page", () => {
    const axis = buildTimelineAxis(TODAY, "UTC", NOW);
    expect(axis.dayText).toBe("Today");
    expect(axis.now).toEqual({ at: (9 * 60 + 41) / DAY_LENGTH, text: "09:41" });
    expect(axis.hours).toHaveLength(23);
    expect(axis.hours.slice(0, 3)).toEqual([
      { at: 60 / DAY_LENGTH, label: "01:00", isMajor: false },
      { at: 120 / DAY_LENGTH, label: "02:00", isMajor: false },
      { at: 180 / DAY_LENGTH, label: "03:00", isMajor: true },
    ]);
  });

  it("leaves out the labels the now line's time covers", () => {
    // 09:00 and 10:00 are within 45 minutes of 09:41.
    const axis = buildTimelineAxis(TODAY, "UTC", NOW);
    expect(axis.hours.slice(7, 11).map((hour) => hour.label)).toEqual([
      "08:00",
      undefined,
      undefined,
      "11:00",
    ]);
  });

  it("draws a day before today with no now line", () => {
    const axis = buildTimelineAxis(computeTimelineDay(NOW, 1, "UTC"), "UTC", NOW);
    expect(axis.dayText).toBe("Yesterday");
    expect(axis.now).toBeUndefined();
    expect(axis.hours.every((hour) => hour.label !== undefined)).toBe(true);
  });

  it("draws the repeated hour twice on a day the clock moves back", () => {
    const sunday = computeTimelineDay(new Date("2026-10-26T09:00:00Z"), 1, "Europe/Amsterdam");
    const axis = buildTimelineAxis(sunday, "Europe/Amsterdam", NOW);
    expect(axis.hours).toHaveLength(24);
    expect(axis.hours.slice(0, 3).map((hour) => hour.label)).toEqual(["01:00", "02:00", "02:00"]);
  });
});

describe("computeTimelineReadRange", () => {
  it("reads from the start of the day before, so a run that crossed midnight is read", () => {
    expect(computeTimelineReadRange(TODAY, "UTC")).toEqual({
      since: "2026-09-28T00:00:00.000Z",
      until: "2026-09-30T00:00:00.000Z",
    });
  });
});
