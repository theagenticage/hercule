import { assert, describe, it } from "vitest";
import type { RunSummary, Trigger, WorkflowDefinition } from "@hercule/contract";
import {
  buildTimelineBars,
  buildTimelineFires,
  buildTimelineHours,
  computeTimelineDay,
  findNextTimelineMinute,
  isHourLabelCovered,
  locateTimelineNow,
  type TimelineBar,
  type TimelineDay,
} from "./run-timeline";
import { MAX_TIMELINE_DAYS_BACK } from "./timeline-limit";

// Tuesday 29 September 2026, 09:41:30 UTC.
const NOW = new Date("2026-09-29T09:41:30.000Z");
const AT = "2026-09-01T00:00:00.000Z";
const DAY_MINUTES = 24 * 60;

const RELEASE: WorkflowDefinition = {
  name: "Release",
  triggers: [{ id: "on_friday", kind: "start", on: { schedule: "0 14 * * 5" } }],
  steps: [{ id: "notes", kind: "agent", agent: "a-writer", prompt: "Write the notes." }],
};

const ON_FRIDAY: Trigger = {
  workflowId: "w-release",
  workflowName: "Release",
  triggerId: "on_friday",
  kind: "start",
  on: { schedule: "0 14 * * 5" },
  status: "active",
  health: { state: "ok" },
  nextFireAt: "2026-09-29T14:00:00.000Z",
  createdAt: AT,
  updatedAt: AT,
};

/** Returns the instant `hhmm` on 29 September 2026 in UTC, or on `date` when given. */
const at = (hhmm: string, date = "2026-09-29"): string => `${date}T${hhmm}:00.000Z`;

/** Returns a run that ran from `from` to `to`, or is still running when `to` is undefined. */
const buildRun = (id: string, from: string, to: string | undefined): RunSummary => {
  const fields = {
    id,
    workflowId: "w-release",
    workflowName: "Release",
    origin: { kind: "manual", actor: "user" },
    createdAt: from,
    startedAt: from,
  } as const;
  return to === undefined
    ? { ...fields, status: "running", activeStepIds: ["notes"], awaitedSignalIds: [] }
    : { ...fields, status: "completed", finishedAt: to };
};

const TODAY = computeTimelineDay(NOW, 0, "UTC");
const YESTERDAY = computeTimelineDay(NOW, 1, "UTC");

/** Builds the bars of `runs` on `day`, with no session waiting on the user. */
const buildBars = (runs: ReadonlyArray<RunSummary>, day: TimelineDay = TODAY) =>
  buildTimelineBars(runs, RELEASE, [], day);

/** Returns the minutes since the start of a 24-hour day of a place across it. */
const readMinutes = (place: number | null): number | null =>
  place === null ? null : Math.round(place * DAY_MINUTES);

/** Returns what a test reads of each bar: the run's id, its ends in minutes, and its cuts. */
const readBars = (bars: ReadonlyArray<TimelineBar>) =>
  bars.map((bar) => ({
    id: bar.row.id,
    from: readMinutes(bar.from),
    to: readMinutes(bar.to),
    startsBefore: bar.startsBefore,
    endsAfter: bar.endsAfter,
  }));

const readDay = (day: TimelineDay) => [day.start.toISOString(), day.end.toISOString()];

describe("computeTimelineDay", () => {
  it("returns today, and the days before it", () => {
    assert.deepStrictEqual(readDay(TODAY), [
      "2026-09-29T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    ]);
    assert.isTrue(TODAY.isToday);
    assert.deepStrictEqual(readDay(computeTimelineDay(NOW, 2, "UTC")), [
      "2026-09-27T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
    ]);
    assert.isFalse(YESTERDAY.isToday);
  });

  it("gives the day the clock moves forward 23 hours, and the day it moves back 25", () => {
    // Amsterdam moves to summer time on Sunday 29 March 2026, and back on Sunday 25 October.
    const march = computeTimelineDay(new Date("2026-03-30T09:00:00Z"), 1, "Europe/Amsterdam");
    assert.deepStrictEqual(readDay(march), [
      "2026-03-28T23:00:00.000Z",
      "2026-03-29T22:00:00.000Z",
    ]);
    const october = computeTimelineDay(new Date("2026-10-26T09:00:00Z"), 1, "Europe/Amsterdam");
    assert.deepStrictEqual(readDay(october), [
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T23:00:00.000Z",
    ]);
    // Stepping over the long day lands on the midnight before it.
    assert.deepStrictEqual(
      readDay(computeTimelineDay(new Date("2026-10-26T09:00:00Z"), 2, "Europe/Amsterdam")),
      ["2026-10-23T22:00:00.000Z", "2026-10-24T22:00:00.000Z"],
    );
  });

  it("starts a day whose clock skips midnight at 01:00, and one that reads midnight twice at the first", () => {
    // Havana skips 00:00 on Sunday 8 March 2026, and reads it twice on Sunday 1 November.
    assert.deepStrictEqual(
      readDay(computeTimelineDay(new Date("2026-03-09T15:00:00Z"), 1, "America/Havana")),
      ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    );
    assert.deepStrictEqual(
      readDay(computeTimelineDay(new Date("2026-11-02T15:00:00Z"), 1, "America/Havana")),
      ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    );
    // Santiago skips 00:00 on Sunday 6 September 2026, and on Sunday 5 April
    // goes back from 00:00 to 23:00 on Saturday 4 April, which is 25 hours long.
    assert.deepStrictEqual(
      readDay(computeTimelineDay(new Date("2026-09-07T15:00:00Z"), 1, "America/Santiago")),
      ["2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"],
    );
    assert.deepStrictEqual(
      readDay(computeTimelineDay(new Date("2026-04-05T15:00:00Z"), 1, "America/Santiago")),
      ["2026-04-04T03:00:00.000Z", "2026-04-05T04:00:00.000Z"],
    );
  });

  it("counts back across leap years, and clamps daysBack to the range it allows", () => {
    // Ten years back from 29 September 2026 is 3652 days, over 29 February 2020 and 2024.
    const oldest = computeTimelineDay(NOW, MAX_TIMELINE_DAYS_BACK, "UTC");
    assert.deepStrictEqual(readDay(oldest), [
      "2016-10-01T00:00:00.000Z",
      "2016-10-02T00:00:00.000Z",
    ]);
    assert.deepStrictEqual(readDay(computeTimelineDay(NOW, 100_000, "UTC")), readDay(oldest));
    const beforeToday = computeTimelineDay(NOW, -3, "UTC");
    assert.deepStrictEqual(readDay(beforeToday), readDay(TODAY));
    assert.isTrue(beforeToday.isToday);
  });
});

describe("buildTimelineBars", () => {
  it("draws a run from its start to its end, and leaves a live run's end to the now line", () => {
    const { bars, trackCount } = buildBars([
      buildRun("r-live", at("09:12"), undefined),
      buildRun("r-done", at("06:00"), at("06:30")),
    ]);
    assert.deepStrictEqual(readBars(bars), [
      { id: "r-done", from: 360, to: 390, startsBefore: false, endsAfter: false },
      { id: "r-live", from: 552, to: null, startsBefore: false, endsAfter: false },
    ]);
    assert.strictEqual(bars[1]?.row.state, "working");
    assert.strictEqual(trackCount, 1);
  });

  it("draws a run that has not started a step from when it was created", () => {
    const pending: RunSummary = {
      id: "r-pending",
      workflowId: "w-release",
      workflowName: "Release",
      origin: { kind: "manual", actor: "user" },
      createdAt: at("09:40"),
      status: "pending",
    };
    const [bar] = buildBars([pending]).bars;
    assert.deepInclude(bar, { from: 580 / DAY_MINUTES, to: null });
    assert.strictEqual(bar?.row.state, "starting");
  });

  it("stacks the runs that overlap, and puts a later run back on the first free track", () => {
    const { bars, trackCount } = buildBars([
      buildRun("r-c", at("07:00"), at("08:00")),
      buildRun("r-a", at("06:00"), at("06:50")),
      buildRun("r-b", at("06:20"), at("07:30")),
    ]);
    assert.deepStrictEqual(
      bars.map((bar) => [bar.row.id, bar.track]),
      [
        ["r-a", 0],
        ["r-b", 1],
        ["r-c", 0],
      ],
    );
    assert.strictEqual(trackCount, 2);
  });

  it("keeps a short run's track for 45 minutes, so the next bar clears its mark", () => {
    const { bars } = buildBars([
      buildRun("r-short", at("06:00"), at("06:02")),
      buildRun("r-soon", at("06:30"), at("06:35")),
      buildRun("r-later", at("06:45"), at("06:50")),
    ]);
    assert.deepStrictEqual(
      bars.map((bar) => bar.track),
      [0, 1, 0],
    );
  });

  it("cuts a run that started the day before at the day's start, and leaves out one that ended then", () => {
    const { bars } = buildBars([
      buildRun("r-overnight", at("23:30", "2026-09-28"), at("00:40")),
      buildRun("r-yesterday", at("20:00", "2026-09-28"), at("21:00", "2026-09-28")),
    ]);
    assert.deepStrictEqual(readBars(bars), [
      { id: "r-overnight", from: 0, to: 40, startsBefore: true, endsAfter: false },
    ]);
  });

  it("cuts a run that went on past a day at the day's end, whether it ended later or still runs", () => {
    const { bars } = buildBars(
      [
        buildRun("r-overnight", at("23:30", "2026-09-28"), at("00:40")),
        buildRun("r-since-monday", at("05:41", "2026-09-28"), undefined),
      ],
      YESTERDAY,
    );
    assert.deepStrictEqual(readBars(bars), [
      { id: "r-since-monday", from: 341, to: DAY_MINUTES, startsBefore: false, endsAfter: true },
      { id: "r-overnight", from: 1410, to: DAY_MINUTES, startsBefore: false, endsAfter: true },
    ]);
  });
});

describe("buildTimelineFires", () => {
  it("marks a start trigger's next fire later today, titled with what it does", () => {
    assert.deepStrictEqual(buildTimelineFires([ON_FRIDAY], true, TODAY, "UTC"), [
      {
        triggerId: "on_friday",
        at: (14 * 60) / DAY_MINUTES,
        text: "14:00",
        title: "on_friday starts a run at 14:00",
      },
    ]);
  });

  it("marks no fire that is not today, or of a trigger that does not fire", () => {
    const tomorrow = { ...ON_FRIDAY, nextFireAt: at("14:00", "2026-09-30") };
    assert.deepStrictEqual(buildTimelineFires([tomorrow], true, TODAY, "UTC"), []);
    assert.deepStrictEqual(
      buildTimelineFires([{ ...ON_FRIDAY, status: "paused" }], true, TODAY, "UTC"),
      [],
    );
    assert.deepStrictEqual(buildTimelineFires([ON_FRIDAY], false, TODAY, "UTC"), []);
    const yesterdays = { ...ON_FRIDAY, nextFireAt: at("14:00", "2026-09-28") };
    assert.deepStrictEqual(buildTimelineFires([yesterdays], true, YESTERDAY, "UTC"), []);
  });
});

describe("buildTimelineHours", () => {
  it("draws a line at each hour after the first, every third one major", () => {
    const hours = buildTimelineHours(TODAY, "UTC");
    assert.lengthOf(hours, 23);
    assert.deepStrictEqual(
      hours.slice(0, 3).map(({ at: place, label, isMajor }) => ({ place, label, isMajor })),
      [
        { place: 60 / DAY_MINUTES, label: "01:00", isMajor: false },
        { place: 120 / DAY_MINUTES, label: "02:00", isMajor: false },
        { place: 180 / DAY_MINUTES, label: "03:00", isMajor: true },
      ],
    );
  });

  it("skips the hour the clock jumps over, and draws the hour it repeats twice", () => {
    const march = computeTimelineDay(new Date("2026-03-30T09:00:00Z"), 1, "Europe/Amsterdam");
    const short = buildTimelineHours(march, "Europe/Amsterdam");
    assert.lengthOf(short, 22);
    assert.deepStrictEqual(
      short.slice(0, 3).map((hour) => hour.label),
      ["01:00", "03:00", "04:00"],
    );
    // Each line stays at its place in real time: 03:00 is two hours in, not three.
    assert.strictEqual(short[1]?.at, 2 / 23);

    const october = computeTimelineDay(new Date("2026-10-26T09:00:00Z"), 1, "Europe/Amsterdam");
    const long = buildTimelineHours(october, "Europe/Amsterdam");
    assert.lengthOf(long, 24);
    assert.deepStrictEqual(
      long.slice(0, 4).map((hour) => hour.label),
      ["01:00", "02:00", "02:00", "03:00"],
    );
  });

  it("draws the lines on whole hours where the clock moves by half an hour", () => {
    // Lord Howe Island moves from 02:00 to 02:30 on Sunday 4 October 2026,
    // so the day is 23.5 hours long, and 03:00 comes 1.5 hours after 01:00.
    const lordHowe = "Australia/Lord_Howe";
    const october = computeTimelineDay(new Date("2026-10-05T03:00:00Z"), 1, lordHowe);
    assert.deepStrictEqual(readDay(october), [
      "2026-10-03T13:30:00.000Z",
      "2026-10-04T13:00:00.000Z",
    ]);
    const short = buildTimelineHours(october, lordHowe);
    assert.lengthOf(short, 22);
    assert.isTrue(short.every((hour) => hour.label.endsWith(":00")));
    assert.deepStrictEqual(
      short.slice(0, 2).map((hour) => [hour.label, new Date(hour.startsAt).toISOString()]),
      [
        ["01:00", "2026-10-03T14:30:00.000Z"],
        ["03:00", "2026-10-03T16:00:00.000Z"],
      ],
    );

    // On Sunday 5 April 2026 it goes back from 02:00 to 01:30, so the day is
    // 24.5 hours long, and 02:00 comes 1.5 hours after 01:00.
    const april = computeTimelineDay(new Date("2026-04-06T03:00:00Z"), 1, lordHowe);
    assert.deepStrictEqual(readDay(april), [
      "2026-04-04T13:00:00.000Z",
      "2026-04-05T13:30:00.000Z",
    ]);
    const long = buildTimelineHours(april, lordHowe);
    assert.lengthOf(long, 23);
    assert.isTrue(long.every((hour) => hour.label.endsWith(":00")));
    assert.deepStrictEqual(
      long.slice(0, 3).map((hour) => [hour.label, new Date(hour.startsAt).toISOString()]),
      [
        ["01:00", "2026-04-04T14:00:00.000Z"],
        ["02:00", "2026-04-04T15:30:00.000Z"],
        ["03:00", "2026-04-04T16:30:00.000Z"],
      ],
    );

    // On a day the clock does not move, the lines are an hour apart.
    const normal = buildTimelineHours(computeTimelineDay(NOW, 0, lordHowe), lordHowe);
    assert.lengthOf(normal, 23);
    assert.deepStrictEqual(
      normal.slice(0, 2).map((hour) => hour.startsAt - normal[0]!.startsAt),
      [0, 3_600_000],
    );
  });
});

describe("the now line", () => {
  it("is drawn at the start of the minute now falls in, and moves at the next one", () => {
    assert.deepStrictEqual(locateTimelineNow(TODAY, "UTC", NOW.getTime()), {
      instant: Date.parse(at("09:41")),
      at: (9 * 60 + 41) / DAY_MINUTES,
      text: "09:41",
    });
    assert.strictEqual(findNextTimelineMinute(NOW).toISOString(), at("09:42"));
  });

  it("is not drawn on a day before today", () => {
    assert.isNull(locateTimelineNow(YESTERDAY, "UTC", NOW.getTime()));
  });

  it("covers the hour labels within 45 minutes of it", () => {
    const now = locateTimelineNow(TODAY, "UTC", NOW.getTime());
    const hours = buildTimelineHours(TODAY, "UTC");
    assert.deepStrictEqual(
      hours.filter((hour) => isHourLabelCovered(hour, now)).map((hour) => hour.label),
      ["09:00", "10:00"],
    );
    assert.isFalse(hours.some((hour) => isHourLabelCovered(hour, null)));
  });
});
