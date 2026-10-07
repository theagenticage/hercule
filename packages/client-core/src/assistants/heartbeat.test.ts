/**
 * Tests the heartbeat schedule functions:
 * - `parseHeartbeatWindow(schedule)` reads a cron expression as an interval
 *   and a window of hours, or returns null when it is not one.
 * - `buildHeartbeatSchedule(window)` writes the window back as a cron
 *   expression that parses to the same beats.
 * - `buildHeartbeatDay(window, nowMinutes)` places the window, its beats,
 *   "now" and the axis labels on one day.
 * - `fitHeartbeatWindow(window)` moves the window's end to its last beat.
 * - `changeHeartbeatInterval`, `moveHeartbeatStart` and `moveHeartbeatEnd`
 *   apply the section's edits, or refuse them with an error.
 * - `listHeartbeatIntervalChoices(stored)` lists the intervals offered.
 * - `computeHeartbeatNow(at, heartbeatZone, userZone)` places "now".
 */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  buildHeartbeatDay,
  buildHeartbeatSchedule,
  changeHeartbeatInterval,
  computeHeartbeatNow,
  fitHeartbeatWindow,
  listHeartbeatIntervalChoices,
  moveHeartbeatEnd,
  moveHeartbeatStart,
  parseHeartbeatWindow,
  type HeartbeatWindow,
} from "./heartbeat";

describe("parseHeartbeatWindow", () => {
  it.each([
    ["0 7-23 * * *", { intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }],
    [
      "0 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *",
      { intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 },
    ],
    ["0 7-23/1 * * *", { intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }],
    ["15 * * * *", { intervalHours: 1, minute: 15, fromHour: 0, toHour: 23 }],
  ])("reads the hourly window %s", (schedule, window) => {
    expect(parseHeartbeatWindow(schedule)).toEqual(window);
  });

  it.each([
    ["0 9-17/2 * * *", { intervalHours: 2, minute: 0, fromHour: 9, toHour: 17 }],
    // 8-22/4 beats at 8, 12, 16 and 20: the last beat is 20, not 22.
    ["30 8-22/4 * * *", { intervalHours: 4, minute: 30, fromHour: 8, toHour: 20 }],
    ["0 0,5,10,15,20 * * *", { intervalHours: 5, minute: 0, fromHour: 0, toHour: 20 }],
  ])("reads the stepped window %s", (schedule, window) => {
    expect(parseHeartbeatWindow(schedule)).toEqual(window);
  });

  it.each([
    ["0 22-23,0-6 * * *", { intervalHours: 1, minute: 0, fromHour: 22, toHour: 6 }],
    ["0 22,0,2,4,6 * * *", { intervalHours: 2, minute: 0, fromHour: 22, toHour: 6 }],
    ["45 23,2,5 * * *", { intervalHours: 3, minute: 45, fromHour: 23, toHour: 5 }],
  ])("reads the window %s that crosses midnight", (schedule, window) => {
    expect(parseHeartbeatWindow(schedule)).toEqual(window);
  });

  it.each([
    ["0 * * * *", { intervalHours: 1, minute: 0, fromHour: 0, toHour: 23 }],
    ["0 */2 * * *", { intervalHours: 2, minute: 0, fromHour: 0, toHour: 22 }],
    ["0 1-23/2 * * *", { intervalHours: 2, minute: 0, fromHour: 1, toHour: 23 }],
    ["0 9,21 * * *", { intervalHours: 12, minute: 0, fromHour: 9, toHour: 21 }],
  ])("reads %s, which fills the day evenly, from its earliest hour", (schedule, window) => {
    expect(parseHeartbeatWindow(schedule)).toEqual(window);
  });

  it.each([
    ["0 9,17 * * *", { intervalHours: 8, minute: 0, fromHour: 9, toHour: 17 }],
    ["0 3,20 * * *", { intervalHours: 7, minute: 0, fromHour: 20, toHour: 3 }],
    ["0 0,23 * * *", { intervalHours: 1, minute: 0, fromHour: 23, toHour: 0 }],
    ["0 1,22 * * *", { intervalHours: 3, minute: 0, fromHour: 22, toHour: 1 }],
  ])("reads the two hours of %s with the shorter gap as the interval", (schedule, window) => {
    expect(parseHeartbeatWindow(schedule)).toEqual(window);
  });

  it("reads a single hour as one beat a day", () => {
    expect(parseHeartbeatWindow("30 9 * * *")).toEqual({
      intervalHours: 24,
      minute: 30,
      fromHour: 9,
      toHour: 9,
    });
  });

  it.each([
    ["0 9 * * 1-5", "names days of the week"],
    ["0 9 * * 0-6", "names every day of the week, but still names them"],
    ["0 9 1 * *", "names a day of the month"],
    ["0 9 1-31 * *", "names every day of the month"],
    ["0 9 * 1 *", "names a month"],
    ["0,30 9 * * *", "beats at two minutes past the hour"],
    ["*/5 * * * *", "beats every five minutes"],
    ["* 9 * * *", "beats every minute"],
    ["0 1,2,5 * * *", "has hours that are not evenly spaced"],
    ["0 1,3,4,6 * * *", "has two different gaps that repeat"],
    ["0 0 9 * * *", "has a field for seconds"],
    ["0 9 * *", "has four fields"],
    ["not a schedule", "is not cron"],
  ])("returns null for %s, which %s", (schedule) => {
    expect(parseHeartbeatWindow(schedule)).toBeNull();
  });
});

describe("buildHeartbeatSchedule", () => {
  it.each([
    [{ intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }, "0 7-23 * * *"],
    [{ intervalHours: 2, minute: 15, fromHour: 9, toHour: 17 }, "15 9-17/2 * * *"],
    [{ intervalHours: 24, minute: 30, fromHour: 9, toHour: 9 }, "30 9 * * *"],
    [{ intervalHours: 2, minute: 0, fromHour: 22, toHour: 6 }, "0 0,2,4,6,22 * * *"],
    [{ intervalHours: 3, minute: 0, fromHour: 23, toHour: 5 }, "0 2,5,23 * * *"],
  ])("writes %o as %s", (window, schedule) => {
    expect(buildHeartbeatSchedule(window)).toBe(schedule);
  });

  it("writes only the beats of a window that is not a whole number of intervals", () => {
    expect(buildHeartbeatSchedule({ intervalHours: 3, minute: 0, fromHour: 7, toHour: 23 })).toBe(
      "0 7-22/3 * * *",
    );
    expect(buildHeartbeatSchedule({ intervalHours: 12, minute: 0, fromHour: 7, toHour: 9 })).toBe(
      "0 7 * * *",
    );
    expect(buildHeartbeatSchedule({ intervalHours: 5, minute: 0, fromHour: 22, toHour: 6 })).toBe(
      "0 3,22 * * *",
    );
  });

  it("writes an hour list read from a cron expression as a range", () => {
    const window = parseHeartbeatWindow("0 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *");

    expect(buildHeartbeatSchedule(window!)).toBe("0 7-23 * * *");
  });
});

describe("fitHeartbeatWindow", () => {
  it.each([
    [{ intervalHours: 3, minute: 0, fromHour: 7, toHour: 23 }, 22],
    [{ intervalHours: 4, minute: 15, fromHour: 7, toHour: 22 }, 19],
    [{ intervalHours: 2, minute: 0, fromHour: 8, toHour: 23 }, 22],
    [{ intervalHours: 12, minute: 0, fromHour: 7, toHour: 9 }, 7],
    [{ intervalHours: 5, minute: 0, fromHour: 22, toHour: 6 }, 3],
    [{ intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }, 23],
    [{ intervalHours: 6, minute: 0, fromHour: 9, toHour: 9 }, 9],
  ])("moves the end of %o to %i, its last beat", (window, toHour) => {
    expect(fitHeartbeatWindow(window)).toEqual({ ...window, toHour });
  });
});

describe("listHeartbeatIntervalChoices", () => {
  it("offers the standard intervals", () => {
    expect(listHeartbeatIntervalChoices(2)).toEqual([1, 2, 3, 4, 6, 8, 12]);
    expect(listHeartbeatIntervalChoices(null)).toEqual([1, 2, 3, 4, 6, 8, 12]);
  });

  it("adds a stored interval the select does not offer, in order", () => {
    expect(listHeartbeatIntervalChoices(5)).toEqual([1, 2, 3, 4, 5, 6, 8, 12]);
    expect(listHeartbeatIntervalChoices(24)).toEqual([1, 2, 3, 4, 6, 8, 12, 24]);
  });
});

/**
 * Lists every window whose last beat is a whole number of intervals after
 * its first, for every interval, start hour and end hour, at two minutes.
 */
const listEveryWindow = (): Array<HeartbeatWindow> =>
  [0, 45].flatMap((minute) =>
    Array.from({ length: 24 }, (_, fromHour) =>
      Array.from({ length: 24 }, (_, toHour) => {
        const length = (toHour - fromHour + 24) % 24;
        if (length === 0) return [{ intervalHours: 24, minute, fromHour, toHour }];
        return Array.from({ length: 23 }, (_, index) => index + 1)
          .filter((intervalHours) => length % intervalHours === 0)
          .map((intervalHours) => ({ intervalHours, minute, fromHour, toHour }));
      }).flat(),
    ).flat(),
  );

/** Returns the times of day, in minutes, `schedule` beats at. */
const listBeatMinutes = (schedule: string): Array<number> => {
  const cron = Result.getOrThrow(Cron.parse(schedule));
  const hours = cron.hours.size === 0 ? Array.from({ length: 24 }, (_, h) => h) : [...cron.hours];
  return hours
    .flatMap((hour) => [...cron.minutes].map((minute) => hour * 60 + minute))
    .sort((a, b) => a - b);
};

/**
 * Checks whether `window` is the reading `parseHeartbeatWindow` picks for
 * its beats:
 * - a window whose beats fill the day evenly is read from its earliest beat;
 * - a window with two beats is read with the shorter gap as its interval.
 */
const isCanonical = (window: HeartbeatWindow): boolean => {
  const length = (window.toHour - window.fromHour + 24) % 24;
  if (length === 0) return true;
  if (length + window.intervalHours === 24) return window.fromHour < window.intervalHours;
  if (length === window.intervalHours) return window.intervalHours < 24 - window.intervalHours;
  return true;
};

describe("the round trip", () => {
  const windows = listEveryWindow();

  it("covers a grid of windows", () => {
    expect(windows.length).toBeGreaterThan(1000);
  });

  it("writes every window as a five-field expression the contract accepts", () => {
    for (const window of windows) {
      const schedule = buildHeartbeatSchedule(window);
      expect(schedule.split(" ")).toHaveLength(5);
      expect(Result.isSuccess(Cron.parse(schedule))).toBe(true);
    }
  });

  it("reads every written window back with the same beats", () => {
    for (const window of windows) {
      const schedule = buildHeartbeatSchedule(window);
      const read = parseHeartbeatWindow(schedule);
      expect(read, schedule).not.toBeNull();
      expect(listBeatMinutes(buildHeartbeatSchedule(read!))).toEqual(listBeatMinutes(schedule));
    }
  });

  it("reads every window in the reading the parser picks back as itself", () => {
    const canonical = windows.filter(isCanonical);
    expect(canonical.length).toBeGreaterThan(windows.length / 2);
    for (const window of canonical) {
      expect(parseHeartbeatWindow(buildHeartbeatSchedule(window))).toEqual(window);
    }
  });
});

describe("buildHeartbeatDay", () => {
  const hours = (hour: number, minute = 0): number => (hour * 60 + minute) / 1440;

  it("draws the Bureau book's day: every hour from 07 to 23, at 09:41", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }, 581);

    expect(day.spans).toEqual([{ from: hours(7), to: hours(23) }]);
    expect(day.beats).toEqual(
      Array.from({ length: 17 }, (_, index) => ({ at: hours(7 + index), atEnd: index === 16 })),
    );
    expect(day.now).toBe(581 / 1440);
    expect(day.labels).toEqual([
      { at: 0, text: "00" },
      { at: hours(7), text: "07" },
      { at: 581 / 1440, text: "now" },
      { at: hours(12), text: "12" },
      { at: hours(18), text: "18" },
      { at: hours(23), text: "23" },
    ]);
  });

  it("places the beats at their minute past the hour", () => {
    const day = buildHeartbeatDay({ intervalHours: 4, minute: 30, fromHour: 8, toHour: 20 }, 0);

    expect(day.beats.map((beat) => beat.at)).toEqual([
      hours(8, 30),
      hours(12, 30),
      hours(16, 30),
      hours(20, 30),
    ]);
    expect(day.spans).toEqual([{ from: hours(8, 30), to: hours(20, 30) }]);
  });

  it("splits a window that crosses midnight into two spans", () => {
    const day = buildHeartbeatDay({ intervalHours: 2, minute: 0, fromHour: 22, toHour: 6 }, 900);

    expect(day.spans).toEqual([
      { from: 0, to: hours(6) },
      { from: hours(22), to: 1 },
    ]);
    // The tick at 06 ends the morning span, so it is drawn ending at its beat.
    expect(day.beats).toEqual([
      { at: 0, atEnd: false },
      { at: hours(2), atEnd: false },
      { at: hours(4), atEnd: false },
      { at: hours(6), atEnd: true },
      { at: hours(22), atEnd: false },
    ]);
    expect(day.labels.map((label) => label.text)).toEqual(["00", "06", "12", "now", "18", "22"]);
  });

  it("drops a fixed label closer than an hour and a half to a window label or now", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 1, toHour: 17 }, 780);

    // 00 is an hour from 01, 12 an hour from now (13:00) and 18 an hour from 17.
    expect(day.labels.map((label) => label.text)).toEqual(["01", "now", "17"]);
  });

  it("keeps a fixed label exactly an hour and a half away", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 30, fromHour: 1, toHour: 16 }, 0);

    // 18 is an hour and a half after the last beat at 16:30; 00 is at now.
    expect(day.labels.map((label) => label.text)).toEqual(["now", "01", "12", "16", "18"]);
  });

  it("drops a window label closer than an hour to now", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }, 1360);

    // Now is 22:40, twenty minutes before the last beat at 23:00.
    expect(day.labels.map((label) => label.text)).toEqual(["00", "07", "12", "18", "now"]);
  });

  it("keeps a window label exactly an hour from now", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 9, toHour: 13 }, 600);

    expect(day.labels.map((label) => label.text)).toEqual(["00", "09", "now", "13", "18"]);
  });

  it("labels a window that starts at midnight once, with the window's label", () => {
    const day = buildHeartbeatDay({ intervalHours: 6, minute: 0, fromHour: 0, toHour: 18 }, 600);

    expect(day.labels).toEqual([
      { at: 0, text: "00" },
      { at: 600 / 1440, text: "now" },
      { at: hours(12), text: "12" },
      { at: hours(18), text: "18" },
    ]);
  });

  it("labels a window with one beat once", () => {
    const day = buildHeartbeatDay({ intervalHours: 24, minute: 0, fromHour: 9, toHour: 9 }, 900);

    expect(day.beats).toEqual([{ at: hours(9), atEnd: true }]);
    expect(day.labels.map((label) => label.text)).toEqual(["00", "09", "12", "now", "18"]);
  });

  it("draws one span for a window that crosses midnight and ends at 00:00", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 7, toHour: 0 }, 600);

    expect(day.spans).toEqual([{ from: hours(7), to: 1 }]);
    // The beat at 00:00 closes the window, so its tick ends the day.
    expect(day.beats.at(-1)).toEqual({ at: 1, atEnd: true });
    expect(day.beats[0]).toEqual({ at: hours(7), atEnd: false });
    expect(day.labels.map((label) => label.text)).toEqual(["00", "07", "now", "12", "18"]);
  });

  it("drops a window label that sits exactly at now", () => {
    const day = buildHeartbeatDay({ intervalHours: 1, minute: 0, fromHour: 7, toHour: 23 }, 420);

    expect(day.labels.map((label) => label.text)).toEqual(["00", "now", "12", "18", "23"]);
  });
});

const window = (
  intervalHours: number,
  fromHour: number,
  toHour: number,
  minute = 0,
): HeartbeatWindow => ({ intervalHours, minute, fromHour, toHour });

describe("changeHeartbeatInterval", () => {
  it("moves the end back to the last beat of the new interval", () => {
    expect(changeHeartbeatInterval(window(1, 7, 23), 3)).toEqual(window(3, 7, 22));
  });

  it("replaces a schedule that is not a window with the interval from 07:00 to 23:00", () => {
    expect(changeHeartbeatInterval(null, 2)).toEqual(window(2, 7, 23));
  });

  it("widens a once-a-day window to 23:00 at the same minute", () => {
    expect(changeHeartbeatInterval(window(24, 9, 9, 30), 3)).toEqual(window(3, 9, 21, 30));
  });

  it("widens a window that the new interval would leave with one beat", () => {
    expect(changeHeartbeatInterval(window(1, 7, 9), 12)).toEqual(window(12, 7, 19));
  });

  it.each([
    [22, 3, 19],
    [23, 1, 22],
    [23, 12, 11],
  ])(
    "makes a once-a-day window at %i:00 beat all day at every %i h, since 23:00 leaves one beat",
    (fromHour, intervalHours, toHour) => {
      const next = changeHeartbeatInterval(window(24, fromHour, fromHour), intervalHours);
      expect(next).toEqual(window(intervalHours, fromHour, toHour));
    },
  );

  it.each([1, 2, 3, 4, 6, 8, 12])(
    "never leaves one beat a day at every %i h, from any start",
    (intervalHours) => {
      for (let fromHour = 0; fromHour < 24; fromHour += 1) {
        const next = changeHeartbeatInterval(window(24, fromHour, fromHour), intervalHours);
        expect(next.fromHour, `from ${String(fromHour)}`).not.toBe(next.toHour);
      }
    },
  );

  it("keeps one beat a day when the interval chosen is 24 h", () => {
    expect(changeHeartbeatInterval(window(24, 9, 9), 24)).toEqual(window(24, 9, 9));
  });
});

describe("moveHeartbeatStart", () => {
  it("moves the start and the minute of every beat, and fits the end", () => {
    expect(moveHeartbeatStart(window(3, 7, 22), "08:15")).toEqual({
      window: window(3, 8, 20, 15),
    });
  });

  it("moves the only beat of a once-a-day window", () => {
    expect(moveHeartbeatStart(window(24, 9, 9), "10:30")).toEqual({
      window: window(24, 10, 10, 30),
    });
  });

  it("refuses text that is not a time", () => {
    expect(moveHeartbeatStart(window(1, 7, 23), "7")).toEqual({
      error: '"7" is not a time. Write it as HH:MM on a 24-hour clock, such as 07:00.',
    });
  });

  it("refuses a start that leaves one beat a day", () => {
    expect(moveHeartbeatStart(window(3, 7, 22), "21:00")).toEqual({
      error:
        "A start at 21:00 leaves one beat a day before the window ends at 22:00. Start at least 3 h before 22:00.",
    });
  });

  it("refuses a start at the end", () => {
    expect(moveHeartbeatStart(window(1, 7, 23), "23:00")).toHaveProperty("error");
  });

  it("refuses a start that makes the window beat all day", () => {
    expect(moveHeartbeatStart(window(1, 7, 22), "23:00")).toEqual({
      error:
        "A start at 23:00 runs the window past midnight to 22:00, so it beats all day. Start before 22:00, or move the end first.",
    });
  });

  it("moves the start of a window that already beats all day", () => {
    expect(moveHeartbeatStart(window(1, 0, 23), "00:30")).toEqual({
      window: window(1, 0, 23, 30),
    });
  });

  it("moves the start of a window across midnight when it then beats overnight", () => {
    expect(moveHeartbeatStart(window(2, 4, 6), "22:00")).toEqual({ window: window(2, 22, 6) });
  });
});

describe("moveHeartbeatEnd", () => {
  it("moves the end to a beat", () => {
    expect(moveHeartbeatEnd(window(2, 7, 23), "21:00")).toEqual({ window: window(2, 7, 21) });
  });

  it("refuses text that is not a time", () => {
    expect(moveHeartbeatEnd(window(1, 7, 23), "25:00")).toHaveProperty("error");
  });

  it("refuses an end at another minute than the start", () => {
    expect(moveHeartbeatEnd(window(1, 7, 23), "22:30")).toEqual({
      error:
        "The window ends at the same minute past the hour as it starts, so write 22:00. To change the minute, change the start.",
    });
  });

  it("refuses an end that is not a beat, naming the last beat before it", () => {
    expect(moveHeartbeatEnd(window(3, 7, 22), "21:00")).toEqual({
      error:
        "A beat every 3 h from 07:00 does not land on 21:00. The last beat before it is at 19:00.",
    });
  });

  it("refuses an end at the start", () => {
    expect(moveHeartbeatEnd(window(1, 7, 23), "07:00")).toEqual({
      error:
        "An end at 07:00 is the start, which leaves one beat a day. To beat once a day, choose a 24 h interval.",
    });
  });
});

describe("computeHeartbeatNow", () => {
  const AT = new Date("2026-10-07T21:10:00Z");

  it("reads now in the heartbeat's zone", () => {
    expect(computeHeartbeatNow(AT, "Europe/Amsterdam", "America/Los_Angeles")).toEqual({
      nowMinutes: 23 * 60 + 10,
      timezone: "Europe/Amsterdam",
      unknownTimezone: null,
    });
  });

  it("reads now in the user's zone when the heartbeat has none", () => {
    expect(computeHeartbeatNow(AT, undefined, "America/Los_Angeles").nowMinutes).toBe(14 * 60 + 10);
  });

  it("reads now in UTC when neither has a zone", () => {
    expect(computeHeartbeatNow(AT, undefined, undefined)).toEqual({
      nowMinutes: 21 * 60 + 10,
      timezone: "UTC",
      unknownTimezone: null,
    });
  });

  it("reads now in UTC, and names the zone, when this runtime does not know it", () => {
    expect(computeHeartbeatNow(AT, "Mars/Olympus", "Europe/Amsterdam")).toEqual({
      nowMinutes: 21 * 60 + 10,
      timezone: "UTC",
      unknownTimezone: "Mars/Olympus",
    });
  });
});
